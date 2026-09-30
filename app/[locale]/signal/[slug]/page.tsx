import type {Metadata} from 'next';
import Image from 'next/image';
import {notFound} from 'next/navigation';
import {getTranslations, setRequestLocale} from 'next-intl/server';
import {Link} from '@/i18n/navigation';
import Breadcrumbs from '@/components/Breadcrumbs';
import {compactNumber, formatDate, pct, signedPct} from '@/lib/format';
import {getBySlug, listSignals} from '@/lib/repo';
import {alternates, breadcrumbJsonLd, jsonLdScript, signalJsonLd} from '@/lib/seo';

type Props = {
  params: Promise<{locale: string; slug: string}>;
};

/** Pre-render existing signals at build time; new ones are rendered on demand (ISR). */
export function generateStaticParams() {
  const {items} = listSignals({sort: 'date', page: 1, pageSize: 200});
  return items.map((signal) => ({slug: signal.slug}));
}

export const revalidate = 300;

export async function generateMetadata({params}: Props): Promise<Metadata> {
  const {locale, slug} = await params;
  const signal = getBySlug(slug);
  if (!signal) return {};

  const t = await getTranslations({locale, namespace: 'Metadata'});
  const edge = signedPct(signal.edge, locale);
  const title = t('signalMetaTitle', {question: signal.question, edge});
  const description = t('signalMetaDescription', {
    question: signal.question,
    market: pct(signal.market_price, locale),
    predicted: pct(signal.predicted_price, locale),
    edge
  });

  return {
    title,
    description,
    alternates: alternates(locale as 'ru' | 'en', `/signal/${slug}`),
    openGraph: {
      title,
      description,
      type: 'article',
      locale: locale === 'ru' ? 'ru_RU' : 'en_US',
      images: signal.image ? [{url: signal.image}] : undefined
    },
    twitter: {card: 'summary_large_image'}
  };
}

export default async function SignalPage({params}: Props) {
  const {locale, slug} = await params;
  setRequestLocale(locale);

  const signal = getBySlug(slug);
  if (!signal) notFound();

  const t = await getTranslations({locale, namespace: 'Signal'});
  const isRu = locale === 'ru';
  const analysisText = isRu ? signal.reason_ru : signal.reason_en;
  const statusLabel =
    signal.status === 'correct'
      ? t('statusCorrect')
      : signal.status === 'incorrect'
        ? t('statusIncorrect')
        : t('statusPending');
  const statusClass =
    signal.status === 'correct'
      ? 'badge-correct'
      : signal.status === 'incorrect'
        ? 'badge-incorrect'
        : 'badge-pending';

  const breadcrumbs = [
    {name: t('breadcrumbHome'), path: `/${locale}`},
    {name: signal.question, path: `/signal/${signal.slug}`}
  ];

  const facts: Array<{label: string; value: string}> = [
    {label: t('question'), value: signal.question},
    {label: t('outcome'), value: signal.outcome},
    {label: t('marketPrice'), value: pct(signal.market_price, locale)},
    {label: t('predictedPrice'), value: pct(signal.predicted_price, locale)},
    {label: t('edge'), value: signedPct(signal.edge, locale)}
  ];
  if (signal.current_price !== null && signal.current_price !== undefined) {
    facts.push({label: t('currentPrice'), value: pct(signal.current_price, locale)});
  }
  const volume = compactNumber(signal.volume, locale);
  if (volume) facts.push({label: t('volume'), value: volume});
  const liquidity = compactNumber(signal.liquidity, locale);
  if (liquidity) facts.push({label: t('liquidity'), value: liquidity});
  if (signal.end_date) facts.push({label: t('endDate'), value: formatDate(signal.end_date, locale)!});
  if (signal.category) facts.push({label: t('category'), value: signal.category});
  facts.push({label: t('published'), value: formatDate(signal.created_at, locale)!});
  facts.push({label: t('updated'), value: formatDate(signal.updated_at, locale)!});

  return (
    <article className="space-y-8">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{__html: jsonLdScript(signalJsonLd(locale as 'ru' | 'en', signal))}}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{__html: jsonLdScript(breadcrumbJsonLd(breadcrumbs))}}
      />

      <Breadcrumbs items={[{label: t('breadcrumbHome'), href: '/'}, {label: signal.question}]} />

      <header className="flex flex-col gap-5 sm:flex-row sm:items-start">
        <div className="relative h-20 w-20 shrink-0 overflow-hidden rounded-xl bg-zinc-100 sm:h-24 sm:w-24 dark:bg-zinc-800">
          {signal.image ? (
            <Image
              src={signal.image}
              alt={signal.title}
              fill
              sizes="96px"
              className="object-cover"
              priority
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center text-2xl font-semibold text-zinc-400">
              {signal.title.slice(0, 1).toUpperCase()}
            </div>
          )}
        </div>

        <div className="min-w-0 flex-1">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <span className="badge badge-positive">{signedPct(signal.edge, locale)}</span>
            <span className={`badge ${statusClass}`}>{statusLabel}</span>
            <span className="badge badge-pending">
              {signal.recommendation === 'BUY' ? t('buy') : t('noAction')}
            </span>
          </div>
          <h1 className="text-xl font-semibold leading-snug tracking-tight sm:text-2xl">
            {signal.question}
          </h1>
          <p className="mt-1 text-sm text-zinc-500">{signal.title}</p>
        </div>
      </header>

      <div className="grid gap-8 lg:grid-cols-[1fr_360px]">
        <section aria-labelledby="analysis-title">
          <h2 id="analysis-title" className="mb-3 text-lg font-medium">
            {t('analysisTitle')}
          </h2>
          <div className="analysis-text text-sm text-zinc-700 sm:text-base dark:text-zinc-300">
            {analysisText.split(/\n+/).map((paragraph, index) => (
              <p key={index}>{paragraph}</p>
            ))}
          </div>
          <p className="mt-6 text-xs text-zinc-400">{t('disclaimer')}</p>
        </section>

        <aside aria-labelledby="details-title">
          <h2 id="details-title" className="mb-3 text-lg font-medium">
            {t('detailsTitle')}
          </h2>
          <dl className="card divide-y divide-zinc-200 text-sm dark:divide-zinc-800">
            {facts.map((fact) => (
              <div key={fact.label} className="flex items-start justify-between gap-4 px-4 py-3">
                <dt className="text-zinc-500">{fact.label}</dt>
                <dd className="text-right font-medium tabular-nums">{fact.value}</dd>
              </div>
            ))}
          </dl>

          {signal.polymarket_url && (
            <a
              href={signal.polymarket_url}
              target="_blank"
              rel="noopener noreferrer nofollow"
              className="mt-4 inline-flex w-full items-center justify-center rounded-lg border border-zinc-300 px-4 py-2.5 text-sm font-medium transition-colors hover:border-zinc-900 dark:border-zinc-700 dark:hover:border-zinc-100"
            >
              {t('openOnPolymarket')} ↗
            </a>
          )}

          <Link
            href="/"
            className="mt-3 inline-flex w-full items-center justify-center px-4 py-2 text-sm text-zinc-500 transition-colors hover:text-zinc-900 dark:hover:text-white"
          >
            ← {t('backToCatalog')}
          </Link>
        </aside>
      </div>
    </article>
  );
}
