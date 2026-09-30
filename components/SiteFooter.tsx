import {getTranslations} from 'next-intl/server';
import {countSignals} from '@/lib/repo';

type Props = {locale: string};


/** Minimal footer: data attribution + total signal counter. */
export default async function SiteFooter({locale}: Props) {
  const t = await getTranslations({locale, namespace: 'Footer'});
  const total = countSignals();

  return (
    <footer className="mt-12 border-t border-zinc-200 py-8 dark:border-zinc-800">
      <div className="container-page flex flex-col gap-2 text-sm text-zinc-500 sm:flex-row sm:items-center sm:justify-between">
        <p>
          {t('note')} · {t('rights', {year: new Date().getUTCFullYear()})}
        </p>
        <p aria-label="signals count">{total}</p>
      </div>
    </footer>
  );
}
