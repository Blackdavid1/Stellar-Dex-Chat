/**
 * transferStatusReconciler.ts
 *
 * Implements authoritative, monotonic transfer status reconciliation
 * across two linked stages:
 *   1. on_chain: Blockchain transaction confirmation
 *   2. provider: Fiat settlement with provider
 *
 * Enforces:
 *   - Monotonic state progression (terminal states cannot be reverted by delayed/out-of-order updates)
 *   - Authoritative source requirement (success is only confirmed by polling or push webhook, never optimistic HTTP 200)
 *   - De-duplication of duplicate updates
 *   - Accessible announcements for state changes
 *   - Resumable transfer state persistence (safe non-sensitive fields only)
 */

export type TransferStageId = 'on_chain' | 'provider';

export type OnChainStatus =
  | 'idle'
  | 'pending'
  | 'submitting'
  | 'confirmed'
  | 'failed';

export type ProviderStatus =
  | 'idle'
  | 'initiated'
  | 'pending'
  | 'success'
  | 'failed'
  | 'reversed'
  | 'cancelled';

export type TransferStatus = ProviderStatus | OnChainStatus;

export type EventSource = 'on_chain' | 'provider' | 'polling' | 'push' | 'rpc';

export interface StageEvent {
  id?: string;
  stage: TransferStageId;
  status: TransferStatus;
  timestamp: string; // ISO string
  source: EventSource;
  label?: string;
  copyValue?: string;
  isAuthoritative?: boolean;
}

export interface StageState {
  stage: TransferStageId;
  status: TransferStatus;
  lastUpdated: string; // ISO string
  source: EventSource;
  label?: string;
  error?: string;
  isAuthoritative?: boolean;
}

export interface ResumableTransferState {
  transferReference: string;
  overallStatus: 'pending' | 'success' | 'failed' | 'reversed' | 'cancelled';
  stages: {
    on_chain: StageState;
    provider: StageState;
  };
  events: StageEvent[];
  lastUpdated: string;
  announcement?: string;
}

const ON_CHAIN_TERMINAL_STATUSES: Set<TransferStatus> = new Set([
  'confirmed',
  'failed',
]);

const PROVIDER_TERMINAL_STATUSES: Set<TransferStatus> = new Set([
  'success',
  'failed',
  'reversed',
  'cancelled',
]);

export function isOnChainTerminal(status: TransferStatus): boolean {
  return ON_CHAIN_TERMINAL_STATUSES.has(status);
}

export function isProviderTerminal(status: TransferStatus): boolean {
  return PROVIDER_TERMINAL_STATUSES.has(status);
}

export function isStageTerminal(stage: TransferStageId, status: TransferStatus): boolean {
  return stage === 'on_chain'
    ? isOnChainTerminal(status)
    : isProviderTerminal(status);
}

/**
 * Creates an initial blank transfer state.
 */
export function createInitialTransferState(
  transferReference: string,
  now = new Date(),
): ResumableTransferState {
  const timestampStr = now.toISOString();
  return {
    transferReference,
    overallStatus: 'pending',
    stages: {
      on_chain: {
        stage: 'on_chain',
        status: 'pending',
        lastUpdated: timestampStr,
        source: 'on_chain',
        label: 'Awaiting blockchain submission',
        isAuthoritative: false,
      },
      provider: {
        stage: 'provider',
        status: 'idle',
        lastUpdated: timestampStr,
        source: 'provider',
        label: 'Pending blockchain confirmation',
        isAuthoritative: false,
      },
    },
    events: [
      {
        id: `on_chain_${Date.now()}_0`,
        stage: 'on_chain',
        status: 'pending',
        timestamp: timestampStr,
        source: 'on_chain',
        label: 'Transfer initialized on blockchain',
        isAuthoritative: false,
      },
    ],
    lastUpdated: timestampStr,
    announcement: 'Transfer initialized. Awaiting blockchain confirmation.',
  };
}

export interface StatusUpdatePayload {
  stage: TransferStageId;
  status: TransferStatus;
  source: EventSource;
  timestamp?: string | Date;
  label?: string;
  error?: string;
  copyValue?: string;
  isAuthoritative?: boolean;
}

/**
 * Reconciles an incoming status update monotonically against current transfer state.
 *
 * Rules:
 * 1. Monotonicity: Terminal status cannot be overwritten by non-terminal status.
 * 2. Stale updates: If incoming timestamp is older than stage lastUpdated and current is terminal, ignore.
 * 3. De-duplication: If incoming status and stage matches existing latest event for that stage, don't duplicate.
 * 4. Authoritative confirmation: Provider status 'success' can only be set if source is polling or push
 *    with authoritative confirmation (or isAuthoritative is true). An initial HTTP 200 response cannot set 'success'.
 */
export function reconcileTransferStatus(
  current: ResumableTransferState,
  update: StatusUpdatePayload,
): ResumableTransferState {
  const updateDate = update.timestamp
    ? new Date(update.timestamp)
    : new Date();
  const updateTimestampStr = updateDate.toISOString();
  const stage = update.stage;
  const currentStage = current.stages[stage];

  // 1. Monotonicity check: If current stage is terminal, ignore non-terminal updates
  if (isStageTerminal(stage, currentStage.status)) {
    if (!isStageTerminal(stage, update.status)) {
      // Suppress delayed or out-of-order non-terminal update
      return current;
    }
    // If both are terminal, only allow transition if identical or moving from failed to reversed
    if (currentStage.status === update.status) {
      return current;
    }
  }

  // 2. Reordered/delayed check: If timestamp is earlier than lastUpdated and stage is already progressed
  const currentLastUpdatedTime = new Date(currentStage.lastUpdated).getTime();
  if (
    updateDate.getTime() < currentLastUpdatedTime &&
    isStageTerminal(stage, currentStage.status)
  ) {
    return current;
  }

  // 3. Authoritative source rule for provider success
  if (stage === 'provider' && update.status === 'success') {
    // Only authoritative sources (polling with verified record or push webhook) can declare success
    const isAuthoritativeSource =
      update.isAuthoritative === true ||
      update.source === 'polling' ||
      update.source === 'push';

    if (!isAuthoritativeSource) {
      // Downgrade to pending with note
      return {
        ...current,
        stages: {
          ...current.stages,
          provider: {
            ...currentStage,
            status: 'pending',
            lastUpdated: updateTimestampStr,
            source: update.source,
            label: 'Processing payout — awaiting authoritative confirmation',
          },
        },
      };
    }
  }

  // 4. De-duplication check: Is this identical to the last event for this stage?
  const lastStageEvent = [...current.events]
    .reverse()
    .find((e) => e.stage === stage);

  const isDuplicate =
    lastStageEvent &&
    lastStageEvent.status === update.status &&
    lastStageEvent.source === update.source &&
    (!update.error || lastStageEvent.label?.includes(update.error));

  if (isDuplicate) {
    return current;
  }

  // Format accessible announcement for terminal/status changes
  let announcement = current.announcement;
  if (stage === 'on_chain') {
    if (update.status === 'confirmed') {
      announcement = 'Blockchain transaction confirmed.';
    } else if (update.status === 'failed') {
      announcement = `Blockchain transaction failed${update.error ? `: ${update.error}` : ''}.`;
    }
  } else if (stage === 'provider') {
    if (update.status === 'success') {
      announcement = 'Fiat payout confirmed and settled successfully.';
    } else if (update.status === 'failed') {
      announcement = `Fiat settlement failed${update.error ? `: ${update.error}` : ''}.`;
    } else if (update.status === 'reversed') {
      announcement = 'Fiat transfer reversed.';
    }
  }

  // Determine overall status
  let overallStatus = current.overallStatus;
  if (
    update.status === 'failed' ||
    current.stages.on_chain.status === 'failed' ||
    current.stages.provider.status === 'failed'
  ) {
    overallStatus = 'failed';
  } else if (
    update.status === 'reversed' ||
    current.stages.provider.status === 'reversed'
  ) {
    overallStatus = 'reversed';
  } else if (
    update.status === 'cancelled' ||
    current.stages.provider.status === 'cancelled'
  ) {
    overallStatus = 'cancelled';
  } else if (
    (stage === 'provider' && update.status === 'success') ||
    current.stages.provider.status === 'success'
  ) {
    overallStatus = 'success';
  } else {
    overallStatus = 'pending';
  }

  const newStageState: StageState = {
    stage,
    status: update.status,
    lastUpdated: updateTimestampStr,
    source: update.source,
    label: update.label,
    error: update.error,
    isAuthoritative: Boolean(update.isAuthoritative),
  };

  const newEvent: StageEvent = {
    id: `${stage}_${Date.now()}_${current.events.length}`,
    stage,
    status: update.status,
    timestamp: updateTimestampStr,
    source: update.source,
    label: update.label,
    copyValue: update.copyValue,
    isAuthoritative: Boolean(update.isAuthoritative),
  };

  return {
    transferReference: current.transferReference,
    overallStatus,
    stages: {
      ...current.stages,
      [stage]: newStageState,
    },
    events: [...current.events, newEvent],
    lastUpdated: updateTimestampStr,
    announcement,
  };
}

/**
 * Resumable transfer state persistence helpers.
 * Strictly non-sensitive data: references, status, timestamps, and stage logs.
 * NEVER stores secret keys, account numbers, or signed XDR.
 */
const RESUMABLE_TRANSFER_PREFIX = 'stellar_resumable_transfer_';

export function saveResumableTransfer(state: ResumableTransferState): void {
  if (typeof window === 'undefined' || !state.transferReference) return;
  try {
    const key = `${RESUMABLE_TRANSFER_PREFIX}${state.transferReference}`;
    localStorage.setItem(key, JSON.stringify(state));
  } catch {
    // Ignore storage quota errors
  }
}

export function loadResumableTransfer(
  transferReference: string,
): ResumableTransferState | null {
  if (typeof window === 'undefined' || !transferReference) return null;
  try {
    const key = `${RESUMABLE_TRANSFER_PREFIX}${transferReference}`;
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    return JSON.parse(raw) as ResumableTransferState;
  } catch {
    return null;
  }
}

export function clearResumableTransfer(transferReference: string): void {
  if (typeof window === 'undefined' || !transferReference) return;
  try {
    const key = `${RESUMABLE_TRANSFER_PREFIX}${transferReference}`;
    localStorage.removeItem(key);
  } catch {
    // Ignore
  }
}
