import { describe, it, expect } from 'vitest';
import {
  parseAssetAmount,
  formatAssetAmount,
  validateAmountInput,
  STELLAR_NATIVE_DECIMALS,
  MAX_I128,
  MAX_INT64,
  type TokenPrecisionMetadata,
} from './exactAmount';

describe('Exact Asset Amount Arithmetic', () => {
  describe('parseAssetAmount', () => {
    it('parses valid integer and decimal amounts at default precision (7 decimals)', () => {
      const res1 = parseAssetAmount('1');
      expect(res1.success).toBe(true);
      if (res1.success) {
        expect(res1.stroops).toBe(10_000_000n);
        expect(res1.canonical).toBe('10000000');
        expect(res1.decimals).toBe(7);
      }

      const resHalf = parseAssetAmount('0.5');
      expect(resHalf.success).toBe(true);
      if (resHalf.success) {
        expect(resHalf.stroops).toBe(5_000_000n);
        expect(resHalf.canonical).toBe('5000000');
      }

      const resMin = parseAssetAmount('0.0000001');
      expect(resMin.success).toBe(true);
      if (resMin.success) {
        expect(resMin.stroops).toBe(1n);
      }

      const resCompound = parseAssetAmount('100.1234567');
      expect(resCompound.success).toBe(true);
      if (resCompound.success) {
        expect(resCompound.stroops).toBe(1_001_234_567n);
      }
    });

    it('rejects excess fractional digits with field-level precision feedback', () => {
      const res = parseAssetAmount('0.00000001', { decimals: 7 });
      expect(res.success).toBe(false);
      if (!res.success) {
        expect(res.code).toBe('EXCESS_DECIMALS');
        expect(res.error).toBe('Exceeds maximum precision of 7 decimal places');
      }

      const res2 = parseAssetAmount('1.123', { decimals: 2 });
      expect(res2.success).toBe(false);
      if (!res2.success) {
        expect(res2.code).toBe('EXCESS_DECIMALS');
        expect(res2.error).toBe('Exceeds maximum precision of 2 decimal places');
      }
    });

    it('rejects exponent notation with informative error', () => {
      for (const expVal of ['1e5', '1e-7', '2.5E+3', '1E-2']) {
        const res = parseAssetAmount(expVal);
        expect(res.success).toBe(false);
        if (!res.success) {
          expect(res.code).toBe('EXPONENT');
          expect(res.error).toBe('Exponential notation is not supported');
        }
      }
    });

    it('rejects negative values', () => {
      for (const negVal of ['-1', '-0.5', '-0.0000001']) {
        const res = parseAssetAmount(negVal);
        expect(res.success).toBe(false);
        if (!res.success) {
          expect(res.code).toBe('NEGATIVE');
          expect(res.error).toBe('Amount cannot be negative');
        }
      }
    });

    it('rejects empty, whitespace, and malformed inputs', () => {
      expect(parseAssetAmount('').success).toBe(false);
      expect(parseAssetAmount('   ').success).toBe(false);
      expect(parseAssetAmount('.').success).toBe(false);
      expect(parseAssetAmount('1.2.3').success).toBe(false);
      expect(parseAssetAmount('abc').success).toBe(false);
      expect(parseAssetAmount('$100').success).toBe(false);
    });

    it('rejects overflow beyond maximum bounded limits', () => {
      const maxCustom = 100_000_000n; // 10 XLM max limit
      const res = parseAssetAmount('10.0000001', { maxAmount: maxCustom, decimals: 7 });
      expect(res.success).toBe(false);
      if (!res.success) {
        expect(res.code).toBe('OVERFLOW');
        expect(res.error).toBe('Amount exceeds maximum allowable limit');
      }

      // Check i128 max overflow
      const huge = '99999999999999999999999999999999999999999';
      const resHuge = parseAssetAmount(huge);
      expect(resHuge.success).toBe(false);
      if (!resHuge.success) {
        expect(resHuge.code).toBe('OVERFLOW');
      }
    });
  });

  describe('formatAssetAmount', () => {
    it('formats stroops to human-readable strings without trailing zeros', () => {
      expect(formatAssetAmount(10_000_000n)).toBe('1');
      expect(formatAssetAmount(5_000_000n)).toBe('0.5');
      expect(formatAssetAmount(1n)).toBe('0.0000001');
      expect(formatAssetAmount(0n)).toBe('0');
      expect(formatAssetAmount(1_005_000_000n)).toBe('100.5');
      expect(formatAssetAmount('50000000')).toBe('5');
    });

    it('formats negative stroops with leading minus sign', () => {
      expect(formatAssetAmount(-5_000_000n)).toBe('-0.5');
      expect(formatAssetAmount(-10_000_000n)).toBe('-1');
    });

    it('supports 0 decimals (integer tokens)', () => {
      expect(formatAssetAmount(500n, { decimals: 0 })).toBe('500');
      expect(formatAssetAmount(-500n, { decimals: 0 })).toBe('-500');
    });
  });

  describe('validateAmountInput', () => {
    it('returns null for valid positive amounts', () => {
      expect(validateAmountInput('1')).toBeNull();
      expect(validateAmountInput('0.0000001')).toBeNull();
    });

    it('returns error when amount is zero or negative or invalid', () => {
      expect(validateAmountInput('0')).toBe('Amount must be greater than zero');
      expect(validateAmountInput('-5')).toBe('Amount cannot be negative');
      expect(validateAmountInput('1e-3')).toBe('Exponential notation is not supported');
    });
  });

  describe('Property-based round-trip testing across varied precisions', () => {
    const precisions = [0, 2, 4, 6, 7, 9, 12, 18];

    it('round-trips boundary values across all precisions', () => {
      for (const dec of precisions) {
        const meta: TokenPrecisionMetadata = { decimals: dec };
        const divisor = 10n ** BigInt(dec);

        // 0 units
        expect(formatAssetAmount(0n, meta)).toBe('0');

        // 1 base unit (smallest stroop)
        if (dec > 0) {
          const formattedMin = formatAssetAmount(1n, meta);
          const parsedMin = parseAssetAmount(formattedMin, meta);
          expect(parsedMin.success).toBe(true);
          if (parsedMin.success) {
            expect(parsedMin.stroops).toBe(1n);
          }
        }

        // Exactly 1 full token
        const formattedOne = formatAssetAmount(divisor, meta);
        expect(formattedOne).toBe('1');
        const parsedOne = parseAssetAmount('1', meta);
        expect(parsedOne.success).toBe(true);
        if (parsedOne.success) {
          expect(parsedOne.stroops).toBe(divisor);
        }

        // 1000 full tokens
        const thousandTokens = 1000n * divisor;
        expect(formatAssetAmount(thousandTokens, meta)).toBe('1000');
        const parsedThousand = parseAssetAmount('1000', meta);
        expect(parsedThousand.success).toBe(true);
        if (parsedThousand.success) {
          expect(parsedThousand.stroops).toBe(thousandTokens);
        }
      }
    });

    it('property test: parse -> format -> parse preserves exact BigInt stroop equality', () => {
      // Deterministic pseudo-random generation for repeatable property testing
      let seed = 42;
      const random = () => {
        seed = (seed * 16807) % 2147483647;
        return (seed - 1) / 2147483646;
      };

      for (const dec of precisions) {
        const meta: TokenPrecisionMetadata = { decimals: dec };

        for (let i = 0; i < 50; i++) {
          const whole = Math.floor(random() * 10000);
          let decimalPart = '';
          if (dec > 0) {
            const numDecDigits = Math.floor(random() * (dec + 1));
            for (let d = 0; d < numDecDigits; d++) {
              decimalPart += Math.floor(random() * 10).toString();
            }
            // Strip trailing zeros for clean comparison or keep
            decimalPart = decimalPart.replace(/0+$/, '');
          }

          const originalStr = decimalPart ? `${whole}.${decimalPart}` : `${whole}`;
          const parseRes = parseAssetAmount(originalStr, meta);
          expect(parseRes.success).toBe(true);
          if (parseRes.success) {
            const formatted = formatAssetAmount(parseRes.stroops, meta);
            const secondParse = parseAssetAmount(formatted, meta);
            expect(secondParse.success).toBe(true);
            if (secondParse.success) {
              expect(secondParse.stroops).toBe(parseRes.stroops);
              expect(secondParse.canonical).toBe(parseRes.canonical);
            }
          }
        }
      }
    });

    it('property test: stroops -> format -> parse preserves exact stroops', () => {
      for (const dec of [2, 6, 7, 9]) {
        const meta: TokenPrecisionMetadata = { decimals: dec };
        const testStroops: bigint[] = [
          1n,
          2n,
          9n,
          10n,
          99n,
          100n,
          123456n,
          987654321n,
          10_000_000_000_000n,
          MAX_INT64 / 2n,
        ];

        for (const s of testStroops) {
          const formatted = formatAssetAmount(s, meta);
          const parsed = parseAssetAmount(formatted, meta);
          expect(parsed.success).toBe(true);
          if (parsed.success) {
            expect(parsed.stroops).toBe(s);
          }
        }
      }
    });
  });
});
