# PolySignals — AI-analyzed Polymarket signal catalog

**Live: https://poly-signals.ru** (production, ru/en) · The catalog grows automatically: +20 signals/day.

A minimal catalog site for Polymarket trading signals: a TypeScript engine pulls events from the
Gamma API, sends them to DeepSeek and stores signals with an *edge* (the gap between the AI
probability and the market price). The site is bilingual (ru/en), mobile-first and optimized for
Google and Yandex.

Highlights:

- **Next.js 16 (App Router) + TypeScript + Tailwind 4** — SSR/ISR, dark theme, mobile-first.
- **Two-phase AI pipeline**: batch probability estimation *without market prices* (to avoid model
  anchoring) → edge-based signal selection with diversification → a long published analysis text
  generated only for the selected signals.
- **Cron worker**: `node-cron`, a daily quota of +20 signals, price refresh every 3 hours,
  catch-up on restart, a per-request LLM journal in the `ai_calls` table (tokens, statuses) and
  fail-fast when the DeepSeek balance runs out.
- **SEO for Google & Yandex**: canonical/hreflang/x-default, sitemap, robots.txt with `Host:`,
  JSON-LD, webmaster verifications, Yandex.Metrika at the top of `<body>`.
- **Production**: Docker (web + worker), nginx + Let's Encrypt (webroot); configs in `deploy/`.
- **Quality**: 86 unit tests (Vitest), ESLint, GitHub Actions CI.

The project is **fully independent** of the Telegram bot in `C:\dev\poly` — own code, own database
(`data/poly_site.db`), no shared modules or APIs.

The rest of the documentation is in Russian (the primary audience): see [README.md](./README.md).
Below is only the command reference.

## Quick start

```bash
npm install
cp .env.example .env      # set DEEPSEEK_API_KEY and SITE_URL
npm run dev               # http://localhost:3000 -> /ru
```

```bash
npm run worker:once       # manual daily run: +DAILY_NEW_SIGNALS signals + price refresh
npm run worker            # cron mode: +20 signals/day, prices every 3 hours
npm run worker:collect    # one-off: grow the catalog up to COLLECT_TARGET (200)
npm run worker:enrich     # regenerate long analyses for stored signals
npm test && npm run lint  # 86 unit tests + ESLint
```

## Configuration

All settings live in `.env` (see `.env.example`): `SITE_URL`, `DEEPSEEK_API_KEY`,
`DAILY_NEW_SIGNALS`, `MIN_EDGE`, `MIN_LIQUIDITY`, `MIN_HOURS_TO_END`, `MIN_EVENT_DURATION_HOURS`,
`EXCLUDED_TAGS`, `ANALYSIS_CRON`, `PRICE_REFRESH_CRON`, `YANDEX_METRIKA_ID`, and others.

## Architecture

- `lib/analyze.ts` — phase 1: filters → edge → diversity → batch retry (fatal 401/402 abort).
- `lib/enrich.ts` — phase 2: long published analyses + backfill.
- `lib/collect.ts` — orchestration across five Gamma API "windows", quotas, abort logic.
- `lib/deepseek.ts` — JSON-mode client, zod validation, call journal sink, fatal errors.
- `lib/repo.ts` — SQLite access, migrations (`user_version`), `ai_calls` journal.
- `worker/index.ts` — cron jobs, catch-up, per-run summaries.
- `app/[locale]` — catalog and signal pages, SEO metadata, sitemap/robots.

Useful SQL for the LLM journal (how many calls happened in the last N days):

```sql
SELECT substr(created_at,1,10) day, phase, COUNT(*) calls, SUM(ok) ok,
       SUM(status = 402) err402, SUM(input_tokens) in_tok, SUM(output_tokens) out_tok
FROM ai_calls GROUP BY day, phase ORDER BY day;
```

## Deployment

Docker: `docker-compose up -d --build` (web on `127.0.0.1:${WEB_PORT:-3010}`, worker + shared
`./data` volume). The production setup (Ubuntu 24.04 VPS behind nginx with webroot SSL) is
described in the [Russian README](./README.md#деплой-docker), including host-specific gotchas
(broken systemd nginx unit, `docker-compose` standalone, webroot certificates) and the
regression check for co-hosted sites: `node deploy/check-sites.mjs`.

## License

[MIT](./LICENSE) — see also the disclaimer in the [Russian README](./README.md#лицензия-и-дисклеймер):
signals are an experimental AI analysis, not investment advice.
