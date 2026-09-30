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
├── tests/                        # Vitest (71 тест)
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
npm run worker:once       # дневной прогон вручную: +DAILY_NEW_SIGNALS сигналов и обновление цен
npm run worker            # cron-режим: каждый день +20 сигналов, цены каждые 3 часа
npm run worker:collect    # одноразово вырастить каталог до COLLECT_TARGET сигналов (200)
```

### Ежедневное пополнение (`DAILY_NEW_SIGNALS=20`)

Дневной cron (`ANALYSIS_CRON`, по умолчанию 00:00 UTC) добавляет ровно **20 новых сигналов**:

1. Цель считается как `текущее число + 20` — работа прекращается сразу после достижения квоты.
2. Анализируются **только ранее необработанные события** (`analyzed_events`), поэтому токены
   не тратятся повторно; обход 5 «окон» Gamma API гарантирует достаток свежих событий.
3. Диверсификация: группа (матч/тема) ≤ `MAX_SIGNALS_PER_GROUP`, категория ≤ `ceil(target/5)`,
   а за один прогон в одну категорию может попасть не более `ceil(20/4) = 5` сигналов —
   день никогда не состоит из одной темы.
4. Новые сигналы сразу получают развёрнутый текст (фаза 2, параллельно).
5. Прогон идёт и при старте, если последний был больше `ANALYSIS_MAX_AGE_HOURS` назад
   (перезапуск сервера не теряет день); `POST /api/run-analysis` запускает ту же квоту вручную.
6. Если квота не набрана (исчерпан пул событий), в лог пишется предупреждение
   `quota not met (N/20)` — сигнал к тому, что нужно ослабить пороги или расширить окна.

### Режим сбора (`worker:collect`)

Используется, чтобы быстро наполнить каталог (например, до 200 сигналов):

1. Обходит **5 «окон» Gamma API** (разные сортировки: `endDate` asc/desc, `volume` asc/desc) —
   так покрывается 2000+ подходящих событий, а не одна страница из 600.
2. Событие анализируется **один раз** (`analyzed_events`), повторные запуски почти бесплатны.
3. Пачки по 3 события идут в DeepSeek **параллельно** (`COLLECT_CONCURRENCY`), после каждой
   группы пачек сильнейшие кандидаты сохраняются с учётом уже накопленных лимитов
   (`MAX_SIGNALS_PER_GROUP`, категория ≤ `ceil(target/5)`), пока не наберётся `COLLECT_TARGET`.
4. Финальный проход дописывает развёрнутый текст всем сигналам, у которых он ещё краткий.

Отладка: `COLLECT_TARGET=50 COLLECT_CONCURRENCY=2 npm run worker:collect`.
Код выхода 0 — цель достигнута, 2 — не хватило сигналов (нужно расширить окна/пороги).

Полезные команды:

```bash
npm test                  # unit-тесты (Vitest)
npm run worker:enrich     # перегенерировать развёрнутый анализ у старых сигналов
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
- `YANDEX_METRIKA_ID` — счётчик Яндекс.Метрики; сниппет рендерится первым элементом `<body>`
  на всех страницах (пустое значение — счётчик отключается). На 404-страницах Next не
  рендерит тело layout в HTML, поэтому компонент дополнительно инициализирует счётчик
  на клиенте (guard по `window.ym` исключает двойной вызов на обычных страницах).

### Как строится сигнал

1. Забор активных событий Gamma API → фильтры (ликвидность, цена, длительность, теги).
2. **Этап 1 (пакетный):** пачки по 3 события уходят в DeepSeek **без текущих цен**
   (иначе модель «прилипает» к ним и edge всегда ≈ 0). Модель оценивает честную вероятность
   каждого исхода и даёт краткое обоснование (фолбэк).
3. `edge = прогноз − цена рынка`; отбираются сигналы с `edge ≥ MIN_EDGE`,
   лучший на событие, затем диверсифицированный топ по группам/категориям (≤ `TARGET_SIGNALS_COUNT`).
4. **Этап 2 (публикуемый текст):** только для отобранных сигналов (≤ 8) второй запрос генерирует
   развёрнутый анализ на 150–220 слов на каждом языке — с ценой, прогнозом и edge в промпте.
   Длинный ответ не входит в пакетный бюджет токенов, поэтому не обрезается; при сбое остаётся
   краткое обоснование этапа 1. `npm run worker:enrich` дописывает развёрнутый текст
   у уже сохранённых сигналов.
5. Если ответ модели обрезан/битый — пачка автоматически делится пополам и повторяется
   до одиночного события; JSON вычленяется из ответа с хвостовым текстом.
6. Сигнал сохраняется в `data/poly_site.db`, страница собирается из него же (ISR 5 минут).

## Деплой (Docker)

Локально/стейджинг:

```bash
docker compose up -d --build
# web: Next.js на 127.0.0.1:${WEB_PORT:-3010}→3000, worker: cron-анализ; общая volume ./data с БД
```

Или без Docker: `npm run build` + процесс `npm start` и `npm run worker` под PM2/systemd.

### Продакшен: poly-signals.ru (Ubuntu 24.04, VPS)

Конфиги в `deploy/`; приложение живёт в `/opt/poly-signals`, контейнеры
`poly-signals-web-1` (127.0.0.1:3010) и `poly-signals-worker-1`, за nginx.

**Особенности хостинга, которые нельзя игнорировать:**

1. **systemd-юнит nginx в состоянии `failed`** (мастер запущен вручную, PID см.
   `ps -eo pid,args | grep 'nginx: master'` — нужен тот, что с `-c /etc/nginx/nginx.conf`).
   Запрещено `systemctl restart/reload nginx` — он уронит все сайты. Правильно:
   ```bash
   nginx -t && kill -HUP <pid_мастера>
   ```
2. **Плагина `docker compose` нет** — только standalone `docker-compose`.
3. **Сертификаты — только webroot**: `certbot --nginx` пытается перезапустить nginx
   и падает. Рабочая схема: ACME-локация в вирталке (уже есть) + корень
   `/var/www/letsencrypt-webroot`:
   ```bash
   certbot certonly --webroot -w /var/www/letsencrypt-webroot \
     -d poly-signals.ru -d www.poly-signals.ru --non-interactive --agree-tos
   ```
4. **`SITE_URL` передаётся в сборку** (build arg) — без него в пререндеренном HTML
   останется localhost; `sitemap.ts` намеренно `force-dynamic`, т.к. на этапе
   сборки образа нет тома с БД.

Обновление:

```bash
# локально: упаковать исходники (без node_modules/.next/.git/data)
tar -czf poly-site.tar.gz --exclude=./node_modules --exclude=./.next \
  --exclude=./.git --exclude=./data --exclude='./*.log' .
scp -i <key> poly-site.tar.gz root@85.198.67.207:/root/
ssh -i <key> root@85.198.67.207 "tar -xzf /root/poly-site.tar.gz -C /opt/poly-signals \
  && cd /opt/poly-signals && docker-compose build && docker-compose up -d"
```

Проверки после деплоя: `curl -s https://poly-signals.ru/api/health`,
`docker-compose ps`, `docker logs poly-signals-worker-1`, `nginx -t`,
и пройтись по чужим доменам (см. `deploy/check-sites.mjs`).

## Данные и SEO-заметки

- База сайта — `data/poly_site.db` (в `.gitignore`). Миграции применяются автоматически.
- Страницы сигналов пререндерятся и обновляются раз в 5 минут (ISR); каталог рендерится на запрос.
- `robots.txt` содержит `Sitemap:` и `Host:` (для Яндекса), sitemap отдаёт hreflang для каждой страницы.
- Статистику точности модели (accuracy/ROI) и страницу `/stats` планируем во второй фазе.

## Лицензия и дисклеймер

Не является инвестиционной рекомендацией. Все сигналы — экспериментальный AI-анализ,
торговля на Polymarket связана с риском.
