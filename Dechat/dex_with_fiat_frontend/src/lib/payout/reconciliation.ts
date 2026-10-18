import {
  getAllTransfers,
  getTransferStatus,
  setTransferStatus,
  TransferStatusRecord,
} from '@/lib/transferStore';
import { getPayoutProvider } from './providers/registry';
import type { PayoutProvider } from './providers/types';
import { isProviderOutage } from './circuitBreaker';
import { telemetry } from '@/lib/telemetry';

export type PayoutStatus =
  'pending' | 'success' | 'failed' | 'reversed' | 'cancelled';

export const TERMINAL_PAYOUT_STATUSES: readonly PayoutStatus[] = [
  'success',
  'failed',
  'reversed',
  'cancelled',
] as const;

export interface ReconciliationConfig {
  staleAgeMs?: number; // Minimum age to consider a pending transfer stale (default: 5m)
  batchSize?: number; // Maximum records per reconciliation run (bounded, default: 50, max: 100)
  baseRetryDelayMs?: number; // Base delay for next retry backoff (default: 60s)
  maxRetryDelayMs?: number; // Maximum delay cap (default: 1 hour)
  clock?: () => number;
}

export interface ReconciliationSingleResult {
  reference: string;
  previousStatus: PayoutStatus;
  newStatus: PayoutStatus;
  result:
    | 'transitioned'
    | 'no_change'
    | 'provider_unavailable'
    | 'invalid_transition'
    | 'error';
  attempts: number;
  nextRetryAt?: number;
  error?: string;
}

export interface ReconciliationBatchResult {
  processed: number;
  transitioned: number;
  noChange: number;
  providerUnavailable: number;
  errors: number;
  results: ReconciliationSingleResult[];
  timestamp: number;
}

export function isTerminalStatus(status: string): boolean {
  return TERMINAL_PAYOUT_STATUSES.includes(status as PayoutStatus);
}

/**
 * Validates state-machine transitions.
 * Terminal states cannot transition to any other state.
 * Pending state can transition to success, failed, reversed, cancelled, or remain pending.
 */
export function isValidPayoutTransition(
  from: PayoutStatus,
  to: PayoutStatus,
): boolean {
  if (isTerminalStatus(from)) {
    return false;
  }

  if (from === 'pending') {
    return ['pending', 'success', 'failed', 'reversed', 'cancelled'].includes(
      to,
    );
  }

  return false;
}

export function normalizeProviderStatus(
  providerRawStatus: unknown,
): PayoutStatus {
  if (typeof providerRawStatus !== 'string') {
    return 'pending';
  }

  const normalized = providerRawStatus.trim().toLowerCase();

  switch (normalized) {
    case 'success':
    case 'successful':
    case 'completed':
      return 'success';
    case 'failed':
    case 'rejected':
      return 'failed';
    case 'reversed':
      return 'reversed';
    case 'cancelled':
    case 'canceled':
      return 'cancelled';
    case 'pending':
    case 'processing':
    case 'queued':
    case 'received':
    default:
      return 'pending';
  }
}

/**
 * Filters and selects stale records from storage.
 * - Must be in pending state (non-terminal).
 * - Must be older than staleAgeMs.
 * - If nextRetryAt is set, current time must be >= nextRetryAt.
 * - Bounded by batchSize.
 */
export function selectStalePayouts(
  records: TransferStatusRecord[],
  config: ReconciliationConfig = {},
): TransferStatusRecord[] {
  const staleAgeMs = config.staleAgeMs ?? 5 * 60 * 1000;
  const batchSize = Math.min(Math.max(1, config.batchSize ?? 50), 100);
  const now = config.clock ? config.clock() : Date.now();

  const staleRecords: TransferStatusRecord[] = [];

  for (const record of records) {
    // 1. Skip terminal records
    if (isTerminalStatus(record.status)) {
      continue;
    }

    // Determine timestamp of record
    const recordTimestamp =
      record.updatedAtMs ?? new Date(record.updatedAt).getTime();

    // 2. Skip recently updated records
    const age = now - recordTimestamp;
    if (age < staleAgeMs) {
      continue;
    }

    // 3. Skip records whose scheduled nextRetryAt is in the future
    if (record.nextRetryAt && now < record.nextRetryAt) {
      continue;
    }

    staleRecords.push(record);
    if (staleRecords.length >= batchSize) {
      break;
    }
  }

  return staleRecords;
}

export function calculateNextRetry(
  attempts: number,
  currentTime: number,
  baseRetryDelayMs: number = 60_000,
  maxRetryDelayMs: number = 60 * 60 * 1000,
): number {
  // Exponential backoff: base * 2^(attempts - 1)
  const multiplier = Math.pow(2, Math.max(0, attempts - 1));
  const delay = Math.min(baseRetryDelayMs * multiplier, maxRetryDelayMs);
  return currentTime + delay;
}

/**
 * Reconciles a single stale payout record with the authoritative provider.
 * NEVER creates a new transfer; only queries status.
 */
export async function reconcileSinglePayout(
  record: TransferStatusRecord,
  provider: PayoutProvider,
  config: ReconciliationConfig = {},
): Promise<ReconciliationSingleResult> {
  const now = config.clock ? config.clock() : Date.now();
  const attempts = (record.reconciliationAttempts ?? 0) + 1;
  const baseDelay = config.baseRetryDelayMs ?? 60_000;
  const maxDelay = config.maxRetryDelayMs ?? 60 * 60 * 1000;
  const isoNow = new Date(now).toISOString();

  // Guard: Never reconcile already terminal records
  if (isTerminalStatus(record.status)) {
    return {
      reference: record.reference,
      previousStatus: record.status,
      newStatus: record.status,
      result: 'no_change',
      attempts: record.reconciliationAttempts ?? 0,
    };
  }

  try {
    // Query authoritative provider status without creating any new transfer
    const providerResult = await provider.checkTransferStatus({
      reference: record.reference,
    });

    const rawStatus =
      (providerResult?.status as unknown) ||
      (providerResult?.data as Record<string, unknown> | undefined)?.status;

    const authoritativeStatus = normalizeProviderStatus(rawStatus);

    // Validate state-machine transition
    if (
      authoritativeStatus !== record.status &&
      !isValidPayoutTransition(record.status, authoritativeStatus)
    ) {
      setTransferStatus({
        ...record,
        reconciliationAttempts: attempts,
        lastReconciledAt: isoNow,
        lastReconciliationResult: 'invalid_transition',
        nextRetryAt: calculateNextRetry(attempts, now, baseDelay, maxDelay),
      });

      return {
        reference: record.reference,
        previousStatus: record.status,
        newStatus: record.status,
        result: 'invalid_transition',
        attempts,
        nextRetryAt: calculateNextRetry(attempts, now, baseDelay, maxDelay),
        error: `Invalid state transition from ${record.status} to ${authoritativeStatus}`,
      };
    }

    const hasTransitioned = authoritativeStatus !== record.status;
    const isNowTerminal = isTerminalStatus(authoritativeStatus);

    const updatedRecord: TransferStatusRecord = {
      ...record,
      status: authoritativeStatus,
      updatedAt: isoNow,
      updatedAtMs: now,
      reconciliationAttempts: attempts,
      lastReconciledAt: isoNow,
      lastReconciliationResult: hasTransitioned ? 'transitioned' : 'no_change',
      // If still pending, schedule next retry. If terminal, no next retry.
      nextRetryAt: isNowTerminal
        ? undefined
        : calculateNextRetry(attempts, now, baseDelay, maxDelay),
    };

    setTransferStatus(updatedRecord);

    telemetry.addLog(
      'reconciliation',
      'info',
      `Reconciled payout ${record.reference}`,
      {
        reference: record.reference,
        from: record.status,
        to: authoritativeStatus,
        attempts,
      },
    );

    return {
      reference: record.reference,
      previousStatus: record.status,
      newStatus: authoritativeStatus,
      result: hasTransitioned ? 'transitioned' : 'no_change',
      attempts,
      nextRetryAt: updatedRecord.nextRetryAt,
    };
  } catch (error) {
    const isOutage = isProviderOutage(error);
    const resultType = isOutage ? 'provider_unavailable' : 'error';
    const nextRetry = calculateNextRetry(attempts, now, baseDelay, maxDelay);

    setTransferStatus({
      ...record,
      reconciliationAttempts: attempts,
      lastReconciledAt: isoNow,
      lastReconciliationResult: resultType,
      nextRetryAt: nextRetry,
    });

    telemetry.addLog(
      'reconciliation',
      'warn',
      `Reconciliation attempt failed for ${record.reference}`,
      {
        reference: record.reference,
        isOutage,
        error: error instanceof Error ? error.message : String(error),
        nextRetryAt: nextRetry,
      },
    );

    return {
      reference: record.reference,
      previousStatus: record.status,
      newStatus: record.status,
      result: resultType,
      attempts,
      nextRetryAt: nextRetry,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Reconcile a batch of stale payouts from storage.
 */
export async function reconcileStalePayouts(
  config: ReconciliationConfig & { provider?: PayoutProvider } = {},
): Promise<ReconciliationBatchResult> {
  const provider = config.provider ?? getPayoutProvider();
  const allRecords = getAllTransfers();
  const staleRecords = selectStalePayouts(allRecords, config);
  const now = config.clock ? config.clock() : Date.now();

  const results: ReconciliationSingleResult[] = [];
  let transitioned = 0;
  let noChange = 0;
  let providerUnavailable = 0;
  let errors = 0;

  for (const record of staleRecords) {
    const res = await reconcileSinglePayout(record, provider, config);
    results.push(res);

    switch (res.result) {
      case 'transitioned':
        transitioned++;
        break;
      case 'no_change':
        noChange++;
        break;
      case 'provider_unavailable':
        providerUnavailable++;
        break;
      case 'error':
      case 'invalid_transition':
        errors++;
        break;
    }
  }

  return {
    processed: staleRecords.length,
    transitioned,
    noChange,
    providerUnavailable,
    errors,
    results,
    timestamp: now,
  };
}
