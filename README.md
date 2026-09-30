# PolySignals — каталог AI-анализов Polymarket

Минималистичный сайт-каталог торговых сигналов Polymarket: движок на TypeScript собирает события
через Gamma API, отправляет их в DeepSeek и сохраняет сигналы с edge (разница между прогнозом ИИ
и рыночной ценой). Сайт двухязычный (ru/en), мобильный и оптимизирован под Google и Яндекс.

Проект **полностью независим** от Telegram-бота в `C:\dev\poly` — свой код, своя база данных
(`data/poly_site.db`), никаких общих модулей или API.

## Стек

| Слой      | Технологии                                              |
|-----------|---------------------------------------------------------|
| Фронтенд  | Next.js 16 (App Router, SSR/ISR), React 19, Tailwind 4  |
| Языки     | next-intl: `/ru`, `/en`, hreflang + x-default           |
| Данные    | SQLite (`better-sqlite3`), WAL                          |
| Анализ    | Gamma API (публичный) + DeepSeek (JSON-mode)            |
| Воркер    | `node-cron` в отдельном процессе (`worker/index.ts`)    |
| Тесты     | Vitest                                                  |

## Возможности

- **Каталог сигналов** с сортировкой **по дате** и **по edge**, фильтром по категориям и пагинацией.
- **Страница сигнала**: детали рынка из Polymarket (цены, объём, ликвидность, дата окончания,
  ссылка на событие, картинка) + текст анализа ИИ на выбранном языке.
- **Изображения** берутся напрямую из Polymarket API (`image`/`icon`), отдаются через `next/image`.
- **Два языка**: ru (по умолчанию) и en — перевод анализа генерируется вместе с анализом
  (один запрос к DeepSeek возвращает `reasonRu` + `reasonEn`).
- **Качество каталога**: сигнальный движок отсеивает ультракороткие крипто-маркеты
  (теги `1M/5M/15M/30M/1H/Up or Down`, события короче `MIN_EVENT_DURATION_HOURS` и
  закрывающиеся раньше `MIN_HOURS_TO_END`), а отбор кандидатов диверсифицирует выдачу —
  не более `MAX_SIGNALS_PER_GROUP` сигналов на матч/тему и `MAX_SIGNALS_PER_CATEGORY` на категорию.
- **SEO**: SSR/ISR, canonical, hreflang, `sitemap.xml` (обновляется каждый час), `robots.txt`
  (для Google и Яндекса), JSON-LD (`WebSite`, `ItemList`, `Article`, `BreadcrumbList`),
  уникальные title/description, OG-теги, мета-верификация Яндекс.Вебмастера и Google Search Console.
- **Мобайл-френдли**: mobile-first разметка, тач-таргеты, оптимизированные изображения.
- **Свежие данные**: воркер раз в сутки генерирует новые сигналы и каждые 3 часа обновляет
  текущие цены и статусы (correct/incorrect) у завершённых рынков.

## Структура проекта

```
poly_site/
├── app/
│   ├── [locale]/                 # ru | en
│   │   ├── layout.tsx            # html/lang, метаданные, шапка/подвал
│   │   ├── page.tsx              # каталог (сортировка, категории, пагинация)
│   │   ├── not-found.tsx
│   │   └── signal/[slug]/page.tsx  # страница сигнала (ISR 5 мин)
│   ├── api/health/route.ts       # health-check
│   ├── api/run-analysis/route.ts # ручной запуск анализа (за токеном)
│   ├── sitemap.ts, robots.ts, icon.svg
│   └── globals.css               # Tailwind 4 + базовые стили
├── components/                   # SignalCard, LangSwitch, Breadcrumbs, ...
├── i18n/                         # routing / request / navigation (next-intl)
├── lib/
│   ├── config.ts                 # вся конфигурация из env
│   ├── db.ts                     # SQLite + миграции (user_version)
│   ├── repo.ts                   # запросы каталога (date/edge, категории, пагинация)
│   ├── polymarket.ts             # Gamma API: события, картинки, цены
│   ├── deepseek.ts               # DeepSeek JSON-mode + zod-валидация
│   ├── analyze.ts                # фильтры -> edge -> топ-N сигналов
│   ├── refresh.ts                # обновление цен/статусов из Polymarket
│   ├── seo.ts, format.ts, types.ts
├── worker/index.ts               # cron: анализ, обновление цен, catch-up
├── messages/{ru,en}.json         # переводы интерфейса
├── tests/                        # Vitest (50 тестов)
├── Dockerfile, docker-compose.yml
└── .env.example
```

## Быстрый старт

```bash
npm install
cp .env.example .env      # и заполните DEEPSEEK_API_KEY, SITE_URL
npm run dev               # http://localhost:3000 -> /ru
```

Первый сигнал появится после запуска анализатора:

```bash
npm run worker:once       # один прогон: анализ + обновление цен
npm run worker            # cron-режим: ежедневный анализ + обновление цен каждые 3 часа
```

Полезные команды:

```bash
npm test                  # unit-тесты (Vitest)
npm run build && npm start
npm run lint
curl localhost:3000/api/health
# ручной запуск анализа (если задан ANALYSIS_TOKEN):
curl -X POST -H "Authorization: Bearer <token>" localhost:3000/api/run-analysis
```

## Конфигурация

Все настройки — в `.env` (см. `.env.example`):

- `SITE_URL` — канонический домен (обязательно для SEO: canonical/hreflang/sitemap).
- `DEEPSEEK_API_KEY` — ключ модели анализа.
- `EVENTS_LIMIT` / `ANALYZE_LIMIT` — сколько событий забрать из Polymarket и сколько отправить модели.
- `MIN_LIQUIDITY`, `MIN_MARKET_PRICE`, `MIN_EDGE`, `TARGET_SIGNALS_COUNT` — пороги движка
  (дефолты совпадают с проверенными значениями бота).
- `MIN_HOURS_TO_END`, `MIN_EVENT_DURATION_HOURS`, `EXCLUDED_TAGS` — какие события публиковать
  (по умолчанию отсеиваются 1m–1h крипто-«монетки» и рынки, закрывающиеся в ближайшие 6 часов).
- `MAX_SIGNALS_PER_GROUP`, `MAX_SIGNALS_PER_CATEGORY` — диверсификация каталога.
- `ANALYSIS_CRON`, `PRICE_REFRESH_CRON` — расписание воркера (UTC).
- `YANDEX_VERIFICATION`, `GOOGLE_SITE_VERIFICATION` — мета-верификация поисковиков.

### Как строится сигнал

1. Забор активных событий Gamma API → фильтры (ликвидность, цена, длительность, теги).
2. Пачки по 3 события уходят в DeepSeek **без текущих цен** (иначе модель «прилипает»
   к ним и edge всегда ≈ 0). Модель оценивает честную вероятность каждого исхода.
3. `edge = прогноз − цена рынка`; отбираются сигналы с `edge ≥ MIN_EDGE`,
   лучший на событие, затем диверсифицированный топ по группам/категориям (≤ `TARGET_SIGNALS_COUNT`).
4. Если ответ модели обрезан/битый — пачка автоматически делится пополам и повторяется
   до одиночного события; JSON вычленяется из ответа с хвостовым текстом.
5. Сигнал сохраняется в `data/poly_site.db`, страница собирается из него же (ISR 5 минут).

## Деплой (Docker)

```bash
docker compose up -d --build
# web: Next.js на :3000, worker: cron-анализ; общая volume ./data с БД
```

Или без Docker: `npm run build` + процесс `npm start` и `npm run worker` под PM2/systemd.

## Данные и SEO-заметки

- База сайта — `data/poly_site.db` (в `.gitignore`). Миграции применяются автоматически.
- Страницы сигналов пререндерятся и обновляются раз в 5 минут (ISR); каталог рендерится на запрос.
- `robots.txt` содержит `Sitemap:` и `Host:` (для Яндекса), sitemap отдаёт hreflang для каждой страницы.
- Статистику точности модели (accuracy/ROI) и страницу `/stats` планируем во второй фазе.

## Лицензия и дисклеймер

Не является инвестиционной рекомендацией. Все сигналы — экспериментальный AI-анализ,
торговля на Polymarket связана с риском.
