'use client';

import {useTranslations} from 'next-intl';
import {Link} from '@/i18n/navigation';

/** Rendered by notFound() inside the [locale] segment. */
export default function NotFound() {
  const t = useTranslations('NotFound');

  return (
    <div className="mx-auto max-w-lg py-16 text-center">
      <p className="text-sm uppercase tracking-widest text-zinc-400">404</p>
      <h1 className="mt-3 text-2xl font-semibold tracking-tight">{t('title')}</h1>
      <p className="mt-3 text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">{t('text')}</p>
      <Link
        href="/"
        className="mt-8 inline-flex rounded-lg bg-zinc-900 px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
      >
        {t('link')}
      </Link>
    </div>
  );
}
