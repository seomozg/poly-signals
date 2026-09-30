import LangSwitch from './LangSwitch';
import {Link} from '@/i18n/navigation';

type Props = {
  locale: string;
  brand: string;
  brandSubtitle: string;
  catalogLabel: string;
  languageLabel: string;
};

/** Site header: brand, catalog link and the ru/en language switcher. */
export default function SiteHeader({locale, brand, brandSubtitle, catalogLabel, languageLabel}: Props) {
  return (
    <header className="sticky top-0 z-40 border-b border-zinc-200 bg-white/90 backdrop-blur dark:border-zinc-800 dark:bg-zinc-950/90">
      <div className="container-page flex h-14 items-center justify-between gap-4 sm:h-16">
        <Link href="/" className="flex items-baseline gap-2 font-semibold tracking-tight">
          <span className="text-base sm:text-lg">{brand}</span>
          <span className="hidden text-xs font-normal text-zinc-500 sm:inline">
            {brandSubtitle}
          </span>
        </Link>

        <div className="flex items-center gap-4">
          <Link
            href="/"
            className="text-sm text-zinc-600 transition-colors hover:text-zinc-900 dark:text-zinc-300 dark:hover:text-white"
          >
            {catalogLabel}
          </Link>
          <LangSwitch currentLocale={locale} label={languageLabel} />
        </div>
      </div>
    </header>
  );
}
