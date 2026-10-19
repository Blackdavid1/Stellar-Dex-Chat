import { renderHook, act, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { usePaginatedTxHistory } from '../usePaginatedTxHistory';
import type { TransactionHistoryEntry } from '@/types';
import { encodeTxCursor } from '@/lib/txCursorPagination';

const mockStoreEntries: TransactionHistoryEntry[] = [];

vi.mock('../useTxHistory', () => ({
  useTxHistory: () => ({
    entries: mockStoreEntries,
  }),
}));

function createEntry(id: string, timestamp: number): TransactionHistoryEntry {
  return {
    id,
    createdAt: new Date(timestamp),
    kind: 'deposit',
    status: 'completed',
    amount: '10',
    asset: 'XLM',
    message: `Deposit ${id}`,
  };
}

describe('usePaginatedTxHistory (#61)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStoreEntries.length = 0;
  });

  it('loads first page and exposes correct initial states', async () => {
    const mockFetcher = vi.fn().mockResolvedValue({
      items: [createEntry('tx-1', 2000), createEntry('tx-2', 1000)],
      nextCursor: 'cursor-page-1',
      hasMore: true,
      totalFiltered: 4,
    });

    const { result } = renderHook(() =>
      usePaginatedTxHistory({ pageSize: 2, fetcher: mockFetcher }),
    );

    expect(result.current.isLoading).toBe(true);

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.entries).toHaveLength(2);
    expect(result.current.entries[0].id).toBe('tx-1');
    expect(result.current.hasMore).toBe(true);
    expect(result.current.isEndOfHistory).toBe(false);
    expect(result.current.isEmpty).toBe(false);
  });

  it('appends next page on loadMore without duplicating entries', async () => {
    const page1Entries = [createEntry('tx-1', 4000), createEntry('tx-2', 3000)];
    const page2Entries = [createEntry('tx-3', 2000), createEntry('tx-4', 1000)];

    const mockFetcher = vi
      .fn()
      .mockResolvedValueOnce({
        items: page1Entries,
        nextCursor: encodeTxCursor(page1Entries[1]),
        hasMore: true,
        totalFiltered: 4,
      })
      .mockResolvedValueOnce({
        items: page2Entries,
        nextCursor: null,
        hasMore: false,
        totalFiltered: 4,
      });

    const { result } = renderHook(() =>
      usePaginatedTxHistory({ pageSize: 2, fetcher: mockFetcher }),
    );

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.entries).toHaveLength(2);

    await act(async () => {
      await result.current.loadMore();
    });

    expect(result.current.entries).toHaveLength(4);
    expect(result.current.entries.map((e) => e.id)).toEqual([
      'tx-1',
      'tx-2',
      'tx-3',
      'tx-4',
    ]);
    expect(result.current.hasMore).toBe(false);
    expect(result.current.isEndOfHistory).toBe(true);
  });

  it('invalidates state and re-fetches when accountAddress changes', async () => {
    const mockFetcher = vi.fn().mockResolvedValue({
      items: [createEntry('tx-acc1', 1000)],
      nextCursor: null,
      hasMore: false,
      totalFiltered: 1,
    });

    const { result, rerender } = renderHook(
      ({ account }) =>
        usePaginatedTxHistory({
          accountAddress: account,
          network: 'TESTNET',
          fetcher: mockFetcher,
        }),
      { initialProps: { account: 'GA_ACCOUNT_1' } },
    );

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(mockFetcher).toHaveBeenCalledTimes(1);

    // Switch account
    rerender({ account: 'GA_ACCOUNT_2' });

    await waitFor(() => {
      expect(mockFetcher).toHaveBeenCalledTimes(2);
    });
  });

  it('invalidates state and re-fetches when network changes', async () => {
    const mockFetcher = vi.fn().mockResolvedValue({
      items: [createEntry('tx-net1', 1000)],
      nextCursor: null,
      hasMore: false,
      totalFiltered: 1,
    });

    const { result, rerender } = renderHook(
      ({ network }) =>
        usePaginatedTxHistory({
          accountAddress: 'GA_TEST',
          network,
          fetcher: mockFetcher,
        }),
      { initialProps: { network: 'TESTNET' } },
    );

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(mockFetcher).toHaveBeenCalledTimes(1);

    // Switch network
    rerender({ network: 'PUBLIC' });

    await waitFor(() => {
      expect(mockFetcher).toHaveBeenCalledTimes(2);
    });
  });

  it('handles partial-error on loadMore without losing loaded entries and retries successfully', async () => {
    const page1Entries = [createEntry('tx-1', 2000)];
    const mockFetcher = vi
      .fn()
      .mockResolvedValueOnce({
        items: page1Entries,
        nextCursor: 'cursor-1',
        hasMore: true,
        totalFiltered: 2,
      })
      .mockRejectedValueOnce(new Error('Network RPC timeout'))
      .mockResolvedValueOnce({
        items: [createEntry('tx-2', 1000)],
        nextCursor: null,
        hasMore: false,
        totalFiltered: 2,
      });

    const { result } = renderHook(() =>
      usePaginatedTxHistory({ pageSize: 1, fetcher: mockFetcher }),
    );

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.entries).toHaveLength(1);

    // Trigger loadMore which fails
    await act(async () => {
      await result.current.loadMore();
    });

    expect(result.current.error).toBe('Network RPC timeout');
    // Already loaded entries are safely preserved
    expect(result.current.entries).toHaveLength(1);

    // Click retry
    await act(async () => {
      await result.current.retry();
    });

    expect(result.current.error).toBeNull();
    expect(result.current.entries).toHaveLength(2);
    expect(result.current.isEndOfHistory).toBe(true);
  });

  it('identifies empty state cleanly', async () => {
    const mockFetcher = vi.fn().mockResolvedValue({
      items: [],
      nextCursor: null,
      hasMore: false,
      totalFiltered: 0,
    });

    const { result } = renderHook(() =>
      usePaginatedTxHistory({ fetcher: mockFetcher }),
    );

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.isEmpty).toBe(true);
    expect(result.current.isEndOfHistory).toBe(false);
  });
});
