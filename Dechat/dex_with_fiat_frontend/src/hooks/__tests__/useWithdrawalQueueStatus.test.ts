import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  useWithdrawalQueueStatus,
  SETTLEMENT_TIME_DISCLAIMER,
} from '../useWithdrawalQueueStatus';
import { fiatBridgeClient } from '@/lib/stellarContract';

vi.mock('@/lib/stellarContract', () => ({
  fiatBridgeClient: {
    getEventVersion: vi.fn(),
    getWithdrawalQueueDepth: vi.fn(),
    getWithdrawalQueueOldestAgeLedgers: vi.fn(),
    getWithdrawalQueueOldestQueuedLedger: vi.fn(),
    getWithdrawalRequest: vi.fn(),
  },
}));

describe('useWithdrawalQueueStatus (#60)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.mocked(fiatBridgeClient.getEventVersion).mockResolvedValue(1);
    vi.mocked(fiatBridgeClient.getWithdrawalQueueDepth).mockResolvedValue(0);
    vi.mocked(fiatBridgeClient.getWithdrawalQueueOldestAgeLedgers).mockResolvedValue(null);
    vi.mocked(fiatBridgeClient.getWithdrawalQueueOldestQueuedLedger).mockResolvedValue(null);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('handles empty queue state', async () => {
    vi.mocked(fiatBridgeClient.getWithdrawalQueueDepth).mockResolvedValue(0);

    const { result } = renderHook(() =>
      useWithdrawalQueueStatus({ pollIntervalMs: 5000 }),
    );

    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.state).toBe('empty');
    expect(result.current.depth).toBe(0);
    expect(result.current.estimatedPosition).toBe(0);
    expect(result.current.settlementDisclaimer).toBe(
      SETTLEMENT_TIME_DISCLAIMER,
    );
  });

  it('handles active queue with depth and oldest age', async () => {
    vi.mocked(fiatBridgeClient.getWithdrawalQueueDepth).mockResolvedValue(5);
    vi.mocked(fiatBridgeClient.getWithdrawalQueueOldestAgeLedgers).mockResolvedValue(60);
    vi.mocked(fiatBridgeClient.getWithdrawalQueueOldestQueuedLedger).mockResolvedValue(123450);

    const { result } = renderHook(() =>
      useWithdrawalQueueStatus({ pollIntervalMs: 5000 }),
    );

    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.state).toBe('active');
    expect(result.current.depth).toBe(5);
    expect(result.current.oldestAgeLedgers).toBe(60);
    expect(result.current.estimatedPosition).toBe(5);
    expect(result.current.estimatedWaitMinutes).toBe(5); // (60 * 5s) / 60 = 5 mins
  });

  it('handles contract-version mismatch', async () => {
    vi.mocked(fiatBridgeClient.getEventVersion).mockResolvedValue(2); // Expected 1

    const { result } = renderHook(() =>
      useWithdrawalQueueStatus({ expectedVersion: 1 }),
    );

    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.state).toBe('version_mismatch');
    expect(result.current.errorMessage).toContain('Contract version mismatch');
  });

  it('handles RPC failure gracefully', async () => {
    vi.mocked(fiatBridgeClient.getWithdrawalQueueDepth).mockRejectedValue(
      new Error('Soroban RPC node timeout'),
    );

    const { result } = renderHook(() => useWithdrawalQueueStatus());

    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.state).toBe('rpc_error');
    expect(result.current.errorMessage).toContain('Soroban RPC node timeout');
  });

  it('detects stale data when freshness threshold is exceeded', async () => {
    vi.mocked(fiatBridgeClient.getWithdrawalQueueDepth).mockResolvedValue(3);

    const { result } = renderHook(() =>
      useWithdrawalQueueStatus({
        pollIntervalMs: 60000,
        staleThresholdMs: 1000,
      }),
    );

    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.state).toBe('active');
    expect(result.current.isStale).toBe(false);

    // Advance time past stale threshold
    act(() => {
      vi.advanceTimersByTime(2000);
    });

    expect(result.current.isStale).toBe(true);
  });

  it('stops polling when view unmounts', async () => {
    const { unmount } = renderHook(() =>
      useWithdrawalQueueStatus({ pollIntervalMs: 1000 }),
    );

    await act(async () => {
      await Promise.resolve();
    });

    const callsBeforeUnmount = vi.mocked(
      fiatBridgeClient.getWithdrawalQueueDepth,
    ).mock.calls.length;

    unmount();

    act(() => {
      vi.advanceTimersByTime(5000);
    });

    expect(
      vi.mocked(fiatBridgeClient.getWithdrawalQueueDepth).mock.calls.length,
    ).toBe(callsBeforeUnmount);
  });

  it('stops polling once bounded maxPollCount is reached', async () => {
    const { result } = renderHook(() =>
      useWithdrawalQueueStatus({ pollIntervalMs: 1000, maxPollCount: 3 }),
    );

    await act(async () => {
      await Promise.resolve();
    });

    // Advance through 3 polls
    for (let i = 0; i < 4; i++) {
      await act(async () => {
        vi.advanceTimersByTime(1000);
        await Promise.resolve();
      });
    }

    expect(result.current.pollCount).toBe(3);
    expect(result.current.isPollingActive).toBe(false);
  });
});
