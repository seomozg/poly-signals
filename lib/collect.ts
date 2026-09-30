/**
 * Collection mode: sweeps several Gamma API views (orderings) until the
 * catalog holds `target` signals.
 *
 * - Events are analysed only once (`analyzed_events` table), so re-runs are cheap.
 * - Analysis runs in small concurrent batches; after every group of batches the
 *   strongest candidates are stored with diversity caps that also account for
 *   what is already in the catalog.
 * - After the target is reached, every signal without a full-length analysis
 *   gets its published text (phase 2, concurrent).
 */
import {fetchUpcomingEvents} from './polymarket';
import {
  analyzeEventsBatch,
  evaluateResponses,
  enrichStoredSignals,
  groupKey,
  passesFilters,
  selectDiverse,
  trimMarkets
} from './analyze';
import {
  countAnalyzed,
  countSignals,
  filterUnanalyzed,
  listSignalsForStats,
  markAnalyzed,
  upsertSignal
} from './repo';
import {chunk, mapPool} from './pool';
import {config} from './config';
import type {NormalizedEvent, SignalCandidate} from './types';

export interface CollectView {
  order: string;
  ascending: boolean;
  maxDaysAhead: number;
}

/**
 * Different orderings expose different slices of the pool. Measured on the
 * live API: these five views together cover 2000+ eligible events
 * (a single view only reaches ~600 events because the API caps offset/limit).
 */
export const COLLECT_VIEWS: CollectView[] = [
  {order: 'endDate', ascending: true, maxDaysAhead: 30},
  {order: 'endDate', ascending: false, maxDaysAhead: 90},
  {order: 'volume', ascending: false, maxDaysAhead: 90},
  {order: 'volume', ascending: true, maxDaysAhead: 90},
  {order: 'endDate', ascending: false, maxDaysAhead: 30}
];

export interface CollectOptions {
  /** Stop once the catalog holds this many signals. */
  target: number;
  /** Page size (the API caps it at 100). */
  pageLimit?: number;
  /** Max offset per view — bounds how deep we walk each ordering. */
  maxOffset?: number;
  /** Concurrent DeepSeek requests. */
  concurrency?: number;
  /** Events per analysis request. */
  batchSize?: number;
  /**
   * Max NEW signals per category within this run. Defaults to `ceil(quota / 4)`
   * so a single run can never be dominated by one topic.
   */
  runCategoryCap?: number;
  onProgress?: (info: CollectProgress) => void;
}

export interface CollectProgress {
  signals: number;
  target: number;
  analysed: number;
  candidates: number;
  stored: number;
  freshEvents: number;
  phase: 'sweep' | 'analyse' | 'enrich' | 'done';
}

export interface CollectResult {
  target: number;
  signals: number;
  freshEvents: number;
  analysedEvents: number;
  analyzedTotal: number;
  candidates: number;
  stored: number;
  enriched: number;
  errors: string[];
}

/** Diversity usage already present in the catalog. */
function catalogUsage(): {groups: Map<string, number>; categories: Map<string, number>} {
  const groups = new Map<string, number>();
  const categories = new Map<string, number>();
  for (const row of listSignalsForStats()) {
    const group = groupKey(row.title);
    groups.set(group, (groups.get(group) ?? 0) + 1);
    const category = (row.category ?? 'other').toLowerCase();
    categories.set(category, (categories.get(category) ?? 0) + 1);
  }
  return {groups, categories};
}

/** Collects eligible events from every view, skipping already analysed ones. */
async function sweepEvents(
  options: Required<Pick<CollectOptions, 'pageLimit' | 'maxOffset'>>,
  fetchImpl: typeof fetch
): Promise<{fresh: NormalizedEvent[]; skipped: number}> {
  const fresh: NormalizedEvent[] = [];
  const seen = new Set<string>();
  let skipped = 0;

  for (const view of COLLECT_VIEWS) {
    for (let offset = 0; offset <= options.maxOffset; offset += options.pageLimit) {
      const page = await fetchUpcomingEvents(
        {
          limit: options.pageLimit,
          offset,
          order: view.order,
          ascending: view.ascending,
          maxDaysAhead: view.maxDaysAhead
        },
        fetchImpl
      );
      if (page.length === 0) break;

      const eligible = page
        .filter((event) =>
          passesFilters(event, {
            minLiquidity: config.minLiquidity,
            minMarketPrice: config.minMarketPrice,
            minDurationHours: config.minEventDurationHours,
            excludedTags: config.excludedTags
          })
        )
        .map((event) => trimMarkets(event, config.maxMarketsPerEvent));

      const unknown = new Set(filterUnanalyzed(eligible.map((event) => event.id)));
      for (const event of eligible) {
        if (seen.has(event.id)) continue;
        seen.add(event.id);
        if (unknown.has(event.id)) fresh.push(event);
        else skipped++;
      }

      if (page.length < options.pageLimit) break;
    }
  }

  console.log('[collect] sweep: fresh=%d skipped(analysed before)=%d', fresh.length, skipped);
  return {fresh, skipped};
}

/** Runs the full collection cycle. */
export async function collectSignals(
  options: CollectOptions,
  fetchImpl: typeof fetch = fetch
): Promise<CollectResult> {
  const target = options.target;
  const pageLimit = options.pageLimit ?? 100;
  const maxOffset = options.maxOffset ?? 600;
  const concurrency = options.concurrency ?? config.collectConcurrency;
  const batchSize = options.batchSize ?? config.analyzeBatchSize;
  const maxPerCategory = Math.max(1, Math.ceil(target / 5));
  const errors: string[] = [];
  const startCount = countSignals();
  const quota = Math.max(0, target - startCount);
  const runCategoryCap = options.runCategoryCap ?? Math.max(1, Math.ceil(quota / 4));
  const runCategoryUsed = new Map<string, number>();

  const report = (phase: CollectProgress['phase'], analysed: number, candidates: number) =>
    options.onProgress?.({
      signals: countSignals(),
      target,
      analysed,
      candidates,
      stored: 0,
      freshEvents: 0,
      phase
    });

  // --- phase: sweep -------------------------------------------------
  report('sweep', 0, 0);
  const {fresh} = await sweepEvents({pageLimit, maxOffset}, fetchImpl);

  // --- phase: analyse -----------------------------------------------
  const state = {
    candidates: [] as SignalCandidate[],
    observedEdges: [] as number[],
    analysed: 0
  };
  const batches = chunk(fresh, batchSize);
  let stored = 0;

  /** Stores the strongest candidates that still fit the remaining quota. */
  const storeRound = (): number => {
    if (state.candidates.length === 0) return 0;
    const remaining = target - countSignals();
    if (remaining <= 0) return 0;

    const usage = catalogUsage();
    const selected = selectDiverse(state.candidates, {
      limit: remaining,
      maxPerGroup: config.maxPerGroup,
      maxPerCategory,
      initial: usage,
      runCategoryCap,
      runCategoryUsed
    });

    let written = 0;
    for (const candidate of selected) {
      try {
        upsertSignal(candidate);
        written++;
        state.candidates = state.candidates.filter((item) => item !== candidate);
      } catch (error) {
        errors.push(`store ${candidate.marketId}: ${(error as Error).message}`);
      }
    }
    return written;
  };

  for (const group of chunk(batches, concurrency)) {
    if (countSignals() >= target) break;
    await mapPool(group, concurrency, async (batch) => {
      try {
        const responses = await analyzeEventsBatch(batch, {}, fetchImpl);
        evaluateResponses(batch, responses, state);
        markAnalyzed(batch.map((event) => event.id));
      } catch (error) {
        errors.push(`batch: ${(error as Error).message}`);
        console.error('[collect] batch failed: %s', (error as Error).message);
      }
    });

    stored += storeRound();
    const signals = countSignals();
    console.log(
      '[collect] signals=%d/%d analysed=%d candidates=%d',
      signals,
      target,
      state.analysed,
      state.candidates.length
    );
    options.onProgress?.({
      signals,
      target,
      analysed: state.analysed,
      candidates: state.candidates.length,
      stored,
      freshEvents: fresh.length,
      phase: 'analyse'
    });

    if (signals >= target) break;
  }

  stored += storeRound();

  // --- phase: enrich -------------------------------------------------
  console.log('[collect] enriching published analyses for stored signals…');
  options.onProgress?.({
    signals: countSignals(),
    target,
    analysed: state.analysed,
    candidates: state.candidates.length,
    stored,
    freshEvents: fresh.length,
    phase: 'enrich'
  });
  const enrich = await enrichStoredSignals(600, fetchImpl, concurrency);

  const result: CollectResult = {
    target,
    signals: countSignals(),
    freshEvents: fresh.length,
    analysedEvents: state.analysed,
    analyzedTotal: countAnalyzed(),
    candidates: state.candidates.length,
    stored,
    enriched: enrich.updated,
    errors
  };

  options.onProgress?.({
    signals: result.signals,
    target,
    analysed: result.analysedEvents,
    candidates: result.candidates,
    stored: result.stored,
    freshEvents: result.freshEvents,
    phase: 'done'
  });

  return result;
}

/**
 * Daily quota job: adds `dailyNew` NEW signals on top of what the catalog
 * already holds (target = current + quota). Reuses the collection sweep, so
 * only never-analysed events are paid for, and stops as soon as the quota
 * is reached. Used by the daily cron, `--once` and POST /api/run-analysis.
 */
export async function dailyAddSignals(
  dailyNew: number = config.dailyNewSignals,
  options: Omit<CollectOptions, 'target'> = {},
  fetchImpl: typeof fetch = fetch
): Promise<CollectResult> {
  const current = countSignals();
  const quota = Math.max(0, Math.floor(dailyNew));

  if (quota === 0) {
    console.log('[collect] daily quota disabled (DAILY_NEW_SIGNALS=0)');
    return {
      target: current,
      signals: current,
      freshEvents: 0,
      analysedEvents: 0,
      analyzedTotal: countAnalyzed(),
      candidates: 0,
      stored: 0,
      enriched: 0,
      errors: []
    };
  }

  const target = current + quota;
  console.log('[collect] daily quota: +%d signals → target %d', quota, target);
  return collectSignals({...options, target}, fetchImpl);
}

