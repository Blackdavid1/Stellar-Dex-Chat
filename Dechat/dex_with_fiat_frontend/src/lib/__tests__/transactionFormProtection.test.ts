import { describe, it, expect, vi } from 'vitest';
import {
  createQuoteSnapshot,
  createBalanceSnapshot,
  createSimulationSnapshot,
  revalidateFormInputs,
  QUOTE_VALIDITY_WINDOW_MS,
} from '../transactionFormProtection';

describe('Transaction Form Protection (#62)', () => {
  const TEST_WALLET = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
  const BASE_TIME = 1000000;

  it('attaches timestamps and source identity to snapshots', () => {
    const quote = createQuoteSnapshot(0.12, 'XLM', 'USD', 'coingecko', 60000, BASE_TIME);
    expect(quote.timestamp).toBe(BASE_TIME);
    expect(quote.expiresAt).toBe(BASE_TIME + 60000);
    expect(quote.sourceId).toBe('coingecko');
    expect(quote.price).toBe(0.12);

    const balance = createBalanceSnapshot('150.00', TEST_WALLET, 'stellar-horizon', BASE_TIME);
    expect(balance.timestamp).toBe(BASE_TIME);
    expect(balance.sourceId).toBe('stellar-horizon');
    expect(balance.balance).toBe('150.00');

    const sim = createSimulationSnapshot(
      { minFee: '100', fee: 0.00001, baseFee: 0.00001, resourceFee: 0 },
      BigInt(1000),
      'soroban-rpc',
      BASE_TIME,
    );
    expect(sim.sourceId).toBe('soroban-rpc');
  });

  describe('Expiry Boundaries', () => {
    it('allows submission before quote expires', async () => {
      const quote = createQuoteSnapshot(0.12, 'XLM', 'USD', 'coingecko', 60000, BASE_TIME);
      const balance = createBalanceSnapshot('150.00', TEST_WALLET, 'horizon', BASE_TIME);

      const result = await revalidateFormInputs({
        quoteSnapshot: quote,
        balanceSnapshot: balance,
        currentAmountXlm: '50',
        walletAddress: TEST_WALLET,
        now: BASE_TIME + 59999, // 1 ms before expiry
        fetchLatestPrice: async () => ({ price: 0.12, source: 'coingecko' }),
        fetchLatestBalance: async () => '150.00',
      });

      expect(result.valid).toBe(true);
    });

    it('rejects submission at or after quote expiry and requires reconfirmation', async () => {
      const quote = createQuoteSnapshot(0.12, 'XLM', 'USD', 'coingecko', 60000, BASE_TIME);
      const balance = createBalanceSnapshot('150.00', TEST_WALLET, 'horizon', BASE_TIME);

      const result = await revalidateFormInputs({
        quoteSnapshot: quote,
        balanceSnapshot: balance,
        currentAmountXlm: '50',
        walletAddress: TEST_WALLET,
        now: BASE_TIME + 60000, // exactly at expiry
        fetchLatestPrice: async () => ({ price: 0.122, source: 'coingecko' }),
        fetchLatestBalance: async () => '150.00',
      });

      expect(result.valid).toBe(false);
      expect(result.reason).toBe('quote_expired');
      expect(result.explanation).toContain('conversion quote expired');
      expect(result.latestQuote?.price).toBe(0.122);
    });
  });

  describe('Changed Balances', () => {
    it('detects material balance change and requires reconfirmation', async () => {
      const quote = createQuoteSnapshot(0.12, 'XLM', 'USD', 'coingecko', 60000, BASE_TIME);
      const balance = createBalanceSnapshot('150.00', TEST_WALLET, 'horizon', BASE_TIME);

      const result = await revalidateFormInputs({
        quoteSnapshot: quote,
        balanceSnapshot: balance,
        currentAmountXlm: '50',
        walletAddress: TEST_WALLET,
        now: BASE_TIME + 10000,
        fetchLatestPrice: async () => ({ price: 0.12, source: 'coingecko' }),
        fetchLatestBalance: async () => '40.00', // Dropped below transaction amount!
      });

      expect(result.valid).toBe(false);
      expect(result.reason).toBe('balance_changed');
      expect(result.explanation).toContain('balance changed from 150.00 XLM to 40.00 XLM');
      expect(result.latestBalance?.balance).toBe('40.00');
    });
  });

  describe('Changed Quotes', () => {
    it('detects quote price change beyond tolerance threshold', async () => {
      const quote = createQuoteSnapshot(0.10, 'XLM', 'USD', 'coingecko', 60000, BASE_TIME);
      const balance = createBalanceSnapshot('150.00', TEST_WALLET, 'horizon', BASE_TIME);

      const result = await revalidateFormInputs({
        quoteSnapshot: quote,
        balanceSnapshot: balance,
        currentAmountXlm: '50',
        walletAddress: TEST_WALLET,
        priceTolerancePercent: 1.0, // 1%
        now: BASE_TIME + 10000,
        fetchLatestPrice: async () => ({ price: 0.105, source: 'coingecko' }), // 5% shift
        fetchLatestBalance: async () => '150.00',
      });

      expect(result.valid).toBe(false);
      expect(result.reason).toBe('quote_changed');
      expect(result.explanation).toContain('price quote shifted');
      expect(result.latestQuote?.price).toBe(0.105);
    });
  });

  describe('RPC Outage Handling', () => {
    it('handles network RPC outage during revalidation without throwing', async () => {
      const quote = createQuoteSnapshot(0.10, 'XLM', 'USD', 'coingecko', 60000, BASE_TIME);
      const balance = createBalanceSnapshot('150.00', TEST_WALLET, 'horizon', BASE_TIME);

      const result = await revalidateFormInputs({
        quoteSnapshot: quote,
        balanceSnapshot: balance,
        currentAmountXlm: '50',
        walletAddress: TEST_WALLET,
        now: BASE_TIME + 10000,
        fetchLatestPrice: async () => {
          throw new Error('Connection refused: RPC timeout');
        },
      });

      expect(result.valid).toBe(false);
      expect(result.reason).toBe('rpc_outage');
      expect(result.explanation).toContain('network RPC outage');
      expect(result.explanation).toContain('form details are saved');
    });
  });

  describe('Successful Reconfirmation', () => {
    it('accepts updated snapshot on subsequent revalidation', async () => {
      // User receives new quote snapshot after expiry or change
      const freshQuote = createQuoteSnapshot(0.105, 'XLM', 'USD', 'coingecko', 60000, BASE_TIME + 65000);
      const freshBalance = createBalanceSnapshot('140.00', TEST_WALLET, 'horizon', BASE_TIME + 65000);

      const result = await revalidateFormInputs({
        quoteSnapshot: freshQuote,
        balanceSnapshot: freshBalance,
        currentAmountXlm: '50',
        walletAddress: TEST_WALLET,
        now: BASE_TIME + 66000,
        fetchLatestPrice: async () => ({ price: 0.105, source: 'coingecko' }),
        fetchLatestBalance: async () => '140.00',
      });

      expect(result.valid).toBe(true);
    });
  });
});
