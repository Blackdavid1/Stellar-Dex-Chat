import { NextRequest, NextResponse } from 'next/server';
import {
  authorizeTransferAccess,
  uniformReceiptNotFoundResponse,
} from '@/lib/auth/authorizationMatrix';

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

    // IDOR check: Authorize caller before returning sensitive receipt data.
    // Denials return uniform 404 to avoid leaking record existence.
    const auth = authorizeTransferAccess(request, reference);
    if (!auth.authorized || !auth.record) {
      return uniformReceiptNotFoundResponse();
    }

    const record = auth.record;
    const receiptData = {
      reference: record.reference,
      amount: record.amount,
      status: record.status,
      timestamp: record.updatedAt,
      type: 'Payout',
      currency: 'NGN',
    };

    return NextResponse.json({
      success: true,
      data: receiptData,
    });
  } catch (error: unknown) {
    console.error('Get receipt error:', error);
    return NextResponse.json(
      { success: false, message: 'Failed to retrieve receipt' },
      { status: 500 },
    );
  }
}
