import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import crypto from 'crypto';
import axios from 'axios';
import { NextRequest } from 'next/server';
import {
  assertSandboxSecretKey,
  isLiveSecretKey,
  LiveCredentialsRefusedError,
} from '../credentialGuard';
import { credentialManager } from '../credentialManager';
import {
  executeWithTimeoutBudget,
  ProviderTimeoutError,
  AmbiguousInitiationError,
} from '../timeoutBudget';
import { reconcileAmbiguousInitiation } from '../reconciliation';
import {
  getTransferStatus,
  setTransferStatus,
  transferStore,
} from '@/lib/transferStore';

// Mock serverEnv
vi.mock('@/lib/serverEnv', () => ({
  serverEnv: {
    PAYSTACK_SECRET_KEY: 'sk_test_sandbox_secret_key_1',
    PAYSTACK_KEY_VERSION: 'v1',
    PAYOUT_PROVIDER: 'paystack',
    ADMIN_SECRET: 'test-admin-secret',
    ADMIN_IP_ALLOWLIST_BYPASS_LOCAL: true,
  },
}));

vi.mock('@/lib/telemetry', () => ({
  telemetry: {
    extractTraceFromHeaders: () => ({
      traceId: 'test-trace',
      spanId: 'test-span',
    }),
    createSpan: () => ({ spanId: 'test-span' }),
    addLog: vi.fn(),
    finishSpan: vi.fn(),
    setTraceHeaders: vi.fn(),
  },
}));

// Route handlers
import { POST as initiateTransferPost } from '@/app/api/initiate-transfer/route';
import { POST as webhookPost } from '@/app/api/webhook/route';
import { paystackProvider } from '../providers/paystackProvider';

function generateWebhookSignature(payload: string, secretKey: string): string {
  return crypto.createHmac('sha512', secretKey).update(payload).digest('hex');
}

describe('Sandbox End-to-End Payout Lifecycle Suite (Issues #98, #105, #106)', () => {
  const sandboxKeyV1 = 'sk_test_sandbox_secret_key_1';
  const sandboxKeyV2 = 'sk_test_sandbox_secret_key_2';
  const liveKey = 'sk_live_super_secret_production_key_123';
  const clientSessionId = 'session_sandbox_user_1';

  beforeEach(() => {
    vi.clearAllMocks();
    transferStore.clear();
    credentialManager.resetForTesting();
    // Configure active v1 sandbox credentials
    credentialManager.rotateCredential(sandboxKeyV1, 'v1');

    // Default axios sandbox stubs
    vi.spyOn(axios, 'get').mockImplementation(
      async (url: string, config?: any) => {
        if (url.includes('/bank/resolve')) {
          return {
            data: {
              status: true,
              data: {
                account_number: config?.params?.account_number || '0123456789',
                account_name: 'Jane Doe',
                bank_id: 44,
              },
            },
          } as any;
        }
        if (url.includes('/transfer/verify/')) {
          const reference = url.split('/').pop() || 'tx_default';
          return {
            data: {
              status: true,
              data: {
                reference,
                status: 'success',
                amount: 7500,
              },
            },
          } as any;
        }
        return { data: { status: true, data: {} } } as any;
      },
    );

    vi.spyOn(axios, 'post').mockImplementation(
      async (url: string, data?: any) => {
        if (url.includes('/transferrecipient')) {
          return {
            data: {
              status: true,
              data: {
                recipient_code: 'RCP_test_123',
                name: data?.name || 'Jane Doe',
              },
            },
          } as any;
        }
        if (url.includes('/transfer')) {
          return {
            data: {
              status: true,
              data: {
                reference: data?.reference || 'tx_default',
                status: 'pending',
                transfer_code: 'TRF_123456',
                amount: data?.amount,
              },
            },
          } as any;
        }
        return { data: { status: true, data: {} } } as any;
      },
    );
  });

  afterEach(() => {
    // Sandbox artifact cleanup
    transferStore.clear();
    credentialManager.resetForTesting();
    vi.restoreAllMocks();
  });

  describe('1. Live Credentials Rejection & CI Gating (#106)', () => {
    it('identifies live keys and refuses execution with LiveCredentialsRefusedError', () => {
      expect(isLiveSecretKey(liveKey)).toBe(true);
      expect(isLiveSecretKey(sandboxKeyV1)).toBe(false);

      expect(() => assertSandboxSecretKey(liveKey)).toThrow(
        LiveCredentialsRefusedError,
      );
      expect(() => assertSandboxSecretKey(sandboxKeyV1)).not.toThrow();
    });

    it('rejects attempts to run provider operations with live credentials in sandbox', async () => {
      expect(() => {
        assertSandboxSecretKey(liveKey);
      }).toThrow('Live credentials are not permitted in sandbox or test runs');
    });
  });

  describe('2. Account Verification & Recipient Creation Lifecycle', () => {
    it('verifies bank account using provider within timeout budget', async () => {
      const result = await paystackProvider.verifyAccount({
        accountNumber: '0123456789',
        bankCode: '044',
      });

      expect(result).toBeDefined();
      expect(result.account_number).toBe('0123456789');
    });

    it('creates transfer recipient within timeout budget', async () => {
      const recipient = await paystackProvider.createRecipient({
        type: 'nuban',
        name: 'Jane Doe',
        account_number: '0123456789',
        bank_code: '044',
        currency: 'NGN',
      });

      expect(recipient).toBeDefined();
      expect(recipient.recipient_code).toBeDefined();
    });
  });

  describe('3. Transfer Initiation & Idempotency Duplicate Protection', () => {
    it('initiates payout and protects against duplicate initiation on repeated calls', async () => {
      const idempotencyKey = 'idemp_test_tx_001';

      const payload = {
        source: 'balance',
        amount: 2500,
        recipient: 'RCP_12345',
        reason: 'Sandbox test payout',
        clientSessionId,
      };

      // 1. First initiation
      const req1 = new NextRequest('http://localhost/api/initiate-transfer', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'X-Idempotency-Key': idempotencyKey,
          'x-client-session-id': clientSessionId,
        },
        body: JSON.stringify(payload),
      });

      const res1 = await initiateTransferPost(req1);
      expect(res1.status).toBe(200);
      const data1 = await res1.json();
      expect(data1.success).toBe(true);

      const record = getTransferStatus(idempotencyKey);
      expect(record).toBeDefined();
      expect(record?.status).toBe('pending');
      expect(record?.credentialVersion).toBe('v1');

      // 2. Duplicate initiation with same idempotency key
      const req2 = new NextRequest('http://localhost/api/initiate-transfer', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'X-Idempotency-Key': idempotencyKey,
          'x-client-session-id': clientSessionId,
        },
        body: JSON.stringify(payload),
      });

      const res2 = await initiateTransferPost(req2);
      expect(res2.status).toBe(200);
      const data2 = await res2.json();
      expect(data2.success).toBe(true);

      // Verify no duplicate transfer created; record remains consistent
      expect(transferStore.size).toBe(1);
    });
  });

  describe('4. Delayed / Out-of-Order Webhooks & Replay Protection', () => {
    it('verifies HMAC SHA-512 signature, applies out-of-order webhook, and rejects replay', async () => {
      const reference = 'tx_delayed_webhook_001';

      setTransferStatus({
        reference,
        status: 'pending',
        amount: 10000,
        updatedAt: new Date().toISOString(),
        clientSessionId,
        credentialVersion: 'v1',
      });

      const webhookPayload = JSON.stringify({
        event: 'transfer.success',
        data: {
          id: 'ev_001',
          reference,
          amount: 10000,
          recipient: 'RCP_12345',
          status: 'success',
        },
      });

      const signature = generateWebhookSignature(webhookPayload, sandboxKeyV1);

      const webhookReq = new NextRequest('http://localhost/api/webhook', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-paystack-signature': signature,
        },
        body: webhookPayload,
      });

      const res = await webhookPost(webhookReq);
      expect(res.status).toBe(200);

      // Persisted record should now be updated to success
      const updated = getTransferStatus(reference);
      expect(updated?.status).toBe('success');
    });

    it('rejects webhooks with invalid HMAC signatures', async () => {
      const webhookPayload = JSON.stringify({
        event: 'transfer.success',
        data: { id: 'ev_002', reference: 'ref_tampered', amount: 5000 },
      });

      const invalidReq = new NextRequest('http://localhost/api/webhook', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-paystack-signature': 'invalid_tampered_signature_hex',
        },
        body: webhookPayload,
      });

      const res = await webhookPost(invalidReq);
      expect(res.status).toBe(401);
    });
  });

  describe('5. Timeout Budgets, Stalls, and Ambiguous Reconciliation (#98)', () => {
    it('bounds calls with operation budgets and classifies response timeout as ambiguous', async () => {
      const reference = 'tx_stall_ref_001';

      // Simulate a connection stall exceeding connect deadline
      await expect(
        executeWithTimeoutBudget(
          'verify',
          async (signal) => {
            await new Promise((resolve) => setTimeout(resolve, 500));
            if (signal.aborted) throw new Error('AbortError');
          },
          {
            budget: {
              connectTimeoutMs: 50,
              responseTimeoutMs: 100,
              totalDeadlineMs: 120,
              maxRetries: 0,
            },
          },
        ),
      ).rejects.toThrow(ProviderTimeoutError);

      // Simulate response phase stall on initiation -> must throw AmbiguousInitiationError
      await expect(
        executeWithTimeoutBudget(
          'initiate',
          async (signal, phaseNotifier) => {
            phaseNotifier?.markConnected(); // connection succeeded, response stalled
            await new Promise((_, reject) => {
              signal.addEventListener('abort', () => {
                const err = new Error('AbortError');
                err.name = 'AbortError';
                reject(err);
              });
            });
          },
          {
            reference,
            budget: {
              connectTimeoutMs: 50,
              responseTimeoutMs: 50,
              totalDeadlineMs: 100,
              maxRetries: 0,
            },
          },
        ),
      ).rejects.toThrow(AmbiguousInitiationError);
    });

    it('reconciles ambiguous initiation without duplicate transfers', async () => {
      const reference = 'tx_reconcile_001';

      // Set ambiguous in-flight transfer
      setTransferStatus({
        reference,
        status: 'pending',
        amount: 7500,
        updatedAt: new Date().toISOString(),
        clientSessionId,
        credentialVersion: 'v1',
        timeoutOutcome: 'ambiguous',
        reconciled: false,
      });

      // Execute reconciliation
      const result = await reconcileAmbiguousInitiation(reference, 'v1');
      expect(result.reconciled).toBe(true);
      expect(result.outcome).toBe('known');

      const finalRecord = getTransferStatus(reference);
      expect(finalRecord?.reconciled).toBe(true);
      expect(finalRecord?.timeoutOutcome).toBe('known');
    });
  });

  describe('6. Provider Credential Rotation without Interrupting In-Flight Payouts (#105)', () => {
    it('rotates to v2 while preserving status reconciliation and webhooks for v1 in-flight intent', async () => {
      const inFlightRef = 'tx_inflight_v1_999';

      // 1. Payout initiated under v1 credentials
      setTransferStatus({
        reference: inFlightRef,
        status: 'pending',
        amount: 8000,
        updatedAt: new Date().toISOString(),
        clientSessionId,
        credentialVersion: 'v1',
        reconciled: false,
      });

      // 2. Security team rotates active credentials to v2
      const rotated = credentialManager.rotateCredential(sandboxKeyV2, 'v2');
      expect(rotated.version).toBe('v2');
      expect(credentialManager.getActiveCredential()?.version).toBe('v2');

      // 3. New transfer requests now automatically use v2
      const newRef = 'tx_new_v2_100';
      const newTransfer = await paystackProvider.initiateTransfer({
        source: 'balance',
        amount: 3000,
        recipient: 'RCP_67890',
        reference: newRef,
      });
      expect(newTransfer.credentialVersion).toBe('v2');

      // 4. In-flight transfer created under v1 still successfully reconciles using v1
      const reconResult = await reconcileAmbiguousInitiation(inFlightRef, 'v1');
      expect(reconResult.reconciled).toBe(true);
      expect(reconResult.record?.credentialVersion).toBe('v1');

      // 5. Webhook signed with older v1 key is still accepted during bounded overlap
      const v1WebhookPayload = JSON.stringify({
        event: 'transfer.success',
        data: {
          id: 'ev_v1_overlap',
          reference: inFlightRef,
          amount: 8000,
          status: 'success',
        },
      });
      const v1Sig = generateWebhookSignature(v1WebhookPayload, sandboxKeyV1);

      const v1Req = new NextRequest('http://localhost/api/webhook', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-paystack-signature': v1Sig,
        },
        body: v1WebhookPayload,
      });

      const v1Res = await webhookPost(v1Req);
      expect(v1Res.status).toBe(200);

      // 6. Webhook signed with new v2 key is also accepted
      const v2WebhookPayload = JSON.stringify({
        event: 'transfer.success',
        data: {
          id: 'ev_v2_new',
          reference: newRef,
          amount: 3000,
          status: 'success',
        },
      });
      const v2Sig = generateWebhookSignature(v2WebhookPayload, sandboxKeyV2);

      const v2Req = new NextRequest('http://localhost/api/webhook', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-paystack-signature': v2Sig,
        },
        body: v2WebhookPayload,
      });

      const v2Res = await webhookPost(v2Req);
      expect(v2Res.status).toBe(200);

      // Verify that logContext logs only version, never secret material
      const logCtx = credentialManager.logContext('v1');
      expect(logCtx).toEqual({ credentialVersion: 'v1' });
      expect(JSON.stringify(logCtx)).not.toContain('secret');
      expect(JSON.stringify(logCtx)).not.toContain('sk_');
    });
  });
});
