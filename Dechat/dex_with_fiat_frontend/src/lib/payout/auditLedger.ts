import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

export type PayoutAuditAction =
  | 'payout_initiated'
  | 'payout_provider_accepted'
  | 'payout_succeeded'
  | 'payout_failed'
  | 'payout_reversed'
  | 'payout_event_rejected'
  | 'retry_scheduled'
  | 'retry_attempted'
  | 'retry_exhausted'
  | 'dead_letter_moved'
  | 'dead_letter_replayed'
  | 'operator_intervention';

export interface PayoutAuditEntry {
  id: string;
  sequenceNumber: number;
  payoutId: string;
  action: PayoutAuditAction;
  actor: string;
  requestCorrelationId: string;
  providerReference: string;
  timestamp: string;
  metadata: Record<string, unknown>;
  previousHash: string;
  hash: string;
}

export interface RecordPayoutEventParams {
  payoutId: string;
  action: PayoutAuditAction;
  actor: string;
  requestCorrelationId?: string;
  providerReference?: string;
  metadata?: Record<string, unknown>;
  timestamp?: string;
}

export interface PayoutAuditFilter {
  payoutId?: string;
  action?: PayoutAuditAction;
  actor?: string;
  providerReference?: string;
  startDate?: string | Date;
  endDate?: string | Date;
}

export interface PaginationOptions {
  page?: number;
  limit?: number;
}

export interface PaginatedPayoutAuditResult {
  entries: PayoutAuditEntry[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  hasMore: boolean;
}

export class PayoutAuditLedger {
  private entries: PayoutAuditEntry[] = [];
  private storageFilePath: string | null = null;
  private lastHash = '0'.repeat(64);

  constructor(storageDir?: string) {
    if (storageDir) {
      this.initStorage(storageDir);
    } else if (process.env.PAYOUT_DATA_DIR) {
      this.initStorage(process.env.PAYOUT_DATA_DIR);
    }
  }

  public initStorage(storageDir: string): void {
    try {
      if (!fs.existsSync(storageDir)) {
        fs.mkdirSync(storageDir, { recursive: true });
      }
      this.storageFilePath = path.join(storageDir, 'payout_audit_ledger.jsonl');
      this.loadFromFile();
    } catch (err) {
      console.warn('Failed to initialize audit ledger storage:', err);
    }
  }

  private loadFromFile(): void {
    if (!this.storageFilePath || !fs.existsSync(this.storageFilePath)) {
      return;
    }

    try {
      const fileData = fs.readFileSync(this.storageFilePath, 'utf8');
      const lines = fileData
        .split('\n')
        .filter((line) => line.trim().length > 0);
      const loaded: PayoutAuditEntry[] = [];

      for (const line of lines) {
        try {
          const entry = JSON.parse(line) as PayoutAuditEntry;
          loaded.push(entry);
        } catch {
          // Skip corrupted line
        }
      }

      this.entries = loaded;
      if (loaded.length > 0) {
        this.lastHash = loaded[loaded.length - 1].hash;
      }
    } catch (err) {
      console.warn('Failed to load audit ledger from file:', err);
    }
  }

  private appendToFile(entry: PayoutAuditEntry): void {
    if (!this.storageFilePath) return;

    try {
      fs.appendFileSync(
        this.storageFilePath,
        JSON.stringify(entry) + '\n',
        'utf8',
      );
    } catch (err) {
      console.error('Failed to append audit record to file:', err);
    }
  }

  private computeHash(
    sequenceNumber: number,
    previousHash: string,
    payoutId: string,
    action: string,
    actor: string,
    requestCorrelationId: string,
    providerReference: string,
    timestamp: string,
    metadata: Record<string, unknown>,
  ): string {
    const raw = `${sequenceNumber}|${previousHash}|${payoutId}|${action}|${actor}|${requestCorrelationId}|${providerReference}|${timestamp}|${JSON.stringify(metadata)}`;
    return crypto.createHash('sha256').update(raw).digest('hex');
  }

  /**
   * Append an immutable audit event to the ledger.
   */
  public recordEvent(params: RecordPayoutEventParams): PayoutAuditEntry {
    const sequenceNumber = this.entries.length + 1;
    const timestamp = params.timestamp || new Date().toISOString();
    const requestCorrelationId = params.requestCorrelationId || 'n/a';
    const providerReference = params.providerReference || params.payoutId;
    const metadata = params.metadata ? { ...params.metadata } : {};
    const previousHash = this.lastHash;

    const hash = this.computeHash(
      sequenceNumber,
      previousHash,
      params.payoutId,
      params.action,
      params.actor,
      requestCorrelationId,
      providerReference,
      timestamp,
      metadata,
    );

    const entry: PayoutAuditEntry = Object.freeze({
      id: `audit_${sequenceNumber}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
      sequenceNumber,
      payoutId: params.payoutId,
      action: params.action,
      actor: params.actor,
      requestCorrelationId,
      providerReference,
      timestamp,
      metadata,
      previousHash,
      hash,
    });

    this.entries.push(entry);
    this.lastHash = hash;
    this.appendToFile(entry);

    return entry;
  }

  /**
   * Filter and paginate audit entries. Read-only.
   */
  public getEntries(
    filter?: PayoutAuditFilter,
    pagination?: PaginationOptions,
  ): PaginatedPayoutAuditResult {
    let filtered = [...this.entries];

    if (filter) {
      if (filter.payoutId) {
        filtered = filtered.filter((e) => e.payoutId === filter.payoutId);
      }
      if (filter.action) {
        filtered = filtered.filter((e) => e.action === filter.action);
      }
      if (filter.actor) {
        filtered = filtered.filter((e) => e.actor === filter.actor);
      }
      if (filter.providerReference) {
        filtered = filtered.filter(
          (e) => e.providerReference === filter.providerReference,
        );
      }
      if (filter.startDate) {
        const start = new Date(filter.startDate).getTime();
        filtered = filtered.filter(
          (e) => new Date(e.timestamp).getTime() >= start,
        );
      }
      if (filter.endDate) {
        const end = new Date(filter.endDate).getTime();
        filtered = filtered.filter(
          (e) => new Date(e.timestamp).getTime() <= end,
        );
      }
    }

    // Default newest first
    filtered.sort(
      (a, b) =>
        new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
    );

    const total = filtered.length;
    const limit = Math.min(Math.max(pagination?.limit || 20, 1), 100);
    const totalPages = Math.max(Math.ceil(total / limit), 1);
    const page = Math.min(Math.max(pagination?.page || 1, 1), totalPages);
    const startIndex = (page - 1) * limit;
    const paginatedEntries = filtered.slice(startIndex, startIndex + limit);

    return {
      entries: paginatedEntries,
      total,
      page,
      pageSize: limit,
      totalPages,
      hasMore: page < totalPages,
    };
  }

  /**
   * Export audit log as CSV suitable for reconciliation.
   */
  public exportCsv(filter?: PayoutAuditFilter): string {
    const { entries } = this.getEntries(filter, { limit: 10000 });
    const headers = [
      'id',
      'sequenceNumber',
      'payoutId',
      'action',
      'actor',
      'requestCorrelationId',
      'providerReference',
      'timestamp',
      'metadata',
      'hash',
    ];

    const escapeCsv = (val: unknown): string => {
      if (val === undefined || val === null) return '""';
      const str = typeof val === 'object' ? JSON.stringify(val) : String(val);
      return `"${str.replace(/"/g, '""')}"`;
    };

    const rows = entries.map((e) =>
      [
        escapeCsv(e.id),
        escapeCsv(e.sequenceNumber),
        escapeCsv(e.payoutId),
        escapeCsv(e.action),
        escapeCsv(e.actor),
        escapeCsv(e.requestCorrelationId),
        escapeCsv(e.providerReference),
        escapeCsv(e.timestamp),
        escapeCsv(e.metadata),
        escapeCsv(e.hash),
      ].join(','),
    );

    return [headers.join(','), ...rows].join('\n');
  }

  /**
   * Verify cryptographic integrity of the append-only ledger.
   */
  public verifyIntegrity(): { valid: boolean; invalidEntries: string[] } {
    let expectedPrevious = '0'.repeat(64);
    const invalidEntries: string[] = [];

    for (const entry of this.entries) {
      if (entry.previousHash !== expectedPrevious) {
        invalidEntries.push(entry.id);
      }

      const calculated = this.computeHash(
        entry.sequenceNumber,
        entry.previousHash,
        entry.payoutId,
        entry.action,
        entry.actor,
        entry.requestCorrelationId,
        entry.providerReference,
        entry.timestamp,
        entry.metadata,
      );

      if (calculated !== entry.hash) {
        invalidEntries.push(entry.id);
      }

      expectedPrevious = entry.hash;
    }

    return {
      valid: invalidEntries.length === 0,
      invalidEntries,
    };
  }

  /**
   * Explicitly prevent modification of historical records.
   */
  public update(): never {
    throw new Error(
      'Audit ledger is append-only: modifications are strictly prohibited.',
    );
  }

  public delete(): never {
    throw new Error(
      'Audit ledger is append-only: deletions are strictly prohibited.',
    );
  }

  /**
   * Test-only helper to reset in-memory state or switch directory
   */
  public _resetForTest(newDir?: string): void {
    this.entries = [];
    this.lastHash = '0'.repeat(64);
    this.storageFilePath = null;
    if (newDir) {
      this.initStorage(newDir);
    }
  }
}

export const payoutAuditLedger = new PayoutAuditLedger();
