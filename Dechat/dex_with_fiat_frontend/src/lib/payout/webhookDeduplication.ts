import fs from 'fs';
import path from 'path';

export interface WebhookDedupeRecord {
  eventId: string;
  eventType: string;
  payoutReference?: string;
  payloadHash: string;
  status: 'in_flight' | 'committed' | 'failed';
  createdAt: number;
  committedAt?: number;
}

export interface WebhookDedupeConfig {
  retentionMs?: number; // Default 7 days
  inFlightTimeoutMs?: number; // Default 30s
  storageDir?: string;
}

const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const DEFAULT_IN_FLIGHT_TIMEOUT_MS = 30 * 1000; // 30 seconds

export class WebhookDeduplicationService {
  private records: Map<string, WebhookDedupeRecord> = new Map();
  private storageFilePath: string | null = null;
  private retentionMs: number;
  private inFlightTimeoutMs: number;

  constructor(config?: WebhookDedupeConfig) {
    this.retentionMs = config?.retentionMs || DEFAULT_RETENTION_MS;
    this.inFlightTimeoutMs =
      config?.inFlightTimeoutMs || DEFAULT_IN_FLIGHT_TIMEOUT_MS;

    const dir = config?.storageDir || process.env.PAYOUT_DATA_DIR;
    if (dir) {
      this.initStorage(dir);
    }
  }

  public initStorage(storageDir: string): void {
    try {
      if (!fs.existsSync(storageDir)) {
        fs.mkdirSync(storageDir, { recursive: true });
      }
      this.storageFilePath = path.join(storageDir, 'webhook_dedupe.json');
      this.loadFromFile();
    } catch (err) {
      console.warn('Failed to initialize webhook deduplication storage:', err);
    }
  }

  private loadFromFile(): void {
    if (!this.storageFilePath || !fs.existsSync(this.storageFilePath)) {
      return;
    }

    try {
      const data = fs.readFileSync(this.storageFilePath, 'utf8');
      const parsed = JSON.parse(data) as Record<string, WebhookDedupeRecord>;
      this.records = new Map(Object.entries(parsed));
      this.pruneExpired();
    } catch (err) {
      console.warn('Failed to load webhook dedupe records from disk:', err);
    }
  }

  private persistToFile(): void {
    if (!this.storageFilePath) return;

    try {
      const obj: Record<string, WebhookDedupeRecord> = {};
      for (const [k, v] of this.records.entries()) {
        obj[k] = v;
      }
      const tmpPath = `${this.storageFilePath}.${Date.now()}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(obj, null, 2), 'utf8');
      fs.renameSync(tmpPath, this.storageFilePath);
    } catch (err) {
      console.error('Failed to persist webhook dedupe records to disk:', err);
    }
  }

  public pruneExpired(now = Date.now()): void {
    let changed = false;
    for (const [key, record] of this.records.entries()) {
      if (now - record.createdAt > this.retentionMs) {
        this.records.delete(key);
        changed = true;
      } else if (
        record.status === 'in_flight' &&
        now - record.createdAt > this.inFlightTimeoutMs
      ) {
        // Expired in-flight lock - recover deterministically
        record.status = 'failed';
        changed = true;
      }
    }
    if (changed) {
      this.persistToFile();
    }
  }

  /**
   * Check if event identifier has already been processed or is in-flight.
   * Atomic check-and-acquire for incoming webhook event.
   */
  public async acquireOrCheck(
    eventId: string,
    eventType: string,
    payloadHash: string,
    payoutReference?: string,
  ): Promise<{
    acquired: boolean;
    isDuplicate: boolean;
    record?: WebhookDedupeRecord;
  }> {
    this.pruneExpired();

    const existing = this.records.get(eventId);

    if (existing) {
      if (existing.status === 'committed') {
        return { acquired: false, isDuplicate: true, record: existing };
      }

      if (existing.status === 'in_flight') {
        const age = Date.now() - existing.createdAt;
        if (age <= this.inFlightTimeoutMs) {
          // Concurrent delivery underway
          return { acquired: false, isDuplicate: true, record: existing };
        }
        // Timed out in-flight: reclaim lock for deterministic recovery
      }
    }

    const now = Date.now();
    const newRecord: WebhookDedupeRecord = {
      eventId,
      eventType,
      payloadHash,
      payoutReference,
      status: 'in_flight',
      createdAt: now,
    };

    this.records.set(eventId, newRecord);
    this.persistToFile();

    return { acquired: true, isDuplicate: false, record: newRecord };
  }

  /**
   * Commit the event processing atomically with the state transition.
   */
  public commit(eventId: string): void {
    const record = this.records.get(eventId);
    if (!record) return;

    record.status = 'committed';
    record.committedAt = Date.now();
    this.persistToFile();
  }

  /**
   * Deterministic recovery if event processing fails before commit.
   */
  public releaseOnError(eventId: string): void {
    const record = this.records.get(eventId);
    if (!record) return;

    record.status = 'failed';
    this.persistToFile();
  }

  /**
   * Process a webhook event with durable deduplication and atomic commit.
   */
  public async processEvent<T>(
    eventId: string,
    eventType: string,
    payloadHash: string,
    payoutReference: string | undefined,
    handler: () => Promise<T>,
  ): Promise<{
    duplicate: boolean;
    result?: T;
    providerResponse: { received: boolean; duplicate?: boolean };
  }> {
    const { acquired, isDuplicate } = await this.acquireOrCheck(
      eventId,
      eventType,
      payloadHash,
      payoutReference,
    );

    if (!acquired && isDuplicate) {
      return {
        duplicate: true,
        providerResponse: { received: true, duplicate: true },
      };
    }

    try {
      const result = await handler();
      this.commit(eventId);
      return {
        duplicate: false,
        result,
        providerResponse: { received: true },
      };
    } catch (error) {
      this.releaseOnError(eventId);
      throw error;
    }
  }

  public getRecord(eventId: string): WebhookDedupeRecord | undefined {
    return this.records.get(eventId);
  }

  public _resetForTest(newDir?: string): void {
    this.records.clear();
    this.storageFilePath = null;
    if (newDir) {
      this.initStorage(newDir);
    }
  }
}

export const webhookDeduplicationService = new WebhookDeduplicationService();
