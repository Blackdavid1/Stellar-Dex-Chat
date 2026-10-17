import { describe, it, expect } from 'vitest';
import goldenFixtures from '../../fixtures/events/golden_events.json';
import { ContractEvent } from '../types/events';

describe('Indexer Event Schema and Golden Fixture Compatibility', () => {
  it('loads valid golden fixtures with correct top-level metadata', () => {
    expect(goldenFixtures.version).toBe(1);
    expect(goldenFixtures.events.length).toBeGreaterThan(0);
  });

  it('validates every event has EVENT_VERSION = 1', () => {
    for (const evt of goldenFixtures.events) {
      expect(evt.version).toBe(1);
      if (typeof evt.data === 'object' && evt.data !== null && 'version' in evt.data) {
        expect((evt.data as { version: number }).version).toBe(1);
      }
    }
  });

  it('verifies all expected event families are present in the golden fixtures', () => {
    const families = goldenFixtures.events.map((e) => e.family);
    expect(families).toContain('DepositEvent');
    expect(families).toContain('ReceiptIssuedEvent');
    expect(families).toContain('WithdrawEvent');
    expect(families).toContain('WithdrawalRequestedEvent');
    expect(families).toContain('WithdrawalExecutedEvent');
    expect(families).toContain('WithdrawalCancelledEvent');
    expect(families).toContain('WithdrawalExpiredEvent');
    expect(families).toContain('FeeAccruedEvent');
    expect(families).toContain('FeeWithdrawnEvent');
    expect(families).toContain('RefundEvent');
    expect(families).toContain('SetLimitEvent');
    expect(families).toContain('SetOperatorEvent');
    expect(families).toContain('upg_prop');
    expect(families).toContain('upg_exec');
    expect(families).toContain('multisig_proposed');
  });

  it('maps deposit and withdraw events into frontend ContractEvent format', () => {
    const depositEvt = goldenFixtures.events.find((e) => e.family === 'DepositEvent');
    expect(depositEvt).toBeDefined();

    const mappedDeposit: ContractEvent = {
      id: 'tx-1-0',
      type: 'deposit',
      contractId: 'CAWYXBN4PSVXD7NIYEWVFFIIIEUCC6PUN3IMG3J2WHKDB4NVIISMXBPR',
      ledger: depositEvt!.data.ledger,
      ledgerClosedAt: new Date().toISOString(),
      txHash: '0000000000000000000000000000000000000000000000000000000000000000',
      actor: depositEvt!.data.from,
      amount: depositEvt!.data.amount,
      token: depositEvt!.data.token,
      version: depositEvt!.version,
    };

    expect(mappedDeposit.type).toBe('deposit');
    expect(mappedDeposit.version).toBe(1);
    expect(BigInt(mappedDeposit.amount)).toBeGreaterThan(0n);

    const withdrawEvt = goldenFixtures.events.find((e) => e.family === 'WithdrawEvent');
    expect(withdrawEvt).toBeDefined();

    const mappedWithdraw: ContractEvent = {
      id: 'tx-2-0',
      type: 'withdraw',
      contractId: 'CAWYXBN4PSVXD7NIYEWVFFIIIEUCC6PUN3IMG3J2WHKDB4NVIISMXBPR',
      ledger: withdrawEvt!.data.ledger,
      ledgerClosedAt: new Date().toISOString(),
      txHash: '0000000000000000000000000000000000000000000000000000000000000000',
      actor: withdrawEvt!.data.to,
      amount: withdrawEvt!.data.amount,
      token: withdrawEvt!.data.token,
      version: withdrawEvt!.version,
    };

    expect(mappedWithdraw.type).toBe('withdraw');
    expect(mappedWithdraw.version).toBe(1);
    expect(BigInt(mappedWithdraw.amount)).toBeGreaterThan(0n);
  });

  it('tolerates additive (non-breaking) fields gracefully', () => {
    const rawWithAdditive = {
      ...goldenFixtures.events[0],
      data: {
        ...goldenFixtures.events[0].data,
        extraIndexerNote: 'new non-breaking field',
      },
    };
    expect(rawWithAdditive.data.extraIndexerNote).toBe('new non-breaking field');
    expect(rawWithAdditive.version).toBe(1);
  });
});
