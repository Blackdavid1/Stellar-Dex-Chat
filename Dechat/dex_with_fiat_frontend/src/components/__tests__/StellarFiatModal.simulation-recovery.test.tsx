import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import StellarFiatModal from '../StellarFiatModal';
import * as stellarContract from '@/lib/stellarContract';
import * as transactionRecovery from '@/lib/transactionRecovery';

const mockSignTx = vi.fn();
const mockRefreshBalance = vi.fn().mockResolvedValue(undefined);
let mockWalletState = {
  connection: {
    isConnected: true,
    publicKey: 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFDAGORAcct1',
    address: 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFDAGORAcct1',
    network: 'TESTNET',
  },
  signTx: mockSignTx,
  refreshXlmBalance: mockRefreshBalance,
  xlmBalance: '100',
};

vi.mock('@/contexts/StellarWalletContext', () => ({
  useStellarWallet: () => mockWalletState,
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

const mockGetTransaction = vi.fn();
const mockSendTransaction = vi.fn();

vi.mock('@/lib/stellarContract', () => ({
  CONTRACT_ID: 'CCONTRACTID1234567890ABCDEF',
  depositToContract: vi.fn(),
  withdrawFromContract: vi.fn(),
  getContractBalance: vi.fn().mockResolvedValue(1_000_000_000_000n),
  getBridgeLimit: vi.fn().mockResolvedValue(10_000_000_000_000n),
  getTotalDeposited: vi.fn().mockResolvedValue(0n),
  clearCache: vi.fn(),
  pollTransaction: vi.fn(),
  stroopsToDisplay: (s: bigint) => String(Number(s) / 1e7),
  BRIDGE_LIMIT_WARNING_PERCENT: 0.9,
  server: {
    getTransaction: (...args: any[]) => mockGetTransaction(...args),
    sendTransaction: (...args: any[]) => mockSendTransaction(...args),
  },
  rpc: {
    Api: {
      GetTransactionStatus: {
        SUCCESS: 'SUCCESS',
        FAILED: 'FAILED',
        NOT_FOUND: 'NOT_FOUND',
      },
    },
  },
  simulateDeposit: vi.fn().mockResolvedValue({
    baseFee: 0.00001,
    resourceFee: 0.00005,
    fee: 0.00006,
    minFee: '600',
  }),
  simulateWithdraw: vi.fn().mockResolvedValue({
    baseFee: 0.00001,
    resourceFee: 0.00005,
    fee: 0.00006,
    minFee: '600',
  }),
  simulateTransactionPayload: vi.fn().mockResolvedValue({
    contractId: 'CCONTRACTID1234567890ABCDEF',
    operation: 'deposit',
    token: 'XLM',
    amountStroops: 100_000_000n,
    amountFormatted: '10',
    feeEstimate: {
      baseFee: 0.00001,
      resourceFee: 0.00005,
      fee: 0.00006,
      minFee: '600',
    },
    network: 'TESTNET',
    account: 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFDAGORAcct1',
    expectedEffects: [
      'Transfer 10 XLM from GBRPYH...cct1 to Bridge Escrow Contract',
      'Estimated total fee: 0.0000600 XLM',
    ],
    simulationTimestamp: Date.now(),
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

vi.mock('@/lib/cryptoPriceService', () => ({
  getTokenPriceWithStatus: vi.fn().mockResolvedValue({ price: 0.12, stale: false }),
  formatFiatAmount: (val: number) => `$${val.toFixed(2)}`,
}));

describe('Issue #52: Transaction Simulation and Pre-Sign Review', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    mockWalletState = {
      connection: {
        isConnected: true,
        publicKey: 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFDAGORAcct1',
        address: 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFDAGORAcct1',
        network: 'TESTNET',
      },
      signTx: mockSignTx,
      refreshXlmBalance: mockRefreshBalance,
      xlmBalance: '100',
    };
    vi.mocked(stellarContract.simulateTransactionPayload).mockResolvedValue({
      contractId: 'CCONTRACTID1234567890ABCDEF',
      operation: 'deposit',
      token: 'XLM',
      amountStroops: 100_000_000n,
      amountFormatted: '10',
      feeEstimate: {
        baseFee: 0.00001,
        resourceFee: 0.00005,
        fee: 0.00006,
        minFee: '600',
      },
      network: 'TESTNET',
      account: 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFDAGORAcct1',
      expectedEffects: [
        'Transfer 10 XLM from GBRPYH...cct1 to Bridge Escrow Contract',
        'Estimated total fee: 0.0000600 XLM',
      ],
      simulationTimestamp: Date.now(),
    });
  });

  it('simulates transaction payload and shows pre-sign summary before asking wallet to sign', async () => {
    render(
      <StellarFiatModal
        isOpen={true}
        onClose={vi.fn()}
        defaultAmount="10"
      />,
    );

    await waitFor(() => {
      const btn = screen.getByRole('button', { name: /^deposit$/i });
      expect(btn).toBeInTheDocument();
      expect(btn).not.toBeDisabled();
    });

    // Clicking Deposit triggers simulation and opens pre-sign review
    fireEvent.click(screen.getByRole('button', { name: /^deposit$/i }));

    await waitFor(() => {
      expect(screen.getByTestId('pre-sign-summary')).toBeInTheDocument();
      expect(screen.getByText('Pre-Sign Transaction Summary')).toBeInTheDocument();
      expect(screen.getByText('Transfer 10 XLM from GBRPYH...cct1 to Bridge Escrow Contract')).toBeInTheDocument();
      expect(screen.getByTestId('confirm-sign-button')).toBeInTheDocument();
    });

    // Wallet signTx must NOT have been called yet!
    expect(mockSignTx).not.toHaveBeenCalled();
    expect(stellarContract.depositToContract).not.toHaveBeenCalled();
  });

  it('blocks signing when simulation fails and displays field/modal error', async () => {
    vi.mocked(stellarContract.simulateTransactionPayload).mockRejectedValueOnce(
      new Error('HostError: Error(Contract, #101) - Insufficient contract balance'),
    );

    render(
      <StellarFiatModal
        isOpen={true}
        onClose={vi.fn()}
        defaultAmount="10"
      />,
    );

    await waitFor(() => {
      const btn = screen.getByRole('button', { name: /^deposit$/i });
      expect(btn).toBeInTheDocument();
      expect(btn).not.toBeDisabled();
    });

    fireEvent.click(screen.getByRole('button', { name: /^deposit$/i }));

    await waitFor(() => {
      expect(screen.getByText(/Simulation failed: HostError: Error\(Contract, #101\)/i)).toBeInTheDocument();
    });

    // signTx must never be called
    expect(mockSignTx).not.toHaveBeenCalled();
    expect(stellarContract.depositToContract).not.toHaveBeenCalled();
  });

  it('blocks signing when account changes after simulation (stale simulation)', async () => {
    // 1. Initial simulation succeeds
    const { rerender } = render(
      <StellarFiatModal
        isOpen={true}
        onClose={vi.fn()}
        defaultAmount="10"
      />,
    );

    await waitFor(() => {
      const btn = screen.getByRole('button', { name: /^deposit$/i });
      expect(btn).toBeInTheDocument();
      expect(btn).not.toBeDisabled();
    });

    fireEvent.click(screen.getByRole('button', { name: /^deposit$/i }));

    await waitFor(() => {
      expect(screen.getByTestId('pre-sign-summary')).toBeInTheDocument();
    });

    // 2. Change wallet account
    mockWalletState = {
      ...mockWalletState,
      connection: {
        ...mockWalletState.connection,
        publicKey: 'GDIFFERENTACCOUNT22222222222222222222222222222222222222',
      },
    };

    rerender(
      <StellarFiatModal
        isOpen={true}
        onClose={vi.fn()}
        defaultAmount="10"
      />,
    );

    // Stale warning is rendered and confirm button is disabled
    await waitFor(() => {
      expect(screen.getByTestId('stale-simulation-warning')).toBeInTheDocument();
      expect(screen.getByTestId('confirm-sign-button')).toBeDisabled();
    });

    // Clicking confirm button does nothing
    fireEvent.click(screen.getByTestId('confirm-sign-button'));
    expect(mockSignTx).not.toHaveBeenCalled();
  });

  it('handles wallet rejection gracefully without broadcasting a transaction', async () => {
    vi.mocked(stellarContract.depositToContract).mockRejectedValueOnce(
      new Error('User declined to sign the transaction'),
    );

    render(
      <StellarFiatModal
        isOpen={true}
        onClose={vi.fn()}
        defaultAmount="10"
      />,
    );

    await waitFor(() => {
      const btn = screen.getByRole('button', { name: /^deposit$/i });
      expect(btn).toBeInTheDocument();
      expect(btn).not.toBeDisabled();
    });

    // Trigger pre-sign review
    fireEvent.click(screen.getByRole('button', { name: /^deposit$/i }));

    await waitFor(() => {
      expect(screen.getByTestId('confirm-sign-button')).toBeInTheDocument();
    });

    // User confirms and signs, but wallet rejects
    fireEvent.click(screen.getByTestId('confirm-sign-button'));

    await waitFor(() => {
      expect(screen.getByText('User declined to sign the transaction')).toBeInTheDocument();
    });

    // Recovery storage should be clear since transaction was rejected
    expect(transactionRecovery.getPendingRecoveryRecord()).toBeNull();
  });
});

describe('Issue #53: Recover Pending Soroban Transactions After Reload', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
  });

  it('recovers pending transaction on reload and resumes status lookup without duplicate submit', async () => {
    const existingHash = 'tx_abc123456789deadbeef';
    transactionRecovery.savePendingRecoveryRecord({
      hash: existingHash,
      operation: 'deposit',
      amount: '25',
      network: 'TESTNET',
      account: 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFDAGORAcct1',
      timestamp: Date.now(),
      stage: 'pending_confirmation',
    });

    mockGetTransaction.mockResolvedValue({
      status: 'SUCCESS',
    });

    render(
      <StellarFiatModal
        isOpen={true}
        onClose={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText(/Transaction Confirmed!/i)).toBeInTheDocument();
      expect(screen.getByText(existingHash)).toBeInTheDocument();
    });

    // Crucial check: depositToContract or signTx was NEVER triggered during recovery!
    expect(stellarContract.depositToContract).not.toHaveBeenCalled();
    expect(mockSignTx).not.toHaveBeenCalled();

    // Storage is cleared after confirmation
    expect(transactionRecovery.getPendingRecoveryRecord()).toBeNull();
  });

  it('marks error and clears record when recovered transaction fails on-chain', async () => {
    const failedHash = 'tx_failed_99999999';
    transactionRecovery.savePendingRecoveryRecord({
      hash: failedHash,
      operation: 'deposit',
      amount: '25',
      network: 'TESTNET',
      account: 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFDAGORAcct1',
      timestamp: Date.now(),
      stage: 'pending_confirmation',
    });

    mockGetTransaction.mockResolvedValue({
      status: 'FAILED',
    });

    render(
      <StellarFiatModal
        isOpen={true}
        onClose={vi.fn()}
      />,
    );

    await waitFor(
      () => {
        expect(screen.getByText(/Recovered transaction failed on-chain/i)).toBeInTheDocument();
      },
      { timeout: 3000 },
    );

    // Never submitted again
    expect(stellarContract.depositToContract).not.toHaveBeenCalled();
    expect(transactionRecovery.getPendingRecoveryRecord()).toBeNull();
  });
});
