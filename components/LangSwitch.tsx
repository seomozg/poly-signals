'use client';

import {usePathname, useRouter} from '@/i18n/navigation';
import {routing} from '@/i18n/routing';

type Props = {
  currentLocale: string;
  label: string;
};

/**
 * ru/en switcher. Keeps the current path and query string (read from
 * `window.location` on click, so no Suspense boundary is required),
 * only the locale segment changes (/ru/signal/x -> /en/signal/x).
 */
export default function LangSwitch({currentLocale, label}: Props) {
  const router = useRouter();
  const pathname = usePathname();

  const switchTo = (locale: string) => {
    const query = window.location.search;
    router.replace(`${pathname}${query}`, {locale});
  };

  return (
    <div
      className="flex items-center rounded-lg border border-zinc-200 p-0.5 dark:border-zinc-700"
      role="group"
      aria-label={label}
    >
      {routing.locales.map((locale) => (
        <button
          key={locale}
          type="button"
          onClick={() => switchTo(locale)}
          aria-pressed={locale === currentLocale}
          className={
            locale === currentLocale
              ? 'rounded-md bg-zinc-900 px-2.5 py-1 text-xs font-medium text-white dark:bg-zinc-100 dark:text-zinc-900'
              : 'rounded-md px-2.5 py-1 text-xs font-medium text-zinc-500 transition-colors hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-white'
          }
        >
          {locale.toUpperCase()}
        </button>
      ))}
    </div>
  );
}
