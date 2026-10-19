import { describe, it, expect } from 'vitest';
import {
  createInitialTransferState,
  reconcileTransferStatus,
  saveResumableTransfer,
  loadResumableTransfer,
  clearResumableTransfer,
} from '../transferStatusReconciler';

describe('transferStatusReconciler (Issue #64)', () => {
  it('models on-chain and provider states as separate linked stages', () => {
    const state = createInitialTransferState('REF_12345');

    expect(state.stages.on_chain).toBeDefined();
    expect(state.stages.provider).toBeDefined();
    expect(state.stages.on_chain.stage).toBe('on_chain');
    expect(state.stages.provider.stage).toBe('provider');
    expect(state.stages.on_chain.status).toBe('pending');
    expect(state.stages.provider.status).toBe('idle');
  });

  it('tracks event timestamps, source, and last updated time for each stage', () => {
    let state = createInitialTransferState('REF_12345');
    const updateTime = new Date('2026-10-17T12:00:00Z');

    state = reconcileTransferStatus(state, {
      stage: 'on_chain',
      status: 'confirmed',
      source: 'rpc',
      timestamp: updateTime,
      label: 'Confirmed on ledger 12345',
      isAuthoritative: true,
    });

    expect(state.stages.on_chain.status).toBe('confirmed');
    expect(state.stages.on_chain.source).toBe('rpc');
    expect(state.stages.on_chain.lastUpdated).toBe(updateTime.toISOString());
    expect(state.events.some((e) => e.source === 'rpc' && e.status === 'confirmed')).toBe(true);
  });

  it('does NOT transition provider to success before authoritative confirmation', () => {
    let state = createInitialTransferState('REF_12345');

    // On-chain confirmed
    state = reconcileTransferStatus(state, {
      stage: 'on_chain',
      status: 'confirmed',
      source: 'rpc',
      isAuthoritative: true,
    });

    // An optimistic HTTP response from transfer initiation should NOT mark provider as success
    state = reconcileTransferStatus(state, {
      stage: 'provider',
      status: 'success',
      source: 'provider', // API response, not authoritative polling or push webhook
      isAuthoritative: false,
    });

    // Provider status must stay pending, NOT success
    expect(state.stages.provider.status).toBe('pending');
    expect(state.overallStatus).toBe('pending');

    // Now receive authoritative confirmation from polling
    state = reconcileTransferStatus(state, {
      stage: 'provider',
      status: 'success',
      source: 'polling',
      isAuthoritative: true,
      label: 'Settled to bank account',
    });

    expect(state.stages.provider.status).toBe('success');
    expect(state.overallStatus).toBe('success');
  });

  it('enforces monotonic reconciliation: delayed pending updates do not revert terminal success', () => {
    let state = createInitialTransferState('REF_12345');

    // Provider achieves authoritative success
    state = reconcileTransferStatus(state, {
      stage: 'provider',
      status: 'success',
      source: 'push',
      isAuthoritative: true,
      timestamp: new Date('2026-10-17T12:05:00Z'),
    });

    expect(state.stages.provider.status).toBe('success');

    // A delayed polling response arriving later with 'pending'
    const delayedPending = reconcileTransferStatus(state, {
      stage: 'provider',
      status: 'pending',
      source: 'polling',
      timestamp: new Date('2026-10-17T12:04:00Z'),
    });

    // Must still remain success!
    expect(delayedPending.stages.provider.status).toBe('success');
    expect(delayedPending.overallStatus).toBe('success');
  });

  it('de-duplicates duplicate status events', () => {
    let state = createInitialTransferState('REF_12345');
    const initialEventsCount = state.events.length;

    state = reconcileTransferStatus(state, {
      stage: 'on_chain',
      status: 'submitting',
      source: 'rpc',
      label: 'Broadcasting tx',
    });

    const eventCountAfterFirst = state.events.length;
    expect(eventCountAfterFirst).toBe(initialEventsCount + 1);

    // Duplicate update with same stage, status, source
    state = reconcileTransferStatus(state, {
      stage: 'on_chain',
      status: 'submitting',
      source: 'rpc',
      label: 'Broadcasting tx',
    });

    expect(state.events.length).toBe(eventCountAfterFirst);
  });

  it('ignores reordered updates where an older update arrives after terminal update', () => {
    let state = createInitialTransferState('REF_12345');

    state = reconcileTransferStatus(state, {
      stage: 'provider',
      status: 'failed',
      source: 'polling',
      timestamp: new Date('2026-10-17T12:10:00Z'),
      error: 'Account number does not exist',
    });

    expect(state.stages.provider.status).toBe('failed');

    // Older reordered update
    state = reconcileTransferStatus(state, {
      stage: 'provider',
      status: 'initiated',
      source: 'provider',
      timestamp: new Date('2026-10-17T12:01:00Z'),
    });

    expect(state.stages.provider.status).toBe('failed');
  });

  it('announces terminal status changes accessibly', () => {
    let state = createInitialTransferState('REF_12345');

    state = reconcileTransferStatus(state, {
      stage: 'provider',
      status: 'success',
      source: 'push',
      isAuthoritative: true,
    });

    expect(state.announcement).toContain('Fiat payout confirmed');

    state = reconcileTransferStatus(state, {
      stage: 'on_chain',
      status: 'failed',
      source: 'rpc',
      error: 'Insufficient balance',
    });

    expect(state.announcement).toContain('Blockchain transaction failed');
  });

  it('supports resumable state persistence without storing sensitive data', () => {
    const state = createInitialTransferState('REF_PERSIST_TEST');
    saveResumableTransfer(state);

    const loaded = loadResumableTransfer('REF_PERSIST_TEST');
    expect(loaded).not.toBeNull();
    expect(loaded?.transferReference).toBe('REF_PERSIST_TEST');
    expect(loaded?.stages.on_chain.status).toBe('pending');

    // Ensure no sensitive bank details or private keys were stored
    const raw = localStorage.getItem('stellar_resumable_transfer_REF_PERSIST_TEST');
    expect(raw).not.toContain('secret');
    expect(raw).not.toContain('privateKey');
    expect(raw).not.toContain('signedTxXdr');

    clearResumableTransfer('REF_PERSIST_TEST');
    expect(loadResumableTransfer('REF_PERSIST_TEST')).toBeNull();
  });
});
