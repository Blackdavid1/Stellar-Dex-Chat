import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { getPayoutProvider } from '@/lib/payout/providers/registry';
import { telemetry } from '@/lib/telemetry';
import { applyRateLimit, getClientIp } from '@/lib/rateLimit';
import { setTransferStatus } from '@/lib/transferStore';
import { initiateTransferSchema } from '@/lib/apiSchemas';
import { enforcePayoutRouteSecurity } from '@/lib/payout/security';
import {
  getProviderCircuitBreaker,
  handlePayoutApiError,
} from '@/lib/payout/circuitBreaker';

const RATE_LIMIT = { maxRequests: 3, windowMs: 60_000 };

const idempotencyCache = new Map<
  string,
  { result: unknown; timestamp: number }
>();
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

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
  const limited = applyRateLimit(ip, '/api/initiate-transfer', RATE_LIMIT);
  if (limited) return limited;

  const idempotencyKey = request.headers.get('X-Idempotency-Key');
  if (!idempotencyKey) {
    return NextResponse.json(
      { success: false, message: 'X-Idempotency-Key header is required' },
      { status: 400 },
    );
  }

  const cached = idempotencyCache.get(idempotencyKey);
  if (cached && Date.now() - cached.timestamp < IDEMPOTENCY_TTL_MS) {
    return NextResponse.json({ success: true, data: cached.result });
  }

  const traceContext = telemetry.extractTraceFromHeaders(request.headers);
  const span = telemetry.createSpan(
    'initiate-transfer',
    traceContext.spanId,
    traceContext.traceId,
  );

  try {
    telemetry.addLog(span.spanId, 'info', 'Starting transfer initiation', {
      endpoint: '/api/initiate-transfer',
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
    const validationResult = initiateTransferSchema.safeParse(body);

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

    const { source, reason, amount, recipient } = validationResult.data;
    const bodyRecord = body as Record<string, unknown>;
    const clientSessionId =
      typeof bodyRecord.clientSessionId === 'string'
        ? bodyRecord.clientSessionId
        : undefined;

    telemetry.addLog(span.spanId, 'info', 'Request validated', {
      hasSource: !!source,
      hasAmount: !!amount,
      hasRecipient: !!recipient,
      amount: amount,
    });

    const provider = getPayoutProvider();
    const breaker = getProviderCircuitBreaker(provider.name);

    const data = await breaker.execute(() =>
      provider.initiateTransfer({
        source,
        reason,
        amount,
        recipient,
        reference: idempotencyKey,
      }),
    );

    const transferReference =
      typeof data.reference === 'string' && data.reference
        ? data.reference
        : idempotencyKey;

    if (transferReference) {
      const now = Date.now();
      setTransferStatus({
        reference: transferReference,
        status: 'pending',
        amount: Number(amount),
        updatedAt: new Date(now).toISOString(),
        updatedAtMs: now,
        clientSessionId,
      });
    }

    idempotencyCache.set(idempotencyKey, {
      result: data,
      timestamp: Date.now(),
    });

    return NextResponse.json({
      success: true,
      data,
    });
  } catch (error: unknown) {
    Sentry.captureException(error, {
      tags: {
        endpoint: '/api/initiate-transfer',
        operation: 'transfer_initiation',
      },
      extra: {
        ip,
        traceId: traceContext.traceId,
        spanId: span.spanId,
      },
    });

    const errorMessage =
      error instanceof Error ? error.message : 'Unknown error';

    telemetry.addLog(
      span.spanId,
      'error',
      'Unhandled error in transfer initiation',
      { error: errorMessage },
    );

    console.error('Initiate transfer error:', error);

    const errorDetails = handlePayoutApiError(
      error,
      'Failed to initiate transfer. Please try again.',
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
