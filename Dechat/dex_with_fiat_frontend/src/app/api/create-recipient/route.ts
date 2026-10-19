import { NextRequest, NextResponse } from 'next/server';
import { getPayoutProvider } from '@/lib/payout/providers/registry';
import { telemetry } from '@/lib/telemetry';
import { applyRateLimit, getClientIp } from '@/lib/rateLimit';
import { createRecipientSchema } from '@/lib/apiSchemas';
import { enforcePayoutRouteSecurity } from '@/lib/payout/security';
import {
  getProviderCircuitBreaker,
  handlePayoutApiError,
} from '@/lib/payout/circuitBreaker';
import { getOrCreateBeneficiary } from '@/lib/payout/beneficiaryStore';

const RATE_LIMIT = { maxRequests: 5, windowMs: 60_000 };

export async function OPTIONS(request: NextRequest) {
  return (
    enforcePayoutRouteSecurity(request) ||
    new NextResponse(null, { status: 204 })
  );
}

export async function POST(request: NextRequest) {
  // 1. Enforce payout API security: Origin, Sec-Fetch-Site, CSRF, and explicit CORS
  const securityBlocked = enforcePayoutRouteSecurity(request);
  if (securityBlocked) return securityBlocked;

  const ip = getClientIp(request);
  const limited = applyRateLimit(ip, '/api/create-recipient', RATE_LIMIT);
  if (limited) return limited;

  const traceContext = telemetry.extractTraceFromHeaders(request.headers);
  const span = telemetry.createSpan(
    'create-recipient',
    traceContext.spanId,
    traceContext.traceId,
  );

  try {
    telemetry.addLog(span.spanId, 'info', 'Starting recipient creation', {
      endpoint: '/api/create-recipient',
    });

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      telemetry.addLog(span.spanId, 'warn', 'Malformed JSON body');
      telemetry.finishSpan(span.spanId, {
        success: false,
        error: 'Invalid JSON body',
      });
      return NextResponse.json(
        { success: false, message: 'Invalid JSON in request body.' },
        { status: 400 },
      );
    }

    // Validate with Zod
    const validationResult = createRecipientSchema.safeParse(body);

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

    const { type, name, account_number, bank_code, currency } =
      validationResult.data;

    telemetry.addLog(span.spanId, 'info', 'Request validated', {
      hasType: !!type,
      hasName: !!name,
      hasAccountNumber: !!account_number,
      hasBankCode: !!bank_code,
      hasCurrency: !!currency,
      currency: currency,
    });

    const userScope =
      request.headers.get('x-user-scope') ||
      request.headers.get('x-user-id') ||
      ip;

    const provider = getPayoutProvider();
    const breaker = getProviderCircuitBreaker(provider.name);

    // Race-safe beneficiary resolution with circuit breaker protection
    const beneficiaryResult = await getOrCreateBeneficiary(
      {
        name,
        accountNumber: account_number,
        bankCode: bank_code,
        currency,
        userScope,
        type,
      },
      () =>
        breaker.execute(() =>
          provider.createRecipient({
            type,
            name,
            account_number,
            bank_code,
            currency,
          }),
        ),
    );

    telemetry.finishSpan(span.spanId, { success: true });

    const apiResponse = NextResponse.json({
      success: true,
      data: {
        recipient_code: beneficiaryResult.recipientCode,
        name: beneficiaryResult.name,
        reused: beneficiaryResult.reused,
        recovered: beneficiaryResult.recovered,
      },
    });

    telemetry.setTraceHeaders(apiResponse.headers, traceContext);
    return apiResponse;
  } catch (error: unknown) {
    telemetry.addLog(
      span.spanId,
      'error',
      'Unhandled error in recipient creation',
      {
        error: error instanceof Error ? error.message : 'Unknown error',
      },
    );

    const errorDetails = handlePayoutApiError(
      error,
      'Failed to create recipient. Please try again.',
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
