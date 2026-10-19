import { TransactionHistoryEntry } from '@/types';

export interface DecodedCursor {
  timestamp: number;
  id: string;
}

export interface TxCursorFilters {
  kind?: string | string[];
  status?: string | string[];
  asset?: string | string[];
  network?: string | string[];
  searchQuery?: string;
}

export interface PaginateTxOptions<T extends TransactionHistoryEntry = TransactionHistoryEntry> {
  entries: T[];
  cursor?: string | null;
  limit?: number;
  filters?: TxCursorFilters;
}

export interface PaginatedTxResult<T extends TransactionHistoryEntry = TransactionHistoryEntry> {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
  totalFiltered: number;
}

/**
 * Encodes a transaction history entry into an opaque stable cursor string.
 * Format is base64(timestamp_id) with URL-safe replacement.
 */
export function encodeTxCursor(entry: { createdAt: Date | string | number; id: string }): string {
  const ts = new Date(entry.createdAt).getTime();
  const raw = `${ts}_${entry.id}`;
  if (typeof btoa === 'function') {
    return btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  return Buffer.from(raw).toString('base64url');
}

/**
 * Decodes a cursor string back into timestamp and entry ID.
 * Returns null if the cursor is malformed or invalid.
 */
export function decodeTxCursor(cursor: string | null | undefined): DecodedCursor | null {
  if (!cursor || typeof cursor !== 'string') {
    return null;
  }

  try {
    let raw: string;
    if (typeof atob === 'function') {
      const normalized = cursor.replace(/-/g, '+').replace(/_/g, '/');
      const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), '=');
      raw = atob(padded);
    } else {
      raw = Buffer.from(cursor, 'base64url').toString('utf-8');
    }

    const separatorIndex = raw.indexOf('_');
    if (separatorIndex === -1) {
      return null;
    }

    const ts = parseInt(raw.substring(0, separatorIndex), 10);
    const id = raw.substring(separatorIndex + 1);

    if (isNaN(ts) || !id) {
      return null;
    }

    return { timestamp: ts, id };
  } catch {
    return null;
  }
}

/**
 * Compares two transaction history entries deterministically:
 * 1. Timestamp descending (newest first).
 * 2. Tie-breaker ID descending (lexicographical).
 */
export function compareTxEntriesDesc(
  a: { createdAt: Date | string | number; id: string },
  b: { createdAt: Date | string | number; id: string },
): number {
  const aTime = new Date(a.createdAt).getTime();
  const bTime = new Date(b.createdAt).getTime();

  if (aTime !== bTime) {
    return bTime - aTime;
  }

  return b.id.localeCompare(a.id);
}

/**
 * Applies optional filters to a transaction entry.
 */
export function matchesTxFilters(entry: TransactionHistoryEntry, filters?: TxCursorFilters): boolean {
  if (!filters) {
    return true;
  }

  if (filters.kind) {
    const kinds = Array.isArray(filters.kind) ? filters.kind : [filters.kind];
    if (kinds.length > 0 && !kinds.includes(entry.kind)) {
      return false;
    }
  }

  if (filters.status) {
    const statuses = Array.isArray(filters.status) ? filters.status : [filters.status];
    if (statuses.length > 0 && !statuses.includes(entry.status)) {
      return false;
    }
  }

  if (filters.asset) {
    const assets = Array.isArray(filters.asset) ? filters.asset : [filters.asset];
    if (assets.length > 0 && (!entry.asset || !assets.includes(entry.asset))) {
      return false;
    }
  }

  if (filters.searchQuery) {
    const query = filters.searchQuery.trim().toLowerCase();
    if (query) {
      const matchId = entry.id.toLowerCase().includes(query);
      const matchHash = entry.txHash ? entry.txHash.toLowerCase().includes(query) : false;
      const matchMsg = entry.message ? entry.message.toLowerCase().includes(query) : false;
      const matchNote = entry.note ? entry.note.toLowerCase().includes(query) : false;
      if (!matchId && !matchHash && !matchMsg && !matchNote) {
        return false;
      }
    }
  }

  return true;
}

/**
 * Paginates a list of transaction history entries using stable cursors.
 *
 * Guarantees:
 * - Deterministic ordering by (createdAt DESC, id DESC).
 * - Stable slicing: passing a cursor returns items strictly after that cursor,
 *   so newly prepended items do not alter subsequent pages or cause duplicate/skipped items.
 */
export function paginateTxEntries<T extends TransactionHistoryEntry = TransactionHistoryEntry>(
  options: PaginateTxOptions<T>,
): PaginatedTxResult<T> {
  const { entries, cursor, limit = 10, filters } = options;

  // 1. Sort all entries deterministically
  const sorted = [...entries].sort(compareTxEntriesDesc);

  // 2. Filter entries
  const filtered = sorted.filter((entry) => matchesTxFilters(entry, filters));

  // 3. If cursor is provided, slice strictly after the cursor position
  let startIndex = 0;
  const decoded = decodeTxCursor(cursor);

  if (decoded) {
    startIndex = filtered.findIndex((entry) => {
      const entryTime = new Date(entry.createdAt).getTime();
      if (entryTime < decoded.timestamp) {
        return true;
      }
      if (entryTime === decoded.timestamp) {
        return entry.id.localeCompare(decoded.id) < 0;
      }
      return false;
    });

    if (startIndex === -1) {
      // Cursor is past the end of the list
      return {
        items: [],
        nextCursor: null,
        hasMore: false,
        totalFiltered: filtered.length,
      };
    }
  }

  const pageItems = filtered.slice(startIndex, startIndex + limit);
  const hasMore = startIndex + limit < filtered.length;
  const nextCursor =
    hasMore && pageItems.length > 0
      ? encodeTxCursor(pageItems[pageItems.length - 1])
      : null;

  return {
    items: pageItems,
    nextCursor,
    hasMore,
    totalFiltered: filtered.length,
  };
}
