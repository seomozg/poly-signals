/**
 * Central configuration for the site and the analysis worker.
 * Values come from environment variables (.env) with safe defaults,
 * so the project runs out of the box in development.
 */
import path from 'node:path';
import fs from 'node:fs';

/**
 * Minimal .env loader for the standalone worker (`tsx` doesn't load it itself;
 * Next.js loads .env automatically). Existing env vars always win.
 */
function loadDotEnv(): void {
  const file = path.join(process.cwd(), '.env');
  if (!fs.existsSync(file)) return;
  try {
    const content = fs.readFileSync(file, 'utf8');
    for (const line of content.split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!match) continue;
      const [, key, rawValue] = match;
      if (process.env[key] !== undefined && process.env[key] !== '') continue;
      process.env[key] = rawValue.replace(/^["']|["']$/g, '');
    }
  } catch {
    // .env is optional — defaults below keep the app working
  }
}

loadDotEnv();


function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export const config = {
  // --- Public site ---
  /** Canonical origin used for canonical/hreflang/OG/sitemap (e.g. https://example.com) */
  siteUrl: (process.env.SITE_URL ?? 'http://localhost:3000').replace(/\/+$/, ''),
  defaultLocale: 'ru' as const,
  locales: ['ru', 'en'] as const,

  // --- Database ---
  databasePath: process.env.DATABASE_PATH ?? path.join(process.cwd(), 'data', 'poly_site.db'),

  // --- Polymarket (Gamma) API ---
  polymarketApiUrl: (process.env.POLYMARKET_API_URL ?? 'https://gamma-api.polymarket.com').replace(
    /\/+$/,
    ''
  ),

  // --- DeepSeek ---
  deepseekApiUrl: process.env.DEEPSEEK_API_URL ?? 'https://api.deepseek.com/v1/chat/completions',
  /** Read lazily: `.env` may be loaded after this module, and tests set it too. */
  get deepseekApiKey(): string {
    return process.env.DEEPSEEK_API_KEY ?? '';
  },
  deepseekModel: process.env.DEEPSEEK_MODEL ?? 'deepseek-chat',

  // --- Analysis engine (mirrors the proven defaults of the reference bot) ---
  /** Maximum events pulled from Polymarket per run (before filtering) */
  eventsLimit: num('EVENTS_LIMIT', 100),
  /** How many filtered events are actually sent to the model per run */
  analyzeLimit: num('ANALYZE_LIMIT', 30),
  /** Minimum liquidity for an event to be analysed */
  minLiquidity: num('MIN_LIQUIDITY', 300),
  /** Minimum market price considered tradable */
  minMarketPrice: num('MIN_MARKET_PRICE', 0.01),
  /** Minimum positive edge for a signal to be stored */
  minEdge: num('MIN_EDGE', 0.02),
  /** How many top signals per day are kept in the catalog */
  targetSignals: num('TARGET_SIGNALS_COUNT', 8),
  /** Diversity: max signals from one event group (same matchup) per run */
  maxPerGroup: num('MAX_SIGNALS_PER_GROUP', 2),
  /** Diversity: max signals from one category per run */
  maxPerCategory: num('MAX_SIGNALS_PER_CATEGORY', 4),
  /** Events per single DeepSeek request (kept small so replies never truncate) */
  analyzeBatchSize: num('ANALYZE_BATCH_SIZE', 3),
  /** Max markets analysed per event — keeps model replies within the token budget */
  maxMarketsPerEvent: num('MAX_MARKETS_PER_EVENT', 5),
  /** Max days until event end to analyse */
  maxDaysAhead: num('MAX_DAYS_AHEAD', 30),
  /** Skip events ending sooner than this (filters out 1m/5m scalping markets) */
  minHoursToEnd: num('MIN_HOURS_TO_END', 6),
  /** Skip events that last shorter than this (1m/5m/15m crypto flip markets) */
  minEventDurationHours: num('MIN_EVENT_DURATION_HOURS', 2),
  /**
   * Comma-separated tag labels to skip. Defaults remove ultra-short crypto
   * flip markets (5M/15M/1H "Up or Down") that would flood the catalog.
   */
  excludedTags: (process.env.EXCLUDED_TAGS ?? '1M,5M,15M,30M,1H,Up or Down')
    .split(',')
    .map((tag) => tag.trim().toLowerCase())
    .filter(Boolean),

  // --- Scheduler (cron expressions, UTC) ---
  analysisCron: process.env.ANALYSIS_CRON ?? '0 0 * * *',
  priceRefreshCron: process.env.PRICE_REFRESH_CRON ?? '0 */3 * * *',
  /** Guard: if the last successful analysis is older than this, run it on startup */
  analysisMaxAgeHours: num('ANALYSIS_MAX_AGE_HOURS', 25),

  // --- One-off collection mode (`npm run worker:collect`) ---
  /** Grow the catalog up to this many signals */
  collectTarget: num('COLLECT_TARGET', 200),
  /** Concurrent DeepSeek requests during collection */
  collectConcurrency: num('COLLECT_CONCURRENCY', 3),

  // --- API access control for manual triggers ---
  analysisToken: process.env.ANALYSIS_TOKEN ?? '',

  // --- SEO ---
  yandexVerification: process.env.YANDEX_VERIFICATION ?? '',
  googleSiteVerification: process.env.GOOGLE_SITE_VERIFICATION ?? ''
} as const;

export type SiteConfig = typeof config;
