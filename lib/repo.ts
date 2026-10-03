/**
 * Data access for the signal catalog. Pure helpers are exported separately
 * so the logic can be unit-tested without a running server.
 */
import {getDb} from './db';
import type {AiCallRecord} from './deepseek';
import type {Signal, SignalCandidate} from './types';

export const DEFAULT_PAGE_SIZE = 12;

/** Deterministic, human-readable page slug for a signal. */
export function buildSlug(eventSlug: string, marketId: string): string {
  const base = eventSlug
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${base || 'event'}-${marketId}`;
}

/** ISO-8601 UTC timestamp used for created_at / updated_at. */
export function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Inserts or refreshes a candidate signal.
 * Identity: (event_id, market_id) — one page per market; content is re-generated
 * on every analysis run so the catalog always shows the latest AI analysis.
 * Slug conflicts from a different event are resolved by appending a counter.
 */
export function upsertSignal(candidate: SignalCandidate): Signal {
  const db = getDb();
  const ts = nowIso();
  let slug = buildSlug(candidate.eventSlug, candidate.marketId);

  // Slug must stay unique across events with identical slugs/markets.
  const slugExists = db.prepare('SELECT 1 FROM signals WHERE slug = ? AND event_id != ?');
  for (let i = 2; slugExists.get(slug, candidate.eventId); i++) {
    slug = `${buildSlug(candidate.eventSlug, candidate.marketId)}-${i}`;
  }

  db.prepare(
    `INSERT INTO signals (
      event_id, event_slug, market_id, slug, title, question, outcome,
      market_price, predicted_price, edge, recommendation, reason_ru, reason_en,
      image, icon, volume, liquidity, current_price, category, tags, end_date,
      polymarket_url, status, created_at, updated_at
    ) VALUES (
      @event_id, @event_slug, @market_id, @slug, @title, @question, @outcome,
      @market_price, @predicted_price, @edge, @recommendation, @reason_ru, @reason_en,
      @image, @icon, @volume, @liquidity, @market_price, @category, @tags, @end_date,
      @polymarket_url, 'pending', @ts, @ts
    )
    ON CONFLICT(event_id, market_id) DO UPDATE SET
      slug = excluded.slug,
      title = excluded.title,
      question = excluded.question,
      outcome = excluded.outcome,
      market_price = excluded.market_price,
      predicted_price = excluded.predicted_price,
      edge = excluded.edge,
      recommendation = excluded.recommendation,
      reason_ru = excluded.reason_ru,
      reason_en = excluded.reason_en,
      image = excluded.image,
      icon = excluded.icon,
      volume = excluded.volume,
      liquidity = excluded.liquidity,
      category = excluded.category,
      tags = excluded.tags,
      end_date = excluded.end_date,
      polymarket_url = excluded.polymarket_url,
      updated_at = excluded.updated_at`
  ).run({
    event_id: candidate.eventId,
    event_slug: candidate.eventSlug,
    market_id: candidate.marketId,
    slug,
    title: candidate.title,
    question: candidate.question,
    outcome: candidate.outcome,
    market_price: candidate.marketPrice,
    predicted_price: candidate.predictedPrice,
    edge: candidate.edge,
    recommendation: candidate.recommendation,
    reason_ru: candidate.reasonRu,
    reason_en: candidate.reasonEn,
    image: candidate.image ?? null,
    icon: candidate.icon ?? null,
    volume: candidate.volume,
    liquidity: candidate.liquidity,
    category: candidate.category ?? null,
    tags: JSON.stringify(candidate.tags ?? []),
    end_date: candidate.endDate ?? null,
    polymarket_url: candidate.url,
    ts
  });

  return getBySlug(slug)!;
}

/** Returns a signal by its page slug, or null. */
export function getBySlug(slug: string): Signal | null {
  const db = getDb();
  return (db.prepare('SELECT * FROM signals WHERE slug = ?').get(slug) as Signal) ?? null;
}


export interface CatalogFilters {
  sort?: 'date' | 'edge';
  page?: number;
  pageSize?: number;
  category?: string | null;
}

export interface ListResult {
  items: Signal[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

/**
 * Paginated catalog listing.
 * Sort: `date` (newest analysis first) or `edge` (strongest edge first).
 * Category filter is an exact match on the stored category label.
 */
export function listSignals(filters: CatalogFilters = {}): ListResult {
  const db = getDb();
  const sort = filters.sort ?? 'date';
  const pageSize = Math.max(1, filters.pageSize ?? DEFAULT_PAGE_SIZE);
  const page = Math.max(1, filters.page ?? 1);
  const category = filters.category?.trim() || null;

  const where = category ? 'WHERE category = @category' : '';
  const orderBy =
    sort === 'edge'
      ? 'ORDER BY edge DESC, created_at DESC'
      : 'ORDER BY created_at DESC, edge DESC';

  const total = (
    db.prepare(`SELECT COUNT(*) AS c FROM signals ${where}`).get(category ? {category} : {}) as {
      c: number;
    }
  ).c;

  const items = db
    .prepare(`SELECT * FROM signals ${where} ${orderBy} LIMIT @limit OFFSET @offset`)
    .all({
      ...(category ? {category} : {}),
      limit: pageSize,
      offset: (page - 1) * pageSize
    }) as Signal[];

  return {items, total, page, pageSize, totalPages: Math.max(1, Math.ceil(total / pageSize))};
}

/**
 * Distinct categories for the filter chips, most populated first.
 * `limit` keeps the row compact (rare categories are noise).
 */
export function listCategories(limit?: number): string[] {
  const base = `SELECT category FROM signals WHERE category IS NOT NULL AND category != ''
       GROUP BY category ORDER BY COUNT(*) DESC, category ASC`;
  const rows = (
    limit && limit > 0
      ? getDb().prepare(`${base} LIMIT ?`).all(limit)
      : getDb().prepare(base).all()
  ) as Array<{category: string}>;
  return rows.map((r) => r.category);
}

/** Title + category of every stored signal (used for diversity caps). */
export function listSignalsForStats(): Array<{title: string; category: string | null}> {
  return getDb()
    .prepare('SELECT title, category FROM signals')
    .all() as Array<{title: string; category: string | null}>;
}

/* ---------------- analyzed events (token-spending bookkeeping) ---------------- */

/** Marks events as analysed so collection runs never pay for them twice. */
export function markAnalyzed(eventIds: string[]): void {
  if (eventIds.length === 0) return;
  const db = getDb();
  const ts = nowIso();
  const stmt = db.prepare(
    'INSERT INTO analyzed_events (event_id, analyzed_at) VALUES (?, ?) ON CONFLICT(event_id) DO UPDATE SET analyzed_at = excluded.analyzed_at'
  );
  db.transaction(() => {
    for (const id of eventIds) stmt.run(id, ts);
  })();
}

/** Filters out events that are already in `analyzed_events`. */
export function filterUnanalyzed(eventIds: string[]): string[] {
  if (eventIds.length === 0) return [];
  const db = getDb();
  const known = new Set(
    (
      db
        .prepare(
          `SELECT event_id FROM analyzed_events WHERE event_id IN (${eventIds
            .map(() => '?')
            .join(',')})`
        )
        .all(...eventIds) as Array<{event_id: string}>
    ).map((row) => row.event_id)
  );
  return eventIds.filter((id) => !known.has(id));
}

/** How many events have been analysed so far (progress reporting). */
export function countAnalyzed(): number {
  return (getDb().prepare('SELECT COUNT(*) AS c FROM analyzed_events').get() as {c: number}).c;
}

/* ---------------- ai_calls journal (per-request DeepSeek accounting) ---------------- */

/** Persists one journal row. Never throws — accounting must not break analysis. */
export function recordAiCall(record: AiCallRecord): void {
  try {
    getDb()
      .prepare(
        `INSERT INTO ai_calls
           (created_at, phase, status, ok, items, input_tokens, output_tokens, model, error)
         VALUES (@createdAt, @phase, @status, @ok, @items, @inputTokens, @outputTokens, @model, @error)`
      )
      .run({
        createdAt: nowIso(),
        phase: record.phase,
        status: record.status,
        ok: record.ok ? 1 : 0,
        items: record.items,
        inputTokens: record.inputTokens,
        outputTokens: record.outputTokens,
        model: record.model,
        error: record.error
      });
  } catch (error) {
    console.warn('[repo] failed to record ai call: %s', (error as Error).message);
  }
}

export interface CallStats {
  total: number;
  ok: number;
  failed: number;
  byStatus402: number;
  inputTokens: number;
  outputTokens: number;
}

/** Aggregated DeepSeek usage since a point in time (default: everything). */
export function getCallStats(sinceIso?: string): CallStats {
  const where = sinceIso ? 'WHERE created_at >= @since' : '';
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) total,
              COALESCE(SUM(ok), 0) ok,
              COALESCE(SUM(input_tokens), 0) inputTokens,
              COALESCE(SUM(output_tokens), 0) outputTokens,
              COALESCE(SUM(status = 402), 0) by402
       FROM ai_calls ${where}`
    )
    .get(sinceIso ? {since: sinceIso} : {}) as {
    total: number;
    ok: number;
    inputTokens: number;
    outputTokens: number;
    by402: number;
  };
  return {
    total: row.total,
    ok: row.ok,
    failed: row.total - row.ok,
    byStatus402: row.by402,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens
  };
}

export interface AiCallDayRow {
  day: string;
  phase: string;
  calls: number;
  ok: number;
  failed: number;
  err402: number;
  input_tokens: number | null;
  output_tokens: number | null;
}

/** Per-day/per-phase journal — answers "how many DeepSeek calls in N days". */
export function listAiCallsByDay(): AiCallDayRow[] {
  return getDb()
    .prepare(
      `SELECT substr(created_at,1,10) day,
              phase,
              COUNT(*) calls,
              COALESCE(SUM(ok), 0) ok,
              COALESCE(SUM(ok = 0), 0) failed,
              COALESCE(SUM(status = 402), 0) err402,
              SUM(input_tokens) input_tokens,
              SUM(output_tokens) output_tokens
       FROM ai_calls
       GROUP BY day, phase
       ORDER BY day DESC, phase`
    )
    .all() as AiCallDayRow[];
}

/** Signals whose analysis text is still the brief phase-1 version. */
export function listSignalsNeedingReason(minChars: number): Signal[] {
  return getDb()
    .prepare(
      `SELECT * FROM signals
       WHERE LENGTH(reason_ru) < ? OR LENGTH(reason_en) < ?
       ORDER BY edge DESC`
    )
    .all(minChars, minChars) as Signal[];
}

/** Rewrites the analysis text of one signal. */
export function updateReasons(id: number, reasonRu: string, reasonEn: string): void {
  getDb()
    .prepare('UPDATE signals SET reason_ru = ?, reason_en = ?, updated_at = ? WHERE id = ?')
    .run(reasonRu, reasonEn, nowIso(), id);
}

/** Minimal counter for the footer/health endpoint. */
export function countSignals(): number {
  return (getDb().prepare('SELECT COUNT(*) AS c FROM signals').get() as {c: number}).c;
}

/** Distinct event ids that have at least one stored signal (for price refresh). */
export function getSignalEventIds(): string[] {
  const rows = getDb()
    .prepare('SELECT DISTINCT event_id FROM signals ORDER BY created_at DESC')
    .all() as Array<{event_id: string}>;
  return rows.map((r) => r.event_id);
}

/** Market/outcome pairs stored for one event (used to locate live prices). */
export function getMarketOutcomes(
  eventId: string
): Array<{market_id: string; outcome: string; status: string}> {
  return getDb()
    .prepare('SELECT market_id, outcome, status FROM signals WHERE event_id = ?')
    .all(eventId) as Array<{market_id: string; outcome: string; status: string}>;
}

/**
 * Applies fresh market data (current price, volume, liquidity, resolution status)
 * to existing signals of one event. Returns how many rows were touched.
 */
export function applyMarketUpdate(
  eventId: string,
  update: {
    volume?: number;
    liquidity?: number;
    image?: string;
    /** `marketId|outcome` -> current price. */
    prices: Map<string, number>;
    /** `marketId|outcome` -> final price (1/0) when the market has resolved. */
    finalPrices?: Map<string, number>;
  }
): number {
  const db = getDb();
  const signals = db.prepare('SELECT * FROM signals WHERE event_id = ?').all(eventId) as Signal[];
  if (signals.length === 0) return 0;

  const now = nowIso();
  const stmt = db.prepare(
    `UPDATE signals SET
      current_price = @current_price,
      volume = COALESCE(@volume, volume),
      liquidity = COALESCE(@liquidity, liquidity),
      image = COALESCE(@image, image),
      status = @status,
      updated_at = @now
    WHERE id = @id`
  );

  let changed = 0;
  const run = db.transaction(() => {
    for (const s of signals) {
      const key = `${s.market_id}|${s.outcome}`;
      const finalPrice = update.finalPrices?.get(key);
      const livePrice = update.prices.get(key);
      const current = finalPrice ?? livePrice ?? s.current_price;

      // A market is resolved when its final outcome price is 0 or 1.
      let status = s.status;
      if (finalPrice !== undefined && s.status === 'pending') {
        status = finalPrice >= 0.99 ? 'correct' : finalPrice <= 0.01 ? 'incorrect' : 'pending';
      }

      stmt.run({
        id: s.id,
        current_price: current,
        volume: update.volume ?? null,
        liquidity: update.liquidity ?? null,
        image: update.image ?? null,
        status,
        now
      });
      changed++;
    }
  });
  run();

  return changed;
}


