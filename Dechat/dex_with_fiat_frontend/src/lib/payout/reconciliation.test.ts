import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearTransferStore,
  getTransferStatus,
  setTransferStatus,
  TransferStatusRecord,
} from '@/lib/transferStore';
import {
  calculateNextRetry,
  isValidPayoutTransition,
  reconcileSinglePayout,
  reconcileStalePayouts,
  selectStalePayouts,
} from './reconciliation';
import type { PayoutProvider } from './providers/types';

vi.mock('server-only', () => ({}));

describe('Payout Reconciliation', () => {
  beforeEach(() => {
    clearTransferStore();
    vi.clearAllMocks();
  });

  describe('State Machine Transitions', () => {
    it('allows valid transitions from pending to terminal states and pending', () => {
      expect(isValidPayoutTransition('pending', 'success')).toBe(true);
      expect(isValidPayoutTransition('pending', 'failed')).toBe(true);
      expect(isValidPayoutTransition('pending', 'reversed')).toBe(true);
      expect(isValidPayoutTransition('pending', 'cancelled')).toBe(true);
      expect(isValidPayoutTransition('pending', 'pending')).toBe(true);
    });

    it('rejects any transition from a terminal state', () => {
      expect(isValidPayoutTransition('success', 'failed')).toBe(false);
      expect(isValidPayoutTransition('success', 'pending')).toBe(false);
      expect(isValidPayoutTransition('failed', 'success')).toBe(false);
      expect(isValidPayoutTransition('reversed', 'success')).toBe(false);
      expect(isValidPayoutTransition('cancelled', 'success')).toBe(false);
    });
  });

  describe('selectStalePayouts with fake clock', () => {
    const FAKE_NOW = 1_000_000;
    const FIVE_MINS = 5 * 60 * 1000;

    it('selects pending records older than staleAgeMs', () => {
      const staleRecord: TransferStatusRecord = {
        reference: 'tx_stale',
        status: 'pending',
        amount: 100,
        updatedAt: new Date(FAKE_NOW - FIVE_MINS - 1000).toISOString(),
        updatedAtMs: FAKE_NOW - FIVE_MINS - 1000,
      };

      const selected = selectStalePayouts([staleRecord], {
        clock: () => FAKE_NOW,
        staleAgeMs: FIVE_MINS,
      });

      expect(selected).toHaveLength(1);
      expect(selected[0].reference).toBe('tx_stale');
    });

    it('skips recently updated pending records', () => {
      const recentRecord: TransferStatusRecord = {
        reference: 'tx_recent',
        status: 'pending',
        amount: 100,
        updatedAt: new Date(FAKE_NOW - 1000).toISOString(),
        updatedAtMs: FAKE_NOW - 1000,
      };

      const selected = selectStalePayouts([recentRecord], {
        clock: () => FAKE_NOW,
        staleAgeMs: FIVE_MINS,
      });

      expect(selected).toHaveLength(0);
    });

    it('skips terminal records even if they are older than staleAgeMs', () => {
      const successRecord: TransferStatusRecord = {
        reference: 'tx_success',
        status: 'success',
        amount: 100,
        updatedAt: new Date(FAKE_NOW - FIVE_MINS - 10_000).toISOString(),
        updatedAtMs: FAKE_NOW - FIVE_MINS - 10_000,
      };
      const failedRecord: TransferStatusRecord = {
        reference: 'tx_failed',
        status: 'failed',
        amount: 100,
        updatedAt: new Date(FAKE_NOW - FIVE_MINS - 10_000).toISOString(),
        updatedAtMs: FAKE_NOW - FIVE_MINS - 10_000,
      };

      const selected = selectStalePayouts([successRecord, failedRecord], {
        clock: () => FAKE_NOW,
        staleAgeMs: FIVE_MINS,
      });

      expect(selected).toHaveLength(0);
    });

    it('skips records whose scheduled nextRetryAt is in the future', () => {
      const pendingRetryInFuture: TransferStatusRecord = {
        reference: 'tx_future_retry',
        status: 'pending',
        amount: 100,
        updatedAt: new Date(FAKE_NOW - FIVE_MINS - 1000).toISOString(),
        updatedAtMs: FAKE_NOW - FIVE_MINS - 1000,
        nextRetryAt: FAKE_NOW + 30_000, // 30s in future
      };

      const selected = selectStalePayouts([pendingRetryInFuture], {
        clock: () => FAKE_NOW,
        staleAgeMs: FIVE_MINS,
      });

      expect(selected).toHaveLength(0);
    });

    it('respects bounded batch size', () => {
      const records: TransferStatusRecord[] = Array.from({ length: 10 }).map(
        (_, i) => ({
          reference: `tx_${i}`,
          status: 'pending',
          amount: 50,
          updatedAt: new Date(FAKE_NOW - FIVE_MINS - 5000).toISOString(),
          updatedAtMs: FAKE_NOW - FIVE_MINS - 5000,
        }),
      );

      const selected = selectStalePayouts(records, {
        clock: () => FAKE_NOW,
        batchSize: 3,
      });

      expect(selected).toHaveLength(3);
    });
  });

  describe('reconcileSinglePayout with fake clock and provider mocks', () => {
    const FAKE_NOW = 2_000_000;

    const createMockProvider = (
      checkStatusImpl: (ref: string) => Promise<any>,
    ): PayoutProvider => ({
      name: 'paystack',
      verifyAccount: vi.fn(),
      createRecipient: vi.fn(),
      initiateTransfer: vi.fn(), // MUST NOT BE CALLED
      checkTransferStatus: vi.fn().mockImplementation(checkStatusImpl),
    });

    it('updates pending transfer to success on authoritative provider success', async () => {
      const mockProvider = createMockProvider(async (ref) => ({
        status: 'success',
        reference: ref,
      }));

      const record: TransferStatusRecord = {
        reference: 'tx_reconcile_success',
        status: 'pending',
        amount: 250,
        updatedAt: new Date(FAKE_NOW - 400_000).toISOString(),
        updatedAtMs: FAKE_NOW - 400_000,
      };
      setTransferStatus(record);

      const result = await reconcileSinglePayout(record, mockProvider, {
        clock: () => FAKE_NOW,
      });

      expect(result.result).toBe('transitioned');
      expect(result.previousStatus).toBe('pending');
      expect(result.newStatus).toBe('success');
      expect(result.attempts).toBe(1);
      expect(mockProvider.checkTransferStatus).toHaveBeenCalledWith({
        reference: 'tx_reconcile_success',
      });
      // CRITICAL: verify initiateTransfer was never called
      expect(mockProvider.initiateTransfer).not.toHaveBeenCalled();

      // Check updated store record
      const stored = getTransferStatus('tx_reconcile_success');
      expect(stored?.status).toBe('success');
      expect(stored?.reconciliationAttempts).toBe(1);
      expect(stored?.lastReconciliationResult).toBe('transitioned');
      expect(stored?.nextRetryAt).toBeUndefined(); // terminal status, no next retry
    });

    it('updates pending transfer to failed on provider failure', async () => {
      const mockProvider = createMockProvider(async (ref) => ({
        data: { status: 'failed', reference: ref },
      }));

      const record: TransferStatusRecord = {
        reference: 'tx_reconcile_failed',
        status: 'pending',
        amount: 150,
        updatedAt: new Date(FAKE_NOW - 400_000).toISOString(),
        updatedAtMs: FAKE_NOW - 400_000,
      };
      setTransferStatus(record);

      const result = await reconcileSinglePayout(record, mockProvider, {
        clock: () => FAKE_NOW,
      });

      expect(result.result).toBe('transitioned');
      expect(result.newStatus).toBe('failed');
      expect(mockProvider.initiateTransfer).not.toHaveBeenCalled();

      const stored = getTransferStatus('tx_reconcile_failed');
      expect(stored?.status).toBe('failed');
    });

    it('records provider unavailable and schedules exponential nextRetryAt without crashing', async () => {
      const outageError = { isAxiosError: true, response: { status: 503 } };
      const mockProvider = createMockProvider(async () => {
        throw outageError;
      });

      const record: TransferStatusRecord = {
        reference: 'tx_outage',
        status: 'pending',
        amount: 300,
        reconciliationAttempts: 1,
        updatedAt: new Date(FAKE_NOW - 400_000).toISOString(),
        updatedAtMs: FAKE_NOW - 400_000,
      };
      setTransferStatus(record);

      const result = await reconcileSinglePayout(record, mockProvider, {
        clock: () => FAKE_NOW,
        baseRetryDelayMs: 60_000,
      });

      expect(result.result).toBe('provider_unavailable');
      expect(result.newStatus).toBe('pending');
      expect(result.attempts).toBe(2);
      // Attempt 2 backoff: 60_000 * 2^(2 - 1) = 120_000
      expect(result.nextRetryAt).toBe(FAKE_NOW + 120_000);

      const stored = getTransferStatus('tx_outage');
      expect(stored?.status).toBe('pending');
      expect(stored?.reconciliationAttempts).toBe(2);
      expect(stored?.lastReconciliationResult).toBe('provider_unavailable');
      expect(stored?.nextRetryAt).toBe(FAKE_NOW + 120_000);
    });

    it('keeps pending state and schedules next retry if provider still reports pending', async () => {
      const mockProvider = createMockProvider(async () => ({
        status: 'pending',
      }));

      const record: TransferStatusRecord = {
        reference: 'tx_still_pending',
        status: 'pending',
        amount: 75,
        updatedAt: new Date(FAKE_NOW - 400_000).toISOString(),
        updatedAtMs: FAKE_NOW - 400_000,
      };
      setTransferStatus(record);

      const result = await reconcileSinglePayout(record, mockProvider, {
        clock: () => FAKE_NOW,
        baseRetryDelayMs: 30_000,
      });

      expect(result.result).toBe('no_change');
      expect(result.newStatus).toBe('pending');
      expect(result.attempts).toBe(1);
      expect(result.nextRetryAt).toBe(FAKE_NOW + 30_000);
    });
  });

  describe('reconcileStalePayouts batch processing', () => {
    it('processes stale records and aggregates batch result', async () => {
      const FAKE_NOW = 3_000_000;
      const mockProvider: PayoutProvider = {
        name: 'paystack',
        verifyAccount: vi.fn(),
        createRecipient: vi.fn(),
        initiateTransfer: vi.fn(),
        checkTransferStatus: vi
          .fn()
          .mockImplementation(async ({ reference }) => {
            if (reference === 'stale_success') return { status: 'success' };
            if (reference === 'stale_failed') return { status: 'failed' };
            throw { isAxiosError: true, response: { status: 500 } };
          }),
      };

      setTransferStatus({
        reference: 'stale_success',
        status: 'pending',
        amount: 100,
        updatedAt: new Date(FAKE_NOW - 600_000).toISOString(),
        updatedAtMs: FAKE_NOW - 600_000,
      });
      setTransferStatus({
        reference: 'stale_failed',
        status: 'pending',
        amount: 200,
        updatedAt: new Date(FAKE_NOW - 600_000).toISOString(),
        updatedAtMs: FAKE_NOW - 600_000,
      });
      setTransferStatus({
        reference: 'stale_error',
        status: 'pending',
        amount: 300,
        updatedAt: new Date(FAKE_NOW - 600_000).toISOString(),
        updatedAtMs: FAKE_NOW - 600_000,
      });
      setTransferStatus({
        reference: 'already_terminal',
        status: 'success',
        amount: 400,
        updatedAt: new Date(FAKE_NOW - 600_000).toISOString(),
        updatedAtMs: FAKE_NOW - 600_000,
      });

      const batchSummary = await reconcileStalePayouts({
        provider: mockProvider,
        clock: () => FAKE_NOW,
      });

      expect(batchSummary.processed).toBe(3); // 'already_terminal' was skipped
      expect(batchSummary.transitioned).toBe(2);
      expect(batchSummary.providerUnavailable).toBe(1);
    });
  });
});
