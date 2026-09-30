import type {Metadata} from 'next';
import {getTranslations, setRequestLocale} from 'next-intl/server';
import FilterLink from '@/components/FilterLink';
import SignalCard from '@/components/SignalCard';
import {listCategories, listSignals} from '@/lib/repo';
import {alternates, catalogJsonLd, jsonLdScript} from '@/lib/seo';
import type {SortKey} from '@/lib/types';

type Props = {
  params: Promise<{locale: string}>;
  searchParams: Promise<{sort?: string; page?: string; category?: string}>;
};

/** Builds a catalog URL preserving the other active query parameters. */
function catalogHref(params: {sort?: SortKey; page?: number; category?: string}): string {
  const query = new URLSearchParams();
  if (params.sort && params.sort !== 'date') query.set('sort', params.sort);
  if (params.category) query.set('category', params.category);
  if (params.page && params.page > 1) query.set('page', String(params.page));
  const qs = query.toString();
  return qs ? `/?${qs}` : '/';
}

export async function generateMetadata({params}: Props): Promise<Metadata> {
  const {locale} = await params;
  const t = await getTranslations({locale, namespace: 'Metadata'});
  return {
    title: t('catalogTitle'),
    description: t('catalogDescription'),
    alternates: alternates(locale as 'ru' | 'en', '/')
  };
}

export default async function CatalogPage({params, searchParams}: Props) {
  const {locale} = await params;
  const query = await searchParams;
  setRequestLocale(locale);

  const t = await getTranslations({locale, namespace: 'Catalog'});
  const cardLabels = await getTranslations({locale, namespace: 'Catalog'});

  const sort: SortKey = query.sort === 'edge' ? 'edge' : 'date';
  const category = query.category?.trim() || undefined;
  const page = Math.max(1, Number(query.page) || 1);

  const {items, total, totalPages} = listSignals({sort, page, category});
  // Top categories only: with 40+ tags the chip row would overwhelm a minimal layout.
  const categories = listCategories(12);

  const labels = {
    marketPrice: cardLabels('marketPrice'),
    predictedPrice: cardLabels('predictedPrice'),
    edgeLabel: cardLabels('edgeLabel'),
    pending: cardLabels('pending'),
    correct: cardLabels('correct'),
    incorrect: cardLabels('incorrect')
  };

  return (
    <div className="space-y-8">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{__html: jsonLdScript(catalogJsonLd(locale as 'ru' | 'en', items))}}
      />

      <section className="max-w-3xl">
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{t('h1')}</h1>
        <p className="mt-3 text-sm leading-relaxed text-zinc-600 dark:text-zinc-400 sm:text-base">
          {t('lead')}
        </p>
      </section>

      <section className="flex flex-col gap-4" aria-label={t('sortLabel')}>
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-sm text-zinc-500">{t('sortLabel')}</span>
          <FilterLink href={catalogHref({sort: 'date', category})} active={sort === 'date'}>
            {t('sortDate')}
          </FilterLink>
          <FilterLink href={catalogHref({sort: 'edge', category})} active={sort === 'edge'}>
            {t('sortEdge')}
          </FilterLink>
          <span className="ml-auto text-sm tabular-nums text-zinc-500">
            {t('resultsCount', {count: total})}
          </span>
        </div>

        {categories.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm text-zinc-500">{t('categoriesLabel')}</span>
            <FilterLink href={catalogHref({sort})} active={!category}>
              {t('categoryAll')}
            </FilterLink>
            {categories.map((cat) => (
              <FilterLink
                key={cat}
                href={catalogHref({sort, category: cat})}
                active={category === cat}
              >
                {cat}
              </FilterLink>
            ))}
          </div>
        )}
      </section>

      {items.length === 0 ? (
        <p className="rounded-xl border border-dashed border-zinc-300 p-8 text-center text-sm text-zinc-500 dark:border-zinc-700">
          {t('empty')}
        </p>
      ) : (
        <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {items.map((signal) => (
            <li key={signal.id} className="flex">
              <SignalCard signal={signal} locale={locale} labels={labels} />
            </li>
          ))}
        </ul>
      )}

      {totalPages > 1 && (
        <nav className="flex items-center justify-between gap-4" aria-label={t('pagination', {page, total: totalPages})}>
          <FilterLink
            href={catalogHref({sort, category, page: Math.max(1, page - 1)})}
            disabled={page <= 1}
          >
            ← {t('prev')}
          </FilterLink>
          <span className="text-sm tabular-nums text-zinc-500">
            {t('pagination', {page, total: totalPages})}
          </span>
          <FilterLink
            href={catalogHref({sort, category, page: Math.min(totalPages, page + 1)})}
            disabled={page >= totalPages}
          >
            {t('next')} →
          </FilterLink>
        </nav>
      )}
    </div>
  );
}
