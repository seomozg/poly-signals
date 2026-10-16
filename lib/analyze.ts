/**
 * Phase 1 of the analysis engine: Polymarket events -> DeepSeek predictions
 * -> catalog signal candidates (edge, diversity, batch retry).
 *
 * Pure selection/filtering logic lives here so it can be unit-tested;
 * orchestration over Gamma API windows is `lib/collect.ts`, published
 * analysis texts are `lib/enrich.ts`, price refresh is `lib/refresh.ts`.
 */
import {
  analyzeBatch,
  buildUserPrompt,
  DeepSeekFatalError,
  type AnalysisResponse,
  type DeepSeekOptions
} from './deepseek';
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
 * Analyses a batch of events. If the model reply is unusable (usually a
 * truncated response), the batch is split in half and retried down to
 * single-event granularity instead of dropping the whole batch.
 * Fatal errors (401/402 — no balance/bad key) are rethrown immediately:
 * splitting would only burn thousands of doomed requests.
 */
export async function analyzeEventsBatch(
  batch: NormalizedEvent[],
  options: DeepSeekOptions = {},
  fetchImpl: typeof fetch = fetch
): Promise<AnalysisResponse[]> {
  if (batch.length === 0) return [];
  try {
    return [
      await analyzeBatch(buildUserPrompt(batch), {...options, items: batch.length}, fetchImpl)
    ];
  } catch (error) {
    if (error instanceof DeepSeekFatalError) throw error;
    if (batch.length === 1) throw error;
    console.warn(
      '[analysis] batch of %d failed (%s) — splitting and retrying',
      batch.length,
      (error as Error).message
    );
    const half = Math.ceil(batch.length / 2);
    const left = await analyzeEventsBatch(batch.slice(0, half), options, fetchImpl);
    const right = await analyzeEventsBatch(batch.slice(half), options, fetchImpl);
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


