/**
 * Polymarket Gamma API client.
 * Public API, no key required: https://gamma-api.polymarket.com
 */
import {config} from './config';
import type {GammaEvent, GammaMarket, NormalizedEvent, NormalizedMarket} from './types';

/** Converts Gamma's numeric-ish fields ("123.4", 123.4, null) into a number. */
export function toNumber(value: unknown, fallback = 0): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

/** Gamma returns `outcomes`/`outcomePrices` as a JSON-encoded string. */
export function parseJsonArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed.map(String);
    } catch {
      return value
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    }
  }
  return [];
}

/** Normalises a market object (outcomes/prices as arrays of strings/numbers). */
export function normalizeMarket(market: GammaMarket): NormalizedMarket {
  const outcomes = parseJsonArray(market.outcomes);
  const prices = parseJsonArray(market.outcomePrices).map((p) => toNumber(p, 0));
  return {
    id: String(market.id),
    question: market.question ?? '',
    outcomes,
    prices,
    volume: toNumber(market.volume),
    liquidity: toNumber(market.liquidity),
    closed: Boolean(market.closed),
    image: market.image || undefined,
    icon: market.icon || undefined,
    endDate: market.endDate
  };
}

/** Normalises an event: keeps images, liquidity/volume and active markets. */
export function normalizeEvent(event: GammaEvent): NormalizedEvent {
  const markets = (event.markets ?? []).filter((m) => !m.closed).map(normalizeMarket);
  const tags = (event.tags ?? []).map((t) => t.label || t.slug || '').filter(Boolean);
  return {
    id: String(event.id),
    slug: event.slug ?? String(event.id),
    title: event.title ?? '',
    description: event.description || undefined,
    startDate: event.startDate || undefined,
    image: event.image || undefined,
    icon: event.icon || undefined,
    endDate: event.endDate,
    volume: toNumber(event.volume),
    liquidity: toNumber(event.liquidity),
    volume24hr: toNumber(event.volume24hr),
    category: event.category || tags[0],
    tags,
    url: `https://polymarket.com/event/${event.slug ?? event.id}`,
    markets
  };
}

/** Query parameters accepted by GET /events. */
export interface FetchEventsParams {
  limit?: number;
  maxDaysAhead?: number;
  /** Minimum hours until the event ends (skips ultra-short markets). */
  minHoursToEnd?: number;
  order?: string;
  ascending?: boolean;
}

/**
 * Builds the /events query string. Exported for unit tests:
 * `end_date_min` encodes both `minHoursToEnd` and the "now" boundary.
 */
export function buildEventsQuery(
  params: FetchEventsParams,
  now: Date = new Date()
): URLSearchParams {
  const limit = params.limit ?? config.eventsLimit;
  const maxDays = params.maxDaysAhead ?? config.maxDaysAhead;
  const minHours = params.minHoursToEnd ?? config.minHoursToEnd;
  const start = new Date(now.getTime() + minHours * 3_600_000);
  const until = new Date(now.getTime() + maxDays * 24 * 60 * 60 * 1000);

  return new URLSearchParams({
    active: 'true',
    closed: 'false',
    limit: String(limit),
    offset: '0',
    order: params.order ?? 'endDate',
    ascending: String(params.ascending ?? true),
    end_date_min: start.toISOString(),
    end_date_max: until.toISOString()
  });
}

/** Fetches upcoming active events ordered by end date (soonest first). */
export async function fetchUpcomingEvents(
  params: FetchEventsParams = {},
  fetchImpl: typeof fetch = fetch
): Promise<NormalizedEvent[]> {
  const query = buildEventsQuery(params);

  const response = await fetchImpl(`${config.polymarketApiUrl}/events?${query.toString()}`, {
    headers: {accept: 'application/json'},
    // Events change slowly; a short server-side cache keeps ISR renders cheap.
    // The extra `next` field is a Next.js extension and is ignored by plain Node fetch.
    next: {revalidate: 600}
  } as RequestInit);
  if (!response.ok) {
    throw new Error(`Polymarket API error: ${response.status} ${response.statusText}`);
  }

  const payload = (await response.json()) as GammaEvent[];
  return payload.map(normalizeEvent);
}

/** Fetches a single event by id (used to refresh prices of stored signals). */
export async function fetchEventById(
  eventId: string,
  fetchImpl: typeof fetch = fetch
): Promise<NormalizedEvent | null> {
  const response = await fetchImpl(`${config.polymarketApiUrl}/events/${eventId}`, {
    headers: {accept: 'application/json'}
  });
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`Polymarket API error: ${response.status} ${response.statusText}`);
  }
  const payload = (await response.json()) as GammaEvent;
  return normalizeEvent(payload);
}

/**
 * Picks the current price of a specific outcome inside an event.
 * For resolved markets Gamma returns 1/0 in `outcomePrices`.
 */
export function outcomePrice(event: NormalizedEvent, marketId: string, outcome: string): number | null {
  const market = event.markets.find((m) => m.id === marketId);
  if (!market) return null;
  const index = market.outcomes.findIndex((o) => o.toLowerCase() === outcome.toLowerCase());
  if (index < 0 || index >= market.prices.length) return null;
  return market.prices[index];
}
