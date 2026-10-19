'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import {
  acquirePayoutIntent,
  updatePayoutIntent,
  abortPayoutIntentOnTabClose,
  getActiveIntentForWallet,
  getCoordinationChannel,
  getTabId,
  type PayoutIntentCoordinationRecord,
  type CrossTabMessage,
  type AcquireResult,
} from '@/lib/crossTabPayoutCoordination';

export function useCrossTabPayoutCoordination(walletAddress: string) {
  const [activeIntent, setActiveIntent] =
    useState<PayoutIntentCoordinationRecord | null>(() =>
      getActiveIntentForWallet(walletAddress),
    );
  const currentIntentKeyRef = useRef<string | null>(null);

  // Sync state whenever walletAddress changes or on initial mount
  useEffect(() => {
    setActiveIntent(getActiveIntentForWallet(walletAddress));
  }, [walletAddress]);

  // Listen to BroadcastChannel and storage events
  useEffect(() => {
    if (typeof window === 'undefined' || !walletAddress) return;

    const channel = getCoordinationChannel();
    const handleMessage = (event: MessageEvent<CrossTabMessage>) => {
      const data = event.data;
      if (!data || !data.type) return;

      if (
        data.type === 'INTENT_ACQUIRED' ||
        data.type === 'INTENT_UPDATED'
      ) {
        if (data.payload.walletAddress === walletAddress) {
          setActiveIntent(data.payload);
        }
      } else if (data.type === 'INTENT_ABORTED') {
        if (data.payload.walletAddress === walletAddress) {
          setActiveIntent(null);
        }
      }
    };

    if (channel) {
      channel.onmessage = handleMessage;
    }

    const handleStorage = (event: StorageEvent) => {
      if (event.key === `payout_active_intent_${walletAddress}`) {
        setActiveIntent(getActiveIntentForWallet(walletAddress));
      }
    };
    window.addEventListener('storage', handleStorage);

    // Clean up on tab close / unload
    const handleUnload = () => {
      if (currentIntentKeyRef.current) {
        abortPayoutIntentOnTabClose(walletAddress, currentIntentKeyRef.current);
      }
    };
    window.addEventListener('beforeunload', handleUnload);
    window.addEventListener('pagehide', handleUnload);

    return () => {
      if (channel) {
        channel.close();
      }
      window.removeEventListener('storage', handleStorage);
      window.removeEventListener('beforeunload', handleUnload);
      window.removeEventListener('pagehide', handleUnload);
    };
  }, [walletAddress]);

  const acquire = useCallback(
    (intentKey: string, actionName = 'payout_confirm'): AcquireResult => {
      const result = acquirePayoutIntent(intentKey, walletAddress, actionName);
      if (result.acquired) {
        currentIntentKeyRef.current = intentKey;
        setActiveIntent(getActiveIntentForWallet(walletAddress));
      }
      return result;
    },
    [walletAddress],
  );

  const release = useCallback(
    (
      intentKey: string,
      status: 'completed' | 'failed' | 'aborted',
      reference?: string,
    ) => {
      updatePayoutIntent(walletAddress, intentKey, { status, reference });
      if (currentIntentKeyRef.current === intentKey) {
        currentIntentKeyRef.current = null;
      }
      setActiveIntent(getActiveIntentForWallet(walletAddress));
    },
    [walletAddress],
  );

  const myTabId = getTabId();
  const isBlockedByAnotherTab = Boolean(
    activeIntent &&
      activeIntent.status === 'in_flight' &&
      activeIntent.tabId !== myTabId,
  );

  const blockedMessage = isBlockedByAnotherTab
    ? `A payout transaction for this wallet is already in progress in another browser tab.`
    : null;

  return {
    acquireIntent: acquire,
    releaseIntent: release,
    activeIntent,
    isBlockedByAnotherTab,
    blockedMessage,
  };
}
