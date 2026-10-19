import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { PayoutAuditLedger } from './auditLedger';

describe('PayoutAuditLedger', () => {
  let tempDir: string;
  let ledger: PayoutAuditLedger;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'payout-audit-test-'));
    ledger = new PayoutAuditLedger(tempDir);
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it('records immutable audit events and maintains hash chain', () => {
    const e1 = ledger.recordEvent({
      payoutId: 'PO-100',
      action: 'payout_initiated',
      actor: 'client:user_1',
      requestCorrelationId: 'trace-1',
      providerReference: 'ref-100',
      metadata: { amount: 5000, recipient: 'RCP_1' },
    });

    const e2 = ledger.recordEvent({
      payoutId: 'PO-100',
      action: 'payout_succeeded',
      actor: 'webhook:paystack',
      requestCorrelationId: 'trace-2',
      providerReference: 'ref-100',
      metadata: { amount: 5000 },
    });

    expect(e1.sequenceNumber).toBe(1);
    expect(e2.sequenceNumber).toBe(2);
    expect(e2.previousHash).toBe(e1.hash);

    const integrity = ledger.verifyIntegrity();
    expect(integrity.valid).toBe(true);
    expect(integrity.invalidEntries).toHaveLength(0);
  });

  it('prohibits edits and deletions to enforce append-only guarantees', () => {
    expect(() => ledger.update()).toThrow(/append-only/i);
    expect(() => ledger.delete()).toThrow(/append-only/i);
  });

  it('filters and paginates audit entries', () => {
    for (let i = 1; i <= 25; i++) {
      ledger.recordEvent({
        payoutId: `PO-${i % 5}`,
        action: i % 2 === 0 ? 'payout_succeeded' : 'payout_failed',
        actor: 'system',
        requestCorrelationId: `trace-${i}`,
      });
    }

    const page1 = ledger.getEntries(undefined, { page: 1, limit: 10 });
    expect(page1.entries).toHaveLength(10);
    expect(page1.total).toBe(25);
    expect(page1.totalPages).toBe(3);
    expect(page1.hasMore).toBe(true);

    const page3 = ledger.getEntries(undefined, { page: 3, limit: 10 });
    expect(page3.entries).toHaveLength(5);
    expect(page3.hasMore).toBe(false);

    const filtered = ledger.getEntries({ payoutId: 'PO-1' });
    expect(filtered.entries.every((e) => e.payoutId === 'PO-1')).toBe(true);
  });

  it('exports CSV formatted records suitable for financial reconciliation', () => {
    ledger.recordEvent({
      payoutId: 'PO-CSV',
      action: 'payout_succeeded',
      actor: 'system',
      requestCorrelationId: 'req-1',
      metadata: { amount: 1500 },
    });

    const csv = ledger.exportCsv({ payoutId: 'PO-CSV' });
    expect(csv).toContain('sequenceNumber');
    expect(csv).toContain('PO-CSV');
    expect(csv).toContain('payout_succeeded');
  });

  it('persists audit events across simulated process restarts', () => {
    ledger.recordEvent({
      payoutId: 'PO-RESTART',
      action: 'payout_initiated',
      actor: 'client:alice',
      requestCorrelationId: 'corr-init',
    });
    ledger.recordEvent({
      payoutId: 'PO-RESTART',
      action: 'payout_succeeded',
      actor: 'webhook:paystack',
      requestCorrelationId: 'corr-done',
    });

    // Simulate process restart by instantiating new ledger on the same directory
    const restartedLedger = new PayoutAuditLedger(tempDir);
    const { entries, total } = restartedLedger.getEntries({
      payoutId: 'PO-RESTART',
    });

    expect(total).toBe(2);
    expect(entries).toHaveLength(2);
    expect(restartedLedger.verifyIntegrity().valid).toBe(true);
  });

  it('validates audit completeness for success, rejection, retry, reversal, and operator intervention paths', () => {
    const payoutId = 'PO-LIFECYCLE-1';

    // 1. Success path
    ledger.recordEvent({
      payoutId,
      action: 'payout_initiated',
      actor: 'client:user_1',
    });
    ledger.recordEvent({
      payoutId,
      action: 'payout_succeeded',
      actor: 'webhook:paystack',
    });

    // 2. Reversal path
    ledger.recordEvent({
      payoutId,
      action: 'payout_reversed',
      actor: 'webhook:paystack',
    });

    // 3. Out-of-order rejection path
    ledger.recordEvent({
      payoutId,
      action: 'payout_event_rejected',
      actor: 'system:reconciler',
      metadata: { reason: 'OUT_OF_ORDER: cannot regress reversed to pending' },
    });

    // 4. Retry path
    ledger.recordEvent({
      payoutId,
      action: 'retry_scheduled',
      actor: 'system:retry_queue',
      metadata: { attempt: 1 },
    });
    ledger.recordEvent({
      payoutId,
      action: 'dead_letter_moved',
      actor: 'system:retry_queue',
      metadata: { attemptsExhausted: 5 },
    });

    // 5. Operator intervention path
    ledger.recordEvent({
      payoutId,
      action: 'operator_intervention',
      actor: 'admin:0x123',
      metadata: { action: 'dead_letter_replay' },
    });

    const entries = ledger.getEntries({ payoutId }).entries;
    const actions = entries.map((e) => e.action);

    expect(actions).toContain('payout_initiated');
    expect(actions).toContain('payout_succeeded');
    expect(actions).toContain('payout_reversed');
    expect(actions).toContain('payout_event_rejected');
    expect(actions).toContain('retry_scheduled');
    expect(actions).toContain('dead_letter_moved');
    expect(actions).toContain('operator_intervention');
    expect(ledger.verifyIntegrity().valid).toBe(true);
  });
});
