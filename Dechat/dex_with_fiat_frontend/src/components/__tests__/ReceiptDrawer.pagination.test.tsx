import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import ReceiptDrawer from '../ReceiptDrawer';
import type { TransactionHistoryEntry } from '@/types';

vi.mock('@/contexts/TranslationContext', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

vi.mock('@/contexts/ThemeContext', () => ({
  useTheme: () => ({ isDarkMode: false }),
}));

vi.mock('@/hooks/useTransactionFilters', () => ({
  useTransactionFilters: (txs: unknown[]) => ({
    filterState: {},
    filteredTransactions: txs,
    filterStats: {},
    toggleFilter: vi.fn(),
    clearAllFilters: vi.fn(),
  }),
}));

vi.mock('../filters/FilterChipBar', () => ({
  FilterChipBar: () => null,
}));

vi.mock('../components/ui/skeleton/SkeletonReceipt', () => ({
  default: () => <div data-testid="skeleton" />,
}));

vi.mock('../ReceiptQrCode', () => ({
  default: () => null,
}));

const mockTransactions: TransactionHistoryEntry[] = [
  {
    id: 'tx-1',
    kind: 'deposit',
    status: 'completed',
    amount: '100',
    asset: 'USDC',
    message: 'Deposit 100 USDC',
    createdAt: new Date('2026-05-01T10:00:00Z'),
  },
];

describe('ReceiptDrawer pagination states (#61)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders Load More button when hasMore is true and invokes onLoadMore on click', () => {
    const handleLoadMore = vi.fn();

    render(
      <ReceiptDrawer
        isOpen={true}
        onClose={vi.fn()}
        transactions={mockTransactions}
        hasMore={true}
        isLoadingMore={false}
        onLoadMore={handleLoadMore}
      />,
    );

    const loadMoreBtn = screen.getByTestId('load-more-btn');
    expect(loadMoreBtn).toBeDefined();
    expect(loadMoreBtn.textContent).toContain('Load More Transactions');

    fireEvent.click(loadMoreBtn);
    expect(handleLoadMore).toHaveBeenCalledTimes(1);
  });

  it('renders loading spinner when isLoadingMore is true', () => {
    render(
      <ReceiptDrawer
        isOpen={true}
        onClose={vi.fn()}
        transactions={mockTransactions}
        hasMore={true}
        isLoadingMore={true}
      />,
    );

    expect(screen.getByTestId('loading-more-spinner')).toBeDefined();
    expect(screen.queryByTestId('load-more-btn')).toBeNull();
  });

  it('renders partial error banner with retry button and calls onRetryPagination', () => {
    const handleRetry = vi.fn();

    render(
      <ReceiptDrawer
        isOpen={true}
        onClose={vi.fn()}
        transactions={mockTransactions}
        paginationError="Failed to load next page: RPC timed out"
        onRetryPagination={handleRetry}
      />,
    );

    const errorBanner = screen.getByTestId('pagination-error');
    expect(errorBanner).toBeDefined();
    expect(errorBanner.textContent).toContain(
      'Failed to load next page: RPC timed out',
    );

    const retryBtn = screen.getByTestId('pagination-retry-btn');
    fireEvent.click(retryBtn);
    expect(handleRetry).toHaveBeenCalledTimes(1);
  });

  it('renders end-of-history indicator when isEndOfHistory is true', () => {
    render(
      <ReceiptDrawer
        isOpen={true}
        onClose={vi.fn()}
        transactions={mockTransactions}
        hasMore={false}
        isEndOfHistory={true}
      />,
    );

    const endMarker = screen.getByTestId('end-of-history');
    expect(endMarker).toBeDefined();
    expect(endMarker.textContent).toContain('End of transaction history');
  });
});
