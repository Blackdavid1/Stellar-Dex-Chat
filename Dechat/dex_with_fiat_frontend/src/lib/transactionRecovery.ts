/**
 * @fileoverview Pending Soroban transaction recovery manager.
 *
 * Preserves transaction intent and recovery metadata across page refreshes and tab closures.
 * Resumes on-chain status lookup upon reload without ever submitting duplicate transactions.
 * Persists only bounded, non-secret identifiers with a documented 24-hour retention policy.
 */

import { server, rpc } from './stellarContract';

/**
 * Storage key in localStorage for pending recovery records.
 */
export const PENDING_TX_STORAGE_KEY = 'stellar_pending_tx';

/**
 * Documented retention period for unconfirmed recovery records: 24 hours.
 * Records older than this window are considered expired and safely cleared.
 */
export const RECOVERY_RETENTION_PERIOD_MS = 24 * 60 * 60 * 1000; // 24 hours

export type RecoveryStage = 'submitting' | 'pending_confirmation';

export type RecoveryOutcome = 'pending' | 'confirmed' | 'failed' | 'unknown';

export interface PendingRecoveryRecord {
  /** Non-secret on-chain transaction hash. */
  hash: string;
  /** Operation type ('deposit' or 'withdraw'). */
  operation: 'deposit' | 'withdraw';
  /** Human-readable asset amount string. */
  amount: string;
  /** Exact integer stroops string representation. */
  amountStroops?: string;
  /** Destination address for withdrawals (if applicable). */
  recipient?: string;
  /** Stellar network passphrase or name (e.g. 'Test SDF Network ; September 2015'). */
  network: string;
  /** User's public key (signer/sender). */
  account: string;
  /** Submission timestamp in milliseconds. */
  timestamp: number;
  /** Current lifecycle stage. */
  stage: RecoveryStage;
  /** Client idempotency key preventing duplicate dispatch. */
  idempotencyKey?: string;
}

/**
 * Persists bounded, non-secret recovery metadata to browser localStorage.
 */
export function savePendingRecoveryRecord(record: PendingRecoveryRecord): void {
  if (typeof window === 'undefined' || !window.localStorage) {
    return;
  }
  try {
    // Ensure only non-secret bounded fields are stored
    const safeRecord: PendingRecoveryRecord = {
      hash: record.hash.trim(),
      operation: record.operation,
      amount: record.amount,
      amountStroops: record.amountStroops,
      recipient: record.recipient,
      network: record.network,
      account: record.account,
      timestamp: record.timestamp || Date.now(),
      stage: record.stage,
      idempotencyKey: record.idempotencyKey,
    };
    window.localStorage.setItem(PENDING_TX_STORAGE_KEY, JSON.stringify(safeRecord));
  } catch {
    // Ignore storage quota or access errors
  }
}

/**
 * Retrieves the pending recovery record from storage, checking for retention expiry.
 * Automatically clears the record if it exceeds the 24-hour retention period.
 */
export function getPendingRecoveryRecord(now: number = Date.now()): PendingRecoveryRecord | null {
  if (typeof window === 'undefined' || !window.localStorage) {
    return null;
  }
  try {
    const raw = window.localStorage.getItem(PENDING_TX_STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const record = JSON.parse(raw) as PendingRecoveryRecord;
    if (!record || !record.hash || typeof record.timestamp !== 'number') {
      window.localStorage.removeItem(PENDING_TX_STORAGE_KEY);
      return null;
    }

    // Check retention expiry
    if (now - record.timestamp > RECOVERY_RETENTION_PERIOD_MS) {
      window.localStorage.removeItem(PENDING_TX_STORAGE_KEY);
      return null;
    }

    return record;
  } catch {
    try {
      window.localStorage.removeItem(PENDING_TX_STORAGE_KEY);
    } catch {
      // ignore
    }
    return null;
  }
}

/**
 * Clears the pending recovery record from localStorage upon reaching a terminal state.
 */
export function clearPendingRecoveryRecord(): void {
  if (typeof window === 'undefined' || !window.localStorage) {
    return;
  }
  try {
    window.localStorage.removeItem(PENDING_TX_STORAGE_KEY);
  } catch {
    // ignore
  }
}

/**
 * Resumes status lookup from the Soroban RPC network for a pending transaction.
 *
 * Crucially, this function strictly checks status and NEVER re-submits the transaction,
 * ensuring duplicate execution is completely impossible upon page reload.
 *
 * @param hash - Transaction hash to query.
 * @returns One of 'confirmed' | 'pending' | 'failed' | 'unknown'.
 */
export async function lookupTransactionStatus(hash: string): Promise<RecoveryOutcome> {
  if (!hash) {
    return 'unknown';
  }

  try {
    const response = await server.getTransaction(hash);

    if (response.status === rpc.Api.GetTransactionStatus.SUCCESS) {
      return 'confirmed';
    }

    if (response.status === rpc.Api.GetTransactionStatus.FAILED) {
      return 'failed';
    }

    if (response.status === rpc.Api.GetTransactionStatus.NOT_FOUND) {
      return 'pending';
    }

    return 'pending';
  } catch (error) {
    console.warn(`[TransactionRecovery] Network lookup failed for ${hash}:`, error);
    return 'unknown';
  }
}
