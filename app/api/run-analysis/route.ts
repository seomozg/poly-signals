import {NextResponse} from 'next/server';
import {dailyAddSignals} from '@/lib/collect';
import {refreshSignals} from '@/lib/refresh';
import {config} from '@/lib/config';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * Manual trigger for the daily signal quota (adds DAILY_NEW_SIGNALS new
 * signals, then refreshes prices). Protected by ANALYSIS_TOKEN; when the
 * token is not configured the route is disabled.
 *
 *   curl -X POST -H "Authorization: Bearer $ANALYSIS_TOKEN" https://site/api/run-analysis
 */
export async function POST(request: Request) {
  if (!config.analysisToken) {
    return NextResponse.json({ok: false, error: 'ANALYSIS_TOKEN is not configured'}, {status: 403});
  }

  const auth = request.headers.get('authorization') ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (token !== config.analysisToken) {
    return NextResponse.json({ok: false, error: 'unauthorized'}, {status: 401});
  }

  try {
    const analysis = await dailyAddSignals(config.dailyNewSignals, {
      concurrency: config.collectConcurrency
    });
    const refresh = await refreshSignals();
    return NextResponse.json({ok: analysis.errors.length === 0, analysis, refresh});
  } catch (error) {
    return NextResponse.json({ok: false, error: (error as Error).message}, {status: 500});
  }
}
