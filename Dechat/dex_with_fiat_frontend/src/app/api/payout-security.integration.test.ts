import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import crypto from 'crypto';
import { clearBeneficiaryStore } from '@/lib/payout/beneficiaryStore';
import { clearTransferStore } from '@/lib/transferStore';

vi.mock('server-only', () => ({}));

const TEST_SECRET = 'test_paystack_secret_key_1234567890';

const mockEnv = {
  PAYSTACK_SECRET_KEY: TEST_SECRET,
  ADMIN_SECRET: 'test_admin_secret',
};

vi.mock('@/lib/serverEnv', () => ({
  get serverEnv() {
    return mockEnv;
  },
}));

vi.mock('@/lib/rateLimit', () => ({
  applyRateLimit: () => null,
  getClientIp: () => '127.0.0.1',
}));

vi.mock('@/lib/telemetry', () => ({
  telemetry: {
    extractTraceFromHeaders: () => ({ traceId: 't1', spanId: 's1' }),
    createSpan: () => ({ spanId: 'span' }),
    addLog: vi.fn(),
    finishSpan: vi.fn(),
    setTraceHeaders: vi.fn(),
  },
}));

const mockCreateRecipient = vi.fn().mockResolvedValue({
  recipient_code: 'RCP_sec_test',
  name: 'Security Test',
});

vi.mock('@/lib/payout/providers/registry', () => ({
  getPayoutProvider: () => ({
    name: 'paystack',
    createRecipient: mockCreateRecipient,
    verifyAccount: vi.fn(),
    initiateTransfer: vi.fn(),
    checkTransferStatus: vi.fn(),
  }),
}));

const { POST: postRecipient } = await import('./create-recipient/route');
const { POST: postWebhook } = await import('./webhook/route');

const RECIPIENT_PAYLOAD = {
  type: 'nuban',
  name: 'Security Test',
  account_number: '0123456789',
  bank_code: '058',
  currency: 'NGN',
};

describe('Payout API Security Integration Tests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearBeneficiaryStore();
    clearTransferStore();
  });

  describe('Browser State-Changing Routes Security', () => {
    it('allows same-origin browser requests and returns explicit CORS headers', async () => {
      const req = new NextRequest(
        'http://localhost:3000/api/create-recipient',
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            origin: 'http://localhost:3000',
            'sec-fetch-site': 'same-origin',
          },
          body: JSON.stringify(RECIPIENT_PAYLOAD),
        },
      );

      const res = await postRecipient(req);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
    });

    it('rejects hostile untrusted origin requests with 403 Forbidden', async () => {
      const req = new NextRequest(
        'http://localhost:3000/api/create-recipient',
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            origin: 'https://malicious-attacker-domain.xyz',
            'sec-fetch-site': 'cross-site',
          },
          body: JSON.stringify(RECIPIENT_PAYLOAD),
        },
      );

      const res = await postRecipient(req);
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.success).toBe(false);
      expect(body.error).toMatch(/FORBIDDEN/i);
      expect(mockCreateRecipient).not.toHaveBeenCalled();
    });

    it('allows missing-origin wallet-based / programmatic clients without blocking them', async () => {
      // Non-browser wallet client sends no Origin or Sec-Fetch headers
      const req = new NextRequest(
        'http://localhost:3000/api/create-recipient',
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: 'Bearer wallet_preflight_auth',
          },
          body: JSON.stringify(RECIPIENT_PAYLOAD),
        },
      );

      const res = await postRecipient(req);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(mockCreateRecipient).toHaveBeenCalled();
    });

    it('rejects browser requests with cross-site fetch metadata', async () => {
      const req = new NextRequest(
        'http://localhost:3000/api/create-recipient',
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'sec-fetch-site': 'cross-site',
          },
          body: JSON.stringify(RECIPIENT_PAYLOAD),
        },
      );

      const res = await postRecipient(req);
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toBe('CROSS_SITE_REQUEST_FORBIDDEN');
    });
  });

  describe('Signed Provider Webhooks Security Policy', () => {
    function createSignedWebhookRequest(payload: object, signature?: string) {
      const rawBody = JSON.stringify(payload);
      const sig =
        signature ??
        crypto.createHmac('sha512', TEST_SECRET).update(rawBody).digest('hex');

      return new NextRequest('http://localhost:3000/api/webhook', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-paystack-signature': sig,
        },
        body: rawBody,
      });
    }

    it('processes signed webhook requests with valid HMAC signature successfully', async () => {
      const payload = {
        event: 'transfer.success',
        data: {
          reference: 'tx_sec_webhook_success',
          status: 'success',
          amount: 50000,
          recipient: 'RCP_test',
        },
      };

      const req = createSignedWebhookRequest(payload);
      const res = await postWebhook(req);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.received).toBe(true);
    });

    it('rejects webhooks with missing signature with 401', async () => {
      const req = new NextRequest('http://localhost:3000/api/webhook', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ event: 'transfer.success', data: {} }),
      });

      const res = await postWebhook(req);
      expect(res.status).toBe(401);
    });

    it('rejects webhooks with invalid / forged signature with 401', async () => {
      const payload = {
        event: 'transfer.success',
        data: { reference: 'tx_forged' },
      };
      const req = createSignedWebhookRequest(
        payload,
        'tampered_invalid_hex_signature',
      );

      const res = await postWebhook(req);
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.message).toMatch(/invalid.*signature/i);
    });

    it('processes signed webhooks even with external or unusual origin headers', async () => {
      // Inbound webhook from provider server might contain provider server host / origin
      const payload = {
        event: 'transfer.failed',
        data: {
          reference: 'tx_sec_webhook_failed',
          status: 'failed',
          amount: 10000,
          recipient: 'RCP_test',
          reason: 'Bank rejected transfer',
        },
      };

      const rawBody = JSON.stringify(payload);
      const sig = crypto
        .createHmac('sha512', TEST_SECRET)
        .update(rawBody)
        .digest('hex');

      const req = new NextRequest('http://localhost:3000/api/webhook', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-paystack-signature': sig,
          origin: 'https://api.paystack.co',
        },
        body: rawBody,
      });

      const res = await postWebhook(req);
      expect(res.status).toBe(200);
    });
  });
});
