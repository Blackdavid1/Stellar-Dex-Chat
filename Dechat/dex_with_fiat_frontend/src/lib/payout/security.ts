import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { serverEnv as env } from '@/lib/serverEnv';
import { telemetry } from '@/lib/telemetry';

export interface PayoutSecurityOptions {
  allowedOrigins?: string[];
  allowWalletClientsWithoutOrigin?: boolean;
  requireCsrfForBrowserSessions?: boolean;
  csrfSecret?: string;
  maxTokenAgeMs?: number;
}

const DEFAULT_MAX_TOKEN_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

export function getAllowedOrigins(customOrigins?: string[]): string[] {
  const allowed = new Set<string>();

  if (customOrigins) {
    customOrigins.forEach((o) => allowed.add(o.trim().toLowerCase()));
  }

  const envOrigins = process.env.ALLOWED_ORIGINS;
  if (envOrigins) {
    envOrigins.split(',').forEach((o) => allowed.add(o.trim().toLowerCase()));
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL || process.env.APP_URL;
  if (appUrl) {
    try {
      const url = new URL(appUrl);
      allowed.add(url.origin.toLowerCase());
    } catch {
      allowed.add(appUrl.trim().toLowerCase());
    }
  }

  // Common localhost origins for development and testing
  allowed.add('http://localhost:3000');
  allowed.add('http://127.0.0.1:3000');
  allowed.add('https://localhost:3000');
  allowed.add('http://localhost');

  return Array.from(allowed);
}

/**
 * Derives the origin from the request URL, Origin header, or Referer header.
 */
export function extractRequestOrigin(request: NextRequest): string | null {
  const originHeader = request.headers.get('origin');
  if (originHeader) {
    return originHeader.trim().toLowerCase();
  }

  const refererHeader = request.headers.get('referer');
  if (refererHeader) {
    try {
      const url = new URL(refererHeader);
      return url.origin.toLowerCase();
    } catch {
      return null;
    }
  }

  return null;
}

/**
 * Checks whether a client request is a wallet-based client or programmatic client.
 * Non-browser clients do not send Origin or browser Sec-Fetch headers.
 */
export function isWalletOrProgrammaticClient(request: NextRequest): boolean {
  const hasOrigin = !!request.headers.get('origin');
  const hasReferer = !!request.headers.get('referer');
  const hasSecFetch = !!request.headers.get('sec-fetch-site');

  return !hasOrigin && !hasReferer && !hasSecFetch;
}

/**
 * Generates an HMAC-signed CSRF token.
 */
export function generateCsrfToken(
  sessionScope: string = 'default',
  secret?: string,
  clock: () => number = Date.now,
): string {
  const csrfSecret =
    secret ||
    env.PAYSTACK_SECRET_KEY ||
    process.env.CSRF_SECRET ||
    'stellar-dex-chat-csrf-secret-token';

  const timestamp = clock();
  const payload = `${sessionScope}:${timestamp}`;
  const hmac = crypto
    .createHmac('sha256', csrfSecret)
    .update(payload)
    .digest('hex');

  return `${timestamp}.${hmac}`;
}

/**
 * Validates an HMAC-signed CSRF token.
 */
export function validateCsrfToken(
  token: string | null | undefined,
  sessionScope: string = 'default',
  secret?: string,
  maxAgeMs: number = DEFAULT_MAX_TOKEN_AGE_MS,
  clock: () => number = Date.now,
): boolean {
  if (!token) return false;

  const parts = token.split('.');
  if (parts.length !== 2) return false;

  const [timestampStr, receivedHmac] = parts;
  const timestamp = Number.parseInt(timestampStr, 10);
  if (Number.isNaN(timestamp)) return false;

  const now = clock();
  if (now - timestamp > maxAgeMs || timestamp > now + 60_000) {
    return false; // Expired or future timestamp
  }

  const csrfSecret =
    secret ||
    env.PAYSTACK_SECRET_KEY ||
    process.env.CSRF_SECRET ||
    'stellar-dex-chat-csrf-secret-token';

  const payload = `${sessionScope}:${timestamp}`;
  const expectedHmac = crypto
    .createHmac('sha256', csrfSecret)
    .update(payload)
    .digest('hex');

  try {
    return crypto.timingSafeEqual(
      Buffer.from(receivedHmac, 'hex'),
      Buffer.from(expectedHmac, 'hex'),
    );
  } catch {
    return false;
  }
}

/**
 * Builds explicit CORS headers and strictly rejects wildcard credentialed access.
 */
export function buildCorsHeaders(
  request: NextRequest,
  options: {
    allowedOrigins?: string[];
    allowCredentials?: boolean;
  } = {},
): Record<string, string> {
  const allowCredentials = options.allowCredentials ?? true;
  const configuredAllowed = getAllowedOrigins(options.allowedOrigins);
  const requestOrigin = extractRequestOrigin(request);

  const headers: Record<string, string> = {
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers':
      'Content-Type, Authorization, X-CSRF-Token, X-Idempotency-Key, x-trace-id, x-span-id, sec-fetch-site',
    'Access-Control-Max-Age': '86400',
  };

  // Rule: Reject wildcard credentialed access
  // When credentials are used, Access-Control-Allow-Origin MUST NOT be '*'
  if (requestOrigin) {
    const isAllowed =
      configuredAllowed.includes(requestOrigin) ||
      (request.nextUrl &&
        requestOrigin === request.nextUrl.origin.toLowerCase());

    if (isAllowed) {
      headers['Access-Control-Allow-Origin'] = requestOrigin;
      if (allowCredentials) {
        headers['Access-Control-Allow-Credentials'] = 'true';
      }
    }
  }

  return headers;
}

export interface SecurityEvaluation {
  allowed: boolean;
  statusCode?: number;
  error?: string;
  message?: string;
  isWalletClient?: boolean;
}

/**
 * Evaluates origin, fetch metadata, and CSRF protection for state-changing routes.
 */
export function evaluatePayoutRequestSecurity(
  request: NextRequest,
  options: PayoutSecurityOptions = {},
): SecurityEvaluation {
  // 1. Handle non-browser wallet / programmatic clients without blocking them
  if (isWalletOrProgrammaticClient(request)) {
    return {
      allowed: true,
      isWalletClient: true,
    };
  }

  // 2. Fetch metadata validation
  const secFetchSite = request.headers.get('sec-fetch-site');
  if (secFetchSite === 'cross-site') {
    telemetry.addLog(
      'security',
      'warn',
      'Rejected cross-site state-changing request',
      {
        secFetchSite,
        path: request.nextUrl?.pathname,
      },
    );
    return {
      allowed: false,
      statusCode: 403,
      error: 'CROSS_SITE_REQUEST_FORBIDDEN',
      message: 'Cross-site state-changing requests are prohibited.',
    };
  }

  // 3. Origin and Referer validation
  const requestOrigin = extractRequestOrigin(request);
  const allowedOrigins = getAllowedOrigins(options.allowedOrigins);

  if (request.nextUrl && request.nextUrl.origin) {
    allowedOrigins.push(request.nextUrl.origin.toLowerCase());
  }

  if (requestOrigin && !allowedOrigins.includes(requestOrigin)) {
    telemetry.addLog('security', 'warn', 'Rejected untrusted origin', {
      origin: requestOrigin,
      allowedOrigins,
    });
    return {
      allowed: false,
      statusCode: 403,
      error: 'FORBIDDEN_ORIGIN',
      message: `Origin '${requestOrigin}' is not allowed to access this resource.`,
    };
  }

  // 4. CSRF Token Strategy for browser sessions
  // If the request originates from a browser session (has cookie or requires CSRF)
  const hasCookieSession = request.headers.get('cookie') !== null;
  const requireCsrf = options.requireCsrfForBrowserSessions ?? hasCookieSession;

  if (requireCsrf && !isWalletOrProgrammaticClient(request)) {
    const csrfToken =
      request.headers.get('x-csrf-token') ||
      request.headers.get('X-CSRF-Token');

    if (
      !validateCsrfToken(
        csrfToken,
        'default',
        options.csrfSecret,
        options.maxTokenAgeMs,
      )
    ) {
      telemetry.addLog('security', 'warn', 'CSRF token missing or invalid', {
        hasToken: !!csrfToken,
        path: request.nextUrl?.pathname,
      });
      return {
        allowed: false,
        statusCode: 403,
        error: 'CSRF_VALIDATION_FAILED',
        message: 'Invalid or missing CSRF token for browser session.',
      };
    }
  }

  return { allowed: true };
}

/**
 * Middleware/helper to enforce payout security on a route.
 * Returns null if allowed, or a NextResponse if rejected or handling OPTIONS preflight.
 */
export function enforcePayoutRouteSecurity(
  request: NextRequest,
  options: PayoutSecurityOptions = {},
): NextResponse | null {
  // Handle OPTIONS preflight
  if (request.method === 'OPTIONS') {
    const corsHeaders = buildCorsHeaders(request, {
      allowedOrigins: options.allowedOrigins,
    });
    return new NextResponse(null, {
      status: 204,
      headers: corsHeaders,
    });
  }

  const evaluation = evaluatePayoutRequestSecurity(request, options);
  if (!evaluation.allowed) {
    const corsHeaders = buildCorsHeaders(request, {
      allowedOrigins: options.allowedOrigins,
    });
    return NextResponse.json(
      {
        success: false,
        error: evaluation.error,
        message: evaluation.message,
      },
      {
        status: evaluation.statusCode || 403,
        headers: corsHeaders,
      },
    );
  }

  return null;
}
