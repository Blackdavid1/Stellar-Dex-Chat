import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import StellarFiatModal from '../StellarFiatModal';
import * as protectionModule from '@/lib/transactionFormProtection';

vi.mock('@/contexts/TranslationContext', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

vi.mock('@/contexts/ThemeContext', () => ({
  useTheme: () => ({ isDarkMode: false }),
}));

const mockRefetchStats = vi.fn();
const mockRefreshXlmBalance = vi.fn();
const mockSignTransaction = vi.fn().mockResolvedValue('signed-xdr');
const mockConnection = {
  isConnected: true,
  publicKey: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
  address: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
  network: 'TESTNET',
  signTransaction: mockSignTransaction,
};

vi.mock('@/contexts/StellarWalletContext', () => ({
  useStellarWallet: () => ({
    connection: mockConnection,
    refreshXlmBalance: mockRefreshXlmBalance,
  }),
}));

vi.mock('@/contexts/UserPreferencesContext', () => ({
  useUserPreferences: () => ({
    preferences: {
      twoFactorEnabled: false,
      highValueThreshold: 500,
    },
  }),
}));

vi.mock('@/hooks/useBridgeStats', () => ({
  default: () => ({
    limit: BigInt('10000000000'),
    loading: false,
    error: null,
    refetchStats: mockRefetchStats,
  }),
}));

vi.mock('@/lib/stellarContract', () => ({
  CONTRACT_ID: 'CAWYXBN4PSVXD7NIYEWVFFIIIEUCC6PUN3IMG3J2WHKDB4NVIISMXBPR',
  BRIDGE_LIMIT_WARNING_PERCENT: 80,
  depositToContract: vi.fn().mockResolvedValue('tx-hash-123'),
  withdrawFromContract: vi.fn().mockResolvedValue('tx-hash-456'),
  pollTransaction: vi.fn().mockResolvedValue('tx-hash-123'),
  fetchXlmBalance: vi.fn().mockResolvedValue('100.00'),
  clearCache: vi.fn(),
  fiatBridgeClient: {
    getWithdrawalQueueDepth: vi.fn().mockResolvedValue(0),
    getWithdrawalQueueOldestAgeLedgers: vi.fn().mockResolvedValue(null),
    getWithdrawalQueueOldestQueuedLedger: vi.fn().mockResolvedValue(null),
    getEventVersion: vi.fn().mockResolvedValue(1),
  },
}));

vi.mock('@/lib/cryptoPriceService', () => ({
  getTokenPriceWithStatus: vi.fn().mockResolvedValue({
    price: 0.12,
    stale: false,
    source: 'coingecko',
  }),
  formatFiatAmount: (val: number, cur: string) => `${cur} ${val.toFixed(2)}`,
}));

const mockRevalidateFormInputs = vi.fn();

vi.mock('@/lib/transactionFormProtection', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/transactionFormProtection')>();
  return {
    ...actual,
    revalidateFormInputs: (...args: any[]) => mockRevalidateFormInputs(...args),
  };
});

describe('StellarFiatModal Protection & Withdrawal Review (#60, #62)', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    mockRevalidateFormInputs.mockResolvedValue({ valid: true });
  });

  it('renders withdrawal queue review in admin/withdrawal mode', async () => {
    render(<StellarFiatModal isOpen={true} onClose={vi.fn()} isAdminMode={true} />);

    await waitFor(() => {
      expect(screen.getByTestId('queue-status-empty')).toBeDefined();
    });
  });

  it('displays reconfirmation banner when quote expires at submit without losing form fields', async () => {
    mockRevalidateFormInputs.mockImplementation(async () => ({
      valid: false,
      reason: 'quote_expired',
      explanation: 'Your conversion quote has expired. Review updated values.',
      latestQuote: {
        price: 0.13,
        token: 'XLM',
        currency: 'USD',
        timestamp: Date.now(),
        expiresAt: Date.now() + 60000,
        sourceId: 'coingecko',
      },
    }));

    render(
      <StellarFiatModal
        isOpen={true}
        onClose={vi.fn()}
        defaultAmount="50"
      />,
    );

    // Wait for initial UI skeleton to resolve
    const noteInput = await screen.findByPlaceholderText(
      /Add a note for this deposit/i,
    );
    fireEvent.change(noteInput, { target: { value: 'Payment for groceries' } });

    // Click submit
    const submitBtn = screen.getByRole('button', { name: /^Deposit$/i });
    await act(async () => {
      fireEvent.click(submitBtn);
    });

    // Reconfirmation notice appears
    expect(await screen.findByTestId('reconfirmation-notice')).toBeDefined();
    expect(
      screen.getByText(/Your conversion quote has expired/i),
    ).toBeDefined();

    // Verify unrelated form field 'note' is completely preserved
    expect((noteInput as HTMLTextAreaElement).value).toBe(
      'Payment for groceries',
    );
  });

  it('allows user to confirm updated values and successfully submit', async () => {
    mockRevalidateFormInputs.mockResolvedValueOnce({
      valid: false,
      reason: 'quote_changed',
      explanation: 'Exchange rate updated from $0.12 to $0.14.',
      latestQuote: {
        price: 0.14,
        token: 'XLM',
        currency: 'USD',
        timestamp: Date.now(),
        expiresAt: Date.now() + 60000,
        sourceId: 'coingecko',
      },
    });

    render(
      <StellarFiatModal
        isOpen={true}
        onClose={vi.fn()}
        defaultAmount="25"
      />,
    );

    const submitBtn = await screen.findByRole('button', { name: /^Deposit$/i });
    await act(async () => {
      fireEvent.click(submitBtn);
    });

    // Reconfirmation button
    const confirmBtn = await screen.findByRole('button', {
      name: /Confirm Updated Values/i,
    });
    expect(confirmBtn).toBeDefined();

    // Click confirm updated values
    await act(async () => {
      fireEvent.click(confirmBtn);
    });

    // Submits successfully
    await waitFor(() => {
      expect(screen.queryByTestId('reconfirmation-notice')).toBeNull();
    });
  });
});
