import { describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import {
  buildCorsHeaders,
  evaluatePayoutRequestSecurity,
  generateCsrfToken,
  isWalletOrProgrammaticClient,
  validateCsrfToken,
} from './security';

vi.mock('server-only', () => ({}));

function makeRequest(
  headers: Record<string, string> = {},
  url = 'http://localhost:3000/api/create-recipient',
) {
  return new NextRequest(
    new Request(url, {
      method: 'POST',
      headers,
    }),
  );
}

describe('Payout API Security', () => {
  describe('Origin and Fetch Metadata Validation', () => {
    it('allows same-origin browser requests', () => {
      const req = makeRequest({
        origin: 'http://localhost:3000',
        'sec-fetch-site': 'same-origin',
      });

      const result = evaluatePayoutRequestSecurity(req);
      expect(result.allowed).toBe(true);
    });

    it('rejects hostile untrusted origins with 403', () => {
      const req = makeRequest({
        origin: 'https://evil-attacker-site.com',
        'sec-fetch-site': 'cross-site',
      });

      const result = evaluatePayoutRequestSecurity(req);
      expect(result.allowed).toBe(false);
      expect(result.statusCode).toBe(403);
    });

    it('allows missing-origin wallet-based and programmatic clients without blocking them', () => {
      // Wallet clients send no browser Origin or Sec-Fetch headers
      const req = makeRequest({
        authorization: 'Bearer wallet_signature_token',
      });

      expect(isWalletOrProgrammaticClient(req)).toBe(true);
      const result = evaluatePayoutRequestSecurity(req);
      expect(result.allowed).toBe(true);
      expect(result.isWalletClient).toBe(true);
    });

    it('rejects cross-site fetch metadata even if origin is forged or missing', () => {
      const req = makeRequest({
        'sec-fetch-site': 'cross-site',
      });

      const result = evaluatePayoutRequestSecurity(req);
      expect(result.allowed).toBe(false);
      expect(result.statusCode).toBe(403);
      expect(result.error).toBe('CROSS_SITE_REQUEST_FORBIDDEN');
    });
  });

  describe('CORS behavior and wildcard credentialed access rejection', () => {
    it('sets explicit origin and credentials for allowed origins', () => {
      const req = makeRequest({
        origin: 'http://localhost:3000',
      });

      const headers = buildCorsHeaders(req);
      expect(headers['Access-Control-Allow-Origin']).toBe(
        'http://localhost:3000',
      );
      expect(headers['Access-Control-Allow-Credentials']).toBe('true');
    });

    it('never emits wildcard * origin when credentials are enabled', () => {
      const req = makeRequest({
        origin: 'https://unknown-untrusted.com',
      });

      const headers = buildCorsHeaders(req, {
        allowedOrigins: ['http://localhost:3000'],
        allowCredentials: true,
      });

      // Wildcard is strictly forbidden
      expect(headers['Access-Control-Allow-Origin']).toBeUndefined();
      expect(headers['Access-Control-Allow-Origin']).not.toBe('*');
    });
  });

  describe('CSRF Token Strategy', () => {
    it('generates and validates valid CSRF tokens', () => {
      const token = generateCsrfToken('user_session_1');
      expect(validateCsrfToken(token, 'user_session_1')).toBe(true);
    });

    it('rejects tokens with mismatched scope or tampered payload', () => {
      const token = generateCsrfToken('user_session_1');
      expect(validateCsrfToken(token, 'different_session')).toBe(false);

      const tampered = token.slice(0, -3) + 'abc';
      expect(validateCsrfToken(tampered, 'user_session_1')).toBe(false);
    });

    it('rejects expired CSRF tokens', () => {
      let fakeTime = 1_000_000;
      const token = generateCsrfToken('session_1', undefined, () => fakeTime);

      // Advance time by 25 hours (exceeds default 24h TTL)
      fakeTime += 25 * 60 * 60 * 1000;
      expect(
        validateCsrfToken(
          token,
          'session_1',
          undefined,
          undefined,
          () => fakeTime,
        ),
      ).toBe(false);
    });

    it('enforces CSRF tokens for browser sessions with cookies', () => {
      const token = generateCsrfToken('default');

      // Valid token
      const validReq = makeRequest({
        origin: 'http://localhost:3000',
        cookie: 'session_id=123',
        'x-csrf-token': token,
      });
      expect(evaluatePayoutRequestSecurity(validReq).allowed).toBe(true);

      // Missing token on browser session with cookies
      const missingReq = makeRequest({
        origin: 'http://localhost:3000',
        cookie: 'session_id=123',
      });
      const result = evaluatePayoutRequestSecurity(missingReq);
      expect(result.allowed).toBe(false);
      expect(result.statusCode).toBe(403);
      expect(result.error).toBe('CSRF_VALIDATION_FAILED');
    });
  });
});
