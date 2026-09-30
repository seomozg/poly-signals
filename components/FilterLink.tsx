import {Link} from '@/i18n/navigation';

type Props = {
  href: string;
  children: React.ReactNode;
  active?: boolean;
  disabled?: boolean;
  ariaLabel?: string;
};

/** URL-bearing pill used for sorting and category filters (no client JS needed). */
export default function FilterLink({href, children, active, disabled, ariaLabel}: Props) {
  if (disabled) {
    return (
      <span
        aria-disabled="true"
        className="cursor-not-allowed rounded-full border border-zinc-200 px-3 py-1 text-sm text-zinc-300 dark:border-zinc-800 dark:text-zinc-600"
      >
        {children}
      </span>
    );
  }

  return (
    <Link
      href={href}
      aria-label={ariaLabel}
      aria-current={active ? 'true' : undefined}
      className={
        active
          ? 'chip chip-active'
          : 'chip'
      }
    >
      {children}
    </Link>
  );
}
