import { NextRequest, NextResponse } from 'next/server';

import { getPayoutProvider } from '@/lib/payout/providers/registry';
import { applyRateLimit, getClientIp } from '@/lib/rateLimit';
import { transferStatusSchema } from '@/lib/apiSchemas';
import { enforcePayoutRouteSecurity } from '@/lib/payout/security';
import {
  getProviderCircuitBreaker,
  handlePayoutApiError,
} from '@/lib/payout/circuitBreaker';

const RATE_LIMIT = { maxRequests: 10, windowMs: 60_000 };

export async function OPTIONS(request: NextRequest) {
  return (
    enforcePayoutRouteSecurity(request) ||
    new NextResponse(null, { status: 204 })
  );
}

export async function POST(request: NextRequest) {
  // Enforce payout API security
  const securityBlocked = enforcePayoutRouteSecurity(request);
  if (securityBlocked) return securityBlocked;

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

    const provider = getPayoutProvider();
    const breaker = getProviderCircuitBreaker(provider.name);

    const data = await breaker.execute(() =>
      provider.checkTransferStatus({ reference }),
    );

    return NextResponse.json({
      success: true,
      data,
    });
  } catch (error: unknown) {
    console.error('Transfer status error:', error);

    const errorDetails = handlePayoutApiError(
      error,
      'Failed to fetch transfer status. Please try again.',
    );

    return NextResponse.json(errorDetails.body, {
      status: errorDetails.status,
      headers: errorDetails.headers,
    });
  }
}
