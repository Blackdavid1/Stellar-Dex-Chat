import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { PayoutRetryQueue, calculateNextBackoff } from './retryQueue';
import { PayoutAuditLedger } from './auditLedger';
import { PayoutProvider } from './providers/types';

describe('PayoutRetryQueue', () => {
  let tempDir: string;
  let auditLedger: PayoutAuditLedger;
  let retryQueue: PayoutRetryQueue;

  const mockProvider: PayoutProvider = {
    name: 'paystack',
    verifyAccount: vi.fn(),
    createRecipient: vi.fn(),
    initiateTransfer: vi.fn(),
    checkTransferStatus: vi.fn(),
  };

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'retry-queue-test-'));
    auditLedger = new PayoutAuditLedger(tempDir);
    retryQueue = new PayoutRetryQueue(
      tempDir,
      { baseDelayMs: 10, maxDelayMs: 100, maxAttempts: 3, jitterFactor: 0.1 },
      auditLedger,
    );
    vi.clearAllMocks();
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it('calculates bounded exponential backoff with jitter', () => {
    const b0 = calculateNextBackoff(
      0,
      { baseDelayMs: 100, maxDelayMs: 1000, maxAttempts: 5, jitterFactor: 0.2 },
      () => 0.5,
    );
    const b1 = calculateNextBackoff(
      1,
      { baseDelayMs: 100, maxDelayMs: 1000, maxAttempts: 5, jitterFactor: 0.2 },
      () => 0.5,
    );
    const b5 = calculateNextBackoff(
      5,
      { baseDelayMs: 100, maxDelayMs: 1000, maxAttempts: 5, jitterFactor: 0.2 },
      () => 0.5,
    );

    // attempt 0: 100 * 2^0 = 100; jitter = 100 * 0.2 * 0.5 = 10 -> 110
    expect(b0).toBe(110);
    // attempt 1: 100 * 2^1 = 200; jitter = 200 * 0.2 * 0.5 = 20 -> 220
    expect(b1).toBe(220);
    // attempt 5: capped at maxDelayMs 1000
    expect(b5).toBe(1000);
  });

  it('recovers from transient provider failures and succeeds', async () => {
    const job = retryQueue.enqueueJob({
      payoutId: 'PO-TRANSIENT',
      idempotencyKey: 'idem-transient-key',
      payload: { source: 'balance', amount: 5000, recipient: 'RCP-1' },
      initialDelayMs: 0,
    });

    expect(job.status).toBe('pending');
    expect(job.attempts).toBe(0);

    // 1st run: provider fails with 503
    vi.mocked(mockProvider.initiateTransfer).mockRejectedValueOnce(
      new Error('503 Service Unavailable'),
    );
    const res1 = await retryQueue.processDueJobs(
      mockProvider,
      Date.now() + 1000,
    );
    expect(res1.failed).toBe(1);
    expect(job.attempts).toBe(1);
    expect(job.status).toBe('pending');

    // 2nd run: provider succeeds
    vi.mocked(mockProvider.initiateTransfer).mockResolvedValueOnce({
      reference: 'idem-transient-key',
    });
    const res2 = await retryQueue.processDueJobs(
      mockProvider,
      Date.now() + 10000,
    );
    expect(res2.succeeded).toBe(1);
    expect(job.status).toBe('completed');

    // Ensure retries strictly reused the original idempotency key
    expect(mockProvider.initiateTransfer).toHaveBeenLastCalledWith(
      expect.objectContaining({ reference: 'idem-transient-key' }),
    );
  });

  it('moves exhausted jobs to inspectable dead-letter state after max attempts', async () => {
    retryQueue.enqueueJob({
      payoutId: 'PO-EXHAUST',
      idempotencyKey: 'idem-exhaust-key',
      payload: { source: 'balance', amount: 10000, recipient: 'RCP-2' },
      initialDelayMs: 0,
    });

    vi.mocked(mockProvider.initiateTransfer).mockRejectedValue(
      new Error('Fatal 500 Provider Crash'),
    );

    // Attempt 1
    await retryQueue.processDueJobs(mockProvider, Date.now() + 1000);
    // Attempt 2
    await retryQueue.processDueJobs(mockProvider, Date.now() + 10000);
    // Attempt 3 (maxAttempts = 3)
    await retryQueue.processDueJobs(mockProvider, Date.now() + 100000);

    const deadLetters = retryQueue.getDeadLetterJobs();
    expect(deadLetters).toHaveLength(1);
    expect(deadLetters[0].idempotencyKey).toBe('idem-exhaust-key');
    expect(deadLetters[0].status).toBe('dead_letter');
    expect(deadLetters[0].attempts).toBe(3);

    // Verified in audit ledger
    const auditEntries = auditLedger.getEntries({
      payoutId: 'PO-EXHAUST',
    }).entries;
    expect(auditEntries.some((e) => e.action === 'dead_letter_moved')).toBe(
      true,
    );
  });

  it('persists queue state across simulated process restarts', async () => {
    retryQueue.enqueueJob({
      payoutId: 'PO-RESTART',
      idempotencyKey: 'idem-restart-key',
      payload: { source: 'balance', amount: 2000, recipient: 'RCP-3' },
    });

    // Simulate process restart
    const restartedQueue = new PayoutRetryQueue(
      tempDir,
      { baseDelayMs: 10, maxDelayMs: 100, maxAttempts: 3 },
      auditLedger,
    );

    const jobs = restartedQueue.getJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].idempotencyKey).toBe('idem-restart-key');
    expect(jobs[0].status).toBe('pending');
  });

  it('allows safe operator replay of dead-letter jobs reusing the original idempotency key', async () => {
    const job = retryQueue.enqueueJob({
      payoutId: 'PO-OPERATOR',
      idempotencyKey: 'idem-operator-key',
      payload: { source: 'balance', amount: 3500, recipient: 'RCP-4' },
      initialDelayMs: 0,
    });

    // Force to dead letter
    vi.mocked(mockProvider.initiateTransfer).mockRejectedValue(
      new Error('API key expired'),
    );
    await retryQueue.processDueJobs(mockProvider, Date.now() + 1000);
    await retryQueue.processDueJobs(mockProvider, Date.now() + 10000);
    await retryQueue.processDueJobs(mockProvider, Date.now() + 100000);
    expect(job.status).toBe('dead_letter');

    // Operator manually corrects the issue (e.g. rotates provider key) and replays
    const replayedJob = retryQueue.replayDeadLetterJob(
      job.id,
      'operator:admin_user',
    );
    expect(replayedJob.status).toBe('pending');
    expect(replayedJob.attempts).toBe(0);
    expect(replayedJob.idempotencyKey).toBe('idem-operator-key');

    // Next processing run succeeds using original idempotency key
    vi.mocked(mockProvider.initiateTransfer).mockResolvedValueOnce({
      reference: 'idem-operator-key',
    });
    const result = await retryQueue.processDueJobs(mockProvider, Date.now());
    expect(result.succeeded).toBe(1);
    expect(replayedJob.status).toBe('completed');

    expect(mockProvider.initiateTransfer).toHaveBeenLastCalledWith(
      expect.objectContaining({ reference: 'idem-operator-key' }),
    );

    // Operator intervention recorded in audit ledger
    const auditEntries = auditLedger.getEntries({
      payoutId: 'PO-OPERATOR',
    }).entries;
    expect(auditEntries.some((e) => e.action === 'dead_letter_replayed')).toBe(
      true,
    );
  });
});
