import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import StellarFiatModal from '../StellarFiatModal';
import BankDetailsModal from '../BankDetailsModal';
import { StellarWalletContext } from '@/contexts/StellarWalletContext';

// Mocks for StellarFiatModal
const mockReconnect = vi.fn();
let mockWalletState = {
  connection: {
    isConnected: true,
    publicKey: 'GABCDEF1234567890',
    address: 'GABCDEF1234567890',
    network: 'TESTNET',
  },
  accounts: [],
  selectedAccountIndex: 0,
  xlmBalance: '100',
  isFreighterInstalled: true,
  isLoading: false,
  error: null,
  isNetworkMismatch: false,
  sessionExpired: false,
  connect: vi.fn(),
  disconnect: vi.fn(),
  selectAccount: vi.fn(),
  signTx: vi.fn(),
  refreshXlmBalance: vi.fn(),
  clearSessionExpired: vi.fn(),
  reconnect: mockReconnect,
  verifySession: vi.fn(),
};

vi.mock('@/contexts/StellarWalletContext', async () => {
  const actual = await vi.importActual<any>('@/contexts/StellarWalletContext');
  return {
    ...actual,
    useStellarWallet: () => mockWalletState,
  };
});

vi.mock('@/lib/stellarContract', () => ({
  depositToContract: vi.fn(),
  withdrawFromContract: vi.fn(),
  getContractBalance: vi.fn().mockResolvedValue(1_000_000_000_000n),
  getBridgeLimit: vi.fn().mockResolvedValue(10_000_000_000_000n),
  getTotalDeposited: vi.fn().mockResolvedValue(0n),
  clearCache: vi.fn(),
  pollTransaction: vi.fn(),
  stroopsToDisplay: (stroops: bigint) => String(Number(stroops) / 1e7),
  xlmToStroops: (xlm: string) => BigInt(Math.floor(parseFloat(xlm || '0') * 1e7)),
  BRIDGE_LIMIT_WARNING_PERCENT: 0.9,
  CONTRACT_ID: 'CDEMO12345',
  simulateDeposit: vi.fn().mockResolvedValue({
    baseFee: 0.00001,
    resourceFee: 0,
    fee: 0.00001,
    minFee: '100',
  }),
  simulateWithdraw: vi.fn().mockResolvedValue({
    baseFee: 0.00001,
    resourceFee: 0,
    fee: 0.00001,
    minFee: '100',
  }),
}));

vi.mock('@/contexts/UserPreferencesContext', () => ({
  useUserPreferences: () => ({
    fiatCurrency: 'usd',
    currencySymbol: '$',
    setFiatCurrency: vi.fn(),
    remindersEnabled: false,
    setRemindersEnabled: vi.fn(),
    reminderFrequency: 'weekly',
    setReminderFrequency: vi.fn(),
    maskingEnabled: false,
    setMaskingEnabled: vi.fn(),
    maskingStyle: 'asterisk',
    setMaskingStyle: vi.fn(),
    highValueThreshold: 500,
    setHighValueThreshold: vi.fn(),
    twoFactorEnabled: false,
    setTwoFactorEnabled: vi.fn(),
  }),
}));

const mockRefetchStats = vi.fn();
vi.mock('@/hooks/useBridgeStats', () => ({
  default: () => ({
    limit: 10_000_000_000_000n,
    loading: false,
    error: null,
    refetchStats: mockRefetchStats,
  }),
}));

vi.mock('@/hooks/useNotifications', () => ({
  useNotifications: () => ({
    addNotification: vi.fn(),
  }),
}));

vi.mock('@/hooks/useBeneficiaries', () => ({
  useBeneficiaries: () => ({
    beneficiaries: [],
    isLoaded: true,
    addBeneficiary: vi.fn(),
    renameBeneficiary: vi.fn(),
    deleteBeneficiary: vi.fn(),
  }),
}));

vi.mock('@/hooks/useTxHistory', () => ({
  useTxHistory: () => ({
    addEntry: vi.fn(),
  }),
}));

vi.mock('@/hooks/useIdempotentAction', () => ({
  useIdempotentAction: () => ({
    execute: async (fn: (key: string) => Promise<void>) => {
      await fn('test-idempotency-key');
      return null;
    },
    isProcessing: false,
  }),
}));

vi.mock('@/hooks/useAccessibleModal', () => ({
  useAccessibleModal: vi.fn(),
}));

vi.mock('@/lib/cryptoPriceService', () => ({
  getTokenPriceWithStatus: vi.fn().mockResolvedValue({ price: 0.12, stale: false }),
  formatFiatAmount: (val: number) => `$${val.toFixed(2)}`,
  fetchLockedQuote: vi.fn().mockResolvedValue({
    rate: 1500,
    ngnAmount: 150000,
    expiresAt: Date.now() + 120000,
    stale: false,
  }),
}));

global.fetch = vi.fn();

describe('Wallet Session Expiry and Secure Reconnect UX', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    (global.fetch as any).mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        data: [{ id: 1, name: 'Access Bank', code: '044', active: true, country: 'Nigeria', currency: 'NGN', type: 'nuban' }],
      }),
    });
  });

  afterEach(() => {
    mockWalletState.sessionExpired = false;
    mockWalletState.connection.isConnected = true;
  });

  it('preserves draft input values in StellarFiatModal when session expires and offers reconnect action', async () => {
    mockWalletState.sessionExpired = false;
    mockWalletState.connection.isConnected = true;

    const { rerender } = render(
      <StellarFiatModal isOpen={true} onClose={vi.fn()} defaultAmount="50" />,
    );

    // Wait for initial UI skeleton to finish
    await waitFor(
      () =>
        expect(
          screen.getByPlaceholderText(/Add a note for this deposit/i),
        ).toBeInTheDocument(),
      { timeout: 3000 },
    );

    // Enter a note
    const noteInput = screen.getByPlaceholderText(/Add a note for this deposit/i);
    fireEvent.change(noteInput, { target: { value: 'My preserved draft note' } });
    expect((noteInput as HTMLTextAreaElement).value).toBe('My preserved draft note');

    // Simulate session expiration
    mockWalletState = {
      ...mockWalletState,
      sessionExpired: true,
    };
    rerender(
      <StellarFiatModal isOpen={true} onClose={vi.fn()} defaultAmount="50" />,
    );

    // Verify session expired banner is displayed
    expect(screen.getByTestId('session-expired-banner')).toBeInTheDocument();
    expect(screen.getByText(/Wallet Session Expired/i)).toBeInTheDocument();

    // Verify inputs remain intact
    expect((screen.getByPlaceholderText(/Add a note for this deposit/i) as HTMLTextAreaElement).value).toBe('My preserved draft note');
    expect((screen.getByPlaceholderText('0.00') as HTMLInputElement).value).toBe('50');

    // Submit button is disabled
    const submitBtn = screen.getByRole('button', { name: /Deposit/i });
    expect(submitBtn).toBeDisabled();

    // Clicking reconnect calls reconnect()
    const reconnectBtn = screen.getByTestId('reconnect-button');
    fireEvent.click(reconnectBtn);
    expect(mockReconnect).toHaveBeenCalled();
  });

  it('renders session expired banner in BankDetailsModal step 3 and disables confirmation while preserving details', async () => {
    const expiredWallet = {
      ...mockWalletState,
      sessionExpired: true,
    };

    render(
      <StellarWalletContext.Provider value={expiredWallet as any}>
        <BankDetailsModal isOpen={true} onClose={vi.fn()} xlmAmount={100} />
      </StellarWalletContext.Provider>,
    );

    // Wait for bank list and select bank
    await waitFor(() => expect(screen.getByText('Access Bank')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Access Bank'));
    const nextButtonsStep1 = screen.getAllByRole('button', { name: /Next/i });
    fireEvent.click(nextButtonsStep1[0]);

    // Step 2: enter account number and verify
    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        success: true,
        data: { account_name: 'JANE DOE' },
      }),
    });
    const accInput = await screen.findByPlaceholderText('0000000000');
    fireEvent.change(accInput, { target: { value: '0123456789' } });
    fireEvent.blur(accInput);

    await waitFor(() => expect(screen.getByText(/JANE DOE/i)).toBeInTheDocument());
    const nextButtonsStep2 = screen.getAllByRole('button', { name: /Next/i });
    fireEvent.click(nextButtonsStep2[nextButtonsStep2.length - 1]);

    // Step 3: Review step
    await waitFor(() => expect(screen.getByText(/Review your payout details/i)).toBeInTheDocument());

    // Verify session expired banner is shown in step 3
    expect(screen.getByTestId('wallet-session-expired-banner')).toBeInTheDocument();
    expect(screen.getByText(/Your payout details have been preserved/i)).toBeInTheDocument();

    // Verify confirm payout button is disabled
    const confirmBtn = screen.getByRole('button', { name: /Confirm Payout/i });
    expect(confirmBtn).toBeDisabled();

    // Verify draft details are preserved
    expect(screen.getByText('0123456789')).toBeInTheDocument();
    expect(screen.getAllByText('JANE DOE').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Access Bank').length).toBeGreaterThan(0);

    // Click reconnect
    const reconnectBtn = screen.getByTestId('reconnect-button');
    fireEvent.click(reconnectBtn);
    expect(mockReconnect).toHaveBeenCalled();
  });

  it('guarantees that no secret keys or private signing material are stored in localStorage', () => {
    // Assert all keys in storage are clean
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)!;
      const val = localStorage.getItem(key)!;
      expect(key).not.toMatch(/^S[A-Z0-9]{55}$/);
      expect(val).not.toMatch(/S[A-Z0-9]{55}/);
      expect(key.toLowerCase()).not.toContain('secret');
      expect(key.toLowerCase()).not.toContain('private');
    }
  });
});
