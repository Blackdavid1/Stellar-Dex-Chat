import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  savePendingRecoveryRecord,
  getPendingRecoveryRecord,
  clearPendingRecoveryRecord,
  lookupTransactionStatus,
  PENDING_TX_STORAGE_KEY,
  RECOVERY_RETENTION_PERIOD_MS,
  type PendingRecoveryRecord,
} from './transactionRecovery';
import { server, rpc } from './stellarContract';

vi.mock('./stellarContract', () => ({
  server: {
    getTransaction: vi.fn(),
    sendTransaction: vi.fn(),
  },
  rpc: {
    Api: {
      GetTransactionStatus: {
        SUCCESS: 'SUCCESS',
        FAILED: 'FAILED',
        NOT_FOUND: 'NOT_FOUND',
      },
    },
  },
}));

describe('Transaction Recovery Manager', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
  });

  const sampleRecord: PendingRecoveryRecord = {
    hash: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    operation: 'deposit',
    amount: '50.5',
    amountStroops: '505000000',
    network: 'Test SDF Network ; September 2015',
    account: 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFDAGORAcct1',
    timestamp: Date.now(),
    stage: 'pending_confirmation',
    idempotencyKey: 'idemp-12345',
  };

  it('persists only non-secret bounded metadata into localStorage', () => {
    savePendingRecoveryRecord(sampleRecord);
    const storedRaw = localStorage.getItem(PENDING_TX_STORAGE_KEY);
    expect(storedRaw).toBeTruthy();

    const parsed = JSON.parse(storedRaw!);
    expect(parsed.hash).toBe(sampleRecord.hash);
    expect(parsed.amount).toBe('50.5');
    expect(parsed.secretKey).toBeUndefined();
    expect(parsed.privateKey).toBeUndefined();
  });

  it('retrieves active unexpired records', () => {
    savePendingRecoveryRecord(sampleRecord);
    const retrieved = getPendingRecoveryRecord(sampleRecord.timestamp + 1000);
    expect(retrieved).not.toBeNull();
    expect(retrieved?.hash).toBe(sampleRecord.hash);
  });

  it('expires and removes records older than the 24-hour retention period', () => {
    savePendingRecoveryRecord(sampleRecord);
    const pastRetention = sampleRecord.timestamp + RECOVERY_RETENTION_PERIOD_MS + 1000;
    const retrieved = getPendingRecoveryRecord(pastRetention);
    expect(retrieved).toBeNull();
    expect(localStorage.getItem(PENDING_TX_STORAGE_KEY)).toBeNull();
  });

  it('clears record on explicit terminal clear', () => {
    savePendingRecoveryRecord(sampleRecord);
    clearPendingRecoveryRecord();
    expect(localStorage.getItem(PENDING_TX_STORAGE_KEY)).toBeNull();
  });

  describe('lookupTransactionStatus', () => {
    it('identifies confirmed transactions without re-submitting', async () => {
      vi.mocked(server.getTransaction).mockResolvedValueOnce({
        status: rpc.Api.GetTransactionStatus.SUCCESS,
      } as any);

      const outcome = await lookupTransactionStatus(sampleRecord.hash);
      expect(outcome).toBe('confirmed');
      expect(server.getTransaction).toHaveBeenCalledWith(sampleRecord.hash);
      // Ensure sendTransaction was never called!
      expect(server.sendTransaction).not.toHaveBeenCalled();
    });

    it('identifies pending transactions without re-submitting', async () => {
      vi.mocked(server.getTransaction).mockResolvedValueOnce({
        status: rpc.Api.GetTransactionStatus.NOT_FOUND,
      } as any);

      const outcome = await lookupTransactionStatus(sampleRecord.hash);
      expect(outcome).toBe('pending');
      expect(server.sendTransaction).not.toHaveBeenCalled();
    });

    it('identifies failed transactions without re-submitting', async () => {
      vi.mocked(server.getTransaction).mockResolvedValueOnce({
        status: rpc.Api.GetTransactionStatus.FAILED,
      } as any);

      const outcome = await lookupTransactionStatus(sampleRecord.hash);
      expect(outcome).toBe('failed');
      expect(server.sendTransaction).not.toHaveBeenCalled();
    });

    it('identifies unknown status when RPC throws a network error', async () => {
      vi.mocked(server.getTransaction).mockRejectedValueOnce(new Error('Network error / 503 Service Unavailable'));

      const outcome = await lookupTransactionStatus(sampleRecord.hash);
      expect(outcome).toBe('unknown');
      expect(server.sendTransaction).not.toHaveBeenCalled();
    });
  });
});
