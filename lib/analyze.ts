/**
 * Analysis engine: Polymarket events -> DeepSeek predictions -> catalog signals.
 *
 * Pure selection logic lives in exported helpers so it can be unit-tested;
 * network I/O is isolated in `runAnalysis` (single-page re-analysis) and in
 * `lib/collect.ts` (quota-driven runs used by the daily job).
 */
import {
  analyzeBatch,
  buildUserPrompt,
  generateReasons,
  type AnalysisResponse,
  type DeepSeekOptions
} from './deepseek';
import {fetchUpcomingEvents} from './polymarket';
import {
  listSignalsNeedingReason,
  markAnalyzed,
  updateReasons,
  upsertSignal
} from './repo';
import {chunk, mapPool} from './pool';
import {config} from './config';
import type {NormalizedEvent, SignalCandidate} from './types';

/** Duration of an event in hours, or null when start/end are unknown. */
export function eventDurationHours(event: NormalizedEvent): number | null {
  if (!event.startDate || !event.endDate) return null;
  const start = Date.parse(event.startDate);
  const end = Date.parse(event.endDate);
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  return (end - start) / 3_600_000;
}

export interface FilterOptions {
  minLiquidity: number;
  minMarketPrice: number;
  /** Events shorter than this (hours) are skipped — 1m/5m crypto flips, etc. */
  minDurationHours?: number;
  /** Lower-cased tag labels that must not be present on the event. */
  excludedTags?: string[];
}

/** Default liquidity filter used when a caller doesn't provide one. */
export function passesFilters(event: NormalizedEvent, opts: FilterOptions): boolean {
  if (event.markets.length === 0) return false;
  if (event.liquidity < opts.minLiquidity) return false;

  const duration = eventDurationHours(event);
  if (duration !== null && opts.minDurationHours !== undefined && duration < opts.minDurationHours) {
    return false;
  }

  if (opts.excludedTags && opts.excludedTags.length > 0) {
    const tags = event.tags.map((tag) => tag.toLowerCase());
    if (tags.some((tag) => opts.excludedTags!.includes(tag))) return false;
    // category often mirrors the main tag (e.g. "Up or Down")
    const category = event.category?.toLowerCase();
    if (category && opts.excludedTags.includes(category)) return false;
  }

  const hasTradable = event.markets.some((market) =>
    market.prices.some((p) => p >= opts.minMarketPrice && p <= 1 - opts.minMarketPrice)
  );
  return hasTradable;
}

export interface BuildCandidatesOptions {
  minEdge: number;
  minMarketPrice: number;
}

/**
 * Turns raw model analyses into signal candidates: computes edge for every
 * outcome, keeps the single best BUY per event (mirrors the bot's strategy)
 * and drops anything below `minEdge`.
 */
export function buildCandidates(
  events: NormalizedEvent[],
  analyses: Array<{
    marketId: string;
    outcomes: Array<{outcome: string; predicted: number}>;
    reasonRu: string;
    reasonEn: string;
  }>,
  options: BuildCandidatesOptions
): SignalCandidate[] {
  const eventByMarket = new Map<string, NormalizedEvent>();
  for (const event of events) {
    for (const market of event.markets) eventByMarket.set(market.id, event);
  }

  const bestPerEvent = new Map<string, SignalCandidate>();

  for (const analysis of analyses) {
    const event = eventByMarket.get(analysis.marketId);
    if (!event) continue; // model hallucinated a market id — ignore
    const market = event.markets.find((m) => m.id === analysis.marketId);
    if (!market) continue;

    for (const outcomeAnalysis of analysis.outcomes) {
      const index = market.outcomes.findIndex(
        (o) => o.toLowerCase() === outcomeAnalysis.outcome.toLowerCase()
      );
      if (index < 0) continue;
      const marketPrice = market.prices[index];
      if (marketPrice === undefined) continue;
      if (marketPrice < options.minMarketPrice || marketPrice > 1 - options.minMarketPrice) continue;

      const edge = Number((outcomeAnalysis.predicted - marketPrice).toFixed(4));
      if (edge < options.minEdge) continue;

      const candidate: SignalCandidate = {
        eventId: event.id,
        eventSlug: event.slug,
        title: event.title,
        question: market.question || event.title,
        marketId: market.id,
        outcome: market.outcomes[index],
        marketPrice,
        predictedPrice: Number(outcomeAnalysis.predicted.toFixed(4)),
        edge,
        recommendation: 'BUY',
        reasonRu: analysis.reasonRu,
        reasonEn: analysis.reasonEn,
        description: event.description,
        image: event.image ?? market.image,
        icon: event.icon ?? market.icon,
        endDate: market.endDate ?? event.endDate,
        volume: event.volume,
        liquidity: event.liquidity,
        category: event.category,
        tags: event.tags,
        url: event.url
      };

      const existing = bestPerEvent.get(event.id);
      if (!existing || candidate.edge > existing.edge) {
        bestPerEvent.set(event.id, candidate);
      }
    }
  }

  return [...bestPerEvent.values()].sort((a, b) => b.edge - a.edge);
}

/**
 * Group key used to diversify the catalog: the part of the title before the
 * first " - " ("Philadelphia Phillies vs. Atlanta Braves - 1st Inning ..."
 * and "... - 5th Inning ..." share one group).
 */
export function groupKey(title: string): string {
  const separator = title.indexOf(' - ');
  const base = separator > 0 ? title.slice(0, separator) : title;
  return base.trim().toLowerCase();
}

export interface SelectOptions {
  /** Total signals to keep. */
  limit: number;
  /** At most N signals per event group (same matchup/topic). */
  maxPerGroup: number;
  /** At most N signals per category. */
  maxPerCategory: number;
  /** Usage already present in the catalog (for incremental collection runs). */
  initial?: {groups?: Map<string, number>; categories?: Map<string, number>};
  /**
   * Per-run budget: at most N *new* signals per category within one run.
   * `used` is mutable state owned by the caller, so the budget survives
   * across several selection rounds of the same run.
   */
  runCategoryCap?: number;
  runCategoryUsed?: Map<string, number>;
}

/**
 * Greedy diversity selection: strongest edges first, skipping candidates that
 * would exceed the per-group or per-category caps. Pure function, unit-tested.
 * `initial` seeds the counters with what is already stored in the catalog.
 */
export function selectDiverse(
  candidates: SignalCandidate[],
  options: SelectOptions
): SignalCandidate[] {
  const byGroup = new Map(options.initial?.groups ?? []);
  const byCategory = new Map(options.initial?.categories ?? []);
  const selected: SignalCandidate[] = [];

  const sorted = [...candidates].sort((a, b) => b.edge - a.edge);
  for (const candidate of sorted) {
    if (selected.length >= options.limit) break;

    const group = groupKey(candidate.title);
    const category = (candidate.category ?? 'other').toLowerCase();
    if ((byGroup.get(group) ?? 0) >= options.maxPerGroup) continue;
    if ((byCategory.get(category) ?? 0) >= options.maxPerCategory) continue;

    if (options.runCategoryCap !== undefined && options.runCategoryUsed) {
      const used = options.runCategoryUsed.get(category) ?? 0;
      if (used >= options.runCategoryCap) continue;
      options.runCategoryUsed.set(category, used + 1);
    }

    byGroup.set(group, (byGroup.get(group) ?? 0) + 1);
    byCategory.set(category, (byCategory.get(category) ?? 0) + 1);
    selected.push(candidate);
  }

  return selected;
}

/**
 * Limits how many markets of one event are sent to the model. Multi-market
 * events (e.g. an esports match with 14 derivative markets) would otherwise
 * blow the token budget and truncate the reply. The highest-volume markets
 * are kept, in their original order.
 */
export function trimMarkets<T extends NormalizedEvent>(event: T, maxMarkets: number): T {
  if (event.markets.length <= maxMarkets) return event;
  const keep = new Set(
    [...event.markets]
      .sort((a, b) => b.volume - a.volume)
      .slice(0, maxMarkets)
      .map((m) => m.id)
  );
  return {...event, markets: event.markets.filter((m) => keep.has(m.id))};
}

/**
 * Phase 2: replaces the brief phase-1 summary with a full published analysis
 * (150-220 words per language) for the signals that made the cut. Runs only
 * for the ≤ TARGET_SIGNALS_COUNT selected signals, so the long output never
 * hits the token budget of the bulk phase. On failure the brief text is kept.
 */
export async function enrichReasons(
  candidates: SignalCandidate[],
  fetchImpl: typeof fetch = fetch,
  concurrency = 1
): Promise<number> {
  if (candidates.length === 0) return 0;

  const updated = new Set<SignalCandidate>();

  // Phase-2 texts are long (~2000 chars per signal across both languages), so a
  // chunk of three can hit the output token cap. Keep chunks small and split a
  // failing chunk down to single signals instead of dropping it.
  const enrichChunk = async (items: SignalCandidate[]): Promise<void> => {
    try {
      const response = await generateReasons(
        items.map((candidate) => ({
          eventId: candidate.eventId,
          eventTitle: candidate.title,
          eventDescription: candidate.description,
          marketId: candidate.marketId,
          question: candidate.question,
          outcome: candidate.outcome,
          marketPrice: candidate.marketPrice,
          predicted: candidate.predictedPrice,
          edge: candidate.edge
        })),
        {},
        fetchImpl
      );

      for (const reason of response.reasons) {
        const target = items.find((candidate) => candidate.marketId === reason.marketId);
        if (!target) continue;
        target.reasonRu = reason.reasonRu;
        target.reasonEn = reason.reasonEn;
        updated.add(target);
      }
    } catch (error) {
      const message = (error as Error).message;
      if (items.length === 1) {
        console.warn('[analysis] long analysis failed, keeping brief text: %s', message);
        return;
      }
      console.warn(
        '[analysis] reason chunk of %d failed (%s) — splitting',
        items.length,
        message.slice(0, 120)
      );
      const half = Math.ceil(items.length / 2);
      await enrichChunk(items.slice(0, half));
      await enrichChunk(items.slice(half));
    }
  };

  await mapPool(chunk(candidates, 2), concurrency, enrichChunk);

  return updated.size;
}

/**
 * Backfill: regenerates full-length analyses for signals that still hold the
 * brief phase-1 text (e.g. rows stored before phase 2 existed).
 * `minChars` is the length below which a text is considered "brief".
 */
export async function enrichStoredSignals(
  minChars = 600,
  fetchImpl: typeof fetch = fetch,
  concurrency = 1
): Promise<{checked: number; updated: number}> {
  const rows = listSignalsNeedingReason(minChars);
  if (rows.length === 0) return {checked: 0, updated: 0};

  const candidates: SignalCandidate[] = rows.map((row) => ({
    eventId: row.event_id,
    eventSlug: row.event_slug,
    marketId: row.market_id,
    title: row.title,
    question: row.question,
    outcome: row.outcome,
    marketPrice: row.market_price,
    predictedPrice: row.predicted_price,
    edge: row.edge,
    recommendation: (row.recommendation as 'BUY' | 'NO_ACTION') ?? 'BUY',
    reasonRu: row.reason_ru,
    reasonEn: row.reason_en,
    volume: row.volume ?? 0,
    liquidity: row.liquidity ?? 0,
    category: row.category ?? undefined,
    tags: [],
    url: row.polymarket_url ?? ''
  }));

  await enrichReasons(candidates, fetchImpl, concurrency);

  let written = 0;
  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    if (candidate.reasonRu === rows[i].reason_ru && candidate.reasonEn === rows[i].reason_en) {
      continue;
    }
    updateReasons(rows[i].id, candidate.reasonRu, candidate.reasonEn);
    written++;
  }

  return {checked: candidates.length, updated: written};
}

export interface RunAnalysisResult {
  fetched: number;
  eligible: number;
  analysed: number;
  stored: number;
  storedSignals: SignalCandidate[];
  errors: string[];
}

/**
 * Analyses a batch of events. If the model reply is unusable (usually a
 * truncated response), the batch is split in half and retried down to
 * single-event granularity instead of dropping the whole batch.
 */
export async function analyzeEventsBatch(
  batch: NormalizedEvent[],
  options: DeepSeekOptions = {},
  fetchImpl: typeof fetch = fetch
): Promise<AnalysisResponse[]> {
  if (batch.length === 0) return [];
  try {
    return [await analyzeBatch(buildUserPrompt(batch), options, fetchImpl)];
  } catch (error) {
    if (batch.length === 1) throw error;
    console.warn(
      '[analysis] batch of %d failed (%s) — splitting and retrying',
      batch.length,
      (error as Error).message
    );
    const half = Math.ceil(batch.length / 2);
    const left = await analyzeEventsBatch(batch.slice(0, half));
    const right = await analyzeEventsBatch(batch.slice(half));
    return [...left, ...right];
  }
}

/** One batch result turned into catalogue candidates + diagnostics. */
export function evaluateResponses(
  batch: NormalizedEvent[],
  responses: AnalysisResponse[],
  state: {
    candidates: SignalCandidate[];
    observedEdges: number[];
    analysed: number;
  }
): void {
  for (const response of responses) {
    state.analysed += response.analyses.length;

    // Diagnostics: every computed edge, regardless of the storage threshold.
    const all = buildCandidates(batch, response.analyses, {
      minEdge: 0,
      minMarketPrice: config.minMarketPrice
    });
    state.observedEdges.push(...all.map((c) => c.edge));

    state.candidates.push(
      ...buildCandidates(batch, response.analyses, {
        minEdge: config.minEdge,
        minMarketPrice: config.minMarketPrice
      })
    );
  }
}

/**
 * Runs one full analysis cycle:
 * upcoming events -> filters -> DeepSeek batches -> top-N signals -> database.
 */
export async function runAnalysis(): Promise<RunAnalysisResult> {
  const errors: string[] = [];

  const events = await fetchUpcomingEvents({
    limit: config.eventsLimit,
    maxDaysAhead: config.maxDaysAhead
  });
  const eligible = events
    .filter((event) =>
      passesFilters(event, {
        minLiquidity: config.minLiquidity,
        minMarketPrice: config.minMarketPrice,
        minDurationHours: config.minEventDurationHours,
        excludedTags: config.excludedTags
      })
    )
    .slice(0, config.analyzeLimit)
    .map((event) => trimMarkets(event, config.maxMarketsPerEvent));

  const state = {
    candidates: [] as SignalCandidate[],
    observedEdges: [] as number[],
    analysed: 0
  };

  for (let i = 0; i < eligible.length; i += config.analyzeBatchSize) {
    const batch = eligible.slice(i, i + config.analyzeBatchSize);
    try {
      const responses = await analyzeEventsBatch(batch);
      evaluateResponses(batch, responses, state);
      markAnalyzed(batch.map((event) => event.id));
    } catch (error) {
      const message = `batch ${i / config.analyzeBatchSize + 1}: ${(error as Error).message}`;
      errors.push(message);
      console.error('[analysis] %s', message);
    }
  }

  const candidates = state.candidates;
  const observedEdges = state.observedEdges;
  const analysed = state.analysed;

  observedEdges.sort((a, b) => b - a);
  console.log(
    '[analysis] edges observed=%d top=%s (threshold=%s)',
    observedEdges.length,
    observedEdges
      .slice(0, 5)
      .map((e) => e.toFixed(3))
      .join(', ') || 'none',
    config.minEdge
  );

  // Strongest edges first, but keep the catalog diverse (groups/categories).
  const top = selectDiverse(candidates, {
    limit: config.targetSignals,
    maxPerGroup: config.maxPerGroup,
    maxPerCategory: config.maxPerCategory
  });

  // Phase 2: full-length published analyses for the selected signals only.
  const enriched = await enrichReasons(top);
  console.log('[analysis] selected=%d enriched=%d', top.length, enriched);

  let stored = 0;
  for (const candidate of top) {
    try {
      upsertSignal(candidate);
      stored++;
    } catch (error) {
      errors.push(`store ${candidate.marketId}: ${(error as Error).message}`);
    }
  }

  return {fetched: events.length, eligible: eligible.length, analysed, stored, storedSignals: top, errors};
}
