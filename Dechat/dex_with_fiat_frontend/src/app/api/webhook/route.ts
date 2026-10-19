import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { telemetry } from '@/lib/telemetry';
import { isReplayEvent } from '@/lib/transferStore';
import { getTransferStatus, setTransferStatus } from '@/lib/transferStore';
import { serverEnv as env } from '@/lib/serverEnv';
import { publishPaymentStatus } from '@/lib/paymentStatusEvents';
import { webhookDeduplicationService } from '@/lib/payout/webhookDeduplication';
import { payoutReconciliationService } from '@/lib/payout/reconciliation';

interface PaystackWebhookData {
  id?: string | number;
  reference?: string;
  amount?: number;
  recipient?: string;
  status?: string;
  failure_reason?: string;
}

interface PaystackWebhookEvent {
  event: string;
  data: PaystackWebhookData;
}

export async function POST(request: NextRequest) {
  const traceContext = telemetry.extractTraceFromHeaders(request.headers);
  const span = telemetry.createSpan(
    'webhook-handler',
    traceContext.spanId,
    traceContext.traceId,
  );

  try {
    const secretKey = env.PAYSTACK_SECRET_KEY;
    // Fail-closed: reject immediately if the secret key is not configured.
    // Never process a webhook without a verified signature.
    if (!secretKey) {
      telemetry.addLog(
        span.spanId,
        'error',
        'Webhook rejected: PAYSTACK_SECRET_KEY is not configured',
        { endpoint: '/api/webhook' },
      );
      telemetry.finishSpan(span.spanId, {
        success: false,
        error: 'Missing PAYSTACK_SECRET_KEY',
      });
      console.error(
        'PAYSTACK_SECRET_KEY is not configured. Rejecting webhook.',
      );
      return NextResponse.json(
        { message: 'Webhook processing is not configured' },
        { status: 400 },
      );
    }

    telemetry.addLog(span.spanId, 'info', 'Starting webhook processing', {
      endpoint: '/api/webhook',
    });

    const payload = await request.text();
    const signature = request.headers.get('x-paystack-signature');

    telemetry.addLog(span.spanId, 'info', 'Webhook request parsed', {
      hasSignature: !!signature,
      payloadLength: payload.length,
    });

    if (!signature) {
      telemetry.addLog(span.spanId, 'warn', 'No signature provided', {
        endpoint: '/api/webhook',
      });
      telemetry.finishSpan(span.spanId, {
        success: false,
        error: 'No signature provided',
      });

      return NextResponse.json(
        { message: 'No signature provided' },
        { status: 401 },
      );
    }

    // Verify signature
    telemetry.addLog(span.spanId, 'info', 'Verifying webhook signature', {
      endpoint: '/api/webhook',
    });

    const hash = crypto
      .createHmac('sha512', secretKey)
      .update(payload)
      .digest('hex');

    if (hash !== signature) {
      telemetry.addLog(span.spanId, 'error', 'Invalid webhook signature', {
        expectedHash: hash,
        receivedSignature: signature,
      });
      telemetry.finishSpan(span.spanId, {
        success: false,
        error: 'Invalid signature',
      });

      console.error('Invalid webhook signature');
      return NextResponse.json(
        { message: 'Invalid signature' },
        { status: 401 },
      );
    }

    let event: PaystackWebhookEvent;
    try {
      event = JSON.parse(payload) as PaystackWebhookEvent;
    } catch {
      telemetry.addLog(
        span.spanId,
        'warn',
        'Webhook payload is not valid JSON',
        {
          endpoint: '/api/webhook',
          payloadLength: payload.length,
        },
      );
      telemetry.finishSpan(span.spanId, {
        success: false,
        error: 'Invalid JSON payload',
        errorType: 'parse_error',
      });
      return NextResponse.json(
        { message: 'Webhook payload must be valid JSON' },
        { status: 400 },
      );
    }

    const payloadHash = crypto
      .createHash('sha256')
      .update(payload)
      .digest('hex');
    const dataId = event?.data?.id;
    const dataRef = event?.data?.reference;
    if (!dataId && !dataRef) {
      telemetry.addLog(
        span.spanId,
        'error',
        'Missing event data id and reference',
        {
          eventType: event.event,
        },
      );
      telemetry.finishSpan(span.spanId, {
        success: false,
        error: 'Missing event data id and reference',
      });
      return NextResponse.json(
        { message: 'Event data must contain id or reference' },
        { status: 400 },
      );
    }
    const replayKey = `${event.event}:${dataId ?? dataRef}`;
    const dedupeEventId = String(dataId ?? dataRef);

    telemetry.addLog(span.spanId, 'info', 'Webhook signature verified', {
      eventType: event.event,
      reference: event.data?.reference,
      replayKey,
      dedupeEventId,
    });

    console.log('Received Paystack webhook:', event.event);

    // Durable deduplication and replay protection (Issue #35)
    const { acquired, isDuplicate } =
      await webhookDeduplicationService.acquireOrCheck(
        dedupeEventId,
        event.event,
        payloadHash,
        dataRef,
      );

    if (!acquired && isDuplicate) {
      telemetry.addLog(
        span.spanId,
        'info',
        'Durable duplicate webhook recognized',
        {
          dedupeEventId,
          eventType: event.event,
        },
      );
      telemetry.finishSpan(span.spanId, { success: true, duplicate: true });

      const duplicateResponse = NextResponse.json({
        received: true,
        duplicate: true,
      });
      telemetry.setTraceHeaders(duplicateResponse.headers, traceContext);
      return duplicateResponse;
    }

    try {
      const data = event.data ?? {};
      const payoutReference = data.reference ?? '';
      const existingRecord = getTransferStatus(payoutReference);

      // Reconcile out-of-order events with monotonic domain transitions (Issue #36)
      const reconciliation = payoutReconciliationService.reconcileEvent({
        eventId: dedupeEventId,
        payoutReference,
        eventType: event.event,
        currentStatus: existingRecord?.status,
        payload: data as Record<string, unknown>,
        correlationId: traceContext.traceId,
      });

      if (reconciliation.decision === 'REJECTED_OUT_OF_ORDER') {
        telemetry.addLog(
          span.spanId,
          'warn',
          'Out-of-order webhook event rejected',
          {
            eventId: dedupeEventId,
            reference: payoutReference,
            currentStatus: existingRecord?.status,
            targetStatus: reconciliation.targetStatus,
            reason: reconciliation.reason,
          },
        );

        // Commit dedupe record atomically to prevent repeated rejection churn
        webhookDeduplicationService.commit(dedupeEventId);
        telemetry.finishSpan(span.spanId, {
          success: true,
          rejectedOutOfOrder: true,
        });

        const resp = NextResponse.json({
          received: true,
          status: 'ignored_out_of_order',
        });
        telemetry.setTraceHeaders(resp.headers, traceContext);
        return resp;
      }

      if (reconciliation.decision === 'IDEMPOTENT_NOOP') {
        webhookDeduplicationService.commit(dedupeEventId);
        telemetry.finishSpan(span.spanId, { success: true, idempotent: true });

        const resp = NextResponse.json({
          received: true,
          status: 'already_applied',
        });
        telemetry.setTraceHeaders(resp.headers, traceContext);
        return resp;
      }

      // Handle valid domain transitions
      const updatedAt = new Date().toISOString();

      switch (event.event) {
        case 'transfer.success': {
          telemetry.addLog(span.spanId, 'info', 'Processing transfer success', {
            reference: data.reference,
            amount: data.amount,
            recipient: data.recipient,
            status: data.status,
          });
          console.log('Transfer successful:', {
            reference: data.reference,
            amount: data.amount,
            recipient: data.recipient,
            status: data.status,
          });
          const nextRecord = setTransferStatus({
            reference: data.reference ?? '',
            status: 'success',
            amount: Number(data.amount ?? 0),
            updatedAt,
            clientSessionId: existingRecord?.clientSessionId,
          });
          publishPaymentStatus(nextRecord.clientSessionId, {
            reference: nextRecord.reference,
            status: nextRecord.status,
            amount: nextRecord.amount,
            updatedAt,
          });
          break;
        }

        case 'transfer.failed': {
          telemetry.addLog(span.spanId, 'warn', 'Processing transfer failure', {
            reference: data.reference,
            amount: data.amount,
            recipient: data.recipient,
            status: data.status,
            failureReason: data.failure_reason,
          });
          console.log('Transfer failed:', {
            reference: data.reference,
            amount: data.amount,
            recipient: data.recipient,
            status: data.status,
            failure_reason: data.failure_reason,
          });
          const nextRecord = setTransferStatus({
            reference: data.reference ?? '',
            status: 'failed',
            amount: Number(data.amount ?? 0),
            failureReason: data.failure_reason,
            updatedAt,
            clientSessionId: existingRecord?.clientSessionId,
          });
          publishPaymentStatus(nextRecord.clientSessionId, {
            reference: nextRecord.reference,
            status: nextRecord.status,
            amount: nextRecord.amount,
            updatedAt,
            failureReason: nextRecord.failureReason,
          });
          break;
        }

        case 'transfer.reversed': {
          telemetry.addLog(
            span.spanId,
            'info',
            'Processing transfer reversal',
            {
              reference: data.reference,
              amount: data.amount,
              recipient: data.recipient,
              status: data.status,
            },
          );
          console.log('Transfer reversed:', {
            reference: data.reference,
            amount: data.amount,
            recipient: data.recipient,
            status: data.status,
          });
          const nextRecord = setTransferStatus({
            reference: data.reference ?? '',
            status: 'reversed',
            amount: Number(data.amount ?? 0),
            updatedAt,
            clientSessionId: existingRecord?.clientSessionId,
          });
          publishPaymentStatus(nextRecord.clientSessionId, {
            reference: nextRecord.reference,
            status: nextRecord.status,
            amount: nextRecord.amount,
            updatedAt,
          });
          break;
        }

        default:
          telemetry.addLog(span.spanId, 'info', 'Unhandled webhook event', {
            eventType: event.event,
          });
          console.log('Unhandled webhook event:', event.event);
      }

      // Commit dedupe record atomically with state transition
      webhookDeduplicationService.commit(dedupeEventId);
      isReplayEvent(replayKey);

      telemetry.addLog(span.spanId, 'info', 'Webhook processing completed', {
        eventType: event.event,
      });
      telemetry.finishSpan(span.spanId, { success: true });

      const response = NextResponse.json({ received: true });
      telemetry.setTraceHeaders(response.headers, traceContext);
      return response;
    } catch (processError) {
      webhookDeduplicationService.releaseOnError(dedupeEventId);
      throw processError;
    }
  } catch (error) {
    telemetry.addLog(span.spanId, 'error', 'Webhook processing error', {
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    telemetry.finishSpan(span.spanId, {
      success: false,
      error: 'Webhook processing failed',
      errorType: 'processing_error',
    });

    console.error('Webhook processing error:', error);
    return NextResponse.json(
      { message: 'Webhook processing failed' },
      { status: 500 },
    );
  }
}
