/** Shared domain types used by the worker and the web app. */

/** Raw event as returned by the Polymarket Gamma API (subset we care about). */
export interface GammaMarket {
  id: string;
  question: string;
  outcomes?: string | string[];
  outcomePrices?: string | string[];
  closed?: boolean;
  volume?: number | string;
  liquidity?: number | string;
  image?: string;
  icon?: string;
  endDate?: string;
  slug?: string;
  description?: string;
}

export interface GammaEvent {
  id: string;
  slug: string;
  title: string;
  description?: string;
  image?: string;
  icon?: string;
  endDate?: string;
  startDate?: string;
  active?: boolean;
  closed?: boolean;
  volume?: number | string;
  liquidity?: number | string;
  volume24hr?: number | string;
  tags?: Array<{label?: string; slug?: string}>;
  category?: string;
  markets?: GammaMarket[];
}

/** Normalised market used by the analysis prompt. */
export interface NormalizedMarket {
  id: string;
  question: string;
  outcomes: string[];
  prices: number[];
  volume: number;
  liquidity: number;
  closed: boolean;
  image?: string;
  icon?: string;
  endDate?: string;
}

/** Normalised event used by the analysis prompt and stored with a signal. */
export interface NormalizedEvent {
  id: string;
  slug: string;
  title: string;
  description?: string;
  /** When the event started (ISO) — used to filter out ultra-short markets. */
  startDate?: string;
  image?: string;
  icon?: string;
  endDate?: string;
  volume: number;
  liquidity: number;
  volume24hr: number;
  category?: string;
  tags: string[];
  url: string;
  markets: NormalizedMarket[];
}

/** A single row of the `signals` table (what the site renders). */
export interface Signal {
  id: number;
  event_id: string;
  event_slug: string;
  market_id: string;
  slug: string;
  title: string;
  question: string;
  outcome: string;
  market_price: number;
  predicted_price: number;
  edge: number;
  recommendation: string;
  reason_ru: string;
  reason_en: string;
  image: string | null;
  icon: string | null;
  volume: number | null;
  liquidity: number | null;
  current_price: number | null;
  category: string | null;
  tags: string;
  end_date: string | null;
  polymarket_url: string | null;
  status: 'pending' | 'correct' | 'incorrect';
  created_at: string;
  updated_at: string;
}

/** Candidate produced by one analysis run, before it becomes a stored signal. */
export interface SignalCandidate {
  eventId: string;
  eventSlug: string;
  title: string;
  question: string;
  marketId: string;
  outcome: string;
  marketPrice: number;
  predictedPrice: number;
  edge: number;
  recommendation: 'BUY' | 'NO_ACTION';
  reasonRu: string;
  reasonEn: string;
  image?: string;
  icon?: string;
  endDate?: string;
  volume: number;
  liquidity: number;
  category?: string;
  tags: string[];
  url: string;
}

export type SortKey = 'date' | 'edge';

export interface ListParams {
  sort?: SortKey;
  page?: number;
  pageSize?: number;
  category?: string;
}

export interface ListResult {
  items: Signal[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}
