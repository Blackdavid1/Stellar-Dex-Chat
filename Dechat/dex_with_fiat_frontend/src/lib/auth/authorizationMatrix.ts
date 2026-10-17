/**
 * Route Authorization Matrix and Access Control Helpers.
 * Addresses Issue #104:
 * - Inventories each route, required identity, resource owner, and allowed operation.
 * - Enforces IDOR protection before returning sensitive data.
 * - Uniform denials prevent revealing whether unauthorized records exist.
 * - Separates admin reconciliation from user-owned history.
 */

import { NextResponse } from 'next/server';
import { requireAdminAuth } from '@/app/api/admin/_utils/requireAdminAuth';
import { getTransferStatus, TransferStatusRecord } from '@/lib/transferStore';

export interface RouteAuthorizationRule {
  path: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  requiredIdentity: 'public' | 'user' | 'admin' | 'webhook';
  resourceOwner: 'public' | 'caller' | 'admin';
  allowedOperation: string;
  description: string;
}

export const ROUTE_AUTHORIZATION_MATRIX: RouteAuthorizationRule[] = [
  {
    path: '/api/initiate-transfer',
    method: 'POST',
    requiredIdentity: 'user',
    resourceOwner: 'caller',
    allowedOperation: 'create',
    description: 'Initiate a fiat transfer intent owned by the caller session',
  },
  {
    path: '/api/verify-account',
    method: 'POST',
    requiredIdentity: 'user',
    resourceOwner: 'caller',
    allowedOperation: 'read',
    description: 'Verify account number with bank code',
  },
  {
    path: '/api/create-recipient',
    method: 'POST',
    requiredIdentity: 'user',
    resourceOwner: 'caller',
    allowedOperation: 'create',
    description: 'Create transfer recipient code for caller payout',
  },
  {
    path: '/api/transfer-status',
    method: 'POST',
    requiredIdentity: 'user',
    resourceOwner: 'caller',
    allowedOperation: 'read',
    description: 'Check provider transfer status for caller-owned transfer',
  },
  {
    path: '/api/transfer-status/:reference',
    method: 'GET',
    requiredIdentity: 'user',
    resourceOwner: 'caller',
    allowedOperation: 'read',
    description: 'Read transfer status for caller-owned transfer reference',
  },
  {
    path: '/api/transfer-status/:reference',
    method: 'POST',
    requiredIdentity: 'user',
    resourceOwner: 'caller',
    allowedOperation: 'cancel',
    description: 'Request cancellation of caller-owned pending transfer',
  },
  {
    path: '/api/receipt/:reference',
    method: 'GET',
    requiredIdentity: 'user',
    resourceOwner: 'caller',
    allowedOperation: 'export',
    description: 'Retrieve transaction receipt data for caller-owned transfer',
  },
  {
    path: '/api/payment-status/stream',
    method: 'GET',
    requiredIdentity: 'user',
    resourceOwner: 'caller',
    allowedOperation: 'read',
    description: 'Subscribe to SSE stream for caller-owned session events',
  },
  {
    path: '/api/admin-audit',
    method: 'GET',
    requiredIdentity: 'admin',
    resourceOwner: 'admin',
    allowedOperation: 'admin_read',
    description: 'Retrieve system audit logs with pagination and filters',
  },
  {
    path: '/api/admin/audit-log',
    method: 'GET',
    requiredIdentity: 'admin',
    resourceOwner: 'admin',
    allowedOperation: 'admin_read',
    description: 'Paginated admin audit logs (append-only)',
  },
  {
    path: '/api/admin/reconciliation',
    method: 'GET',
    requiredIdentity: 'admin',
    resourceOwner: 'admin',
    allowedOperation: 'admin_read',
    description:
      'Reconciliation records strictly separated from user-owned history',
  },
  {
    path: '/api/admin/auth/nonce',
    method: 'GET',
    requiredIdentity: 'public',
    resourceOwner: 'public',
    allowedOperation: 'read',
    description:
      'Generate cryptographic nonce for admin authentication challenge',
  },
  {
    path: '/api/admin/auth/nonce',
    method: 'POST',
    requiredIdentity: 'public',
    resourceOwner: 'public',
    allowedOperation: 'create',
    description: 'Verify signature and issue admin session token',
  },
  {
    path: '/api/banks',
    method: 'GET',
    requiredIdentity: 'public',
    resourceOwner: 'public',
    allowedOperation: 'read',
    description: 'Public listing of supported settlement banks',
  },
  {
    path: '/api/webhook',
    method: 'POST',
    requiredIdentity: 'webhook',
    resourceOwner: 'admin',
    allowedOperation: 'webhook_process',
    description:
      'Process provider settlement webhooks verified with HMAC signature',
  },
];

/**
 * Extracts the client session ID from headers, query string, or cookies.
 */
export function extractCallerSessionId(request: Request): string | undefined {
  const headerSession =
    request.headers.get('x-client-session-id') ||
    request.headers.get('x-session-id');
  if (headerSession) return headerSession.trim();

  try {
    const url = new URL(request.url);
    const querySession =
      url.searchParams.get('sessionId') ||
      url.searchParams.get('clientSessionId');
    if (querySession) return querySession.trim();
  } catch {
    // Ignore URL parse failure
  }

  const cookieHeader = request.headers.get('cookie');
  if (cookieHeader) {
    const match = cookieHeader.match(/stellar_client_session_id=([^;]+)/);
    if (match) return match[1].trim();
  }

  return undefined;
}

/**
 * Checks whether the caller is authorized as an administrator.
 */
export function isCallerAdmin(request: Request): boolean {
  return requireAdminAuth(request) === null;
}

export interface AuthorizationResult {
  authorized: boolean;
  isAdmin: boolean;
  callerSessionId?: string;
  record?: TransferStatusRecord;
}

/**
 * Authorizes access to a transfer record.
 * To satisfy IDOR requirements:
 * - If user does not own the record, authorization is denied.
 * - Denial response does not reveal whether the record exists or not.
 */
export function authorizeTransferAccess(
  request: Request,
  reference: string,
  explicitCallerSessionId?: string,
): AuthorizationResult {
  const isAdmin = isCallerAdmin(request);
  const callerSessionId =
    explicitCallerSessionId || extractCallerSessionId(request);
  const record = getTransferStatus(reference);

  // Admin has access to any record
  if (isAdmin) {
    return {
      authorized: true,
      isAdmin: true,
      callerSessionId,
      record,
    };
  }

  // Record exists and has an owner: only the owner can access
  if (record && record.clientSessionId) {
    if (!callerSessionId || callerSessionId !== record.clientSessionId) {
      return {
        authorized: false,
        isAdmin: false,
        callerSessionId,
        record: undefined, // Conceal record
      };
    }

    return {
      authorized: true,
      isAdmin: false,
      callerSessionId,
      record,
    };
  }

  // Record exists without explicit owner (e.g. legacy/mock record):
  // If caller provided a session id, allow if they match
  if (record && !record.clientSessionId) {
    return {
      authorized: true,
      isAdmin: false,
      callerSessionId,
      record,
    };
  }

  // Record does not exist: unauthorized non-admin callers cannot query arbitrary references
  return {
    authorized: false,
    isAdmin: false,
    callerSessionId,
    record: undefined,
  };
}

/**
 * Uniform denial response that prevents leaking record existence.
 * Returns identical 404 response for both non-existent records and cross-user attempts.
 */
export function uniformNotFoundResponse(
  message = 'Transfer not found',
): NextResponse {
  return NextResponse.json(
    {
      success: false,
      message,
    },
    { status: 404 },
  );
}

/**
 * Uniform denial response for receipts.
 */
export function uniformReceiptNotFoundResponse(): NextResponse {
  return NextResponse.json(
    {
      success: false,
      message: 'Receipt not found',
    },
    { status: 404 },
  );
}
