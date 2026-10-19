import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { z } from 'zod';
import { payoutRetryQueue } from '@/lib/payout/retryQueue';
import { payoutAuditLedger } from '@/lib/payout/auditLedger';

vi.mock('server-only', () => ({}));

const mockSchema = z.object({
  source: z.string().min(1),
  reason: z.string().min(1),
  amount: z.string().min(1),
  recipient: z.string().min(1),
  reference: z.string().optional(),
});

vi.mock('@/lib/telemetry', () => ({
  telemetry: {
    extractTraceFromHeaders: () => ({ traceId: 'trace', spanId: 'parent' }),
    createSpan: () => ({ spanId: 'span' }),
    addLog: vi.fn(),
    finishSpan: vi.fn(),
  },
}));

vi.mock('@sentry/nextjs', () => ({
  captureException: vi.fn(),
}));

vi.mock('@/lib/rateLimit', () => ({
  applyRateLimit: vi.fn(() => null),
  getClientIp: vi.fn(() => '127.0.0.1'),
}));

vi.mock('@/lib/transferStore', () => ({
  setTransferStatus: vi.fn(),
  getTransferStatus: vi.fn(() => undefined),
}));

const mockInitiateTransfer = vi
  .fn()
  .mockResolvedValue({ reference: 'ref-123' });

vi.mock('@/lib/payout/providers/registry', () => ({
  getPayoutProvider: () => ({
    initiateTransfer: mockInitiateTransfer,
  }),
}));

vi.mock('@/lib/apiSchemas', () => ({
  initiateTransferSchema: mockSchema,
}));

const { POST } = await import('./route');

function makeRequest(body: unknown, headers: Record<string, string> = {}) {
  return new NextRequest(
    new Request('http://localhost/api/initiate-transfer', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: {
        'content-type': 'application/json',
        'X-Idempotency-Key': 'test-idempotency-key',
        ...headers,
      },
    }),
  );
}

describe('POST /api/initiate-transfer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    payoutRetryQueue._resetForTest();
    payoutAuditLedger._resetForTest();
    mockInitiateTransfer.mockResolvedValue({ reference: 'ref-123' });
  });

  it('returns 400 for malformed JSON body', async () => {
    const badReq = new NextRequest(
      new Request('http://localhost/api/initiate-transfer', {
        method: 'POST',
        body: 'not json{{{',
        headers: {
          'content-type': 'application/json',
          'x-idempotency-key': 'test-idempotency-key',
        },
      }),
    );

    const res = await POST(badReq);
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.message).toContain('Invalid JSON');
  });

  it('returns 400 when X-Idempotency-Key header is missing', async () => {
    const noKeyReq = new NextRequest(
      new Request('http://localhost/api/initiate-transfer', {
        method: 'POST',
        body: JSON.stringify({
          source: 'wallet',
          reason: 'pay',
          amount: '10',
          recipient: 'G1',
        }),
        headers: { 'content-type': 'application/json' },
      }),
    );

    const res = await POST(noKeyReq);
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.message).toContain('X-Idempotency-Key');
  });

  it('returns 400 for validation failures', async () => {
    const req = makeRequest({
      source: '',
      reason: '',
      amount: '',
      recipient: '',
    });
    const res = await POST(req);
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.success).toBe(false);
  });

  it('returns 200 for valid request and records audit events', async () => {
    const req = makeRequest(
      {
        source: 'wallet',
        reason: 'payment',
        amount: '100',
        recipient: 'GABC123',
      },
      { 'X-Idempotency-Key': 'key-valid-req' },
    );
    const res = await POST(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);

    const auditEvents = payoutAuditLedger.getEntries().entries;
    expect(auditEvents.some((e) => e.action === 'payout_initiated')).toBe(true);
    expect(
      auditEvents.some((e) => e.action === 'payout_provider_accepted'),
    ).toBe(true);
  });

  it('enqueues failed provider calls into durable retry queue without losing intent', async () => {
    mockInitiateTransfer.mockRejectedValueOnce(new Error('502 Bad Gateway'));

    const req = makeRequest(
      {
        source: 'wallet',
        reason: 'payment',
        amount: '250',
        recipient: 'GABC456',
      },
      { 'X-Idempotency-Key': 'key-transient-fail' },
    );

    const res = await POST(req);
    expect(res.status).toBe(202);

    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.status).toBe('queued_for_retry');

    const jobs = payoutRetryQueue.getJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].idempotencyKey).toBe('key-transient-fail');
    expect(jobs[0].status).toBe('pending');
  });
});
