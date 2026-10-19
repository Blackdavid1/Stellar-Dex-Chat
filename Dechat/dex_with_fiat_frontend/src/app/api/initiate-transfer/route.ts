import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import * as Sentry from '@sentry/nextjs';
import { getPayoutProvider } from '@/lib/payout/providers/registry';
import { credentialManager } from '@/lib/payout/credentialManager';
import {
  AmbiguousInitiationError,
  ProviderTimeoutError,
  sanitizeProviderError,
} from '@/lib/payout/timeoutBudget';
import { reconcileAmbiguousInitiation } from '@/lib/payout/reconciliation';
import { telemetry } from '@/lib/telemetry';
import { applyRateLimit, getClientIp } from '@/lib/rateLimit';
import { setTransferStatus, getTransferStatus } from '@/lib/transferStore';
import { initiateTransferSchema } from '@/lib/apiSchemas';
import { payoutAuditLedger } from '@/lib/payout/auditLedger';
import { payoutRetryQueue } from '@/lib/payout/retryQueue';

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
      request.headers.get('x-client-session-id') ||
      (typeof bodyRecord.clientSessionId === 'string'
        ? bodyRecord.clientSessionId
        : undefined);

    const activeCred = credentialManager.getActiveCredential();
    const credentialVersion = activeCred?.version || 'v1';

    // Idempotency key from header, body reference, or generated fallback
    const headerIdempotencyKey = request.headers.get('X-Idempotency-Key');
    const idempotencyKey =
      headerIdempotencyKey ||
      (typeof bodyRecord.reference === 'string' && bodyRecord.reference
        ? bodyRecord.reference
        : null) ||
      `idem_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;

    const cached = idempotencyCache.get(idempotencyKey);
    if (cached && Date.now() - cached.timestamp < IDEMPOTENCY_TTL_MS) {
      return NextResponse.json({ success: true, data: cached.result });
    }

    telemetry.addLog(span.spanId, 'info', 'Request validated', {
      hasSource: !!source,
      hasAmount: !!amount,
      hasRecipient: !!recipient,
      amount: amount,
      idempotencyKey,
    });

    // Record immutable audit event for payout initiation (Issue #38)
    payoutAuditLedger.recordEvent({
      payoutId: idempotencyKey,
      action: 'payout_initiated',
      actor: clientSessionId ? `client:${clientSessionId}` : 'client:user',
      requestCorrelationId: traceContext.traceId,
      providerReference: idempotencyKey,
      metadata: {
        source,
        reason,
        amount: Number(amount),
        recipient,
      },
    });

    const provider = getPayoutProvider();

    try {
      const data = await provider.initiateTransfer({
        source,
        reason,
        amount: Number(amount),
        recipient,
        reference: idempotencyKey,
      });

      const transferReference =
        typeof data.reference === 'string' && data.reference
          ? data.reference
          : idempotencyKey;

      if (transferReference) {
        setTransferStatus({
          reference: transferReference,
          status: 'pending',
          amount: Number(amount),
          updatedAt: new Date().toISOString(),
          clientSessionId,
        });
      }

      // Record successful provider acceptance in audit ledger
      payoutAuditLedger.recordEvent({
        payoutId: transferReference,
        action: 'payout_provider_accepted',
        actor: 'provider:paystack',
        requestCorrelationId: traceContext.traceId,
        providerReference: transferReference,
        metadata: { data: data as Record<string, unknown> },
      });

      idempotencyCache.set(idempotencyKey, {
        result: data,
        timestamp: Date.now(),
      });

      return NextResponse.json({
        success: true,
        data,
      });
    } catch (providerError: unknown) {
      const errorMessage =
        providerError instanceof Error
          ? providerError.message
          : 'Unknown provider error';

      // Enqueue into durable retry queue instead of losing payout intent (Issue #37)
      const retryJob = payoutRetryQueue.enqueueJob({
        payoutId: idempotencyKey,
        idempotencyKey,
        payload: {
          source,
          amount: Number(amount),
          recipient,
          reason,
        },
        error: errorMessage,
        correlationId: traceContext.traceId,
      });

      setTransferStatus({
        reference: idempotencyKey,
        status: 'pending',
        amount: Number(amount),
        updatedAt: new Date(now).toISOString(),
        updatedAtMs: now,
        clientSessionId,
        failureReason: `Transient error: ${errorMessage}. Queued for retry.`,
      });

      telemetry.addLog(
        span.spanId,
        'warn',
        'Provider call failed; enqueued into retry queue',
        {
          jobId: retryJob.id,
          idempotencyKey,
          error: errorMessage,
        },
      );

      return NextResponse.json(
        {
          success: true,
          status: 'queued_for_retry',
          reference: idempotencyKey,
          jobId: retryJob.id,
          message: 'Transfer queued for retry due to provider failure',
        },
        { status: 202 },
      );
    }
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

    const sanitized = sanitizeProviderError(error, 'initiate', idempotencyKey);

    telemetry.addLog(
      span.spanId,
      'error',
      'Unhandled error in transfer initiation',
      { error: sanitized.message, code: sanitized.code },
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
