import { describe, it, expect } from 'vitest';
import {
  encodeTxCursor,
  decodeTxCursor,
  compareTxEntriesDesc,
  paginateTxEntries,
} from '../txCursorPagination';
import type { TransactionHistoryEntry } from '@/types';

function createMockEntry(
  id: string,
  timestampMs: number,
  kind: 'deposit' | 'payout' | 'risk_warning' = 'deposit',
  status: 'completed' | 'pending' | 'failed' = 'completed',
  asset: string = 'USDC',
): TransactionHistoryEntry {
  return {
    id,
    createdAt: new Date(timestampMs),
    kind,
    status,
    asset,
    amount: '10',
    message: `Tx ${id}`,
  };
}

describe('txCursorPagination (#61)', () => {
  describe('encodeTxCursor & decodeTxCursor', () => {
    it('encodes and decodes valid entry cursor faithfully', () => {
      const entry = {
        id: 'tx-12345',
        createdAt: new Date('2026-05-10T14:30:00.000Z'),
      };
      const cursor = encodeTxCursor(entry);
      expect(typeof cursor).toBe('string');
      expect(cursor.length).toBeGreaterThan(0);

      const decoded = decodeTxCursor(cursor);
      expect(decoded).not.toBeNull();
      expect(decoded?.timestamp).toBe(entry.createdAt.getTime());
      expect(decoded?.id).toBe('tx-12345');
    });

    it('returns null for invalid or corrupted cursors', () => {
      expect(decodeTxCursor(null)).toBeNull();
      expect(decodeTxCursor(undefined)).toBeNull();
      expect(decodeTxCursor('')).toBeNull();
      expect(decodeTxCursor('invalid!not-base64')).toBeNull();
      expect(decodeTxCursor('bm9fc2VwYXJhdG9y')).toBeNull(); // base64 of 'no_separator'
    });
  });

  describe('compareTxEntriesDesc', () => {
    it('orders primarily by timestamp descending', () => {
      const t1 = createMockEntry('tx-old', 1000);
      const t2 = createMockEntry('tx-new', 2000);

      expect(compareTxEntriesDesc(t1, t2)).toBeGreaterThan(0);
      expect(compareTxEntriesDesc(t2, t1)).toBeLessThan(0);
    });

    it('breaks ties deterministically using id descending', () => {
      const tA = createMockEntry('aaa', 1000);
      const tB = createMockEntry('bbb', 1000);

      // 'bbb' > 'aaa' so b comes first, b - a < 0
      expect(compareTxEntriesDesc(tB, tA)).toBeLessThan(0);
      expect(compareTxEntriesDesc(tA, tB)).toBeGreaterThan(0);
    });
  });

  describe('paginateTxEntries', () => {
    const entries: TransactionHistoryEntry[] = [
      createMockEntry('tx-1', 1000),
      createMockEntry('tx-2', 2000),
      createMockEntry('tx-3', 3000),
      createMockEntry('tx-4', 4000),
      createMockEntry('tx-5', 5000),
    ];

    it('returns first page up to limit with nextCursor', () => {
      const result = paginateTxEntries({ entries, limit: 2 });
      expect(result.items.map((i) => i.id)).toEqual(['tx-5', 'tx-4']);
      expect(result.hasMore).toBe(true);
      expect(result.nextCursor).not.toBeNull();
      expect(result.totalFiltered).toBe(5);
    });

    it('fetches subsequent pages faithfully using nextCursor', () => {
      const page1 = paginateTxEntries({ entries, limit: 2 });
      const page2 = paginateTxEntries({ entries, cursor: page1.nextCursor, limit: 2 });
      const page3 = paginateTxEntries({ entries, cursor: page2.nextCursor, limit: 2 });

      expect(page1.items.map((i) => i.id)).toEqual(['tx-5', 'tx-4']);
      expect(page2.items.map((i) => i.id)).toEqual(['tx-3', 'tx-2']);
      expect(page3.items.map((i) => i.id)).toEqual(['tx-1']);
      expect(page3.hasMore).toBe(false);
      expect(page3.nextCursor).toBeNull();
    });

    it('guarantees stable pagination with prepend inserts (no duplicates, no skips)', () => {
      // User is on page 1 (sees tx-5, tx-4)
      const page1 = paginateTxEntries({ entries, limit: 2 });
      expect(page1.items.map((i) => i.id)).toEqual(['tx-5', 'tx-4']);

      // 3 brand new transactions arrive at the top (prepended)
      const updatedEntries: TransactionHistoryEntry[] = [
        createMockEntry('tx-6', 6000),
        createMockEntry('tx-7', 7000),
        createMockEntry('tx-8', 8000),
        ...entries,
      ];

      // User requests page 2 using page1.nextCursor
      const page2 = paginateTxEntries({
        entries: updatedEntries,
        cursor: page1.nextCursor,
        limit: 2,
      });

      // Page 2 MUST continue from after tx-4: namely tx-3 and tx-2!
      // In offset-based pagination this would have skipped items or duplicated them.
      expect(page2.items.map((i) => i.id)).toEqual(['tx-3', 'tx-2']);

      const page3 = paginateTxEntries({
        entries: updatedEntries,
        cursor: page2.nextCursor,
        limit: 2,
      });
      expect(page3.items.map((i) => i.id)).toEqual(['tx-1']);
      expect(page3.hasMore).toBe(false);
    });

    it('preserves filters across paginated pages', () => {
      const mixedEntries: TransactionHistoryEntry[] = [
        createMockEntry('tx-d1', 5000, 'deposit'),
        createMockEntry('tx-p1', 4000, 'payout'),
        createMockEntry('tx-d2', 3000, 'deposit'),
        createMockEntry('tx-p2', 2000, 'payout'),
        createMockEntry('tx-d3', 1000, 'deposit'),
      ];

      const page1 = paginateTxEntries({
        entries: mixedEntries,
        filters: { kind: 'payout' },
        limit: 1,
      });

      expect(page1.items.map((i) => i.id)).toEqual(['tx-p1']);
      expect(page1.hasMore).toBe(true);

      const page2 = paginateTxEntries({
        entries: mixedEntries,
        cursor: page1.nextCursor,
        filters: { kind: 'payout' },
        limit: 1,
      });

      expect(page2.items.map((i) => i.id)).toEqual(['tx-p2']);
      expect(page2.hasMore).toBe(false);
    });

    it('handles empty entries cleanly', () => {
      const result = paginateTxEntries({ entries: [], limit: 10 });
      expect(result.items).toEqual([]);
      expect(result.hasMore).toBe(false);
      expect(result.nextCursor).toBeNull();
      expect(result.totalFiltered).toBe(0);
    });

    it('handles out-of-range cursor gracefully', () => {
      const expiredCursor = encodeTxCursor({ id: 'tx-oldest', createdAt: new Date(100) });
      const result = paginateTxEntries({ entries, cursor: expiredCursor, limit: 10 });
      expect(result.items).toEqual([]);
      expect(result.hasMore).toBe(false);
      expect(result.nextCursor).toBeNull();
    });
  });
});
