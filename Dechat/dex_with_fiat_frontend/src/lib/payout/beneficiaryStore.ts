import crypto from 'crypto';
import { serverEnv as env } from '@/lib/serverEnv';
import { telemetry } from '@/lib/telemetry';

export interface BeneficiaryRecord {
  dedupeKey: string;
  recipientCode: string;
  name: string;
  bankCode: string;
  accountNumberMasked: string;
  currency: string;
  userScope: string;
  verified: boolean;
  createdAt: string;
  updatedAt: string;
  providerData?: Record<string, unknown>;
}

export interface DeriveDedupeKeyInput {
  accountNumber: string;
  bankCode: string;
  userScope?: string;
  currency?: string;
}

export interface CreateBeneficiaryInput extends DeriveDedupeKeyInput {
  type?: string;
  name: string;
}

export interface BeneficiaryResolutionResult {
  recipientCode: string;
  name: string;
  dedupeKey: string;
  reused: boolean;
  recovered?: boolean;
}

// In-memory persistent storage for beneficiaries
const beneficiaryStore = new Map<string, BeneficiaryRecord>();

// Recovery journal for remote success followed by local persistence failure
const pendingRecoveryJournal = new Map<
  string,
  {
    recipientCode: string;
    name: string;
    bankCode: string;
    currency: string;
    userScope: string;
    timestamp: number;
  }
>();

// Coalesce concurrent requests for the same dedupe key
const inFlightRequests = new Map<
  string,
  Promise<BeneficiaryResolutionResult>
>();

// Failure injection hook for automated testing
let simulatedCommitFailureTarget: string | null = null;

export function _injectCommitFailureOnce(targetKey?: string): void {
  simulatedCommitFailureTarget = targetKey || '__ANY__';
}

export function maskAccountNumber(accountNumber: string): string {
  const digits = accountNumber.replace(/\D/g, '');
  if (digits.length <= 4) {
    return '****';
  }
  const last4 = digits.slice(-4);
  return `${'*'.repeat(Math.max(4, digits.length - 4))}${last4}`;
}

export function normalizeAccountDetails(input: DeriveDedupeKeyInput): {
  normalizedAccount: string;
  normalizedBank: string;
  normalizedScope: string;
  normalizedCurrency: string;
} {
  const normalizedAccount = input.accountNumber.replace(/\D/g, '').trim();
  const normalizedBank = input.bankCode.trim().toLowerCase();
  const normalizedScope = (input.userScope || 'global').trim().toLowerCase();
  const normalizedCurrency = (input.currency || 'NGN').trim().toUpperCase();

  return {
    normalizedAccount,
    normalizedBank,
    normalizedScope,
    normalizedCurrency,
  };
}

export function deriveBeneficiaryDedupeKey(
  input: DeriveDedupeKeyInput,
): string {
  const {
    normalizedAccount,
    normalizedBank,
    normalizedScope,
    normalizedCurrency,
  } = normalizeAccountDetails(input);

  const secret =
    env.PAYSTACK_SECRET_KEY ||
    process.env.BENEFICIARY_DEDUPE_SECRET ||
    'stellar-dex-chat-beneficiary-salt-v1';

  const payload = `${normalizedScope}:${normalizedBank}:${normalizedAccount}:${normalizedCurrency}`;

  // Privacy-preserving HMAC-SHA256 hash. Raw account number is never exposed.
  const hash = crypto
    .createHmac('sha256', secret)
    .update(payload)
    .digest('hex');

  return `bdk_${hash}`;
}

export function getBeneficiaryByDedupeKey(
  dedupeKey: string,
): BeneficiaryRecord | undefined {
  return beneficiaryStore.get(dedupeKey);
}

export function saveBeneficiary(record: BeneficiaryRecord): BeneficiaryRecord {
  // Check if simulated failure is targeted
  if (
    simulatedCommitFailureTarget &&
    (simulatedCommitFailureTarget === '__ANY__' ||
      simulatedCommitFailureTarget === record.dedupeKey)
  ) {
    simulatedCommitFailureTarget = null;
    throw new Error('Local persistence failure: simulated storage write error');
  }

  beneficiaryStore.set(record.dedupeKey, record);
  return record;
}

export function getPendingRecovery(dedupeKey: string) {
  return pendingRecoveryJournal.get(dedupeKey);
}

export function clearBeneficiaryStore(): void {
  beneficiaryStore.clear();
  pendingRecoveryJournal.clear();
  inFlightRequests.clear();
  simulatedCommitFailureTarget = null;
}

/**
 * Race-safe resolution of a beneficiary recipient.
 * If concurrent requests for the same account arrive, only one calls remote provider.
 * If an identical verified beneficiary already exists, reuse provider reference.
 * If remote success occurred but local persistence previously failed, idempotently recover without remote call.
 */
export async function getOrCreateBeneficiary(
  input: CreateBeneficiaryInput,
  callRemoteProvider: () => Promise<Record<string, unknown>>,
): Promise<BeneficiaryResolutionResult> {
  const dedupeKey = deriveBeneficiaryDedupeKey(input);
  const now = new Date().toISOString();
  const { normalizedBank, normalizedCurrency, normalizedScope } =
    normalizeAccountDetails(input);

  // 1. Check persistent store for existing verified beneficiary
  const existing = beneficiaryStore.get(dedupeKey);
  if (existing) {
    telemetry.addLog(
      'beneficiary',
      'info',
      'Reusing existing beneficiary provider reference',
      {
        dedupeKey,
        recipientCode: existing.recipientCode,
      },
    );
    return {
      recipientCode: existing.recipientCode,
      name: existing.name,
      dedupeKey,
      reused: true,
    };
  }

  // 2. Check idempotent recovery journal (provider succeeded earlier, but local commit failed)
  const pending = pendingRecoveryJournal.get(dedupeKey);
  if (pending) {
    telemetry.addLog(
      'beneficiary',
      'warn',
      'Recovering previously uncommitted provider recipient',
      {
        dedupeKey,
        recipientCode: pending.recipientCode,
      },
    );

    const recoveredRecord: BeneficiaryRecord = {
      dedupeKey,
      recipientCode: pending.recipientCode,
      name: pending.name,
      bankCode: pending.bankCode,
      accountNumberMasked: maskAccountNumber(input.accountNumber),
      currency: pending.currency,
      userScope: pending.userScope,
      verified: true,
      createdAt: new Date(pending.timestamp).toISOString(),
      updatedAt: now,
    };

    saveBeneficiary(recoveredRecord);
    pendingRecoveryJournal.delete(dedupeKey);

    return {
      recipientCode: recoveredRecord.recipientCode,
      name: recoveredRecord.name,
      dedupeKey,
      reused: true,
      recovered: true,
    };
  }

  // 3. Concurrency deduplication: if an identical creation is already in-flight, coalesce onto it
  const inFlight = inFlightRequests.get(dedupeKey);
  if (inFlight) {
    telemetry.addLog(
      'beneficiary',
      'info',
      'Coalescing concurrent recipient creation request',
      {
        dedupeKey,
      },
    );
    const result = await inFlight;
    return {
      ...result,
      reused: true,
    };
  }

  // 4. Execute creation with in-flight lock
  const creationPromise = (async (): Promise<BeneficiaryResolutionResult> => {
    try {
      // Call remote provider
      const remoteResult = await callRemoteProvider();
      const recipientCode = String(
        remoteResult.recipient_code ||
          (remoteResult.data as Record<string, unknown> | undefined)
            ?.recipient_code ||
          '',
      );

      if (!recipientCode) {
        throw new Error('Provider response did not contain a recipient_code');
      }

      const recipientName =
        (remoteResult.name as string) ||
        ((remoteResult.data as Record<string, unknown> | undefined)
          ?.name as string) ||
        input.name;

      // Log into recovery journal immediately upon remote success
      pendingRecoveryJournal.set(dedupeKey, {
        recipientCode,
        name: recipientName,
        bankCode: normalizedBank,
        currency: normalizedCurrency,
        userScope: normalizedScope,
        timestamp: Date.now(),
      });

      // Commit to persistent local storage
      const newRecord: BeneficiaryRecord = {
        dedupeKey,
        recipientCode,
        name: recipientName,
        bankCode: normalizedBank,
        accountNumberMasked: maskAccountNumber(input.accountNumber),
        currency: normalizedCurrency,
        userScope: normalizedScope,
        verified: true,
        createdAt: now,
        updatedAt: now,
        providerData: remoteResult,
      };

      saveBeneficiary(newRecord);

      // Local commit succeeded: remove from pending recovery journal
      pendingRecoveryJournal.delete(dedupeKey);

      return {
        recipientCode,
        name: recipientName,
        dedupeKey,
        reused: false,
      };
    } finally {
      inFlightRequests.delete(dedupeKey);
    }
  })();

  inFlightRequests.set(dedupeKey, creationPromise);
  return creationPromise;
}
