/**
 * Operation-specific provider timeout budgets and ambiguous transfer reconciliation.
 * Addresses Issue #98:
 * - Enforces connect, response, and total deadlines for verify, recipient, initiate, and status operations.
 * - Classifies timed-out outcomes as 'known', 'rejected', or 'ambiguous'.
 * - Retries only idempotent operations; reconciles ambiguous initiation instead of blindly retrying.
 * - Returns stable safe errors and sanitized diagnostics.
 */

export type PayoutOperationType =
  | 'verify'
  | 'recipient'
  | 'initiate'
  | 'status';

export type TimeoutOutcome = 'known' | 'rejected' | 'ambiguous';

export interface OperationTimeoutBudget {
  connectTimeoutMs: number;
  responseTimeoutMs: number;
  totalDeadlineMs: number;
  maxRetries: number;
  isIdempotent: boolean;
}

export const DEFAULT_TIMEOUT_BUDGETS: Record<
  PayoutOperationType,
  OperationTimeoutBudget
> = {
  verify: {
    connectTimeoutMs: 2000,
    responseTimeoutMs: 3000,
    totalDeadlineMs: 6000,
    maxRetries: 2,
    isIdempotent: true,
  },
  recipient: {
    connectTimeoutMs: 2000,
    responseTimeoutMs: 3000,
    totalDeadlineMs: 6000,
    maxRetries: 2,
    isIdempotent: true,
  },
  initiate: {
    connectTimeoutMs: 3000,
    responseTimeoutMs: 5000,
    totalDeadlineMs: 8000,
    maxRetries: 0, // NEVER blindly retry initiation!
    isIdempotent: false,
  },
  status: {
    connectTimeoutMs: 2000,
    responseTimeoutMs: 3000,
    totalDeadlineMs: 6000,
    maxRetries: 2,
    isIdempotent: true,
  },
};

export interface SanitizedDiagnostics {
  operation: PayoutOperationType;
  outcome: TimeoutOutcome;
  errorCode: string;
  phase: 'connect' | 'response' | 'total' | 'execution';
  durationMs: number;
  retriesAttempted: number;
  timestamp: string;
  reference?: string;
}

export class ProviderTimeoutError extends Error {
  public readonly code = 'PROVIDER_TIMEOUT';
  public readonly operation: PayoutOperationType;
  public readonly outcome: TimeoutOutcome;
  public readonly phase: 'connect' | 'response' | 'total';
  public readonly diagnostics: SanitizedDiagnostics;

  constructor(
    operation: PayoutOperationType,
    outcome: TimeoutOutcome,
    phase: 'connect' | 'response' | 'total',
    durationMs: number,
    retriesAttempted: number,
    reference?: string,
  ) {
    const message =
      outcome === 'ambiguous'
        ? `Operation '${operation}' timed out during response phase. State is ambiguous; reconciliation required.`
        : `Operation '${operation}' timed out (${phase} deadline exceeded).`;
    super(message);
    this.name = 'ProviderTimeoutError';
    this.operation = operation;
    this.outcome = outcome;
    this.phase = phase;
    this.diagnostics = {
      operation,
      outcome,
      errorCode: this.code,
      phase,
      durationMs,
      retriesAttempted,
      timestamp: new Date().toISOString(),
      reference,
    };
  }
}

export class AmbiguousInitiationError extends Error {
  public readonly code = 'TRANSFER_AMBIGUOUS';
  public readonly outcome: TimeoutOutcome = 'ambiguous';
  public readonly reference: string;
  public readonly diagnostics: SanitizedDiagnostics;

  constructor(reference: string, durationMs: number) {
    super(
      `Transfer initiation for reference '${reference}' is ambiguous. The provider may have initiated the transfer. Blind retry is forbidden.`,
    );
    this.name = 'AmbiguousInitiationError';
    this.reference = reference;
    this.diagnostics = {
      operation: 'initiate',
      outcome: 'ambiguous',
      errorCode: this.code,
      phase: 'response',
      durationMs,
      retriesAttempted: 0,
      timestamp: new Date().toISOString(),
      reference,
    };
  }
}

/**
 * Executes a payout provider operation within its defined timeout budget.
 */
export async function executeWithTimeoutBudget<T>(
  operation: PayoutOperationType,
  fn: (
    signal: AbortSignal,
    phaseNotifier?: { markConnected: () => void },
  ) => Promise<T>,
  options: {
    budget?: Partial<OperationTimeoutBudget>;
    reference?: string;
  } = {},
): Promise<T> {
  const budget: OperationTimeoutBudget = {
    ...DEFAULT_TIMEOUT_BUDGETS[operation],
    ...options.budget,
  };

  const startTime = Date.now();
  let retriesAttempted = 0;

  while (true) {
    const elapsedTotal = Date.now() - startTime;
    const remainingTotal = budget.totalDeadlineMs - elapsedTotal;

    if (remainingTotal <= 0) {
      const outcome: TimeoutOutcome =
        operation === 'initiate' ? 'ambiguous' : 'known';
      throw new ProviderTimeoutError(
        operation,
        outcome,
        'total',
        elapsedTotal,
        retriesAttempted,
        options.reference,
      );
    }

    const controller = new AbortController();
    let isConnected = false;
    let timedOutPhase: 'connect' | 'response' | 'total' | null = null;

    const markConnected = () => {
      isConnected = true;
    };

    // Connect timeout: triggers if connection is not established in time
    const connectTimer = setTimeout(
      () => {
        if (!isConnected) {
          timedOutPhase = 'connect';
          controller.abort(
            new Error(`Connect timeout after ${budget.connectTimeoutMs}ms`),
          );
        }
      },
      Math.min(budget.connectTimeoutMs, remainingTotal),
    );

    // Response timeout: triggers if total single-attempt response exceeds deadline
    const attemptDeadline = Math.min(
      budget.connectTimeoutMs + budget.responseTimeoutMs,
      remainingTotal,
    );
    const responseTimer = setTimeout(() => {
      if (!timedOutPhase) {
        timedOutPhase = isConnected ? 'response' : 'connect';
        controller.abort(
          new Error(`Response timeout after ${attemptDeadline}ms`),
        );
      }
    }, attemptDeadline);

    try {
      const result = await fn(controller.signal, { markConnected });
      clearTimeout(connectTimer);
      clearTimeout(responseTimer);
      return result;
    } catch (err: unknown) {
      clearTimeout(connectTimer);
      clearTimeout(responseTimer);

      const isAbort =
        (err instanceof Error && err.name === 'AbortError') ||
        controller.signal.aborted;

      const duration = Date.now() - startTime;

      if (isAbort || timedOutPhase) {
        const phase = timedOutPhase || (isConnected ? 'response' : 'connect');
        let outcome: TimeoutOutcome = 'known';

        if (operation === 'initiate') {
          // If connection was established before abort or response timed out,
          // the transfer state on the provider is ambiguous!
          outcome = phase === 'connect' ? 'rejected' : 'ambiguous';
        } else {
          outcome = phase === 'connect' ? 'rejected' : 'known';
        }

        // If idempotent and retries remain, and within total budget, retry
        if (
          budget.isIdempotent &&
          retriesAttempted < budget.maxRetries &&
          Date.now() - startTime + budget.connectTimeoutMs <
            budget.totalDeadlineMs
        ) {
          retriesAttempted++;
          continue;
        }

        if (operation === 'initiate' && outcome === 'ambiguous') {
          throw new AmbiguousInitiationError(
            options.reference || 'unknown',
            duration,
          );
        }

        throw new ProviderTimeoutError(
          operation,
          outcome,
          phase,
          duration,
          retriesAttempted,
          options.reference,
        );
      }

      // Non-timeout errors: if idempotent and network error occurred, retry if budget allows
      if (
        budget.isIdempotent &&
        retriesAttempted < budget.maxRetries &&
        Date.now() - startTime + budget.connectTimeoutMs <
          budget.totalDeadlineMs
      ) {
        retriesAttempted++;
        continue;
      }

      throw err;
    }
  }
}

/**
 * Sanitizes errors for safe external consumption without exposing
 * internal tokens, stack traces, or credentials.
 */
export function sanitizeProviderError(
  error: unknown,
  operation: PayoutOperationType,
  reference?: string,
): {
  success: false;
  code: string;
  message: string;
  outcome?: TimeoutOutcome;
  diagnostics?: SanitizedDiagnostics;
} {
  if (error instanceof ProviderTimeoutError) {
    return {
      success: false,
      code: error.code,
      message:
        error.outcome === 'ambiguous'
          ? 'Transfer request timed out while processing. Please do not retry; status will be reconciled automatically.'
          : 'Service is temporarily unavailable due to a timeout. Please try again shortly.',
      outcome: error.outcome,
      diagnostics: error.diagnostics,
    };
  }

  if (error instanceof AmbiguousInitiationError) {
    return {
      success: false,
      code: error.code,
      message:
        'Transfer initiation response timed out. The transfer may have been initiated. Blind retries are blocked to prevent duplicate transfers.',
      outcome: 'ambiguous',
      diagnostics: error.diagnostics,
    };
  }

  const rawMessage = error instanceof Error ? error.message : 'Unknown error';
  // Strip any accidental secret keys or URLs from messages
  const sanitizedMessage = rawMessage
    .replace(/sk_(live|test)_[a-zA-Z0-9]+/g, '[REDACTED_KEY]')
    .replace(/Bearer\s+[^\s]+/gi, 'Bearer [REDACTED]')
    .replace(/https?:\/\/[^\s]+/g, '[EXTERNAL_ENDPOINT]');

  return {
    success: false,
    code: 'PROVIDER_ERROR',
    message: sanitizedMessage,
    diagnostics: {
      operation,
      outcome: 'known',
      errorCode: 'PROVIDER_ERROR',
      phase: 'execution',
      durationMs: 0,
      retriesAttempted: 0,
      timestamp: new Date().toISOString(),
      reference,
    },
  };
}
