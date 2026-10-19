/**
 * @fileoverview Exact integer arithmetic and precision-safe amount utilities for Stellar assets.
 *
 * Eliminates IEEE-754 floating-point conversion from token amount parsing, formatting,
 * and form entry. Parses decimal strings directly into bounded integer stroops / base units
 * using token precision metadata and arbitrary-precision native BigInt arithmetic.
 */

export interface TokenPrecisionMetadata {
  /** Number of decimal places used by the asset (e.g. 7 for XLM, 6 for USDC, 18 for ERC-20). */
  decimals: number;
  /** Maximum allowable stroops / base units (defaults to signed 128-bit integer max: 2^127 - 1). */
  maxAmount?: bigint;
  /** Asset symbol or identifier (e.g. 'XLM', 'USDC'). */
  symbol?: string;
}

/** Standard precision for Stellar Lumens (XLM) and SAC native contracts (10^7). */
export const STELLAR_NATIVE_DECIMALS = 7;

/** Maximum signed 128-bit integer (Soroban i128 max value: 2^127 - 1). */
export const MAX_I128 = (1n << 127n) - 1n;

/** Maximum signed 64-bit integer (Stellar int64 max value: 2^63 - 1). */
export const MAX_INT64 = (1n << 63n) - 1n;

export type AmountErrorCode =
  | 'EMPTY'
  | 'NEGATIVE'
  | 'EXPONENT'
  | 'EXCESS_DECIMALS'
  | 'MALFORMED'
  | 'OVERFLOW'
  | 'ZERO';

export interface ParseAmountSuccess {
  success: true;
  stroops: bigint;
  canonical: string;
  decimals: number;
}

export interface ParseAmountError {
  success: false;
  error: string;
  code: AmountErrorCode;
}

export type ParseAmountResult = ParseAmountSuccess | ParseAmountError;

/**
 * Parses a user-entered decimal string into bounded integer stroops using exact
 * string splitting and BigInt arithmetic, without ever converting through Number or float.
 *
 * Provides granular, field-level error messages rejecting:
 * - Empty / whitespace-only inputs
 * - Exponential notation (e.g. "1e-5", "2e3")
 * - Negative values
 * - Non-numeric or malformed strings
 * - Sub-stroop precision exceeding token metadata decimals
 * - Integer overflow beyond bounded limits
 *
 * @param input - Human-readable decimal string (e.g. "100.5", "0.0000001").
 * @param metadata - Token precision configuration (decimals, maxAmount, symbol).
 * @returns Result object with `success: true` and `stroops: bigint`, or `success: false` and `error: string`.
 */
export function parseAssetAmount(
  input: string | number,
  metadata?: Partial<TokenPrecisionMetadata>,
): ParseAmountResult {
  const decimals = metadata?.decimals ?? STELLAR_NATIVE_DECIMALS;
  const maxAmount = metadata?.maxAmount ?? MAX_I128;

  if (decimals < 0 || decimals > 18 || !Number.isInteger(decimals)) {
    return {
      success: false,
      error: `Invalid token precision: ${decimals}`,
      code: 'MALFORMED',
    };
  }

  const raw = String(input).trim();

  if (!raw) {
    return {
      success: false,
      error: 'Amount is required',
      code: 'EMPTY',
    };
  }

  // Reject scientific / exponential notation
  if (/[eE]/.test(raw)) {
    return {
      success: false,
      error: 'Exponential notation is not supported',
      code: 'EXPONENT',
    };
  }

  // Reject negative numbers
  if (raw.startsWith('-') || raw.includes('-')) {
    return {
      success: false,
      error: 'Amount cannot be negative',
      code: 'NEGATIVE',
    };
  }

  // Reject plus sign or invalid non-digit/dot characters
  if (!/^\d*(?:\.\d*)?$/.test(raw) || raw === '.') {
    return {
      success: false,
      error: 'Invalid amount format',
      code: 'MALFORMED',
    };
  }

  const parts = raw.split('.');
  if (parts.length > 2) {
    return {
      success: false,
      error: 'Invalid amount format',
      code: 'MALFORMED',
    };
  }

  const wholeStr = parts[0] || '0';
  const fracStr = parts[1] || '';

  if (fracStr.length > decimals) {
    return {
      success: false,
      error: `Exceeds maximum precision of ${decimals} decimal place${decimals === 1 ? '' : 's'}`,
      code: 'EXCESS_DECIMALS',
    };
  }

  const divisor = 10n ** BigInt(decimals);
  const fracPadded = fracStr.padEnd(decimals, '0');

  const whole = BigInt(wholeStr);
  const fraction = fracPadded ? BigInt(fracPadded) : 0n;
  const stroops = whole * divisor + fraction;

  if (stroops > maxAmount) {
    return {
      success: false,
      error: 'Amount exceeds maximum allowable limit',
      code: 'OVERFLOW',
    };
  }

  return {
    success: true,
    stroops,
    canonical: stroops.toString(),
    decimals,
  };
}

/**
 * Validates a decimal amount input string and returns a user-facing error message,
 * or `null` if the input is valid and strictly greater than zero.
 */
export function validateAmountInput(
  input: string,
  metadata?: Partial<TokenPrecisionMetadata>,
): string | null {
  const result = parseAssetAmount(input, metadata);
  if (!result.success) {
    return result.error;
  }
  if (result.stroops <= 0n) {
    return 'Amount must be greater than zero';
  }
  return null;
}

/**
 * Formats a raw integer stroop / base unit count into a human-readable decimal string
 * with exact integer division and modulo, completely avoiding floating-point math.
 *
 * @param stroops - The stroop value to format as a `bigint` or base-10 integer string.
 * @param metadata - Token precision configuration (decimals).
 * @returns Human-readable decimal string (e.g. "100.5", "0.0000001", "5").
 */
export function formatAssetAmount(
  stroops: bigint | string,
  metadata?: Partial<TokenPrecisionMetadata>,
): string {
  const decimals = metadata?.decimals ?? STELLAR_NATIVE_DECIMALS;
  const divisor = 10n ** BigInt(decimals);

  let value: bigint;
  if (typeof stroops === 'bigint') {
    value = stroops;
  } else {
    const trimmed = stroops.trim();
    if (!/^[+-]?\d+$/.test(trimmed)) {
      throw new Error(`Expected a base-10 integer stroop count, received ${String(stroops)}`);
    }
    value = BigInt(trimmed);
  }

  const isNegative = value < 0n;
  const magnitude = isNegative ? -value : value;

  if (decimals === 0) {
    const whole = magnitude.toString();
    return isNegative ? `-${whole}` : whole;
  }

  const whole = magnitude / divisor;
  const frac = magnitude % divisor;

  const fracStr = frac.toString().padStart(decimals, '0').replace(/0+$/, '');
  const formatted = fracStr ? `${whole}.${fracStr}` : `${whole}`;

  return isNegative ? `-${formatted}` : formatted;
}
