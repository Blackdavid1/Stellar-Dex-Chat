import { NextRequest, NextResponse } from 'next/server';

import { getPayoutProvider } from '@/lib/payout/providers/registry';
import { applyRateLimit, getClientIp } from '@/lib/rateLimit';
import { transferStatusSchema } from '@/lib/apiSchemas';
import {
  authorizeTransferAccess,
  uniformNotFoundResponse,
} from '@/lib/auth/authorizationMatrix';
import { setTransferStatus } from '@/lib/transferStore';
import { sanitizeProviderError } from '@/lib/payout/timeoutBudget';

const RATE_LIMIT = { maxRequests: 10, windowMs: 60_000 };

export async function POST(request: NextRequest) {
  const ip = getClientIp(request);
  const limited = applyRateLimit(ip, '/api/transfer-status', RATE_LIMIT);
  if (limited) return limited;

  try {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json(
        { success: false, message: 'Request body must be valid JSON' },
        { status: 400 },
      );
    }

    const validationResult = transferStatusSchema.safeParse(body);
    if (!validationResult.success) {
      return NextResponse.json(
        {
          success: false,
          message: 'Validation failed',
          errors: validationResult.error.issues,
        },
        { status: 400 },
      );
    }

    const { reference } = validationResult.data;
    const bodyRecord = body as Record<string, unknown>;
    const clientSessionId =
      request.headers.get('x-client-session-id') ||
      (typeof bodyRecord.clientSessionId === 'string'
        ? bodyRecord.clientSessionId
        : undefined);

    // IDOR check: verify caller is authorized for this reference.
    // If unauthorized, return 404 immediately without calling the provider!
    const auth = authorizeTransferAccess(request, reference, clientSessionId);
    if (!auth.authorized) {
      return uniformNotFoundResponse();
    }

    const provider = getPayoutProvider();
    const data = await provider.checkTransferStatus({
      reference,
      credentialVersion: auth.record?.credentialVersion,
    });

    if (auth.record && typeof data.status === 'string') {
      const statusLower = data.status.toLowerCase();
      const validStatuses = [
        'pending',
        'success',
        'failed',
        'reversed',
        'cancelled',
      ] as const;
      const isValidStatus = (s: string): s is (typeof validStatuses)[number] =>
        (validStatuses as readonly string[]).includes(s);
      const nextStatus = isValidStatus(statusLower)
        ? statusLower
        : auth.record.status;

      setTransferStatus({
        ...auth.record,
        status: nextStatus,
        updatedAt: new Date().toISOString(),
      });
    }

    return NextResponse.json({
      success: true,
      data,
    });
  } catch (error: unknown) {
    console.error('Transfer status error:', error);

    const sanitized = sanitizeProviderError(error, 'status');
    if (sanitized.code === 'PROVIDER_TIMEOUT') {
      return NextResponse.json(sanitized, { status: 504 });
    }

    if (
      error &&
      typeof error === 'object' &&
      'response' in error &&
      error.response &&
      typeof error.response === 'object' &&
      'data' in error.response &&
      error.response.data &&
      typeof error.response.data === 'object' &&
      'message' in error.response.data
    ) {
      return NextResponse.json(
        {
          success: false,
          message: (error.response.data as { message: string }).message,
        },
        { status: 400 },
      );
    }

    return NextResponse.json(sanitized, { status: 500 });
  }
}
