import { getPayoutProvider } from './providers/registry';
import {
  getTransferStatus,
  setTransferStatus,
  TransferStatusRecord,
} from '@/lib/transferStore';
import { executeWithTimeoutBudget, TimeoutOutcome } from './timeoutBudget';

export interface ReconciliationResult {
  reference: string;
  reconciled: boolean;
  outcome: TimeoutOutcome;
  record?: TransferStatusRecord;
  error?: string;
}

/**
 * Reconciles an ambiguous transfer initiation by querying the provider's authoritative status.
 * Prevents unsafe duplicate retries by ensuring the transfer's real status on the provider
 * is determined and persisted.
 */
export async function reconcileAmbiguousInitiation(
  reference: string,
  credentialVersion?: string,
): Promise<ReconciliationResult> {
  const existing = getTransferStatus(reference);
  const provider = getPayoutProvider();

  try {
    const statusData = await executeWithTimeoutBudget(
      'status',
      async () => {
        // Query provider with the specific credential version used during initiation if supported
        return await provider.checkTransferStatus({
          reference,
          credentialVersion,
        });
      },
      { reference },
    );

    // Provider found the transfer
    const providerStatus = (
      typeof statusData.status === 'string'
        ? statusData.status.toLowerCase()
        : 'pending'
    ) as TransferStatusRecord['status'];

    const validStatuses: TransferStatusRecord['status'][] = [
      'pending',
      'success',
      'failed',
      'reversed',
      'cancelled',
    ];
    const resolvedStatus = validStatuses.includes(providerStatus)
      ? providerStatus
      : 'pending';

    const updatedRecord = setTransferStatus({
      reference,
      status: resolvedStatus,
      amount: existing?.amount ?? Number(statusData.amount ?? 0),
      updatedAt: new Date().toISOString(),
      clientSessionId: existing?.clientSessionId,
      credentialVersion: existing?.credentialVersion ?? credentialVersion,
      timeoutOutcome: 'known',
      reconciled: true,
      failureReason:
        (statusData.failure_reason as string) || existing?.failureReason,
    });

    return {
      reference,
      reconciled: true,
      outcome: 'known',
      record: updatedRecord,
    };
  } catch (error: unknown) {
    // Check if error is a 404 from provider (meaning transfer definitely never existed)
    const isNotFound =
      error !== null &&
      typeof error === 'object' &&
      'response' in error &&
      (error as { response?: { status?: number } }).response?.status === 404;

    if (isNotFound) {
      const updatedRecord = setTransferStatus({
        reference,
        status: 'failed',
        amount: existing?.amount ?? 0,
        updatedAt: new Date().toISOString(),
        clientSessionId: existing?.clientSessionId,
        credentialVersion: existing?.credentialVersion ?? credentialVersion,
        timeoutOutcome: 'rejected',
        reconciled: true,
        failureReason:
          'Transfer not found on provider; rejected before initiation',
      });

      return {
        reference,
        reconciled: true,
        outcome: 'rejected',
        record: updatedRecord,
      };
    }

    // Still ambiguous (e.g., status check itself timed out)
    const errMessage =
      error instanceof Error ? error.message : 'Status check failed';
    const updatedRecord = setTransferStatus({
      reference,
      status: existing?.status ?? 'pending',
      amount: existing?.amount ?? 0,
      updatedAt: new Date().toISOString(),
      clientSessionId: existing?.clientSessionId,
      credentialVersion: existing?.credentialVersion ?? credentialVersion,
      timeoutOutcome: 'ambiguous',
      reconciled: false,
      lastError: errMessage,
    });

    return {
      reference,
      reconciled: false,
      outcome: 'ambiguous',
      record: updatedRecord,
      error: errMessage,
    };
  }
}
