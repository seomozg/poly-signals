import Image from 'next/image';
import {Link} from '@/i18n/navigation';
import {formatShortDate, pct, signedPct} from '@/lib/format';
import type {Signal} from '@/lib/types';

type Props = {
  signal: Signal;
  locale: string;
  labels: {
    marketPrice: string;
    predictedPrice: string;
    edgeLabel: string;
    pending: string;
    correct: string;
    incorrect: string;
  };
};

const STATUS_CLASS: Record<Signal['status'], string> = {
  pending: 'badge-pending',
  correct: 'badge-correct',
  incorrect: 'badge-incorrect'
};

/** One catalog entry: artwork, question, AI-vs-market prices and edge. */
export default function SignalCard({signal, locale, labels}: Props) {
  const statusLabel =
    signal.status === 'correct'
      ? labels.correct
      : signal.status === 'incorrect'
        ? labels.incorrect
        : labels.pending;

  return (
    <article className="card flex h-full flex-col overflow-hidden">
      <Link
        href={`/signal/${signal.slug}`}
        className="flex flex-1 items-start gap-4 p-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-400"
      >
        <div className="relative h-16 w-16 shrink-0 overflow-hidden rounded-lg bg-zinc-100 dark:bg-zinc-800">
          {signal.image ? (
            <Image
              src={signal.image}
              alt={signal.title}
              fill
              sizes="64px"
              className="object-cover"
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center text-lg font-semibold text-zinc-400">
              {signal.title.slice(0, 1).toUpperCase()}
            </div>
          )}
        </div>

        <div className="min-w-0 flex-1">
          <div className="mb-1 flex items-center gap-2">
            <span className="badge badge-positive" title={labels.edgeLabel}>
              {signedPct(signal.edge, locale)}
            </span>
            <span className={`badge ${STATUS_CLASS[signal.status]}`}>{statusLabel}</span>
          </div>
          <h2 className="line-clamp-2 text-sm font-medium leading-snug sm:text-base">
            {signal.question}
          </h2>
          {signal.category && (
            <p className="mt-1 text-xs text-zinc-500">{signal.category}</p>
          )}
        </div>
      </Link>

      <dl className="grid grid-cols-3 divide-x divide-zinc-200 border-t border-zinc-200 text-center text-xs dark:divide-zinc-800 dark:border-zinc-800">
        <div className="px-2 py-3">
          <dt className="text-zinc-500">{labels.marketPrice}</dt>
          <dd className="mt-1 font-medium tabular-nums">{pct(signal.market_price, locale)}</dd>
        </div>
        <div className="px-2 py-3">
          <dt className="text-zinc-500">{labels.predictedPrice}</dt>
          <dd className="mt-1 font-medium tabular-nums">{pct(signal.predicted_price, locale)}</dd>
        </div>
        <div className="px-2 py-3">
          <dt className="text-zinc-500">{labels.edgeLabel}</dt>
          <dd className="mt-1 font-medium tabular-nums text-emerald-600 dark:text-emerald-400">
            {signedPct(signal.edge, locale)}
          </dd>
        </div>
      </dl>

      <time
        dateTime={signal.created_at}
        className="border-t border-zinc-200 px-4 py-2 text-xs text-zinc-500 dark:border-zinc-800"
      >
        {formatShortDate(signal.created_at, locale)}
      </time>
    </article>
  );
}
