import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  PayoutReconciliationService,
  DomainPayoutStatus,
} from './reconciliation';
import { PayoutAuditLedger } from './auditLedger';

describe('PayoutReconciliationService', () => {
  let tempDir: string;
  let auditLedger: PayoutAuditLedger;
  let service: PayoutReconciliationService;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reconciliation-test-'));
    auditLedger = new PayoutAuditLedger(tempDir);
    service = new PayoutReconciliationService(tempDir, auditLedger);
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it('allows forward monotonic transitions', () => {
    const res1 = service.reconcileEvent({
      eventId: 'evt_1',
      payoutReference: 'ref_100',
      eventType: 'transfer.success',
      currentStatus: 'pending',
    });
    expect(res1.decision).toBe('APPLIED');
    expect(res1.effectiveStatus).toBe('success');

    const res2 = service.reconcileEvent({
      eventId: 'evt_2',
      payoutReference: 'ref_100',
      eventType: 'transfer.reversed',
      currentStatus: 'success',
    });
    expect(res2.decision).toBe('APPLIED');
    expect(res2.effectiveStatus).toBe('reversed');
  });

  it('rejects out-of-order regression from reversed to earlier states', () => {
    // Current state is already reversed
    const currentStatus: DomainPayoutStatus = 'reversed';

    const res = service.reconcileEvent({
      eventId: 'evt_stale_success',
      payoutReference: 'ref_rev',
      eventType: 'transfer.success',
      currentStatus,
    });

    expect(res.decision).toBe('REJECTED_OUT_OF_ORDER');
    expect(res.effectiveStatus).toBe('reversed');
    expect(res.reason).toMatch(/cannot transition to success/i);

    // Stored for investigation
    const rejected = service.getRejectedEvents({ payoutReference: 'ref_rev' });
    expect(rejected).toHaveLength(1);
    expect(rejected[0].eventId).toBe('evt_stale_success');
    expect(rejected[0].targetStatus).toBe('success');

    // Audit ledger records the rejection
    const auditEntries = auditLedger.getEntries({
      payoutId: 'ref_rev',
    }).entries;
    expect(auditEntries.some((e) => e.action === 'payout_event_rejected')).toBe(
      true,
    );
  });

  it('replays fixtures in multiple delivery orders and yields identical final state', () => {
    interface FixtureEvent {
      id: string;
      type: string;
    }

    const fixtures: FixtureEvent[] = [
      { id: 'evt_succ', type: 'transfer.success' },
      { id: 'evt_rev', type: 'transfer.reversed' },
    ];

    const replaySequence = (events: FixtureEvent[]): DomainPayoutStatus => {
      let state: DomainPayoutStatus = 'pending';
      for (const ev of events) {
        const dec = service.reconcileEvent({
          eventId: ev.id,
          payoutReference: 'ref_fixture',
          eventType: ev.type,
          currentStatus: state,
        });
        state = dec.effectiveStatus;
      }
      return state;
    };

    // Forward order: success then reversed
    const finalOrder1 = replaySequence([fixtures[0], fixtures[1]]);
    expect(finalOrder1).toBe('reversed');

    // Out-of-order: reversed arrives before success
    const finalOrder2 = replaySequence([fixtures[1], fixtures[0]]);
    expect(finalOrder2).toBe('reversed');

    // Both result in identical final state
    expect(finalOrder1).toBe(finalOrder2);
  });

  it('stores and retrieves rejected events for investigation across restarts', () => {
    service.reconcileEvent({
      eventId: 'evt_delayed',
      payoutReference: 'ref_investigate',
      eventType: 'transfer.success',
      currentStatus: 'reversed',
      payload: { note: 'delayed webhook callback' },
    });

    // Simulate restart with new service instance on same storage directory
    const restartedService = new PayoutReconciliationService(
      tempDir,
      auditLedger,
    );
    const rejected = restartedService.getRejectedEvents({
      payoutReference: 'ref_investigate',
    });

    expect(rejected).toHaveLength(1);
    expect(rejected[0].eventId).toBe('evt_delayed');
    expect(rejected[0].payload).toEqual({ note: 'delayed webhook callback' });
  });
});
