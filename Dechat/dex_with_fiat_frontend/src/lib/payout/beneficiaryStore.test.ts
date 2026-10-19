import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _injectCommitFailureOnce,
  clearBeneficiaryStore,
  deriveBeneficiaryDedupeKey,
  getBeneficiaryByDedupeKey,
  getOrCreateBeneficiary,
  maskAccountNumber,
} from './beneficiaryStore';

vi.mock('server-only', () => ({}));

describe('beneficiaryStore', () => {
  beforeEach(() => {
    clearBeneficiaryStore();
    vi.clearAllMocks();
  });

  describe('deriveBeneficiaryDedupeKey and maskAccountNumber', () => {
    it('creates a privacy-preserving hash without exposing raw account number', () => {
      const accountNumber = '0123456789';
      const key = deriveBeneficiaryDedupeKey({
        accountNumber,
        bankCode: '058',
        userScope: 'user_123',
      });

      expect(key).toMatch(/^bdk_[a-f0-9]{64}$/);
      expect(key).not.toContain(accountNumber);
    });

    it('normalizes account number with dashes, spaces, and case', () => {
      const key1 = deriveBeneficiaryDedupeKey({
        accountNumber: '012-345-6789',
        bankCode: '058',
        userScope: 'USER_ABC',
        currency: 'ngn',
      });

      const key2 = deriveBeneficiaryDedupeKey({
        accountNumber: ' 0123456789 ',
        bankCode: '058 ',
        userScope: 'user_abc',
        currency: 'NGN',
      });

      expect(key1).toBe(key2);
    });

    it('isolates different user scopes even with same account details', () => {
      const keyUserA = deriveBeneficiaryDedupeKey({
        accountNumber: '0123456789',
        bankCode: '058',
        userScope: 'user_A',
      });
      const keyUserB = deriveBeneficiaryDedupeKey({
        accountNumber: '0123456789',
        bankCode: '058',
        userScope: 'user_B',
      });

      expect(keyUserA).not.toBe(keyUserB);
    });

    it('masks account number safely preserving only last 4 digits', () => {
      expect(maskAccountNumber('0123456789')).toBe('******6789');
      expect(maskAccountNumber('123')).toBe('****');
    });
  });

  describe('race-safe beneficiary resolution and provider reuse', () => {
    it('creates recipient on first request and reuses reference on second request', async () => {
      const mockProvider = vi.fn().mockResolvedValue({
        recipient_code: 'RCP_test_123',
        name: 'John Doe',
      });

      const input = {
        name: 'John Doe',
        accountNumber: '0123456789',
        bankCode: '058',
        userScope: 'user_1',
      };

      const res1 = await getOrCreateBeneficiary(input, mockProvider);
      expect(res1.recipientCode).toBe('RCP_test_123');
      expect(res1.reused).toBe(false);
      expect(mockProvider).toHaveBeenCalledTimes(1);

      // Second identical request
      const res2 = await getOrCreateBeneficiary(input, mockProvider);
      expect(res2.recipientCode).toBe('RCP_test_123');
      expect(res2.reused).toBe(true);
      // Provider must NOT be called again
      expect(mockProvider).toHaveBeenCalledTimes(1);

      // Verify persistent record
      const stored = getBeneficiaryByDedupeKey(res1.dedupeKey);
      expect(stored).toBeDefined();
      expect(stored?.recipientCode).toBe('RCP_test_123');
      expect(stored?.accountNumberMasked).toBe('******6789');
    });

    it('handles concurrent race conditions by coalescing in-flight requests', async () => {
      let resolveProvider!: (value: {
        recipient_code: string;
        name: string;
      }) => void;
      const mockProvider = vi.fn().mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveProvider = resolve;
          }),
      );

      const input = {
        name: 'Ada Lovelace',
        accountNumber: '9876543210',
        bankCode: '033',
        userScope: 'user_concurrent',
      };

      // Launch 5 concurrent requests simultaneously
      const requests = [
        getOrCreateBeneficiary(input, mockProvider),
        getOrCreateBeneficiary(input, mockProvider),
        getOrCreateBeneficiary(input, mockProvider),
        getOrCreateBeneficiary(input, mockProvider),
        getOrCreateBeneficiary(input, mockProvider),
      ];

      // Simulate provider latency
      resolveProvider({
        recipient_code: 'RCP_concurrent_safe',
        name: 'Ada Lovelace',
      });

      const results = await Promise.all(requests);

      // Provider was only called ONCE despite 5 concurrent requests
      expect(mockProvider).toHaveBeenCalledTimes(1);

      // All 5 returned the exact same recipient code
      results.forEach((r) => {
        expect(r.recipientCode).toBe('RCP_concurrent_safe');
      });

      // Exactly one was the primary creator, others were reused
      const nonReused = results.filter((r) => !r.reused);
      const reused = results.filter((r) => r.reused);
      expect(nonReused).toHaveLength(1);
      expect(reused).toHaveLength(4);
    });
  });

  describe('idempotent recovery path after local persistence failure', () => {
    it('recovers provider reference without creating duplicate recipient when local commit fails', async () => {
      const mockProvider = vi.fn().mockResolvedValue({
        recipient_code: 'RCP_recovered_reference',
        name: 'Grace Hopper',
      });

      const input = {
        name: 'Grace Hopper',
        accountNumber: '5554443322',
        bankCode: '011',
        userScope: 'user_recovery_test',
      };

      // Injected failure: remote provider succeeds, but local commit throws error
      _injectCommitFailureOnce();

      // First attempt: provider succeeds, but local commit throws
      await expect(getOrCreateBeneficiary(input, mockProvider)).rejects.toThrow(
        /simulated storage write error/,
      );
      expect(mockProvider).toHaveBeenCalledTimes(1);

      // Local store should not have committed the broken record yet
      const dedupeKey = deriveBeneficiaryDedupeKey(input);
      expect(getBeneficiaryByDedupeKey(dedupeKey)).toBeUndefined();

      // Retry / Second attempt: recovery path activates
      const recovered = await getOrCreateBeneficiary(input, mockProvider);
      expect(recovered.recipientCode).toBe('RCP_recovered_reference');
      expect(recovered.reused).toBe(true);
      expect(recovered.recovered).toBe(true);

      // Critical: Provider was NOT called a second time! No duplicate created at provider
      expect(mockProvider).toHaveBeenCalledTimes(1);

      // Record is now successfully committed to store
      const committed = getBeneficiaryByDedupeKey(dedupeKey);
      expect(committed).toBeDefined();
      expect(committed?.recipientCode).toBe('RCP_recovered_reference');
    });
  });
});
