import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const mockEnv = { ADMIN_SECRET: 'test-admin-secret' };
vi.mock('@/lib/serverEnv', () => ({
  get serverEnv() {
    return mockEnv;
  },
}));

vi.mock('@/lib/security', () => ({
  enforceAdminIpAllowlist: () => null,
}));

vi.mock('@/lib/payout/reconciliation', () => ({
  reconcileStalePayouts: vi.fn().mockResolvedValue({
    processed: 2,
    transitioned: 1,
    noChange: 1,
    providerUnavailable: 0,
    errors: 0,
    results: [],
    timestamp: 123456789,
  }),
}));

import { GET, POST } from './route';

describe('Admin Reconciliation Route', () => {
  beforeEach(() => {
    mockEnv.ADMIN_SECRET = 'test-admin-secret';
    vi.clearAllMocks();
  });

  describe('GET /api/admin/reconciliation', () => {
    it('returns 401 when no authentication is provided', async () => {
      const req = new NextRequest('http://localhost/api/admin/reconciliation');
      const res = await GET(req);
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error).toMatch(/Unauthorized/i);
    });

    it('returns 401 when invalid token is provided in x-admin-token', async () => {
      const req = new NextRequest('http://localhost/api/admin/reconciliation', {
        headers: { 'x-admin-token': 'wrong-secret' },
      });
      const res = await GET(req);
      expect(res.status).toBe(401);
    });

    it('returns 200 when valid token is provided in x-admin-token', async () => {
      const req = new NextRequest('http://localhost/api/admin/reconciliation', {
        headers: { 'x-admin-token': 'test-admin-secret' },
      });
      const res = await GET(req);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(Array.isArray(body)).toBe(true);
    });

    it('returns 200 when valid bearer token is provided', async () => {
      const req = new NextRequest('http://localhost/api/admin/reconciliation', {
        headers: { authorization: 'Bearer test-admin-secret' },
      });
      const res = await GET(req);
      expect(res.status).toBe(200);
    });
  });

  describe('POST /api/admin/reconciliation', () => {
    it('returns 401 when unauthenticated', async () => {
      const req = new NextRequest('http://localhost/api/admin/reconciliation', {
        method: 'POST',
      });
      const res = await POST(req);
      expect(res.status).toBe(401);
    });

    it('triggers reconciliation when authenticated and returns summary', async () => {
      const req = new NextRequest('http://localhost/api/admin/reconciliation', {
        method: 'POST',
        headers: {
          'x-admin-token': 'test-admin-secret',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ staleAgeMs: 300000, batchSize: 20 }),
      });

      const res = await POST(req);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.data.processed).toBe(2);
      expect(body.data.transitioned).toBe(1);
    });
  });
});
