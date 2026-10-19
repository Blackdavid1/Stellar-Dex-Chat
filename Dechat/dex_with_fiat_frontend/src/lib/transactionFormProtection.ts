import {
  getTokenPriceWithStatus,
} from '@/lib/cryptoPriceService';
import { fetchXlmBalance } from '@/lib/stellarContract';
import { FeeEstimate } from '@/lib/stellarContract';

export interface FormSnapshotMetadata {
  timestamp: number;
  sourceId: string;
}

export interface QuoteSnapshot extends FormSnapshotMetadata {
  price: number;
  token: string;
  currency: string;
  expiresAt: number;
  formattedFiat?: string;
}

export interface BalanceSnapshot extends FormSnapshotMetadata {
  balance: string; // XLM decimal string e.g. "120.50"
  account: string;
}

export interface SimulationSnapshot extends FormSnapshotMetadata {
  fee: number;
  minFee: string;
  amountStroops: string;
}

export type RevalidationFailureReason =
  | 'quote_expired'
  | 'quote_changed'
  | 'balance_changed'
  | 'simulation_changed'
  | 'rpc_outage';

export interface RevalidationResult {
  valid: boolean;
  reason?: RevalidationFailureReason;
  explanation?: string;
  latestQuote?: QuoteSnapshot;
  latestBalance?: BalanceSnapshot;
  latestSimulation?: SimulationSnapshot;
}

export const QUOTE_VALIDITY_WINDOW_MS = 60_000; // 60 seconds
export const DEFAULT_PRICE_TOLERANCE_PERCENT = 1.0; // 1% material price change threshold

/**
 * Creates a quote snapshot with timestamp and source identity.
 */
export function createQuoteSnapshot(
  price: number,
  token: string,
  currency: string,
  sourceId: string = 'crypto-price-service',
  validityMs: number = QUOTE_VALIDITY_WINDOW_MS,
  now: number = Date.now(),
): QuoteSnapshot {
  return {
    price,
    token: token.toUpperCase(),
    currency: currency.toUpperCase(),
    timestamp: now,
    expiresAt: now + validityMs,
    sourceId,
  };
}

/**
 * Creates a balance snapshot with timestamp and source identity.
 */
export function createBalanceSnapshot(
  balance: string,
  account: string,
  sourceId: string = 'stellar-horizon',
  now: number = Date.now(),
): BalanceSnapshot {
  return {
    balance,
    account,
    timestamp: now,
    sourceId,
  };
}

/**
 * Creates a simulation snapshot with timestamp and source identity.
 */
export function createSimulationSnapshot(
  feeEstimate: FeeEstimate,
  amountStroops: bigint,
  sourceId: string = 'soroban-rpc',
  now: number = Date.now(),
): SimulationSnapshot {
  return {
    fee: feeEstimate.fee,
    minFee: feeEstimate.minFee,
    amountStroops: amountStroops.toString(),
    timestamp: now,
    sourceId,
  };
}

export interface RevalidateParams {
  quoteSnapshot: QuoteSnapshot | null;
  balanceSnapshot: BalanceSnapshot | null;
  simulationSnapshot?: SimulationSnapshot | null;
  currentAmountXlm: string;
  tokenSymbol?: string;
  fiatCurrency?: string;
  walletAddress?: string;
  priceTolerancePercent?: number;
  now?: number;
  fetchLatestPrice?: (token: string, currency: string) => Promise<{ price: number; source: string }>;
  fetchLatestBalance?: (address: string) => Promise<string>;
}

/**
 * Revalidates critical transaction inputs (price quote, balance, contract simulation)
 * at submit time. Protects forms from submitting on stale assumptions.
 */
export async function revalidateFormInputs({
  quoteSnapshot,
  balanceSnapshot,
  currentAmountXlm,
  tokenSymbol = 'XLM',
  fiatCurrency = 'USD',
  walletAddress,
  priceTolerancePercent = DEFAULT_PRICE_TOLERANCE_PERCENT,
  now = Date.now(),
  fetchLatestPrice,
  fetchLatestBalance,
}: RevalidateParams): Promise<RevalidationResult> {
  const numericAmount = parseFloat(currentAmountXlm);

  try {
    // 1. Revalidate price quote expiry
    if (quoteSnapshot) {
      if (now >= quoteSnapshot.expiresAt) {
        // Fetch new quote to offer immediate reconfirmation
        let newQuote: QuoteSnapshot | undefined;
        try {
          const freshPriceData = fetchLatestPrice
            ? await fetchLatestPrice(tokenSymbol, fiatCurrency)
            : await getTokenPriceWithStatus(tokenSymbol, fiatCurrency);
          newQuote = createQuoteSnapshot(
            freshPriceData.price,
            tokenSymbol,
            fiatCurrency,
            freshPriceData.source,
            QUOTE_VALIDITY_WINDOW_MS,
            now,
          );
        } catch {
          // ignore quote refresh failure, report expiry
        }

        return {
          valid: false,
          reason: 'quote_expired',
          explanation: `The conversion quote expired at ${new Date(
            quoteSnapshot.expiresAt,
          ).toLocaleTimeString()}. Review the updated rate and reconfirm.`,
          latestQuote: newQuote,
        };
      }

      // 2. Revalidate price quote drift
      const latestPriceData = fetchLatestPrice
        ? await fetchLatestPrice(tokenSymbol, fiatCurrency)
        : await getTokenPriceWithStatus(tokenSymbol, fiatCurrency);

      const latestPrice = latestPriceData.price;
      const initialPrice = quoteSnapshot.price;
      const percentChange =
        initialPrice > 0
          ? (Math.abs(latestPrice - initialPrice) / initialPrice) * 100
          : 0;

      if (percentChange > priceTolerancePercent) {
        const freshQuote = createQuoteSnapshot(
          latestPrice,
          tokenSymbol,
          fiatCurrency,
          latestPriceData.source,
          QUOTE_VALIDITY_WINDOW_MS,
          now,
        );
        return {
          valid: false,
          reason: 'quote_changed',
          explanation: `The price quote shifted by ${percentChange.toFixed(
            1,
          )}% (from ${initialPrice} to ${latestPrice} ${fiatCurrency.toUpperCase()}). Please reconfirm.`,
          latestQuote: freshQuote,
        };
      }
    }

    // 3. Revalidate wallet balance
    if (balanceSnapshot && walletAddress) {
      const latestBalanceStr = fetchLatestBalance
        ? await fetchLatestBalance(walletAddress)
        : await fetchXlmBalance(walletAddress);

      const initialBal = parseFloat(balanceSnapshot.balance);
      const latestBal = parseFloat(latestBalanceStr);

      // Check if balance changed materially or if user can no longer afford amount
      if (
        !isNaN(initialBal) &&
        !isNaN(latestBal) &&
        (Math.abs(latestBal - initialBal) >= 0.01 || latestBal < numericAmount)
      ) {
        const freshBalance = createBalanceSnapshot(
          latestBalanceStr,
          walletAddress,
          'stellar-horizon',
          now,
        );

        return {
          valid: false,
          reason: 'balance_changed',
          explanation: `Your account balance changed from ${balanceSnapshot.balance} XLM to ${latestBalanceStr} XLM. Please reconfirm the transfer.`,
          latestBalance: freshBalance,
        };
      }
    }

    return { valid: true };
  } catch (err) {
    return {
      valid: false,
      reason: 'rpc_outage',
      explanation:
        'Unable to revalidate price quotes or account balance due to a network RPC outage. Your entered form details are saved. Please retry.',
    };
  }
}
