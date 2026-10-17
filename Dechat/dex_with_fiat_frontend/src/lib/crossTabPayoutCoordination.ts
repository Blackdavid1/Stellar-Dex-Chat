/**
 * crossTabPayoutCoordination.ts
 *
 * Coordinates in-flight payout intents across browser tabs for the same wallet
 * using browser-supported BroadcastChannel and storage events.
 *
 * Security & Privacy:
 *   - NEVER broadcasts or persists sensitive bank details (account numbers, IBAN, BVN)
 *   - NEVER broadcasts or persists secret keys, private keys, or signed XDR
 *   - Enforces strict account isolation (intents are scoped per wallet address)
 *   - Prunes stale coordination records (> 30s TTL)
 *   - Releases locks on tab close / unload
 *   - Treats server idempotency as authoritative on reload
 */

export interface PayoutIntentCoordinationRecord {
  intentKey: string;
  walletAddress: string;
  status: 'in_flight' | 'completed' | 'failed' | 'aborted';
  createdAt: number;
  updatedAt: number;
  tabId: string;
  actionName?: string;
  reference?: string;
  failureReason?: string;
}

export type CrossTabMessage =
  | { type: 'INTENT_ACQUIRED'; payload: PayoutIntentCoordinationRecord }
  | { type: 'INTENT_UPDATED'; payload: PayoutIntentCoordinationRecord }
  | { type: 'INTENT_ABORTED'; payload: { intentKey: string; tabId: string; walletAddress: string } }
  | { type: 'INTENT_QUERY'; payload: { walletAddress: string } };

export const STALE_INTENT_TIMEOUT_MS = 30_000;
const CHANNEL_NAME = 'dechat_payout_coordination';
const STORAGE_PREFIX = 'payout_active_intent_';

let currentTabId: string | null = null;
export function getTabId(): string {
  if (!currentTabId) {
    currentTabId = `tab_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  }
  return currentTabId;
}

export function setTestTabId(id: string | null): void {
  currentTabId = id;
}

function getStorageKey(walletAddress: string): string {
  return `${STORAGE_PREFIX}${walletAddress.trim()}`;
}

/**
 * Creates or gets the broadcast channel if supported.
 */
export function getCoordinationChannel(): BroadcastChannel | null {
  if (typeof window !== 'undefined' && typeof BroadcastChannel !== 'undefined') {
    try {
      return new BroadcastChannel(CHANNEL_NAME);
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Reads the active in-flight intent for a specific wallet from storage.
 * Automatically prunes stale records.
 */
export function getActiveIntentForWallet(
  walletAddress: string,
  now = Date.now(),
): PayoutIntentCoordinationRecord | null {
  if (typeof window === 'undefined' || !walletAddress) return null;

  try {
    const raw = localStorage.getItem(getStorageKey(walletAddress));
    if (!raw) return null;

    const record = JSON.parse(raw) as PayoutIntentCoordinationRecord;

    // Strict account isolation check:
    if (record.walletAddress !== walletAddress) {
      return null;
    }

    // Prune stale in-flight records:
    if (
      record.status === 'in_flight' &&
      now - record.updatedAt > STALE_INTENT_TIMEOUT_MS
    ) {
      localStorage.removeItem(getStorageKey(walletAddress));
      return null;
    }

    return record;
  } catch {
    return null;
  }
}

export interface AcquireResult {
  acquired: boolean;
  existingIntent?: PayoutIntentCoordinationRecord;
  error?: string;
}

/**
 * Attempts to acquire an in-flight payout intent lock for a wallet across all tabs.
 *
 * Fails if:
 * - An active in-flight intent already exists for the SAME wallet address from another tab.
 *
 * Succeeds if:
 * - No intent exists, or existing intent is stale, or from the same tab, or for a different wallet.
 */
export function acquirePayoutIntent(
  intentKey: string,
  walletAddress: string,
  actionName = 'payout_confirm',
  now = Date.now(),
): AcquireResult {
  if (!walletAddress || !intentKey) {
    return { acquired: false, error: 'Missing walletAddress or intentKey' };
  }

  const tabId = getTabId();
  const existing = getActiveIntentForWallet(walletAddress, now);

  if (
    existing &&
    existing.status === 'in_flight' &&
    existing.tabId !== tabId &&
    now - existing.updatedAt <= STALE_INTENT_TIMEOUT_MS
  ) {
    return {
      acquired: false,
      existingIntent: existing,
      error: `A payout for wallet ${walletAddress.slice(0, 6)}… is already in progress in another tab.`,
    };
  }

  const record: PayoutIntentCoordinationRecord = {
    intentKey,
    walletAddress,
    status: 'in_flight',
    createdAt: now,
    updatedAt: now,
    tabId,
    actionName,
  };

  try {
    localStorage.setItem(getStorageKey(walletAddress), JSON.stringify(record));
  } catch {
    // Storage quota fallback
  }

  const channel = getCoordinationChannel();
  if (channel) {
    try {
      channel.postMessage({ type: 'INTENT_ACQUIRED', payload: record } as CrossTabMessage);
      channel.close();
    } catch {
      // Ignore postMessage errors
    }
  }

  return { acquired: true };
}

/**
 * Updates an active payout intent (e.g. to completed, failed, or aborted).
 */
export function updatePayoutIntent(
  walletAddress: string,
  intentKey: string,
  update: {
    status: 'completed' | 'failed' | 'aborted';
    reference?: string;
    failureReason?: string;
  },
  now = Date.now(),
): void {
  if (!walletAddress || !intentKey) return;

  const tabId = getTabId();
  const existing = getActiveIntentForWallet(walletAddress, now);
  if (existing && existing.intentKey !== intentKey && existing.status === 'in_flight') {
    // Do not overwrite another active intent
    return;
  }

  const updatedRecord: PayoutIntentCoordinationRecord = {
    intentKey,
    walletAddress,
    status: update.status,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    tabId,
    reference: update.reference ?? existing?.reference,
    failureReason: update.failureReason ?? existing?.failureReason,
  };

  try {
    if (update.status === 'aborted') {
      localStorage.removeItem(getStorageKey(walletAddress));
    } else {
      localStorage.setItem(getStorageKey(walletAddress), JSON.stringify(updatedRecord));
    }
  } catch {
    // Ignore storage errors
  }

  const channel = getCoordinationChannel();
  if (channel) {
    try {
      if (update.status === 'aborted') {
        channel.postMessage({
          type: 'INTENT_ABORTED',
          payload: { intentKey, tabId, walletAddress },
        } as CrossTabMessage);
      } else {
        channel.postMessage({
          type: 'INTENT_UPDATED',
          payload: updatedRecord,
        } as CrossTabMessage);
      }
      channel.close();
    } catch {
      // Ignore
    }
  }
}

/**
 * Cleans up / aborts an intent if a tab unloads or closes before completing.
 */
export function abortPayoutIntentOnTabClose(
  walletAddress: string,
  intentKey: string,
): void {
  updatePayoutIntent(walletAddress, intentKey, { status: 'aborted' });
}

/**
 * Reconciles tab state after a reload by inspecting stored intent and server idempotency.
 */
export async function reconcileIntentAfterReload(
  walletAddress: string,
): Promise<{
  hasActiveIntent: boolean;
  intent: PayoutIntentCoordinationRecord | null;
  isAuthoritativeConfirmed?: boolean;
}> {
  const intent = getActiveIntentForWallet(walletAddress);
  if (!intent) {
    return { hasActiveIntent: false, intent: null };
  }

  // If there is an existing server reference, check server transfer status (server idempotency authority)
  if (intent.reference) {
    try {
      const res = await fetch(`/api/transfer-status/${encodeURIComponent(intent.reference)}`);
      if (res.ok) {
        const json = await res.json();
        const serverStatus = json.data?.status;
        if (serverStatus === 'success') {
          intent.status = 'completed';
          try {
            localStorage.setItem(getStorageKey(walletAddress), JSON.stringify(intent));
          } catch {}
          return {
            hasActiveIntent: true,
            intent,
            isAuthoritativeConfirmed: true,
          };
        }
      }
    } catch {
      // Network failure during reload reconciliation: return local intent
    }
  }

  return {
    hasActiveIntent: intent.status === 'in_flight' || intent.status === 'completed',
    intent,
    isAuthoritativeConfirmed: intent.status === 'completed',
  };
}
