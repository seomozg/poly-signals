import type {MetadataRoute} from 'next';
import {config} from '@/lib/config';
import {localeUrl} from '@/lib/seo';
import {listSignals} from '@/lib/repo';

// Signals are added daily — refresh the sitemap hourly so new pages are
// discovered by Google/Yandex without a redeploy.
export const revalidate = 3600;

/**
 * Sitemap for Google and Yandex: catalog pages for both locales plus every
 * signal page with lastmod so crawlers re-index fresh analyses quickly.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date();
  const languages = {
    ru: localeUrl('ru', '/'),
    en: localeUrl('en', '/'),
    'x-default': localeUrl(config.defaultLocale, '/')
  };

  const entries: MetadataRoute.Sitemap = config.locales.map((locale) => ({
    url: localeUrl(locale, '/'),
    lastModified: now,
    changeFrequency: 'daily',
    priority: 1,
    alternates: {languages}
  }));

  const {items} = listSignals({sort: 'date', page: 1, pageSize: 1000});
  for (const signal of items) {
    const path = `/signal/${signal.slug}`;
    entries.push({
      url: localeUrl('ru', path),
      lastModified: new Date(signal.updated_at),
      changeFrequency: 'weekly',
      priority: 0.8,
      alternates: {
        languages: {
          ru: localeUrl('ru', path),
          en: localeUrl('en', path),
          'x-default': localeUrl(config.defaultLocale, path)
        }
      }
    });
    entries.push({
      url: localeUrl('en', path),
      lastModified: new Date(signal.updated_at),
      changeFrequency: 'weekly',
      priority: 0.8,
      alternates: {
        languages: {
          ru: localeUrl('ru', path),
          en: localeUrl('en', path),
          'x-default': localeUrl(config.defaultLocale, path)
        }
      }
    });
  }

  return entries;
}
