/**
 * Standalone analysis worker.
 *
 *   npm run worker:once   # run analysis + price refresh once, then exit
 *   npm run worker        # schedule cron jobs and keep running
 *
 * The worker shares `lib/` with the Next.js app but runs in its own process,
 * so long DeepSeek calls never block page rendering.
 */
import fs from 'node:fs';
import path from 'node:path';
import cron, {type ScheduledTask} from 'node-cron';
import {enrichStoredSignals} from '../lib/analyze';
import {collectSignals, dailyAddSignals} from '../lib/collect';
import {setAiCallSink} from '../lib/deepseek';
import {getCallStats, recordAiCall} from '../lib/repo';
import {refreshSignals} from '../lib/refresh';
import {config} from '../lib/config';

// Per-request DeepSeek journal (table ai_calls) — installed once for all runs.
setAiCallSink(recordAiCall);

const STATE_FILE = path.join(path.dirname(config.databasePath), 'worker-state.json');

interface WorkerState {
  lastAnalysisAt?: string;
}

function readState(): WorkerState {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) as WorkerState;
  } catch {
    return {};
  }
}

function writeState(state: WorkerState): void {
  fs.mkdirSync(path.dirname(STATE_FILE), {recursive: true});
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
}

/** Adds the daily quota of NEW signals and records the timestamp. */
async function dailyNow(label: string): Promise<void> {
  const started = Date.now();
  const runStart = new Date().toISOString();
  console.log('[worker] %s: daily quota +%d started', label, config.dailyNewSignals);
  try {
    const result = await dailyAddSignals(config.dailyNewSignals, {
      concurrency: config.collectConcurrency
    });
    writeState({...readState(), lastAnalysisAt: new Date().toISOString()});
    console.log(
      '[worker] %s: signals=%d (+%d of %d) fresh=%d analysed=%d enriched=%d errors=%d (%dms)',
      label,
      result.signals,
      result.stored,
      config.dailyNewSignals,
      result.freshEvents,
      result.analysedEvents,
      result.enriched,
      result.errors.length,
      Date.now() - started
    );
    if (result.stored < config.dailyNewSignals) {
      console.warn(
        '[worker] %s: quota not met (%d/%d) — check the fresh-event pool or thresholds',
        label,
        result.stored,
        config.dailyNewSignals
      );
    }
    reportDeepSeek(label, runStart, result.errors);
    for (const error of result.errors.slice(0, 5)) console.error('[worker] %s: %s', label, error);
  } catch (error) {
    console.error('[worker] %s: daily run failed: %s', label, (error as Error).message);
  }
}

/**
 * Prints the per-run journal summary and an explicit call to action when the
 * run was cut short by a fatal DeepSeek error (402 no balance / 401 bad key).
 */
function reportDeepSeek(label: string, runStartIso: string, errors: string[]): void {
  const stats = getCallStats(runStartIso);
  console.log(
    '[worker] %s: deepseek calls total=%d ok=%d failed=%d (402=%d) tokens in=%d out=%d',
    label,
    stats.total,
    stats.ok,
    stats.failed,
    stats.byStatus402,
    stats.inputTokens,
    stats.outputTokens
  );
  if (errors.some((e) => e.startsWith('fatal:'))) {
    console.error(
      '[worker] %s: DEEPSEEK ACCOUNT ERROR — top up the balance at platform.deepseek.com; the run was aborted after %d request(s) instead of retrying',
      label,
      stats.total
    );
  }
}

/** Refreshes current prices / resolution status of stored signals. */
async function refreshNow(label: string): Promise<void> {
  try {
    const result = await refreshSignals();
    console.log(
      '[worker] %s: refreshed events=%d rows=%d errors=%d',
      label,
      result.events,
      result.updated,
      result.errors.length
    );
  } catch (error) {
    console.error('[worker] %s: refresh failed: %s', label, (error as Error).message);
  }
}

/** Catches up if the last daily run is older than the configured window. */
async function catchUpIfNeeded(): Promise<void> {
  const last = readState().lastAnalysisAt;
  if (!last) {
    await dailyNow('startup');
    return;
  }
  const ageHours = (Date.now() - new Date(last).getTime()) / 3_600_000;
  if (ageHours > config.analysisMaxAgeHours) {
    console.log(
      '[worker] last daily run was %s hours ago — catching up',
      ageHours.toFixed(1)
    );
    await dailyNow('catch-up');
  } else {
    console.log(
      '[worker] last daily run %s hours ago — nothing to catch up',
      ageHours.toFixed(1)
    );
  }
}

function startScheduler(): void {
  const tasks: ScheduledTask[] = [];

  tasks.push(
    cron.schedule(config.analysisCron, () => void dailyNow('cron-analysis'), {
      timezone: 'UTC'
    })
  );
  tasks.push(
    cron.schedule(config.priceRefreshCron, () => void refreshNow('cron-refresh'), {
      timezone: 'UTC'
    })
  );

  console.log(
    '[worker] scheduled: analysis="%s" refresh="%s" (UTC)',
    config.analysisCron,
    config.priceRefreshCron
  );

  const shutdown = () => {
    console.log('[worker] shutting down');
    for (const task of tasks) task.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

async function main(): Promise<void> {
  const once = process.argv.includes('--once');
  const refreshOnly = process.argv.includes('--refresh-only');
  const enrichOnly = process.argv.includes('--enrich-only');

  console.log('[worker] database: %s', config.databasePath);
  console.log('[worker] polymarket: %s', config.polymarketApiUrl);
  console.log('[worker] deepseek key: %s', config.deepseekApiKey ? 'set' : 'MISSING');

  if (enrichOnly) {
    // Backfill: give stored signals a full-length analysis text.
    const runStart = new Date().toISOString();
    try {
      const result = await enrichStoredSignals(600, fetch, config.collectConcurrency);
      console.log('[worker] enrich-only: checked=%d updated=%d', result.checked, result.updated);
      reportDeepSeek('enrich-only', runStart, []);
    } catch (error) {
      const message = (error as Error).message;
      reportDeepSeek('enrich-only', runStart, [`fatal: ${message}`]);
      console.error('[worker] enrich-only failed: %s', message.slice(0, 200));
    }
    process.exit(0);
  }

  if (process.argv.includes('--collect')) {
    // One-off: grow the catalog to COLLECT_TARGET signals (then enrich them).
    console.log('[worker] collect target=%d concurrency=%d', config.collectTarget, config.collectConcurrency);
    const started = Date.now();
    const runStart = new Date().toISOString();
    const result = await collectSignals({
      target: config.collectTarget,
      concurrency: config.collectConcurrency
    });
    console.log(
      '[worker] collect done: signals=%d/%d fresh=%d analysed=%d stored=%d enriched=%d errors=%d (%dms)',
      result.signals,
      result.target,
      result.freshEvents,
      result.analysedEvents,
      result.stored,
      result.enriched,
      result.errors.length,
      Date.now() - started
    );
    reportDeepSeek('collect', runStart, result.errors);
    for (const error of result.errors.slice(0, 10)) console.error('[worker] %s', error);
    process.exit(result.signals >= result.target ? 0 : 2);
  }

  if (once) {
    if (!refreshOnly) await dailyNow('once');
    await refreshNow('once');
    process.exit(0);
  }

  await catchUpIfNeeded();
  await refreshNow('startup');
  startScheduler();
}

void main();
