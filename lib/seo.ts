/**
 * SEO helpers: canonical URLs, hreflang alternates and JSON-LD blocks.
 * Everything is built from `SITE_URL` so Google and Yandex always see
 * absolute, consistent URLs.
 */
import type {Signal} from './types';
import {config} from './config';

type Locale = (typeof config.locales)[number];

/** Absolute URL for a locale-specific path, e.g. /signal/foo -> https://x.com/en/signal/foo */
export function localeUrl(locale: Locale, path: string): string {
  const normalized = path.startsWith('/') ? path : `/${path}`;
  return `${config.siteUrl}/${locale}${normalized === '/' ? '' : normalized}`;
}

/** hreflang alternates + canonical for a page rendered in `locale`. */
export function alternates(locale: Locale, path: string) {
  const languages: Record<string, string> = {
    ru: localeUrl('ru', path),
    en: localeUrl('en', path),
    'x-default': localeUrl(config.defaultLocale, path)
  };
  return {canonical: localeUrl(locale, path), languages};
}

/** Breadcrumb JSON-LD. `items` are ordered from top to leaf. */
export function breadcrumbJsonLd(
  items: Array<{name: string; path: string}>
): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map((item, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name: item.name,
      item: item.path.startsWith('http') ? item.path : `${config.siteUrl}${item.path}`
    }))
  };
}

/** Catalog page JSON-LD: WebSite + ItemList of the strongest signals. */
export function catalogJsonLd(locale: Locale, signals: Signal[]): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    name: 'PolySignals',
    url: config.siteUrl,
    inLanguage: locale,
    potentialAction: {
      '@type': 'SearchAction',
      target: {
        '@type': 'EntryPoint',
        urlTemplate: `${config.siteUrl}/${locale}?q={search_term_string}`
      },
      'query-input': 'required name=search_term_string'
    },
    mainEntity: {
      '@type': 'ItemList',
      numberOfItems: signals.length,
      itemListElement: signals.map((signal, index) => ({
        '@type': 'ListItem',
        position: index + 1,
        name: signal.question,
        url: localeUrl(locale, `/signal/${signal.slug}`)
      }))
    }
  };
}

/** Signal page JSON-LD: the analysis article + its market facts. */
export function signalJsonLd(locale: Locale, signal: Signal): Record<string, unknown> {
  const url = localeUrl(locale, `/signal/${signal.slug}`);
  return {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: signal.question,
    description:
      locale === 'ru'
        ? `AI-анализ рынка Polymarket: цена ${signal.market_price}, прогноз ${signal.predicted_price}, edge ${signal.edge}.`
        : `Polymarket AI analysis: market price ${signal.market_price}, prediction ${signal.predicted_price}, edge ${signal.edge}.`,
    datePublished: signal.created_at,
    dateModified: signal.updated_at,
    inLanguage: locale,
    url,
    image: signal.image ?? undefined,
    mainEntityOfPage: url,
    publisher: {'@type': 'Organization', name: 'PolySignals'},
    about: {
      '@type': 'Question',
      name: signal.question,
      answerCount: 1,
      acceptedAnswer: {
        '@type': 'Answer',
        text: `${signal.outcome} (${Math.round(signal.predicted_price * 100)}%)`
      }
    }
  };
}

/** Injects a JSON-LD script safely (escapes `</script>` sequences). */
export function jsonLdScript(data: unknown): string {
  return JSON.stringify(data).replace(/</g, '\\u003c');
}
