import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { WebhookDeduplicationService } from './webhookDeduplication';

describe('WebhookDeduplicationService', () => {
  let tempDir: string;
  let service: WebhookDeduplicationService;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webhook-dedupe-test-'));
    service = new WebhookDeduplicationService({ storageDir: tempDir });
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it('safely recognizes duplicate events and returns provider-compatible success', async () => {
    const handler = vi.fn().mockResolvedValue({ processed: true });

    // First delivery
    const res1 = await service.processEvent(
      'evt_123',
      'transfer.success',
      'hash_1',
      'ref_abc',
      handler,
    );

    expect(res1.duplicate).toBe(false);
    expect(res1.providerResponse.received).toBe(true);
    expect(res1.providerResponse.duplicate).toBeUndefined();
    expect(handler).toHaveBeenCalledTimes(1);

    // Duplicate delivery
    const res2 = await service.processEvent(
      'evt_123',
      'transfer.success',
      'hash_1',
      'ref_abc',
      handler,
    );

    expect(res2.duplicate).toBe(true);
    expect(res2.providerResponse.received).toBe(true);
    expect(res2.providerResponse.duplicate).toBe(true);
    // Handler should not be invoked again
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('persists event identifiers across simulated server restarts', async () => {
    const handler = vi.fn().mockResolvedValue({ processed: true });

    await service.processEvent(
      'evt_restart',
      'transfer.success',
      'hash_restart',
      'ref_restart',
      handler,
    );
    expect(handler).toHaveBeenCalledTimes(1);

    // Simulate process restart by reloading from the same storage directory
    const restartedService = new WebhookDeduplicationService({
      storageDir: tempDir,
    });
    const duplicateRes = await restartedService.processEvent(
      'evt_restart',
      'transfer.success',
      'hash_restart',
      'ref_restart',
      handler,
    );

    expect(duplicateRes.duplicate).toBe(true);
    expect(duplicateRes.providerResponse.received).toBe(true);
    expect(duplicateRes.providerResponse.duplicate).toBe(true);
    // Handler still only called once
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('handles concurrent handler instances safely without duplicate execution', async () => {
    let executionCount = 0;
    const slowHandler = async () => {
      executionCount++;
      await new Promise((resolve) => setTimeout(resolve, 50));
      return { ok: true };
    };

    // Trigger two concurrent deliveries of the same event
    const [p1, p2] = await Promise.all([
      service.processEvent(
        'evt_concurrent',
        'transfer.success',
        'hash_c',
        'ref_c',
        slowHandler,
      ),
      service.processEvent(
        'evt_concurrent',
        'transfer.success',
        'hash_c',
        'ref_c',
        slowHandler,
      ),
    ]);

    expect(executionCount).toBe(1);
    const duplicates = [p1.duplicate, p2.duplicate];
    expect(duplicates).toContain(false);
    expect(duplicates).toContain(true);
    expect(p1.providerResponse.received).toBe(true);
    expect(p2.providerResponse.received).toBe(true);
  });

  it('ensures deterministic recovery if processing fails before commit', async () => {
    const failingHandler = vi
      .fn()
      .mockRejectedValue(new Error('Database error'));

    // First attempt fails
    await expect(
      service.processEvent(
        'evt_fail',
        'transfer.success',
        'hash_f',
        'ref_f',
        failingHandler,
      ),
    ).rejects.toThrow('Database error');

    const record = service.getRecord('evt_fail');
    expect(record?.status).toBe('failed');

    // On subsequent retry after recovery, it can acquire and process
    const successfulHandler = vi.fn().mockResolvedValue({ recovered: true });
    const res = await service.processEvent(
      'evt_fail',
      'transfer.success',
      'hash_f',
      'ref_f',
      successfulHandler,
    );

    expect(res.duplicate).toBe(false);
    expect(res.result).toEqual({ recovered: true });
  });

  it('applies retention policy to prune expired dedupe records', async () => {
    const shortRetentionService = new WebhookDeduplicationService({
      retentionMs: 100, // 100ms retention
      storageDir: tempDir,
    });

    await shortRetentionService.processEvent(
      'evt_old',
      'transfer.success',
      'hash_old',
      'ref_old',
      async () => ({ ok: true }),
    );

    expect(shortRetentionService.getRecord('evt_old')).toBeDefined();

    // Fast-forward past retention period
    shortRetentionService.pruneExpired(Date.now() + 500);

    expect(shortRetentionService.getRecord('evt_old')).toBeUndefined();
  });
});
