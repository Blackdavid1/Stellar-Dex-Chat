'use client';

import React from 'react';
import {
  CheckCircle,
  Clock,
  XCircle,
  RefreshCw,
  Loader2,
  ShieldCheck,
  Building,
} from 'lucide-react';
import CopyButton from '@/components/ui/CopyButton';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import SkeletonTimeline from '@/components/ui/skeleton/SkeletonTimeline';
import type {
  StageState,
  StageEvent,
  ResumableTransferState,
  TransferStageId,
  EventSource,
} from '@/lib/transferStatusReconciler';

export type TransferStatus =
  | 'initiated'
  | 'pending'
  | 'submitting'
  | 'confirmed'
  | 'success'
  | 'failed'
  | 'reversed'
  | 'cancelled'
  | 'idle';

export interface StatusEvent {
  status: TransferStatus;
  timestamp: Date | string;
  label?: string;
  copyValue?: string;
  stage?: TransferStageId;
  source?: EventSource;
}

export interface TransferTimelineProps {
  /** Ordered list of status transitions from oldest to newest */
  events: (StatusEvent | StageEvent)[];
  /** Whether a poll is currently in-flight */
  isPolling?: boolean;
  /** Whether the timeline data is currently loading */
  isLoading?: boolean;
  /** Optional separate linked stages */
  stages?: {
    on_chain?: StageState;
    provider?: StageState;
  };
  /** Optional full resumable transfer state */
  state?: ResumableTransferState;
}

/**
 * WCAG 2.1 AA accessible badge color tokens.
 * All combinations achieve ≥ 4.5:1 contrast ratio.
 */
const STATUS_META: Record<
  string,
  { icon: React.ReactNode; color: string; label: string; defaultLabel: string }
> = {
  initiated: {
    icon: <Clock className="w-4 h-4" />,
    color: 'text-blue-700 border-blue-700 bg-blue-100 dark:text-blue-200 dark:border-blue-700 dark:bg-blue-900',
    label: 'Status: initiated',
    defaultLabel: 'Transfer initiated',
  },
  pending: {
    icon: <Loader2 className="w-4 h-4 animate-spin" />,
    color: 'text-amber-800 border-amber-700 bg-amber-100 dark:text-amber-200 dark:border-amber-700 dark:bg-amber-900',
    label: 'Status: pending',
    defaultLabel: 'Pending processing',
  },
  submitting: {
    icon: <Loader2 className="w-4 h-4 animate-spin" />,
    color: 'text-indigo-800 border-indigo-700 bg-indigo-100 dark:text-indigo-200 dark:border-indigo-700 dark:bg-indigo-900',
    label: 'Status: submitting',
    defaultLabel: 'Submitting transaction',
  },
  confirmed: {
    icon: <CheckCircle className="w-4 h-4" />,
    color: 'text-green-800 border-green-700 bg-green-100 dark:text-green-200 dark:border-green-700 dark:bg-green-900',
    label: 'Status: confirmed',
    defaultLabel: 'Blockchain confirmed',
  },
  success: {
    icon: <CheckCircle className="w-4 h-4" />,
    color: 'text-green-800 border-green-700 bg-green-100 dark:text-green-200 dark:border-green-700 dark:bg-green-900',
    label: 'Status: success',
    defaultLabel: 'Transfer successful',
  },
  failed: {
    icon: <XCircle className="w-4 h-4" />,
    color: 'text-red-800 border-red-700 bg-red-100 dark:text-red-200 dark:border-red-700 dark:bg-red-900',
    label: 'Status: failed',
    defaultLabel: 'Transfer failed',
  },
  reversed: {
    icon: <RefreshCw className="w-4 h-4" />,
    color: 'text-purple-800 border-purple-700 bg-purple-100 dark:text-purple-200 dark:border-purple-700 dark:bg-purple-900',
    label: 'Status: reversed',
    defaultLabel: 'Transfer reversed',
  },
  cancelled: {
    icon: <XCircle className="w-4 h-4" />,
    color: 'text-gray-700 border-gray-600 bg-gray-100 dark:text-gray-200 dark:border-gray-600 dark:bg-gray-800',
    label: 'Status: cancelled',
    defaultLabel: 'Transfer cancelled',
  },
  idle: {
    icon: <Clock className="w-4 h-4" />,
    color: 'text-gray-600 border-gray-500 bg-gray-100 dark:text-gray-300 dark:border-gray-600 dark:bg-gray-800',
    label: 'Status: idle',
    defaultLabel: 'Awaiting prior stage',
  },
};

function formatEventTime(dateInput: Date | string): string {
  const date = typeof dateInput === 'string' ? new Date(dateInput) : dateInput;
  return date.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function formatSourceLabel(source?: EventSource): string {
  switch (source) {
    case 'on_chain':
      return 'On-Chain';
    case 'rpc':
      return 'Stellar RPC';
    case 'push':
      return 'Push Webhook';
    case 'polling':
      return 'Server Poll';
    case 'provider':
      return 'Provider API';
    default:
      return '';
  }
}

/**
 * TransferTimeline — renders an ordered vertical timeline of payout status
 * transitions across linked on-chain and provider stages.
 */
export default function TransferTimeline({
  events,
  isPolling = false,
  isLoading = false,
  stages,
  state,
}: TransferTimelineProps) {
  const prefersReducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)');

  if (isLoading) {
    return <SkeletonTimeline />;
  }

  const effectiveEvents = state?.events ?? events;
  const effectiveStages = state?.stages ?? stages;

  if (effectiveEvents.length === 0 && !effectiveStages) {
    return (
      <p className="theme-text-muted text-xs text-center py-4">
        No status events yet.
      </p>
    );
  }

  const currentEvent = effectiveEvents[effectiveEvents.length - 1];
  const currentMeta = currentEvent
    ? (STATUS_META[currentEvent.status] ?? STATUS_META.pending)
    : STATUS_META.pending;

  const accessibleAnnouncement =
    state?.announcement ||
    (currentEvent
      ? `${currentMeta.label}. ${currentEvent.label ?? currentMeta.defaultLabel}`
      : 'Transfer in progress');

  return (
    <div className="relative space-y-4" aria-label="Transfer status timeline">
      {/* Accessibility: Live region to announce status changes */}
      <div
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
        role="status"
      >
        {accessibleAnnouncement}
      </div>

      {/* Linked Stages Display (if stages are provided) */}
      {effectiveStages && (
        <div className="space-y-3 mb-4" data-testid="linked-stages">
          {/* Stage 1: On-Chain Stage */}
          {effectiveStages.on_chain && (
            <div
              className="p-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]"
              data-testid="stage-on-chain"
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <ShieldCheck className="w-4 h-4 text-blue-500" />
                  <span className="text-xs font-semibold uppercase tracking-wider text-[var(--color-text-secondary)]">
                    Blockchain Confirmation
                  </span>
                </div>
                <span className="text-[11px] font-mono px-2 py-0.5 rounded bg-blue-100 text-blue-800 dark:bg-blue-900/60 dark:text-blue-300">
                  {formatSourceLabel(effectiveStages.on_chain.source) || 'On-Chain'}
                </span>
              </div>
              <div className="mt-2 flex items-center justify-between text-xs">
                <span className="font-medium capitalize text-[var(--color-text-primary)]">
                  {effectiveStages.on_chain.label ?? effectiveStages.on_chain.status}
                </span>
                <span className="text-[11px] text-[var(--color-text-muted)]">
                  Updated: {formatEventTime(effectiveStages.on_chain.lastUpdated)}
                </span>
              </div>
            </div>
          )}

          {/* Stage 2: Provider Stage */}
          {effectiveStages.provider && (
            <div
              className="p-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]"
              data-testid="stage-provider"
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Building className="w-4 h-4 text-emerald-500" />
                  <span className="text-xs font-semibold uppercase tracking-wider text-[var(--color-text-secondary)]">
                    Fiat Settlement
                  </span>
                </div>
                <span className="text-[11px] font-mono px-2 py-0.5 rounded bg-emerald-100 text-emerald-800 dark:bg-emerald-900/60 dark:text-emerald-300">
                  {formatSourceLabel(effectiveStages.provider.source) || 'Provider'}
                </span>
              </div>
              <div className="mt-2 flex items-center justify-between text-xs">
                <span className="font-medium capitalize text-[var(--color-text-primary)]">
                  {effectiveStages.provider.label ?? effectiveStages.provider.status}
                </span>
                <span className="text-[11px] text-[var(--color-text-muted)]">
                  Updated: {formatEventTime(effectiveStages.provider.lastUpdated)}
                </span>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Events Timeline */}
      <div className="relative">
        {/* Vertical connector line */}
        <span
          className="absolute left-[19px] top-5 bottom-5 w-px bg-[var(--color-border)]"
          aria-hidden="true"
        />

        <ol className="space-y-4">
          {effectiveEvents.map((event, idx) => {
            const meta = STATUS_META[event.status] ?? STATUS_META.pending;
            const isLast = idx === effectiveEvents.length - 1;
            const sourceLabel = formatSourceLabel(event.source);

            return (
              <li
                key={('id' in event && event.id) ? event.id : `${event.status}-${idx}`}
                className="flex items-start gap-3"
              >
                {/* Status icon badge — WCAG 2.1 AA accessible colors (#307) */}
                <span
                  aria-label={meta.label}
                  role="img"
                  className={`relative z-10 flex-shrink-0 w-9 h-9 rounded-full border flex items-center justify-center ${meta.color}`}
                >
                  {event.status === 'pending' || event.status === 'submitting' ? (
                    <Loader2
                      className={`w-4 h-4${prefersReducedMotion ? '' : ' animate-spin'}`}
                    />
                  ) : (
                    meta.icon
                  )}
                </span>

                {/* Label + timestamp + source */}
                <div className={`flex-1 pb-1 ${isLast ? 'font-medium' : ''}`}>
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <p
                      className={`text-sm ${
                        isLast ? 'theme-text-primary' : 'theme-text-secondary'
                      }`}
                    >
                      {event.label ?? meta.defaultLabel}
                    </p>
                    {event.copyValue && (
                      <CopyButton value={event.copyValue} iconClassName="w-3 h-3" />
                    )}
                    {sourceLabel && (
                      <span className="text-[10px] uppercase font-mono px-1.5 py-0.5 rounded bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300">
                        {sourceLabel}
                      </span>
                    )}
                  </div>
                  <p className="theme-text-muted text-[11px] mt-0.5">
                    {formatEventTime(event.timestamp)}
                  </p>
                </div>
              </li>
            );
          })}

          {/* Live polling indicator */}
          {isPolling && (
            <li className="flex items-start gap-3 opacity-60">
              <span className="relative z-10 flex-shrink-0 w-9 h-9 rounded-full border border-dashed border-gray-500 flex items-center justify-center text-gray-500">
                <Loader2
                  className={`w-4 h-4${prefersReducedMotion ? '' : ' animate-spin'}`}
                />
              </span>
              <div className="flex-1 pb-1">
                <p className="theme-text-muted text-sm">Checking status…</p>
              </div>
            </li>
          )}
        </ol>
      </div>
    </div>
  );
}
