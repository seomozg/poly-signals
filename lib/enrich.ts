/**
 * Phase 2 of the signal pipeline: the long, published analysis texts.
 *
 * Kept in its own module (SRP): phase 1 (`lib/analyze.ts`) computes edges and
 * picks signals with short fallback reasons, while this module spends the
 * bigger token budget on the ≤ TARGET_SIGNALS_COUNT signals that made the cut.
 */
import {generateReasons, DeepSeekFatalError} from './deepseek';
import {listSignalsNeedingReason, updateReasons} from './repo';
import {chunk, mapPool} from './pool';
import type {SignalCandidate} from './types';

/**
 * Replaces the brief phase-1 summary with a full published analysis
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
  let stopped = false;

  // Phase-2 texts are long (~2000 chars per signal across both languages), so a
  // chunk of three can hit the output token cap. Keep chunks small and split a
  // failing chunk down to single signals instead of dropping it.
  // Fatal errors (401/402) abort the whole enrichment immediately.
  const enrichChunk = async (items: SignalCandidate[]): Promise<void> => {
    if (stopped) return;
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
      if (error instanceof DeepSeekFatalError) {
        stopped = true;
        console.error('[analysis] ABORT enrichment (fatal): %s', message.slice(0, 200));
        throw error;
      }
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
