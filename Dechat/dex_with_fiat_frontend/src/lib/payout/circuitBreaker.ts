import { telemetry } from '@/lib/telemetry';

export type CircuitBreakerState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitBreakerTransition {
  provider: string;
  from: CircuitBreakerState;
  to: CircuitBreakerState;
  timestamp: number;
  failureCount: number;
  failureRate: number;
  reason?: string;
}

export interface CircuitBreakerMetrics {
  state: CircuitBreakerState;
  failureCount: number;
  totalRequests: number;
  totalFailures: number;
  failureRate: number;
  lastFailureTime: number | null;
  lastSuccessTime: number | null;
  lastStateChange: number;
  cooldownRemainingMs: number;
}

export interface CircuitBreakerConfig {
  provider?: string;
  failureThreshold?: number; // consecutive failures or threshold before opening
  cooldownMs?: number; // cooldown period before entering half-open
  halfOpenSuccessThreshold?: number; // successful probes needed to close
  clock?: () => number;
  onStateTransition?: (transition: CircuitBreakerTransition) => void;
  isOutageError?: (error: unknown) => boolean;
}

export class ProviderOutageError extends Error {
  readonly code = 'PROVIDER_OUTAGE';
  readonly statusCode = 503;
  readonly retryAfterSeconds: number;
  readonly circuitState: CircuitBreakerState;
  readonly isPermanentRejection = false;

  constructor(
    message: string = 'Payout provider is currently experiencing temporary downtime. Please try again shortly.',
    circuitState: CircuitBreakerState = 'OPEN',
    retryAfterSeconds: number = 30,
  ) {
    super(message);
    this.name = 'ProviderOutageError';
    this.circuitState = circuitState;
    this.retryAfterSeconds = Math.max(1, retryAfterSeconds);
  }
}

export function isProviderOutage(error: unknown): boolean {
  if (!error) return false;
  if (error instanceof ProviderOutageError) return true;

  if (typeof error === 'object') {
    const err = error as Record<string, unknown>;

    // Axios error with response
    if (err.isAxiosError && err.response && typeof err.response === 'object') {
      const resp = err.response as Record<string, unknown>;
      const status = Number(resp.status);
      // 5xx status from provider indicates outage
      if (status >= 500) return true;
      // 4xx status is a permanent or client rejection (invalid account, insufficient funds, etc.)
      return false;
    }

    // Axios error without response -> network failure / timeout
    if (err.isAxiosError && !err.response) {
      return true;
    }

    // Generic HTTP response objects
    if (typeof err.status === 'number') {
      if (err.status >= 500) return true;
      return false;
    }

    // Network error codes
    const code = String(err.code || '');
    if (
      [
        'ECONNREFUSED',
        'ETIMEDOUT',
        'ENOTFOUND',
        'ECONNRESET',
        'EHOSTUNREACH',
        'EAI_AGAIN',
      ].includes(code)
    ) {
      return true;
    }

    // Timeout or network error in message
    const message = String(err.message || '').toLowerCase();
    if (
      message.includes('timeout') ||
      message.includes('network error') ||
      message.includes('fetch failed') ||
      message.includes('econnrefused') ||
      message.includes('service unavailable') ||
      message.includes('bad gateway') ||
      message.includes('gateway timeout')
    ) {
      return true;
    }
  }

  return false;
}

export function handlePayoutApiError(
  error: unknown,
  defaultMessage: string = 'Payout operation failed. Please try again.',
): {
  status: number;
  body: {
    success: false;
    error?: string;
    message: string;
    retryAfter?: number;
  };
  headers?: Record<string, string>;
} {
  if (error instanceof ProviderOutageError) {
    return {
      status: 503,
      body: {
        success: false,
        error: 'PROVIDER_OUTAGE',
        message: error.message,
        retryAfter: error.retryAfterSeconds,
      },
      headers: {
        'Retry-After': String(error.retryAfterSeconds),
      },
    };
  }

  if (isProviderOutage(error)) {
    return {
      status: 503,
      body: {
        success: false,
        error: 'PROVIDER_OUTAGE',
        message:
          'Payout provider is currently experiencing temporary downtime. Please try again shortly.',
        retryAfter: 30,
      },
      headers: {
        'Retry-After': '30',
      },
    };
  }

  // Handle permanent provider rejection (4xx errors)
  if (
    error &&
    typeof error === 'object' &&
    'response' in error &&
    error.response &&
    typeof error.response === 'object' &&
    'data' in error.response &&
    error.response.data &&
    typeof error.response.data === 'object'
  ) {
    const data = error.response.data as Record<string, unknown>;
    const status =
      'status' in error.response && typeof error.response.status === 'number'
        ? error.response.status
        : 400;
    const msg =
      typeof data.message === 'string' ? data.message : defaultMessage;

    return {
      status: status >= 400 && status < 500 ? status : 400,
      body: {
        success: false,
        error: 'PAYOUT_REJECTED',
        message: msg,
      },
    };
  }

  const message = error instanceof Error ? error.message : defaultMessage;
  return {
    status: 500,
    body: {
      success: false,
      message,
    },
  };
}

export class CircuitBreaker {
  private readonly provider: string;
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly halfOpenSuccessThreshold: number;
  private readonly clock: () => number;
  private readonly onStateTransition?: (
    transition: CircuitBreakerTransition,
  ) => void;
  private readonly isOutage: (error: unknown) => boolean;

  private state: CircuitBreakerState = 'CLOSED';
  private failureCount = 0;
  private totalRequests = 0;
  private totalFailures = 0;
  private halfOpenSuccesses = 0;
  private lastFailureTime: number | null = null;
  private lastSuccessTime: number | null = null;
  private lastStateChange: number;
  private openUntil = 0;
  private halfOpenProbeInFlight = false;

  constructor(config: CircuitBreakerConfig = {}) {
    this.provider = config.provider || 'default';
    this.failureThreshold = config.failureThreshold ?? 5;
    this.cooldownMs = config.cooldownMs ?? 30_000;
    this.halfOpenSuccessThreshold = config.halfOpenSuccessThreshold ?? 1;
    this.clock = config.clock ?? Date.now;
    this.onStateTransition = config.onStateTransition;
    this.isOutage = config.isOutageError ?? isProviderOutage;
    this.lastStateChange = this.clock();
  }

  getState(): CircuitBreakerState {
    this.checkCooldownTransition();
    return this.state;
  }

  private checkCooldownTransition(): void {
    const now = this.clock();
    if (this.state === 'OPEN' && now >= this.openUntil) {
      this.transitionTo(
        'HALF_OPEN',
        'Cooldown elapsed; probing provider health',
      );
    }
  }

  private transitionTo(newState: CircuitBreakerState, reason?: string): void {
    const from = this.state;
    if (from === newState) return;

    const now = this.clock();
    this.state = newState;
    this.lastStateChange = now;

    if (newState === 'OPEN') {
      this.openUntil = now + this.cooldownMs;
      this.halfOpenProbeInFlight = false;
      this.halfOpenSuccesses = 0;
    } else if (newState === 'HALF_OPEN') {
      this.halfOpenSuccesses = 0;
      this.halfOpenProbeInFlight = false;
    } else if (newState === 'CLOSED') {
      this.failureCount = 0;
      this.halfOpenSuccesses = 0;
      this.halfOpenProbeInFlight = false;
      this.openUntil = 0;
    }

    const failureRate =
      this.totalRequests > 0 ? this.totalFailures / this.totalRequests : 0;

    const transition: CircuitBreakerTransition = {
      provider: this.provider,
      from,
      to: newState,
      timestamp: now,
      failureCount: this.failureCount,
      failureRate,
      reason,
    };

    telemetry.addLog(
      'circuit-breaker',
      'warn',
      `Circuit state transition: ${from} -> ${newState}`,
      {
        ...transition,
      },
    );

    if (this.onStateTransition) {
      this.onStateTransition(transition);
    }
  }

  async execute<T>(action: () => Promise<T>): Promise<T> {
    this.checkCooldownTransition();
    const now = this.clock();

    if (this.state === 'OPEN') {
      const remainingSeconds = Math.ceil((this.openUntil - now) / 1000);
      throw new ProviderOutageError(
        `Payout provider '${this.provider}' is currently experiencing an outage. Please try again in ${remainingSeconds}s.`,
        'OPEN',
        remainingSeconds,
      );
    }

    if (this.state === 'HALF_OPEN') {
      if (this.halfOpenProbeInFlight) {
        // Only one probe request at a time
        throw new ProviderOutageError(
          `Payout provider '${this.provider}' is currently recovering. A health check probe is in flight.`,
          'HALF_OPEN',
          5,
        );
      }
      this.halfOpenProbeInFlight = true;
    }

    this.totalRequests++;

    try {
      const result = await action();
      this.handleSuccess();
      return result;
    } catch (error) {
      this.handleFailure(error);
      throw error;
    } finally {
      if (this.state === 'HALF_OPEN') {
        this.halfOpenProbeInFlight = false;
      }
    }
  }

  handleSuccess(): void {
    const now = this.clock();
    this.lastSuccessTime = now;

    if (this.state === 'HALF_OPEN') {
      this.halfOpenSuccesses++;
      if (this.halfOpenSuccesses >= this.halfOpenSuccessThreshold) {
        this.transitionTo('CLOSED', 'Half-open probe succeeded');
      }
    } else if (this.state === 'CLOSED') {
      this.failureCount = 0;
    }
  }

  handleFailure(error: unknown): void {
    const now = this.clock();
    const isOutageFailure = this.isOutage(error);

    // If it's a permanent rejection (e.g. 400 Bad Request, invalid account), do NOT trip circuit
    if (!isOutageFailure) {
      return;
    }

    this.lastFailureTime = now;
    this.totalFailures++;
    this.failureCount++;

    if (this.state === 'HALF_OPEN') {
      this.transitionTo('OPEN', 'Half-open probe failed with provider outage');
    } else if (this.state === 'CLOSED') {
      if (this.failureCount >= this.failureThreshold) {
        this.transitionTo(
          'OPEN',
          `Failure threshold reached (${this.failureCount}/${this.failureThreshold})`,
        );
      }
    }
  }

  getMetrics(): CircuitBreakerMetrics {
    this.checkCooldownTransition();
    const now = this.clock();
    const failureRate =
      this.totalRequests > 0 ? this.totalFailures / this.totalRequests : 0;
    const cooldownRemainingMs = Math.max(0, this.openUntil - now);

    return {
      state: this.state,
      failureCount: this.failureCount,
      totalRequests: this.totalRequests,
      totalFailures: this.totalFailures,
      failureRate,
      lastFailureTime: this.lastFailureTime,
      lastSuccessTime: this.lastSuccessTime,
      lastStateChange: this.lastStateChange,
      cooldownRemainingMs,
    };
  }

  reset(): void {
    this.state = 'CLOSED';
    this.failureCount = 0;
    this.totalRequests = 0;
    this.totalFailures = 0;
    this.halfOpenSuccesses = 0;
    this.lastFailureTime = null;
    this.lastSuccessTime = null;
    this.lastStateChange = this.clock();
    this.openUntil = 0;
    this.halfOpenProbeInFlight = false;
  }
}

// Global registry of circuit breakers by provider name
const circuitBreakers = new Map<string, CircuitBreaker>();

export function getProviderCircuitBreaker(
  provider: string = 'paystack',
  config?: Partial<CircuitBreakerConfig>,
): CircuitBreaker {
  let cb = circuitBreakers.get(provider);
  if (!cb) {
    cb = new CircuitBreaker({ provider, ...config });
    circuitBreakers.set(provider, cb);
  }
  return cb;
}

export function resetCircuitBreakers(): void {
  circuitBreakers.clear();
}
