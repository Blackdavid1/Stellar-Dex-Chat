'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { fiatBridgeClient } from '@/lib/stellarContract';
import { ContractWithdrawRequest } from '@/contracts/types';

export type QueueDisplayState =
  | 'loading'
  | 'empty'
  | 'active'
  | 'stale'
  | 'rpc_error'
  | 'version_mismatch';

export interface WithdrawalQueueStatusOptions {
  requestId?: bigint | number;
  pollIntervalMs?: number;
  maxPollCount?: number;
  staleThresholdMs?: number;
  expectedVersion?: number;
  enabled?: boolean;
}

export interface WithdrawalQueueStatusResult {
  state: QueueDisplayState;
  depth: number | null;
  oldestAgeLedgers: number | null;
  oldestQueuedLedger: number | null;
  estimatedWaitMinutes: number | null;
  estimatedPosition: number | null;
  specificRequest: ContractWithdrawRequest | null;
  contractVersion: number | null;
  lastUpdated: number | null;
  isStale: boolean;
  errorMessage: string | null;
  pollCount: number;
  isPollingActive: boolean;
  settlementDisclaimer: string;
  refetch: () => Promise<void>;
}

export const SETTLEMENT_TIME_DISCLAIMER =
  'Queue position and estimated wait times are operational metrics and do not represent a guaranteed settlement time.';

// On Stellar testnet/mainnet, one ledger closes approximately every 5 seconds.
const SECONDS_PER_LEDGER = 5;

export function useWithdrawalQueueStatus({
  requestId,
  pollIntervalMs = 10_000,
  maxPollCount = 30,
  staleThresholdMs = 30_000,
  expectedVersion = 1,
  enabled = true,
}: WithdrawalQueueStatusOptions = {}): WithdrawalQueueStatusResult {
  const [depth, setDepth] = useState<number | null>(null);
  const [oldestAgeLedgers, setOldestAgeLedgers] = useState<number | null>(null);
  const [oldestQueuedLedger, setOldestQueuedLedger] = useState<number | null>(
    null,
  );
  const [specificRequest, setSpecificRequest] =
    useState<ContractWithdrawRequest | null>(null);
  const [contractVersion, setContractVersion] = useState<number | null>(null);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isInitialLoading, setIsInitialLoading] = useState(true);
  const [pollCount, setPollCount] = useState(0);
  const [isPollingActive, setIsPollingActive] = useState(false);
  const [now, setNow] = useState(Date.now());

  const pollCountRef = useRef(0);
  const isMountedRef = useRef(true);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Periodic clock to evaluate staleness reactively
  useEffect(() => {
    const clockTimer = setInterval(() => {
      if (isMountedRef.current) {
        setNow(Date.now());
      }
    }, 1000);
    return () => clearInterval(clockTimer);
  }, []);

  const fetchData = useCallback(async () => {
    if (!isMountedRef.current) return;

    try {
      // 1. Check contract version first to detect contract-version mismatch
      let version = 1;
      try {
        version = await fiatBridgeClient.getEventVersion();
      } catch {
        // If method fails or is older, keep default
      }

      if (!isMountedRef.current) return;
      setContractVersion(version);

      if (version !== expectedVersion) {
        setErrorMessage(
          `Contract version mismatch: expected v${expectedVersion}, found v${version}.`,
        );
        setIsInitialLoading(false);
        return;
      }

      // 2. Fetch queue operational metrics
      const [fetchedDepth, fetchedOldestAge, fetchedOldestQueued] =
        await Promise.all([
          fiatBridgeClient.getWithdrawalQueueDepth(),
          fiatBridgeClient.getWithdrawalQueueOldestAgeLedgers(),
          fiatBridgeClient.getWithdrawalQueueOldestQueuedLedger(),
        ]);

      if (!isMountedRef.current) return;

      setDepth(fetchedDepth);
      setOldestAgeLedgers(fetchedOldestAge);
      setOldestQueuedLedger(fetchedOldestQueued);

      // 3. If a specific request was provided, fetch its status
      if (requestId !== undefined) {
        const req = await fiatBridgeClient.getWithdrawalRequest(requestId);
        if (isMountedRef.current) {
          setSpecificRequest(req);
        }
      }

      setLastUpdated(Date.now());
      setErrorMessage(null);
      setIsInitialLoading(false);
    } catch (err) {
      if (!isMountedRef.current) return;
      const message =
        err instanceof Error ? err.message : 'Failed to query withdrawal queue';
      setErrorMessage(message);
      setIsInitialLoading(false);
    }
  }, [expectedVersion, requestId]);

  // Periodic bounded polling effect
  useEffect(() => {
    isMountedRef.current = true;
    if (!enabled) {
      setIsPollingActive(false);
      return;
    }

    setIsPollingActive(true);
    pollCountRef.current = 0;
    setPollCount(0);

    const runPoll = async () => {
      if (!isMountedRef.current) return;
      await fetchData();

      pollCountRef.current += 1;
      if (isMountedRef.current) {
        setPollCount(pollCountRef.current);
      }

      // Bounded polling: stop after maxPollCount
      if (pollCountRef.current < maxPollCount && isMountedRef.current) {
        timerRef.current = setTimeout(runPoll, pollIntervalMs);
      } else if (isMountedRef.current) {
        setIsPollingActive(false);
      }
    };

    void runPoll();

    return () => {
      isMountedRef.current = false;
      setIsPollingActive(false);
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [enabled, fetchData, maxPollCount, pollIntervalMs]);

  const isStale =
    lastUpdated !== null && now - lastUpdated > staleThresholdMs;

  // Determine aggregate display state
  let state: QueueDisplayState = 'loading';
  if (isInitialLoading) {
    state = 'loading';
  } else if (contractVersion !== null && contractVersion !== expectedVersion) {
    state = 'version_mismatch';
  } else if (errorMessage !== null && depth === null) {
    state = 'rpc_error';
  } else if (depth === 0) {
    state = 'empty';
  } else if (isStale) {
    state = 'stale';
  } else {
    state = 'active';
  }

  // Calculate estimated wait in minutes based on oldest request age and depth
  let estimatedWaitMinutes: number | null = null;
  if (oldestAgeLedgers !== null && oldestAgeLedgers > 0) {
    estimatedWaitMinutes = Math.max(
      1,
      Math.round((oldestAgeLedgers * SECONDS_PER_LEDGER) / 60),
    );
  } else if (depth !== null && depth > 0) {
    // Fallback heuristic: assume ~2 minutes processing time per queued item
    estimatedWaitMinutes = depth * 2;
  }

  const estimatedPosition = depth !== null ? (depth === 0 ? 0 : depth) : null;

  return {
    state,
    depth,
    oldestAgeLedgers,
    oldestQueuedLedger,
    estimatedWaitMinutes,
    estimatedPosition,
    specificRequest,
    contractVersion,
    lastUpdated,
    isStale,
    errorMessage,
    pollCount,
    isPollingActive,
    settlementDisclaimer: SETTLEMENT_TIME_DISCLAIMER,
    refetch: fetchData,
  };
}
