import {defineRouting} from 'next-intl/routing';

/**
 * Supported locales and routing preferences for the catalog site.
 * `ru` is the default language (primary audience), `en` is the international one.
 */
export const routing = defineRouting({
  locales: ['ru', 'en'],
  defaultLocale: 'ru',
  localePrefix: 'always'
});

export type Locale = (typeof routing.locales)[number];
