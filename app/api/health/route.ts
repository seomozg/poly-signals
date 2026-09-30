import {NextResponse} from 'next/server';
import {countSignals} from '@/lib/repo';

/** Liveness/readiness probe used by the deploy pipeline and monitoring. */
export async function GET() {
  try {
    const signals = countSignals();
    return NextResponse.json({
      ok: true,
      signals,
      time: new Date().toISOString()
    });
  } catch (error) {
    return NextResponse.json({ok: false, error: (error as Error).message}, {status: 500});
  }
}
