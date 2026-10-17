'use client';

import React from 'react';
import {
  useWithdrawalQueueStatus,
  WithdrawalQueueStatusOptions,
} from '@/hooks/useWithdrawalQueueStatus';
import {
  Clock,
  AlertTriangle,
  RefreshCw,
  CheckCircle2,
  Info,
  Loader2,
} from 'lucide-react';

export interface WithdrawalQueueStatusProps extends WithdrawalQueueStatusOptions {
  className?: string;
  onRefresh?: () => void;
}

export function WithdrawalQueueStatus({
  className = '',
  onRefresh,
  ...options
}: WithdrawalQueueStatusProps) {
  const {
    state,
    depth,
    oldestAgeLedgers,
    estimatedWaitMinutes,
    estimatedPosition,
    specificRequest,
    isStale,
    errorMessage,
    settlementDisclaimer,
    refetch,
  } = useWithdrawalQueueStatus(options);

  const handleRefresh = async () => {
    await refetch();
    onRefresh?.();
  };

  if (state === 'loading') {
    return (
      <div
        data-testid="queue-status-loading"
        className={`theme-surface-muted theme-border rounded-xl border p-4 flex items-center gap-3 text-sm text-gray-400 ${className}`}
      >
        <Loader2 className="w-4 h-4 animate-spin text-blue-400 shrink-0" />
        <span>Loading withdrawal queue status…</span>
      </div>
    );
  }

  if (state === 'version_mismatch') {
    return (
      <div
        data-testid="queue-status-version-mismatch"
        className={`bg-amber-950/40 border border-amber-600/50 rounded-xl p-4 text-xs text-amber-200 ${className}`}
      >
        <div className="flex items-center gap-2 font-semibold mb-1 text-amber-300">
          <AlertTriangle className="w-4 h-4 shrink-0 text-amber-400" />
          <span>Contract Version Mismatch</span>
        </div>
        <p>
          {errorMessage ||
            'The connected contract interface differs from expected version. Queue depth estimates may be inaccurate.'}
        </p>
      </div>
    );
  }

  if (state === 'rpc_error') {
    return (
      <div
        data-testid="queue-status-rpc-error"
        className={`bg-red-950/40 border border-red-600/50 rounded-xl p-4 text-xs text-red-200 ${className}`}
      >
        <div className="flex items-center justify-between gap-2 mb-2">
          <div className="flex items-center gap-2 font-semibold text-red-300">
            <AlertTriangle className="w-4 h-4 shrink-0 text-red-400" />
            <span>Queue Status Unavailable</span>
          </div>
          <button
            type="button"
            onClick={handleRefresh}
            className="inline-flex items-center gap-1 text-[11px] underline hover:text-white"
          >
            <RefreshCw className="w-3 h-3" /> Retry
          </button>
        </div>
        <p className="text-gray-300">
          {errorMessage || 'Failed to communicate with Stellar RPC node.'}
        </p>
      </div>
    );
  }

  if (state === 'empty') {
    return (
      <div
        data-testid="queue-status-empty"
        className={`theme-surface-muted theme-border rounded-xl border p-4 text-xs ${className}`}
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-green-400 font-medium">
            <CheckCircle2 className="w-4 h-4 shrink-0" />
            <span>Withdrawal Queue is Empty</span>
          </div>
          <span className="text-[10px] text-gray-500 font-mono">0 pending</span>
        </div>
        <p className="text-gray-400 mt-1 text-[11px]">
          No pending withdrawal requests. New requests will enter with immediate operational priority.
        </p>
      </div>
    );
  }

  // Active or Stale state
  return (
    <div
      data-testid="queue-status-active"
      className={`theme-surface-muted theme-border rounded-xl border p-4 space-y-3 ${className}`}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Clock className="w-4 h-4 text-blue-400 shrink-0" />
          <span className="text-xs font-semibold theme-text-primary">
            Withdrawal Queue Status
          </span>
          {isStale && (
            <span
              data-testid="queue-status-stale"
              className="text-[10px] bg-amber-500/20 text-amber-300 border border-amber-500/30 px-1.5 py-0.5 rounded"
            >
              Stale Data
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={handleRefresh}
          title="Refresh queue status"
          className="p-1 text-gray-400 hover:text-gray-200 transition-colors"
        >
          <RefreshCw className="w-3.5 h-3.5" />
        </button>
      </div>

      <div className="grid grid-cols-2 gap-2 text-xs">
        <div className="theme-surface rounded-lg p-2.5 border theme-border">
          <span className="text-gray-400 text-[10px] block uppercase tracking-wider mb-0.5">
            Queue Depth
          </span>
          <span className="font-bold text-sm theme-text-primary">
            {depth} {depth === 1 ? 'request' : 'requests'}
          </span>
        </div>

        <div className="theme-surface rounded-lg p-2.5 border theme-border">
          <span className="text-gray-400 text-[10px] block uppercase tracking-wider mb-0.5">
            Oldest Pending Age
          </span>
          <span className="font-bold text-sm theme-text-primary">
            {oldestAgeLedgers !== null && oldestAgeLedgers > 0
              ? `${oldestAgeLedgers} ledgers`
              : 'Recent'}
            {estimatedWaitMinutes !== null && ` (~${estimatedWaitMinutes}m)`}
          </span>
        </div>
      </div>

      {estimatedPosition !== null && (
        <div className="flex items-center justify-between text-xs px-1">
          <span className="text-gray-400">Estimated Queue Position:</span>
          <span className="font-semibold text-blue-400">#{estimatedPosition + 1}</span>
        </div>
      )}

      {specificRequest && (
        <div className="border-t theme-border pt-2 text-xs text-gray-300">
          <span className="text-gray-400 block text-[10px]">Specific Request #{specificRequest.id.toString()}:</span>
          <span>Queued at ledger {specificRequest.queuedAtLedger}</span>
        </div>
      )}

      {/* Differentiate queue estimate from guaranteed settlement time */}
      <div className="flex items-start gap-1.5 bg-blue-950/30 border border-blue-800/40 rounded-lg p-2.5 text-[11px] text-blue-200">
        <Info className="w-3.5 h-3.5 text-blue-400 shrink-0 mt-0.5" />
        <span className="leading-snug">{settlementDisclaimer}</span>
      </div>
    </div>
  );
}

export default WithdrawalQueueStatus;
