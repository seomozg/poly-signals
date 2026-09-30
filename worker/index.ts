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
import {runAnalysis} from '../lib/analyze';
import {refreshSignals} from '../lib/refresh';
import {config} from '../lib/config';

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

/** Runs one analysis cycle and records the timestamp. */
async function analyzeNow(label: string): Promise<void> {
  const started = Date.now();
  console.log('[worker] %s: analysis started', label);
  try {
    const result = await runAnalysis();
    writeState({...readState(), lastAnalysisAt: new Date().toISOString()});
    console.log(
      '[worker] %s: fetched=%d eligible=%d analysed=%d stored=%d errors=%d (%dms)',
      label,
      result.fetched,
      result.eligible,
      result.analysed,
      result.stored,
      result.errors.length,
      Date.now() - started
    );
    for (const error of result.errors) console.error('[worker] %s: %s', label, error);
  } catch (error) {
    console.error('[worker] %s: analysis failed: %s', label, (error as Error).message);
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

/** Catches up on analysis if the last run is older than the configured window. */
async function catchUpIfNeeded(): Promise<void> {
  const last = readState().lastAnalysisAt;
  if (!last) {
    await analyzeNow('startup');
    return;
  }
  const ageHours = (Date.now() - new Date(last).getTime()) / 3_600_000;
  if (ageHours > config.analysisMaxAgeHours) {
    console.log('[worker] last analysis was %.1f hours ago — catching up', ageHours);
    await analyzeNow('catch-up');
  } else {
    console.log('[worker] last analysis %.1f hours ago — nothing to catch up', ageHours);
  }
}

function startScheduler(): void {
  const tasks: ScheduledTask[] = [];

  tasks.push(
    cron.schedule(config.analysisCron, () => void analyzeNow('cron-analysis'), {
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

  console.log('[worker] database: %s', config.databasePath);
  console.log('[worker] polymarket: %s', config.polymarketApiUrl);
  console.log('[worker] deepseek key: %s', config.deepseekApiKey ? 'set' : 'MISSING');

  if (once) {
    if (!refreshOnly) await analyzeNow('once');
    await refreshNow('once');
    process.exit(0);
  }

  await catchUpIfNeeded();
  await refreshNow('startup');
  startScheduler();
}

void main();
