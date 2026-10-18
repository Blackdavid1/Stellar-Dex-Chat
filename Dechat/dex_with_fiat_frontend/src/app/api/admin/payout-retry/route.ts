import { NextRequest, NextResponse } from 'next/server';
import { requireAdminAuth } from '../_utils/requireAdminAuth';
import { payoutRetryQueue } from '@/lib/payout/retryQueue';

export async function GET(request: NextRequest) {
  const authError = requireAdminAuth(request);
  if (authError) {
    return authError;
  }

  try {
    const searchParams = request.nextUrl.searchParams;
    const status = searchParams.get('status') || undefined;

    if (status === 'dead_letter') {
      const deadLetterJobs = payoutRetryQueue.getDeadLetterJobs();
      return NextResponse.json({
        jobs: deadLetterJobs,
        count: deadLetterJobs.length,
      });
    }

    const jobs = payoutRetryQueue.getJobs(
      status as
        | 'pending'
        | 'processing'
        | 'dead_letter'
        | 'completed'
        | undefined,
    );
    return NextResponse.json({ jobs, count: jobs.length });
  } catch (err: unknown) {
    console.error('Error fetching retry queue jobs:', err);
    return NextResponse.json(
      { error: 'Failed to retrieve retry queue jobs' },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  const authError = requireAdminAuth(request);
  if (authError) {
    return authError;
  }

  try {
    const body = (await request.json()) as {
      jobId?: string;
      action?: string;
      actor?: string;
    };
    const { jobId, action, actor = 'operator:admin' } = body;

    if (!jobId) {
      return NextResponse.json(
        { error: 'Missing required field: jobId' },
        { status: 400 },
      );
    }

    if (action !== 'replay') {
      return NextResponse.json(
        { error: 'Unsupported action. Supported actions: replay' },
        { status: 400 },
      );
    }

    const job = payoutRetryQueue.replayDeadLetterJob(jobId, actor);

    return NextResponse.json({
      success: true,
      message:
        'Job scheduled for safe operator replay using original idempotency key',
      job,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('Error replaying retry job:', err);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
