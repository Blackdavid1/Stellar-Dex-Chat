'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import type { TransactionHistoryEntry } from '@/types';
import {
  paginateTxEntries,
  PaginatedTxResult,
  TxCursorFilters,
} from '@/lib/txCursorPagination';
import { useTxHistory } from './useTxHistory';

export interface UsePaginatedTxHistoryOptions {
  pageSize?: number;
  filters?: TxCursorFilters;
  accountAddress?: string;
  network?: string;
  /** Custom data fetcher. Defaults to the local transaction history store paginated via stable cursors. */
  fetcher?: (params: {
    cursor: string | null;
    limit: number;
    filters?: TxCursorFilters;
  }) => Promise<PaginatedTxResult<TransactionHistoryEntry>>;
}

export interface UsePaginatedTxHistoryReturn {
  entries: TransactionHistoryEntry[];
  isLoading: boolean;
  isLoadingMore: boolean;
  error: string | null;
  hasMore: boolean;
  isEndOfHistory: boolean;
  isEmpty: boolean;
  loadMore: () => Promise<void>;
  retry: () => Promise<void>;
  refresh: () => Promise<void>;
}

export function usePaginatedTxHistory(
  options: UsePaginatedTxHistoryOptions = {},
): UsePaginatedTxHistoryReturn {
  const {
    pageSize = 10,
    filters,
    accountAddress,
    network,
    fetcher,
  } = options;

  const { entries: allStoreEntries } = useTxHistory();

  const [entries, setEntries] = useState<TransactionHistoryEntry[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Keep track of the failed action to support retry
  const lastFailedActionRef = useRef<'initial' | 'loadMore' | null>(null);

  // Stable ref to options/callbacks
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const filtersRef = useRef(filters);
  filtersRef.current = filters;

  const allStoreEntriesRef = useRef(allStoreEntries);
  allStoreEntriesRef.current = allStoreEntries;

  const defaultFetcher = useCallback(
    async (params: {
      cursor: string | null;
      limit: number;
      filters?: TxCursorFilters;
    }): Promise<PaginatedTxResult<TransactionHistoryEntry>> => {
      // Simulate async boundary
      await new Promise((resolve) => setTimeout(resolve, 10));
      return paginateTxEntries({
        entries: allStoreEntriesRef.current,
        cursor: params.cursor,
        limit: params.limit,
        filters: params.filters,
      });
    },
    [],
  );

  const executeFetch = useCallback(
    async (
      cursor: string | null,
      isLoadMore: boolean,
    ): Promise<boolean> => {
      if (isLoadMore) {
        setIsLoadingMore(true);
      } else {
        setIsLoading(true);
      }
      setError(null);

      try {
        const fetchFn = fetcherRef.current || defaultFetcher;
        const result = await fetchFn({
          cursor,
          limit: pageSize,
          filters: filtersRef.current,
        });

        if (isLoadMore) {
          // Avoid duplicate entries when appending
          setEntries((prev) => {
            const existingIds = new Set(prev.map((e) => e.id));
            const newItems = result.items.filter((item) => !existingIds.has(item.id));
            return [...prev, ...newItems];
          });
        } else {
          setEntries(result.items);
        }

        setNextCursor(result.nextCursor);
        setHasMore(result.hasMore);
        lastFailedActionRef.current = null;
        return true;
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Failed to load transaction history';
        setError(msg);
        lastFailedActionRef.current = isLoadMore ? 'loadMore' : 'initial';
        return false;
      } finally {
        setIsLoading(false);
        setIsLoadingMore(false);
      }
    },
    [defaultFetcher, pageSize],
  );

  // Invalidate and reload when account, network, or filters change
  const refresh = useCallback(async () => {
    setEntries([]);
    setNextCursor(null);
    setHasMore(false);
    await executeFetch(null, false);
  }, [executeFetch]);

  useEffect(() => {
    void refresh();
  }, [accountAddress, network, JSON.stringify(filters), refresh]);

  const loadMore = useCallback(async () => {
    if (!hasMore || isLoading || isLoadingMore || !nextCursor) {
      return;
    }
    await executeFetch(nextCursor, true);
  }, [executeFetch, hasMore, isLoading, isLoadingMore, nextCursor]);

  const retry = useCallback(async () => {
    if (lastFailedActionRef.current === 'loadMore' && nextCursor) {
      await executeFetch(nextCursor, true);
    } else {
      await refresh();
    }
  }, [executeFetch, nextCursor, refresh]);

  const isEndOfHistory = !hasMore && !isLoading && !isLoadingMore && entries.length > 0;
  const isEmpty = !isLoading && !isLoadingMore && entries.length === 0 && !error;

  return {
    entries,
    isLoading,
    isLoadingMore,
    error,
    hasMore,
    isEndOfHistory,
    isEmpty,
    loadMore,
    retry,
    refresh,
  };
}
