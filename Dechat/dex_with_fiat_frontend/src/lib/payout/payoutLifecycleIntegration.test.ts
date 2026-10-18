import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { PayoutAuditLedger } from './auditLedger';
import { WebhookDeduplicationService } from './webhookDeduplication';
import { PayoutReconciliationService } from './reconciliation';
import { PayoutRetryQueue } from './retryQueue';
import { PayoutProvider } from './providers/types';

describe('Payout Lifecycle End-to-End Integration (#35, #36, #37, #38)', () => {
  let tempDir: string;
  let auditLedger: PayoutAuditLedger;
  let dedupeService: WebhookDeduplicationService;
  let reconciler: PayoutReconciliationService;
  let retryQueue: PayoutRetryQueue;

  const mockProvider: PayoutProvider = {
    name: 'paystack',
    verifyAccount: vi.fn(),
    createRecipient: vi.fn(),
    initiateTransfer: vi.fn(),
    checkTransferStatus: vi.fn(),
  };

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'payout-e2e-test-'));
    auditLedger = new PayoutAuditLedger(tempDir);
    dedupeService = new WebhookDeduplicationService({ storageDir: tempDir });
    reconciler = new PayoutReconciliationService(tempDir, auditLedger);
    retryQueue = new PayoutRetryQueue(
      tempDir,
      { baseDelayMs: 10, maxDelayMs: 100, maxAttempts: 3 },
      auditLedger,
    );
    vi.clearAllMocks();
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it('runs the full payout lifecycle preserving invariants across dedupe, reconciliation, retries, and audit ledger', async () => {
    const payoutId = 'PAYOUT-E2E-1';
    const idempotencyKey = 'IDEM-KEY-E2E-1';

    // 1. Payout initiation (Issue #38)
    auditLedger.recordEvent({
      payoutId,
      action: 'payout_initiated',
      actor: 'client:user_1',
      requestCorrelationId: 'trace-e2e-1',
      providerReference: idempotencyKey,
      metadata: { amount: 5000, recipient: 'RCP-E2E' },
    });

    // 2. Transient failure enqueued into retry queue (Issue #37)
    const job = retryQueue.enqueueJob({
      payoutId,
      idempotencyKey,
      payload: { source: 'balance', amount: 5000, recipient: 'RCP-E2E' },
      initialDelayMs: 0,
      error: '503 Service Unavailable',
      correlationId: 'trace-e2e-1',
    });

    expect(job.status).toBe('pending');
    expect(job.idempotencyKey).toBe(idempotencyKey);

    // First attempt fails
    vi.mocked(mockProvider.initiateTransfer).mockRejectedValueOnce(
      new Error('503 Service Unavailable'),
    );
    await retryQueue.processDueJobs(mockProvider, Date.now() + 1000);
    expect(job.status).toBe('pending');
    expect(job.attempts).toBe(1);

    // Second attempt recovers
    vi.mocked(mockProvider.initiateTransfer).mockResolvedValueOnce({
      reference: idempotencyKey,
    });
    await retryQueue.processDueJobs(mockProvider, Date.now() + 10000);
    expect(job.status).toBe('completed');
    expect(mockProvider.initiateTransfer).toHaveBeenLastCalledWith(
      expect.objectContaining({ reference: idempotencyKey }),
    );

    // 3. Provider sends webhooks: test deduplication & replay protection (Issue #35)
    let domainStatus: 'pending' | 'success' | 'failed' | 'reversed' = 'pending';
    const handleWebhook = async (eventId: string, eventType: string) => {
      return dedupeService.processEvent(
        eventId,
        eventType,
        `hash-${eventId}`,
        payoutId,
        async () => {
          const decision = reconciler.reconcileEvent({
            eventId,
            payoutReference: payoutId,
            eventType,
            currentStatus: domainStatus,
          });
          domainStatus = decision.effectiveStatus;
          return decision;
        },
      );
    };

    // First delivery of transfer.success
    const res1 = await handleWebhook('evt-succ-1', 'transfer.success');
    expect(res1.duplicate).toBe(false);
    expect(domainStatus).toBe('success');

    // Duplicate delivery of transfer.success (should be recognized safely without re-processing)
    const res2 = await handleWebhook('evt-succ-1', 'transfer.success');
    expect(res2.duplicate).toBe(true);
    expect(res2.providerResponse.received).toBe(true);
    expect(domainStatus).toBe('success');

    // 4. Out-of-order webhook reconciliation (Issue #36)
    // Later, transfer.reversed arrives
    const res3 = await handleWebhook('evt-rev-1', 'transfer.reversed');
    expect(res3.duplicate).toBe(false);
    expect(domainStatus).toBe('reversed');

    // Now a delayed/reordered transfer.success arrives (e.g. from an old retry callback)
    const res4 = await handleWebhook('evt-delayed-succ', 'transfer.success');
    expect(res4.duplicate).toBe(false);
    // Domain status must NOT regress from reversed back to success!
    expect(domainStatus).toBe('reversed');

    // Check that out-of-order event was recorded in rejected store
    const rejected = reconciler.getRejectedEvents({
      payoutReference: payoutId,
    });
    expect(rejected).toHaveLength(1);
    expect(rejected[0].eventId).toBe('evt-delayed-succ');

    // 5. Append-only Audit Ledger verification (Issue #38)
    const auditEntries = auditLedger.getEntries({ payoutId }).entries;
    const actions = auditEntries.map((e) => e.action);

    expect(actions).toContain('payout_initiated');
    expect(actions).toContain('retry_scheduled');
    expect(actions).toContain('payout_provider_accepted');
    expect(actions).toContain('payout_succeeded');
    expect(actions).toContain('payout_reversed');
    expect(actions).toContain('payout_event_rejected');

    // Integrity check
    const integrity = auditLedger.verifyIntegrity();
    expect(integrity.valid).toBe(true);

    // Export CSV check
    const csv = auditLedger.exportCsv({ payoutId });
    expect(csv).toContain(payoutId);
    expect(csv).toContain('payout_succeeded');
    expect(csv).toContain('payout_reversed');

    // 6. Persistence across simulated restarts (Issues #35, #36, #37, #38)
    const restartedLedger = new PayoutAuditLedger(tempDir);
    const restartedDedupe = new WebhookDeduplicationService({
      storageDir: tempDir,
    });
    const restartedReconciler = new PayoutReconciliationService(
      tempDir,
      restartedLedger,
    );
    const restartedRetryQueue = new PayoutRetryQueue(
      tempDir,
      {},
      restartedLedger,
    );

    expect(restartedLedger.verifyIntegrity().valid).toBe(true);
    expect(restartedDedupe.getRecord('evt-succ-1')?.status).toBe('committed');
    expect(
      restartedReconciler.getRejectedEvents({ payoutReference: payoutId }),
    ).toHaveLength(1);
    expect(
      restartedRetryQueue
        .getJobs()
        .some((j) => j.idempotencyKey === idempotencyKey),
    ).toBe(true);
  });
});
