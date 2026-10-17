import { NextRequest, NextResponse } from 'next/server';
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

const RATE_LIMIT = { maxRequests: 3, windowMs: 60_000 };

const idempotencyCache = new Map<
  string,
  { result: unknown; timestamp: number }
>();
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

export async function POST(request: NextRequest) {
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

  // Idempotency check: if transfer was already executed or recorded, return cached/existing record
  // to prevent blind duplicate initiation.
  const cached = idempotencyCache.get(idempotencyKey);
  if (cached && Date.now() - cached.timestamp < IDEMPOTENCY_TTL_MS) {
    return NextResponse.json({ success: true, data: cached.result });
  }

  const existingRecord = getTransferStatus(idempotencyKey);
  if (existingRecord) {
    if (
      existingRecord.timeoutOutcome === 'ambiguous' &&
      !existingRecord.reconciled
    ) {
      // Reconcile ambiguous outcome rather than blindly retrying
      const recon = await reconcileAmbiguousInitiation(
        idempotencyKey,
        existingRecord.credentialVersion,
      );
      if (recon.reconciled && recon.record) {
        idempotencyCache.set(idempotencyKey, {
          result: recon.record,
          timestamp: Date.now(),
        });
        return NextResponse.json({
          success: true,
          data: recon.record,
          reconciled: true,
        });
      }
    }
    return NextResponse.json({ success: true, data: existingRecord });
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
      request.headers.get('x-client-session-id') ||
      (typeof bodyRecord.clientSessionId === 'string'
        ? bodyRecord.clientSessionId
        : undefined);

    const activeCred = credentialManager.getActiveCredential();
    const credentialVersion = activeCred?.version || 'v1';

    telemetry.addLog(span.spanId, 'info', 'Request validated', {
      hasSource: !!source,
      hasAmount: !!amount,
      hasRecipient: !!recipient,
      amount: amount,
      ...credentialManager.logContext(credentialVersion),
    });

    const provider = getPayoutProvider();
    let data: Record<string, unknown>;

    try {
      data = await provider.initiateTransfer({
        source,
        reason,
        amount,
        recipient,
        reference: idempotencyKey,
        credentialVersion,
      });
    } catch (initiateError: unknown) {
      // Handle Ambiguous Initiation (response timeout / connection drop after handshake)
      if (
        initiateError instanceof AmbiguousInitiationError ||
        (initiateError instanceof ProviderTimeoutError &&
          initiateError.outcome === 'ambiguous')
      ) {
        telemetry.addLog(
          span.spanId,
          'warn',
          'Transfer initiation ambiguous - persisting status and reconciling',
          {
            reference: idempotencyKey,
            ...credentialManager.logContext(credentialVersion),
          },
        );

        // 1. Persist ambiguous outcome immediately
        setTransferStatus({
          reference: idempotencyKey,
          status: 'pending',
          amount: Number(amount),
          updatedAt: new Date().toISOString(),
          clientSessionId,
          credentialVersion,
          timeoutOutcome: 'ambiguous',
          reconciled: false,
          lastError: 'Initiation timed out during response phase',
        });

        // 2. Attempt immediate reconciliation query against provider status
        const recon = await reconcileAmbiguousInitiation(
          idempotencyKey,
          credentialVersion,
        );

        if (recon.reconciled && recon.record) {
          idempotencyCache.set(idempotencyKey, {
            result: recon.record,
            timestamp: Date.now(),
          });
          telemetry.finishSpan(span.spanId, {
            success: true,
            reconciled: true,
          });
          return NextResponse.json({
            success: true,
            data: recon.record,
            reconciled: true,
          });
        }

        // Return stable safe error with sanitized diagnostics
        const sanitized = sanitizeProviderError(
          initiateError,
          'initiate',
          idempotencyKey,
        );
        telemetry.finishSpan(span.spanId, {
          success: false,
          error: sanitized.message,
          errorType: sanitized.code,
        });

        return NextResponse.json(sanitized, { status: 504 });
      }

      // Handle Known / Rejected Provider Timeout (connect phase stall before request dispatch)
      if (initiateError instanceof ProviderTimeoutError) {
        setTransferStatus({
          reference: idempotencyKey,
          status: 'failed',
          amount: Number(amount),
          updatedAt: new Date().toISOString(),
          clientSessionId,
          credentialVersion,
          timeoutOutcome: 'rejected',
          reconciled: true,
          failureReason:
            'Provider connection timed out before request dispatch',
        });

        const sanitized = sanitizeProviderError(
          initiateError,
          'initiate',
          idempotencyKey,
        );
        telemetry.finishSpan(span.spanId, {
          success: false,
          error: sanitized.message,
          errorType: sanitized.code,
        });

        return NextResponse.json(sanitized, { status: 504 });
      }

      throw initiateError;
    }

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
        credentialVersion:
          (data.credentialVersion as string) || credentialVersion,
        timeoutOutcome: 'known',
        reconciled: true,
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

    const sanitized = sanitizeProviderError(error, 'initiate', idempotencyKey);

    telemetry.addLog(
      span.spanId,
      'error',
      'Unhandled error in transfer initiation',
      { error: sanitized.message, code: sanitized.code },
    );

    console.error('Initiate transfer error:', error);

    telemetry.finishSpan(span.spanId, {
      success: false,
      error: sanitized.message,
      errorType: sanitized.code,
    });

    return NextResponse.json(sanitized, { status: 500 });
  }
}
