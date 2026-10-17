import { NextRequest, NextResponse } from 'next/server';
import { setTransferStatus } from '@/lib/transferStore';
import { applyRateLimit, getClientIp } from '@/lib/rateLimit';
import {
  authorizeTransferAccess,
  uniformNotFoundResponse,
} from '@/lib/auth/authorizationMatrix';

const RATE_LIMIT = { maxRequests: 5, windowMs: 60_000 };

// Temporary memory store to mark cancellation requests.
const cancelledTransfers = new Set<string>();

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ reference: string }> },
) {
  const ip = getClientIp(request);
  const limited = applyRateLimit(ip, '/api/transfer-status', RATE_LIMIT);
  if (limited) return limited;

  try {
    const p = await params;
    const { reference } = p;

    if (!reference) {
      return NextResponse.json(
        { success: false, message: 'Reference is required' },
        { status: 400 },
      );
    }

    const body = await request.json().catch(() => ({}));
    const clientSessionId = body.clientSessionId as string | undefined;

    // IDOR check: authorize caller before performing cancellation or returning sensitive data.
    // Denials return uniform 404 to avoid leaking record existence.
    const auth = authorizeTransferAccess(request, reference, clientSessionId);
    if (!auth.authorized || !auth.record) {
      return uniformNotFoundResponse();
    }

    const existing = auth.record;
    if (existing.status !== 'pending') {
      return NextResponse.json(
        { success: false, message: 'Only pending transfers can be cancelled' },
        { status: 409 },
      );
    }

    cancelledTransfers.add(reference);
    setTransferStatus({
      reference,
      status: 'cancelled',
      amount: existing?.amount ?? 0,
      updatedAt: new Date().toISOString(),
      clientSessionId: existing?.clientSessionId,
      failureReason: existing?.failureReason,
      credentialVersion: existing?.credentialVersion,
      timeoutOutcome: existing?.timeoutOutcome,
      reconciled: existing?.reconciled,
    });

    return NextResponse.json({
      success: true,
      data: {
        reference,
        status: 'cancelled',
        message: 'Transfer cancellation requested successfully',
      },
    });
  } catch (error: unknown) {
    console.error('Cancel transfer error:', error);
    return NextResponse.json(
      { success: false, message: 'Failed to cancel transfer' },
      { status: 500 },
    );
  }
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ reference: string }> },
) {
  try {
    const p = await params;
    const { reference } = p;

    if (!reference) {
      return NextResponse.json(
        { success: false, message: 'Reference is required' },
        { status: 400 },
      );
    }

    // IDOR check: authorize caller before returning transfer status.
    // Denials return uniform 404 to prevent probing and leaking record existence.
    const auth = authorizeTransferAccess(request, reference);
    if (!auth.authorized || !auth.record) {
      return uniformNotFoundResponse();
    }

    const transferRecord = auth.record;

    if (cancelledTransfers.has(reference)) {
      return NextResponse.json({
        success: true,
        data: {
          reference,
          status: 'cancelled',
          amount: transferRecord?.amount ?? 0,
          message: 'Transfer cancellation requested successfully',
        },
      });
    }

    return NextResponse.json({
      success: true,
      data: transferRecord,
    });
  } catch (error: unknown) {
    console.error('Get transfer status error:', error);
    return NextResponse.json(
      { success: false, message: 'Failed to retrieve transfer status' },
      { status: 500 },
    );
  }
}
