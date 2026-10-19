import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WithdrawalQueueStatus } from '../WithdrawalQueueStatus';
import * as hookModule from '@/hooks/useWithdrawalQueueStatus';

vi.mock('@/hooks/useWithdrawalQueueStatus');

describe('WithdrawalQueueStatus Component (#60)', () => {
  const mockRefetch = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders loading state', () => {
    vi.mocked(hookModule.useWithdrawalQueueStatus).mockReturnValue({
      state: 'loading',
      depth: null,
      oldestAgeLedgers: null,
      oldestQueuedLedger: null,
      estimatedWaitMinutes: null,
      estimatedPosition: null,
      specificRequest: null,
      contractVersion: null,
      lastUpdated: null,
      isStale: false,
      errorMessage: null,
      pollCount: 0,
      isPollingActive: true,
      settlementDisclaimer: hookModule.SETTLEMENT_TIME_DISCLAIMER,
      refetch: mockRefetch,
    });

    render(<WithdrawalQueueStatus />);
    expect(screen.getByTestId('queue-status-loading')).toBeDefined();
    expect(screen.getByText(/Loading withdrawal queue status/)).toBeDefined();
  });

  it('renders empty queue state', () => {
    vi.mocked(hookModule.useWithdrawalQueueStatus).mockReturnValue({
      state: 'empty',
      depth: 0,
      oldestAgeLedgers: null,
      oldestQueuedLedger: null,
      estimatedWaitMinutes: null,
      estimatedPosition: 0,
      specificRequest: null,
      contractVersion: 1,
      lastUpdated: Date.now(),
      isStale: false,
      errorMessage: null,
      pollCount: 1,
      isPollingActive: true,
      settlementDisclaimer: hookModule.SETTLEMENT_TIME_DISCLAIMER,
      refetch: mockRefetch,
    });

    render(<WithdrawalQueueStatus />);
    expect(screen.getByTestId('queue-status-empty')).toBeDefined();
    expect(screen.getByText(/Withdrawal Queue is Empty/)).toBeDefined();
    expect(screen.getByText(/0 pending/)).toBeDefined();
  });

  it('renders active queue state with depth and oldest age', () => {
    vi.mocked(hookModule.useWithdrawalQueueStatus).mockReturnValue({
      state: 'active',
      depth: 4,
      oldestAgeLedgers: 72,
      oldestQueuedLedger: 100200,
      estimatedWaitMinutes: 6,
      estimatedPosition: 4,
      specificRequest: null,
      contractVersion: 1,
      lastUpdated: Date.now(),
      isStale: false,
      errorMessage: null,
      pollCount: 2,
      isPollingActive: true,
      settlementDisclaimer: hookModule.SETTLEMENT_TIME_DISCLAIMER,
      refetch: mockRefetch,
    });

    render(<WithdrawalQueueStatus />);
    expect(screen.getByTestId('queue-status-active')).toBeDefined();
    expect(screen.getByText('4 requests')).toBeDefined();
    expect(screen.getByText(/72 ledgers/)).toBeDefined();
    expect(screen.getByText(/#5/)).toBeDefined();
    expect(
      screen.getByText(hookModule.SETTLEMENT_TIME_DISCLAIMER),
    ).toBeDefined();
  });

  it('renders stale data indicator', () => {
    vi.mocked(hookModule.useWithdrawalQueueStatus).mockReturnValue({
      state: 'stale',
      depth: 2,
      oldestAgeLedgers: 20,
      oldestQueuedLedger: 100200,
      estimatedWaitMinutes: 2,
      estimatedPosition: 2,
      specificRequest: null,
      contractVersion: 1,
      lastUpdated: Date.now() - 40000,
      isStale: true,
      errorMessage: null,
      pollCount: 3,
      isPollingActive: false,
      settlementDisclaimer: hookModule.SETTLEMENT_TIME_DISCLAIMER,
      refetch: mockRefetch,
    });

    render(<WithdrawalQueueStatus />);
    expect(screen.getByTestId('queue-status-stale')).toBeDefined();
    expect(screen.getByText('Stale Data')).toBeDefined();
  });

  it('renders RPC error with retry button', async () => {
    vi.mocked(hookModule.useWithdrawalQueueStatus).mockReturnValue({
      state: 'rpc_error',
      depth: null,
      oldestAgeLedgers: null,
      oldestQueuedLedger: null,
      estimatedWaitMinutes: null,
      estimatedPosition: null,
      specificRequest: null,
      contractVersion: null,
      lastUpdated: null,
      isStale: false,
      errorMessage: 'RPC connection lost',
      pollCount: 1,
      isPollingActive: false,
      settlementDisclaimer: hookModule.SETTLEMENT_TIME_DISCLAIMER,
      refetch: mockRefetch,
    });

    render(<WithdrawalQueueStatus />);
    expect(screen.getByTestId('queue-status-rpc-error')).toBeDefined();
    expect(screen.getByText('RPC connection lost')).toBeDefined();

    const retryBtn = screen.getByRole('button', { name: /Retry/i });
    await act(async () => {
      fireEvent.click(retryBtn);
    });
    expect(mockRefetch).toHaveBeenCalledTimes(1);
  });

  it('renders contract version mismatch state', () => {
    vi.mocked(hookModule.useWithdrawalQueueStatus).mockReturnValue({
      state: 'version_mismatch',
      depth: null,
      oldestAgeLedgers: null,
      oldestQueuedLedger: null,
      estimatedWaitMinutes: null,
      estimatedPosition: null,
      specificRequest: null,
      contractVersion: 2,
      lastUpdated: null,
      isStale: false,
      errorMessage: 'Contract version mismatch: expected v1, found v2.',
      pollCount: 1,
      isPollingActive: false,
      settlementDisclaimer: hookModule.SETTLEMENT_TIME_DISCLAIMER,
      refetch: mockRefetch,
    });

    render(<WithdrawalQueueStatus />);
    expect(screen.getByTestId('queue-status-version-mismatch')).toBeDefined();
    expect(
      screen.getByText(/Contract version mismatch: expected v1, found v2/),
    ).toBeDefined();
  });
});
