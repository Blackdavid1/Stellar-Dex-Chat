import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  acquirePayoutIntent,
  updatePayoutIntent,
  getActiveIntentForWallet,
  abortPayoutIntentOnTabClose,
  reconcileIntentAfterReload,
  setTestTabId,
  STALE_INTENT_TIMEOUT_MS,
} from '../crossTabPayoutCoordination';

describe('crossTabPayoutCoordination (Issue #63)', () => {
  const WALLET_A = 'GA111111111111111111111111111111111111111111111111111111';
  const WALLET_B = 'GB222222222222222222222222222222222222222222222222222222';

  beforeEach(() => {
    localStorage.clear();
    setTestTabId('tab_1');
    vi.restoreAllMocks();
  });

  afterEach(() => {
    setTestTabId(null);
  });

  it('prevents two-tab duplicate submission for the same wallet', () => {
    // Tab 1 initiates a payout
    setTestTabId('tab_1');
    const result1 = acquirePayoutIntent('intent_abc', WALLET_A);
    expect(result1.acquired).toBe(true);

    // Tab 2 attempts to submit a payout for the same wallet while tab_1 is in-flight
    setTestTabId('tab_2');
    const result2 = acquirePayoutIntent('intent_xyz', WALLET_A);
    expect(result2.acquired).toBe(false);
    expect(result2.error).toContain('already in progress in another tab');
  });

  it('enforces account isolation (Wallet A does NOT block Wallet B)', () => {
    // Tab 1 initiates for Wallet A
    setTestTabId('tab_1');
    const resultA = acquirePayoutIntent('intent_A', WALLET_A);
    expect(resultA.acquired).toBe(true);

    // Tab 2 initiates for Wallet B
    setTestTabId('tab_2');
    const resultB = acquirePayoutIntent('intent_B', WALLET_B);
    expect(resultB.acquired).toBe(true);
  });

  it('allows subsequent submission after tab closure / abort', () => {
    // Tab 1 starts payout
    setTestTabId('tab_1');
    acquirePayoutIntent('intent_1', WALLET_A);

    // Tab 1 closes or navigates away
    abortPayoutIntentOnTabClose(WALLET_A, 'intent_1');

    // Tab 2 should now be able to acquire
    setTestTabId('tab_2');
    const result2 = acquirePayoutIntent('intent_2', WALLET_A);
    expect(result2.acquired).toBe(true);
  });

  it('prunes stale coordination records when TTL expires', () => {
    const startTime = 1_000_000;
    setTestTabId('tab_1');
    acquirePayoutIntent('intent_old', WALLET_A, 'payout_confirm', startTime);

    // Verify it is active immediately
    expect(getActiveIntentForWallet(WALLET_A, startTime + 5_000)).not.toBeNull();

    // After 35 seconds (> 30s TTL), tab 2 attempts submission
    setTestTabId('tab_2');
    const laterTime = startTime + STALE_INTENT_TIMEOUT_MS + 5_000;
    const result = acquirePayoutIntent('intent_new', WALLET_A, 'payout_confirm', laterTime);

    expect(result.acquired).toBe(true);
  });

  it('never broadcasts or stores sensitive bank details or signing material', () => {
    setTestTabId('tab_1');
    acquirePayoutIntent('intent_audit', WALLET_A);
    updatePayoutIntent(WALLET_A, 'intent_audit', {
      status: 'completed',
      reference: 'PAY_REF_999',
    });

    const active = getActiveIntentForWallet(WALLET_A);
    expect(active).not.toBeNull();

    const storedJson = localStorage.getItem(`payout_active_intent_${WALLET_A}`);
    expect(storedJson).not.toBeNull();

    // Sensitive field validation
    expect(storedJson).not.toContain('account_number');
    expect(storedJson).not.toContain('bank_code');
    expect(storedJson).not.toContain('bvn');
    expect(storedJson).not.toContain('iban');
    expect(storedJson).not.toContain('secret');
    expect(storedJson).not.toContain('signedTxXdr');
  });

  it('reconciles tab state after reload using server idempotency', async () => {
    setTestTabId('tab_1');
    acquirePayoutIntent('intent_reload', WALLET_A);
    updatePayoutIntent(WALLET_A, 'intent_reload', {
      status: 'completed',
      reference: 'SERVER_REF_456',
    });

    // Mock fetch for server transfer status check
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, data: { status: 'success' } }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const reconciled = await reconcileIntentAfterReload(WALLET_A);
    expect(reconciled.hasActiveIntent).toBe(true);
    expect(reconciled.isAuthoritativeConfirmed).toBe(true);
    expect(reconciled.intent?.reference).toBe('SERVER_REF_456');
  });
});
