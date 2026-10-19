import { NextRequest, NextResponse } from 'next/server';
import { getPayoutProvider } from '@/lib/payout/providers/registry';
import { telemetry } from '@/lib/telemetry';
import { applyRateLimit, getClientIp } from '@/lib/rateLimit';
import { verifyAccountSchema } from '@/lib/apiSchemas';
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
  const limited = applyRateLimit(ip, '/api/verify-account', RATE_LIMIT);
  if (limited) return limited;

  const traceContext = telemetry.extractTraceFromHeaders(request.headers);
  const span = telemetry.createSpan(
    'verify-account',
    traceContext.spanId,
    traceContext.traceId,
  );

  try {
    telemetry.addLog(span.spanId, 'info', 'Starting account verification', {
      endpoint: '/api/verify-account',
    });

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      telemetry.addLog(span.spanId, 'warn', 'Request body is not valid JSON', {
        endpoint: '/api/verify-account',
      });
      telemetry.finishSpan(span.spanId, {
        success: false,
        error: 'Invalid JSON body',
      });
      return NextResponse.json(
        { success: false, message: 'Request body must be valid JSON' },
        { status: 400 },
      );
    }

    // Validate with Zod
    const validationResult = verifyAccountSchema.safeParse(body);

    if (!validationResult.success) {
      telemetry.addLog(span.spanId, 'warn', 'Zod validation failed', {
        errors: validationResult.error.issues,
      });
      telemetry.finishSpan(span.spanId, {
        success: false,
        error: 'Validation failed',
      });

      return NextResponse.json(
        {
          success: false,
          message: 'Validation failed',
          errors: validationResult.error.issues,
        },
        { status: 400 },
      );
    }

    const { accountNumber, bankCode } = validationResult.data;

    telemetry.addLog(span.spanId, 'info', 'Request validated', {
      hasAccountNumber: !!accountNumber,
      hasBankCode: !!bankCode,
      bankCode: bankCode,
    });

    const provider = getPayoutProvider();
    const breaker = getProviderCircuitBreaker(provider.name);

    const data = await breaker.execute(() =>
      provider.verifyAccount({ accountNumber, bankCode }),
    );

    telemetry.finishSpan(span.spanId, { success: true });

    const apiResponse = NextResponse.json({ success: true, data });
    telemetry.setTraceHeaders(apiResponse.headers, traceContext);
    return apiResponse;
  } catch (error: unknown) {
    telemetry.addLog(
      span.spanId,
      'error',
      'Unhandled error in account verification',
      {
        error: error instanceof Error ? error.message : 'Unknown error',
      },
    );

    console.error('Account verification error:', error);

    const errorDetails = handlePayoutApiError(
      error,
      'Account verification failed. Please try again.',
    );

    telemetry.finishSpan(span.spanId, {
      success: false,
      error: errorDetails.body.message,
    });

    return NextResponse.json(errorDetails.body, {
      status: errorDetails.status,
      headers: errorDetails.headers,
    });
  }
}
