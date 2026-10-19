import { describe, expect, it, vi } from 'vitest';
import {
  CircuitBreaker,
  CircuitBreakerTransition,
  isProviderOutage,
  ProviderOutageError,
} from './circuitBreaker';

vi.mock('server-only', () => ({}));

describe('isProviderOutage', () => {
  it('identifies 5xx Axios errors as provider outages', () => {
    const error503 = {
      isAxiosError: true,
      response: { status: 503, data: {} },
    };
    const error500 = {
      isAxiosError: true,
      response: { status: 500, data: {} },
    };
    expect(isProviderOutage(error503)).toBe(true);
    expect(isProviderOutage(error500)).toBe(true);
  });

  it('identifies network failures without response as provider outages', () => {
    const networkError = { isAxiosError: true, message: 'Network Error' };
    expect(isProviderOutage(networkError)).toBe(true);
  });

  it('identifies socket connection errors as provider outages', () => {
    const connRefused = { code: 'ECONNREFUSED', message: 'connection refused' };
    const timedOut = { code: 'ETIMEDOUT', message: 'timeout' };
    expect(isProviderOutage(connRefused)).toBe(true);
    expect(isProviderOutage(timedOut)).toBe(true);
  });

  it('does NOT identify 4xx client/business rejections as outages', () => {
    const error400 = {
      isAxiosError: true,
      response: { status: 400, data: { message: 'Account not found' } },
    };
    const error422 = {
      isAxiosError: true,
      response: { status: 422, data: { message: 'Invalid recipient' } },
    };
    const error404 = { status: 404, message: 'Not Found' };
    expect(isProviderOutage(error400)).toBe(false);
    expect(isProviderOutage(error422)).toBe(false);
    expect(isProviderOutage(error404)).toBe(false);
  });
});

describe('CircuitBreaker with deterministic clock', () => {
  function createDeterministicEnvironment(options?: {
    failureThreshold?: number;
    cooldownMs?: number;
    halfOpenSuccessThreshold?: number;
  }) {
    let currentTime = 1_000_000;
    const transitions: CircuitBreakerTransition[] = [];

    const cb = new CircuitBreaker({
      provider: 'paystack-test',
      failureThreshold: options?.failureThreshold ?? 3,
      cooldownMs: options?.cooldownMs ?? 10_000,
      halfOpenSuccessThreshold: options?.halfOpenSuccessThreshold ?? 1,
      clock: () => currentTime,
      onStateTransition: (t) => transitions.push(t),
    });

    return {
      cb,
      transitions,
      advanceTime: (ms: number) => {
        currentTime += ms;
      },
      getCurrentTime: () => currentTime,
    };
  }

  it('starts in CLOSED state and executes successful calls', async () => {
    const { cb } = createDeterministicEnvironment();
    expect(cb.getState()).toBe('CLOSED');

    const result = await cb.execute(async () => 'success_result');
    expect(result).toBe('success_result');
    expect(cb.getState()).toBe('CLOSED');
    expect(cb.getMetrics().failureCount).toBe(0);
  });

  it('does not open on 4xx permanent rejection errors', async () => {
    const { cb } = createDeterministicEnvironment({ failureThreshold: 2 });

    const permanentError = {
      isAxiosError: true,
      response: { status: 400, data: { message: 'Bad request' } },
    };

    for (let i = 0; i < 5; i++) {
      await expect(
        cb.execute(async () => {
          throw permanentError;
        }),
      ).rejects.toEqual(permanentError);
    }

    expect(cb.getState()).toBe('CLOSED');
    expect(cb.getMetrics().failureCount).toBe(0);
  });

  it('opens the circuit once the failure threshold is reached on provider outage', async () => {
    const { cb, transitions } = createDeterministicEnvironment({
      failureThreshold: 3,
    });

    const outageError = {
      isAxiosError: true,
      response: { status: 503, data: 'Unavailable' },
    };

    // Failure 1
    await expect(
      cb.execute(async () => {
        throw outageError;
      }),
    ).rejects.toEqual(outageError);
    expect(cb.getState()).toBe('CLOSED');
    expect(cb.getMetrics().failureCount).toBe(1);

    // Failure 2
    await expect(
      cb.execute(async () => {
        throw outageError;
      }),
    ).rejects.toEqual(outageError);
    expect(cb.getState()).toBe('CLOSED');
    expect(cb.getMetrics().failureCount).toBe(2);

    // Failure 3 -> Trips to OPEN
    await expect(
      cb.execute(async () => {
        throw outageError;
      }),
    ).rejects.toEqual(outageError);
    expect(cb.getState()).toBe('OPEN');
    expect(cb.getMetrics().failureCount).toBe(3);

    // Check transition metric event
    expect(transitions).toHaveLength(1);
    expect(transitions[0]).toMatchObject({
      provider: 'paystack-test',
      from: 'CLOSED',
      to: 'OPEN',
      failureCount: 3,
    });
  });

  it('rejects calls immediately with fallback message when OPEN', async () => {
    const { cb, advanceTime } = createDeterministicEnvironment({
      failureThreshold: 2,
      cooldownMs: 10_000,
    });

    const outageError = { code: 'ECONNREFUSED' };
    await expect(
      cb.execute(async () => {
        throw outageError;
      }),
    ).rejects.toThrow();
    await expect(
      cb.execute(async () => {
        throw outageError;
      }),
    ).rejects.toThrow();
    expect(cb.getState()).toBe('OPEN');

    // Attempt call while OPEN before cooldown
    advanceTime(3_000); // 3 seconds into 10s cooldown
    let caught: unknown;
    try {
      await cb.execute(async () => 'should_not_run');
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(ProviderOutageError);
    const outageErr = caught as ProviderOutageError;
    expect(outageErr.code).toBe('PROVIDER_OUTAGE');
    expect(outageErr.statusCode).toBe(503);
    expect(outageErr.retryAfterSeconds).toBe(7); // 10s - 3s = 7s
    expect(outageErr.circuitState).toBe('OPEN');
    expect(outageErr.isPermanentRejection).toBe(false);
  });

  it('transitions to HALF_OPEN after cooldown and closes after successful probe', async () => {
    const { cb, advanceTime, transitions } = createDeterministicEnvironment({
      failureThreshold: 2,
      cooldownMs: 10_000,
      halfOpenSuccessThreshold: 1,
    });

    const outageError = { code: 'ETIMEDOUT' };
    await expect(
      cb.execute(async () => {
        throw outageError;
      }),
    ).rejects.toThrow();
    await expect(
      cb.execute(async () => {
        throw outageError;
      }),
    ).rejects.toThrow();
    expect(cb.getState()).toBe('OPEN');

    // Advance beyond cooldown
    advanceTime(10_001);
    expect(cb.getState()).toBe('HALF_OPEN');

    // Half-open probe succeeds
    const result = await cb.execute(async () => 'probe_success');
    expect(result).toBe('probe_success');
    expect(cb.getState()).toBe('CLOSED');
    expect(cb.getMetrics().failureCount).toBe(0);

    // Verify transition events recorded
    const transitionTypes = transitions.map((t) => `${t.from}->${t.to}`);
    expect(transitionTypes).toContain('CLOSED->OPEN');
    expect(transitionTypes).toContain('OPEN->HALF_OPEN');
    expect(transitionTypes).toContain('HALF_OPEN->CLOSED');
  });

  it('re-opens circuit if probe fails in HALF_OPEN', async () => {
    const { cb, advanceTime, transitions } = createDeterministicEnvironment({
      failureThreshold: 2,
      cooldownMs: 10_000,
    });

    const outageError = { isAxiosError: true, response: { status: 502 } };
    await expect(
      cb.execute(async () => {
        throw outageError;
      }),
    ).rejects.toThrow();
    await expect(
      cb.execute(async () => {
        throw outageError;
      }),
    ).rejects.toThrow();
    expect(cb.getState()).toBe('OPEN');

    advanceTime(10_001);
    expect(cb.getState()).toBe('HALF_OPEN');

    // Probe fails with outage
    await expect(
      cb.execute(async () => {
        throw outageError;
      }),
    ).rejects.toThrow();
    expect(cb.getState()).toBe('OPEN');

    const transitionTypes = transitions.map((t) => `${t.from}->${t.to}`);
    expect(transitionTypes).toContain('HALF_OPEN->OPEN');
  });

  it('limits concurrent probes during HALF_OPEN to a controlled probe', async () => {
    const { cb, advanceTime } = createDeterministicEnvironment({
      failureThreshold: 1,
      cooldownMs: 5_000,
    });

    const outageError = { isAxiosError: true, response: { status: 500 } };
    await expect(
      cb.execute(async () => {
        throw outageError;
      }),
    ).rejects.toThrow();
    advanceTime(5_001);
    expect(cb.getState()).toBe('HALF_OPEN');

    // First probe hangs
    let resolveProbe!: (val: string) => void;
    const probePromise = cb.execute(
      () =>
        new Promise<string>((res) => {
          resolveProbe = res;
        }),
    );

    // Second concurrent probe should be rejected immediately
    await expect(cb.execute(async () => 'second_probe')).rejects.toThrow(
      ProviderOutageError,
    );

    // Complete the first probe
    resolveProbe('ok');
    const result = await probePromise;
    expect(result).toBe('ok');
    expect(cb.getState()).toBe('CLOSED');
  });
});
