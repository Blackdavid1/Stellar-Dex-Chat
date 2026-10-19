import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import {
  ROUTE_AUTHORIZATION_MATRIX,
  extractCallerSessionId,
} from '../authorizationMatrix';
import { setTransferStatus, transferStore } from '@/lib/transferStore';

// Mock serverEnv
vi.mock('@/lib/serverEnv', () => ({
  serverEnv: {
    ADMIN_SECRET: 'test-admin-secret-xyz',
    PAYSTACK_SECRET_KEY: 'sk_test_123',
    PAYOUT_PROVIDER: 'paystack',
    ADMIN_IP_ALLOWLIST_BYPASS_LOCAL: true,
  },
}));

vi.mock('@/lib/security', () => ({
  enforceAdminIpAllowlist: () => null,
}));

// Mock provider to assert unauthorized calls make NO provider requests
const mockCheckTransferStatus = vi.fn().mockResolvedValue({
  reference: 'tx_user1_123',
  status: 'success',
  amount: 5000,
});
const mockInitiateTransfer = vi.fn().mockResolvedValue({
  reference: 'tx_init_123',
  status: 'pending',
});

vi.mock('@/lib/payout/providers/registry', () => ({
  getPayoutProvider: () => ({
    name: 'paystack',
    checkTransferStatus: mockCheckTransferStatus,
    initiateTransfer: mockInitiateTransfer,
    verifyAccount: vi.fn(),
    createRecipient: vi.fn(),
  }),
}));

// Import route handlers
import { POST as transferStatusPost } from '@/app/api/transfer-status/route';
import {
  GET as transferStatusRefGet,
  POST as transferStatusRefPost,
} from '@/app/api/transfer-status/[reference]/route';
import { GET as receiptGet } from '@/app/api/receipt/[reference]/route';
import { GET as adminReconciliationGet } from '@/app/api/admin/reconciliation/route';
import { GET as adminAuditGet } from '@/app/api/admin-audit/route';

describe('Endpoint Authorization Matrix & IDOR Suite (Issue #104)', () => {
  const user1Session = 'session_user_alice';
  const user2Session = 'session_user_bob';
  const user1Ref = 'tx_user1_alice_999';

  beforeEach(() => {
    vi.clearAllMocks();
    transferStore.clear();

    // Seed a transfer owned by user 1
    setTransferStatus({
      reference: user1Ref,
      status: 'pending',
      amount: 5000,
      updatedAt: new Date().toISOString(),
      clientSessionId: user1Session,
      credentialVersion: 'v1',
    });
  });

  describe('Authorization Matrix Inventory', () => {
    it('inventories all required API routes with identities, resource owners, and allowed operations', () => {
      expect(ROUTE_AUTHORIZATION_MATRIX.length).toBeGreaterThanOrEqual(10);

      const paths = ROUTE_AUTHORIZATION_MATRIX.map((r) => r.path);
      expect(paths).toContain('/api/initiate-transfer');
      expect(paths).toContain('/api/verify-account');
      expect(paths).toContain('/api/create-recipient');
      expect(paths).toContain('/api/transfer-status');
      expect(paths).toContain('/api/transfer-status/:reference');
      expect(paths).toContain('/api/receipt/:reference');
      expect(paths).toContain('/api/admin/reconciliation');
      expect(paths).toContain('/api/admin-audit');
    });

    it('correctly extracts session IDs from headers, query parameters, and cookies', () => {
      const headerReq = new Request('http://localhost/api/transfer-status', {
        headers: { 'x-client-session-id': 'session_header_123' },
      });
      expect(extractCallerSessionId(headerReq)).toBe('session_header_123');

      const queryReq = new Request(
        'http://localhost/api/transfer-status?sessionId=session_query_456',
      );
      expect(extractCallerSessionId(queryReq)).toBe('session_query_456');

      const cookieReq = new Request('http://localhost/api/transfer-status', {
        headers: { cookie: 'stellar_client_session_id=session_cookie_789' },
      });
      expect(extractCallerSessionId(cookieReq)).toBe('session_cookie_789');
    });
  });

  describe('IDOR & Cross-User Transfer Status: POST /api/transfer-status', () => {
    it('asserts unauthorized cross-user calls make NO provider request and return 404', async () => {
      // User Bob attempts to query Alice's transfer reference
      const req = new NextRequest('http://localhost/api/transfer-status', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-client-session-id': user2Session, // Bob's session
        },
        body: JSON.stringify({ reference: user1Ref }),
      });

      const res = await transferStatusPost(req);

      // Crucial: status must be 404 and provider must NOT be contacted
      expect(res.status).toBe(404);
      const data = await res.json();
      expect(data.success).toBe(false);
      expect(data.message).toBe('Transfer not found');

      // Assert provider request was NEVER dispatched
      expect(mockCheckTransferStatus).not.toHaveBeenCalled();
    });

    it('allows owner to query their own transfer status and invokes provider', async () => {
      const req = new NextRequest('http://localhost/api/transfer-status', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-client-session-id': user1Session, // Alice's session
        },
        body: JSON.stringify({ reference: user1Ref }),
      });

      const res = await transferStatusPost(req);
      expect(res.status).toBe(200);
      expect(mockCheckTransferStatus).toHaveBeenCalledWith({
        reference: user1Ref,
        credentialVersion: 'v1',
      });
    });

    it('allows admin to query any transfer status with admin authorization', async () => {
      const req = new NextRequest('http://localhost/api/transfer-status', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-admin-token': 'test-admin-secret-xyz',
        },
        body: JSON.stringify({ reference: user1Ref }),
      });

      const res = await transferStatusPost(req);
      expect(res.status).toBe(200);
      expect(mockCheckTransferStatus).toHaveBeenCalled();
    });
  });

  describe('IDOR & Existence Leaking: GET /api/transfer-status/[reference]', () => {
    it('denials do not reveal record existence (non-existent vs cross-user denial have identical responses)', async () => {
      // 1. Non-existent reference
      const nonExistentReq = new NextRequest(
        'http://localhost/api/transfer-status/tx_non_existent',
        {
          headers: { 'x-client-session-id': user2Session },
        },
      );
      const nonExistentRes = await transferStatusRefGet(nonExistentReq, {
        params: Promise.resolve({ reference: 'tx_non_existent' }),
      });
      const nonExistentBody = await nonExistentRes.json();

      // 2. Existing reference owned by someone else
      const crossUserReq = new NextRequest(
        `http://localhost/api/transfer-status/${user1Ref}`,
        {
          headers: { 'x-client-session-id': user2Session },
        },
      );
      const crossUserRes = await transferStatusRefGet(crossUserReq, {
        params: Promise.resolve({ reference: user1Ref }),
      });
      const crossUserBody = await crossUserRes.json();

      // Both must return identical 404 responses
      expect(crossUserRes.status).toBe(404);
      expect(nonExistentRes.status).toBe(404);
      expect(crossUserBody).toEqual(nonExistentBody);
      expect(crossUserBody.message).toBe('Transfer not found');
    });

    it('authorizes owner to view their own transfer record', async () => {
      const req = new NextRequest(
        `http://localhost/api/transfer-status/${user1Ref}`,
        {
          headers: { 'x-client-session-id': user1Session },
        },
      );
      const res = await transferStatusRefGet(req, {
        params: Promise.resolve({ reference: user1Ref }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.data.reference).toBe(user1Ref);
    });
  });

  describe('Cross-User Cancellation: POST /api/transfer-status/[reference]', () => {
    it('prevents cross-user cancellation and conceals record existence', async () => {
      const req = new NextRequest(
        `http://localhost/api/transfer-status/${user1Ref}`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-client-session-id': user2Session, // Bob tries to cancel Alice's transfer
          },
          body: JSON.stringify({ clientSessionId: user2Session }),
        },
      );

      const res = await transferStatusRefPost(req, {
        params: Promise.resolve({ reference: user1Ref }),
      });

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.message).toBe('Transfer not found');

      // Transfer must remain in pending state
      const record = transferStore.get(user1Ref);
      expect(record?.status).toBe('pending');
    });

    it('allows owner to cancel their own pending transfer', async () => {
      const req = new NextRequest(
        `http://localhost/api/transfer-status/${user1Ref}`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-client-session-id': user1Session,
          },
          body: JSON.stringify({ clientSessionId: user1Session }),
        },
      );

      const res = await transferStatusRefPost(req, {
        params: Promise.resolve({ reference: user1Ref }),
      });

      expect(res.status).toBe(200);
      const record = transferStore.get(user1Ref);
      expect(record?.status).toBe('cancelled');
    });
  });

  describe('Cross-User Receipt Export: GET /api/receipt/[reference]', () => {
    it('denies cross-user receipt requests without leaking existence', async () => {
      // User 2 tries to read User 1's receipt
      const req = new NextRequest(`http://localhost/api/receipt/${user1Ref}`, {
        headers: { 'x-client-session-id': user2Session },
      });

      const res = await receiptGet(req, {
        params: Promise.resolve({ reference: user1Ref }),
      });

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.message).toBe('Receipt not found');
    });

    it('allows owner to export/view their receipt data', async () => {
      const req = new NextRequest(`http://localhost/api/receipt/${user1Ref}`, {
        headers: { 'x-client-session-id': user1Session },
      });

      const res = await receiptGet(req, {
        params: Promise.resolve({ reference: user1Ref }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.data.reference).toBe(user1Ref);
      expect(body.data.amount).toBe(5000);
    });
  });

  describe('Admin Reconciliation & Audit Log Isolation', () => {
    it('strictly separates admin reconciliation from user-owned history', async () => {
      // Regular user attempts to access admin reconciliation
      const userReq = new NextRequest(
        'http://localhost/api/admin/reconciliation',
        {
          headers: { 'x-client-session-id': user1Session },
        },
      );
      const userRes = await adminReconciliationGet(userReq);
      expect(userRes.status).toBe(401);

      // Admin access succeeds
      const adminReq = new NextRequest(
        'http://localhost/api/admin/reconciliation',
        {
          headers: { 'x-admin-token': 'test-admin-secret-xyz' },
        },
      );
      const adminRes = await adminReconciliationGet(adminReq);
      expect(adminRes.status).toBe(200);
    });

    it('enforces pagination and authentication on admin audit logs', async () => {
      // Unauthorized call rejected
      const unauthReq = new NextRequest(
        'http://localhost/api/admin-audit?limit=10&offset=0',
      );
      const unauthRes = await adminAuditGet(unauthReq);
      expect(unauthRes.status).toBe(401);

      // Authorized admin call succeeds with pagination
      const adminReq = new NextRequest(
        'http://localhost/api/admin-audit?limit=10&offset=0',
        {
          headers: { 'x-admin-token': 'test-admin-secret-xyz' },
        },
      );
      const adminRes = await adminAuditGet(adminReq);
      expect(adminRes.status).toBe(200);
      const body = await adminRes.json();
      expect(body.limit).toBe(10);
      expect(body.offset).toBe(0);
      expect(Array.isArray(body.entries)).toBe(true);
    });
  });
});
