import fs from 'fs';
import path from 'path';
import { payoutAuditLedger, PayoutAuditLedger } from './auditLedger';
import { PayoutProvider } from './providers/types';

export interface RetryJobPayload {
  source: string;
  amount: number;
  recipient: string;
  reason?: string;
  reference: string;
}

export interface RetryJob {
  id: string;
  payoutId: string;
  idempotencyKey: string;
  providerName: 'paystack';
  payload: RetryJobPayload;
  attempts: number;
  maxAttempts: number;
  status: 'pending' | 'processing' | 'dead_letter' | 'completed';
  createdAt: string;
  updatedAt: string;
  nextRunAt: number;
  lastError?: string;
}

export interface BackoffConfig {
  baseDelayMs: number;
  maxDelayMs: number;
  maxAttempts: number;
  jitterFactor: number;
}

export const DEFAULT_BACKOFF_CONFIG: BackoffConfig = {
  baseDelayMs: 1000,
  maxDelayMs: 60000,
  maxAttempts: 5,
  jitterFactor: 0.2,
};

export function calculateNextBackoff(
  attempt: number,
  config: BackoffConfig = DEFAULT_BACKOFF_CONFIG,
  rng: () => number = Math.random,
): number {
  const exponential = config.baseDelayMs * Math.pow(2, Math.max(0, attempt));
  const capped = Math.min(exponential, config.maxDelayMs);
  const jitter = capped * config.jitterFactor * rng();
  return Math.min(capped + jitter, config.maxDelayMs);
}

export class PayoutRetryQueue {
  private jobs: Map<string, RetryJob> = new Map();
  private storageFilePath: string | null = null;
  private config: BackoffConfig;
  private auditLedger: PayoutAuditLedger;

  constructor(
    storageDir?: string,
    config: Partial<BackoffConfig> = {},
    auditLedgerInstance?: PayoutAuditLedger,
  ) {
    this.config = { ...DEFAULT_BACKOFF_CONFIG, ...config };
    this.auditLedger = auditLedgerInstance || payoutAuditLedger;

    const dir = storageDir || process.env.PAYOUT_DATA_DIR;
    if (dir) {
      this.initStorage(dir);
    }
  }

  public initStorage(storageDir: string): void {
    try {
      if (!fs.existsSync(storageDir)) {
        fs.mkdirSync(storageDir, { recursive: true });
      }
      this.storageFilePath = path.join(storageDir, 'payout_retry_queue.json');
      this.loadFromFile();
    } catch (err) {
      console.warn('Failed to initialize retry queue storage:', err);
    }
  }

  private loadFromFile(): void {
    if (!this.storageFilePath || !fs.existsSync(this.storageFilePath)) {
      return;
    }

    try {
      const data = fs.readFileSync(this.storageFilePath, 'utf8');
      const parsed = JSON.parse(data) as Record<string, RetryJob>;
      this.jobs = new Map(Object.entries(parsed));
    } catch (err) {
      console.warn('Failed to load retry queue from disk:', err);
    }
  }

  private persistToFile(): void {
    if (!this.storageFilePath) return;

    try {
      const obj: Record<string, RetryJob> = {};
      for (const [k, v] of this.jobs.entries()) {
        obj[k] = v;
      }
      const tmpPath = `${this.storageFilePath}.${Date.now()}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(obj, null, 2), 'utf8');
      fs.renameSync(tmpPath, this.storageFilePath);
    } catch (err) {
      console.error('Failed to persist retry queue to disk:', err);
    }
  }

  /**
   * Enqueue a failed provider call into the durable retry queue.
   * Guarantees that retries reuse the original idempotency key.
   */
  public enqueueJob(params: {
    payoutId: string;
    idempotencyKey: string;
    payload: {
      source: string;
      amount: number;
      recipient: string;
      reason?: string;
    };
    error?: string;
    initialDelayMs?: number;
    correlationId?: string;
  }): RetryJob {
    const existing = Array.from(this.jobs.values()).find(
      (j) => j.idempotencyKey === params.idempotencyKey,
    );
    if (existing) {
      return existing;
    }

    const now = Date.now();
    const delay = params.initialDelayMs ?? calculateNextBackoff(0, this.config);
    const nextRunAt = now + delay;
    const nowIso = new Date(now).toISOString();

    const job: RetryJob = {
      id: `job_${now}_${Math.random().toString(36).substr(2, 7)}`,
      payoutId: params.payoutId,
      idempotencyKey: params.idempotencyKey,
      providerName: 'paystack',
      payload: {
        ...params.payload,
        // Crucial: reference must always be the original idempotency key
        reference: params.idempotencyKey,
      },
      attempts: 0,
      maxAttempts: this.config.maxAttempts,
      status: 'pending',
      createdAt: nowIso,
      updatedAt: nowIso,
      nextRunAt,
      lastError: params.error,
    };

    this.jobs.set(job.id, job);
    this.persistToFile();

    this.auditLedger.recordEvent({
      payoutId: job.payoutId,
      action: 'retry_scheduled',
      actor: 'system:retry_queue',
      requestCorrelationId: params.correlationId || job.id,
      providerReference: job.idempotencyKey,
      metadata: {
        jobId: job.id,
        attempts: 0,
        nextRunAt: new Date(nextRunAt).toISOString(),
        error: params.error,
      },
    });

    return job;
  }

  /**
   * Process all pending jobs that are currently due.
   */
  public async processDueJobs(
    provider: PayoutProvider,
    now = Date.now(),
  ): Promise<{
    processed: number;
    succeeded: number;
    failed: number;
    deadLetter: number;
  }> {
    let processed = 0;
    let succeeded = 0;
    let failed = 0;
    let deadLetter = 0;

    for (const job of this.jobs.values()) {
      if (job.status !== 'pending' || job.nextRunAt > now) {
        continue;
      }

      processed++;
      job.status = 'processing';
      job.attempts++;
      job.updatedAt = new Date().toISOString();
      this.persistToFile();

      try {
        await provider.initiateTransfer({
          source: job.payload.source,
          amount: job.payload.amount,
          recipient: job.payload.recipient,
          reason: job.payload.reason,
          reference: job.idempotencyKey, // Reuses original idempotency key!
        });

        job.status = 'completed';
        job.updatedAt = new Date().toISOString();
        succeeded++;
        this.persistToFile();

        this.auditLedger.recordEvent({
          payoutId: job.payoutId,
          action: 'payout_provider_accepted',
          actor: 'system:retry_queue',
          providerReference: job.idempotencyKey,
          metadata: {
            jobId: job.id,
            attempts: job.attempts,
            status: 'completed',
          },
        });
      } catch (err: unknown) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        job.lastError = errorMessage;
        job.updatedAt = new Date().toISOString();

        if (job.attempts >= job.maxAttempts) {
          job.status = 'dead_letter';
          deadLetter++;
          this.persistToFile();

          this.auditLedger.recordEvent({
            payoutId: job.payoutId,
            action: 'dead_letter_moved',
            actor: 'system:retry_queue',
            providerReference: job.idempotencyKey,
            metadata: {
              jobId: job.id,
              attempts: job.attempts,
              maxAttempts: job.maxAttempts,
              error: errorMessage,
            },
          });
        } else {
          job.status = 'pending';
          const backoff = calculateNextBackoff(job.attempts, this.config);
          job.nextRunAt = Date.now() + backoff;
          failed++;
          this.persistToFile();

          this.auditLedger.recordEvent({
            payoutId: job.payoutId,
            action: 'retry_attempted',
            actor: 'system:retry_queue',
            providerReference: job.idempotencyKey,
            metadata: {
              jobId: job.id,
              attempts: job.attempts,
              nextRunAt: new Date(job.nextRunAt).toISOString(),
              error: errorMessage,
            },
          });
        }
      }
    }

    return { processed, succeeded, failed, deadLetter };
  }

  /**
   * Retrieve dead-letter jobs for inspection.
   */
  public getDeadLetterJobs(): RetryJob[] {
    return Array.from(this.jobs.values()).filter(
      (j) => j.status === 'dead_letter',
    );
  }

  /**
   * Retrieve all jobs with optional status filter.
   */
  public getJobs(status?: RetryJob['status']): RetryJob[] {
    const list = Array.from(this.jobs.values());
    if (status) {
      return list.filter((j) => j.status === status);
    }
    return list;
  }

  public getJob(id: string): RetryJob | undefined {
    return this.jobs.get(id);
  }

  /**
   * Operator action: Replay an exhausted dead-letter job.
   * Resets status to pending with immediate execution schedule,
   * reusing the original idempotency key to prevent double transfers.
   */
  public replayDeadLetterJob(
    jobId: string,
    actor = 'operator:admin',
  ): RetryJob {
    const job = this.jobs.get(jobId);
    if (!job) {
      throw new Error(`Retry job not found: ${jobId}`);
    }

    if (job.status !== 'dead_letter') {
      throw new Error(
        `Only dead-letter jobs can be replayed. Current status: ${job.status}`,
      );
    }

    job.status = 'pending';
    job.nextRunAt = Date.now(); // run immediately
    job.attempts = 0; // reset attempts for operator replay
    job.updatedAt = new Date().toISOString();
    this.persistToFile();

    this.auditLedger.recordEvent({
      payoutId: job.payoutId,
      action: 'dead_letter_replayed',
      actor,
      providerReference: job.idempotencyKey,
      metadata: {
        jobId: job.id,
        action: 'operator_replay',
        originalIdempotencyKey: job.idempotencyKey,
      },
    });

    return job;
  }

  public _resetForTest(newDir?: string): void {
    this.jobs.clear();
    this.storageFilePath = null;
    if (newDir) {
      this.initStorage(newDir);
    }
  }
}

export const payoutRetryQueue = new PayoutRetryQueue();
