import {Link} from '@/i18n/navigation';

type Item = {label: string; href?: string};

/** Server-rendered breadcrumb trail with BreadcrumbList JSON-LD on the page. */
export default function Breadcrumbs({items}: {items: Item[]}) {
  return (
    <nav aria-label="Breadcrumb">
      <ol className="flex flex-wrap items-center gap-2 text-sm text-zinc-500">
        {items.map((item, index) => {
          const last = index === items.length - 1;
          return (
            <li key={`${item.label}-${index}`} className="flex items-center gap-2">
              {index > 0 && <span aria-hidden="true">/</span>}
              {item.href && !last ? (
                <Link href={item.href} className="transition-colors hover:text-zinc-900 dark:hover:text-white">
                  {item.label}
                </Link>
              ) : (
                <span aria-current={last ? 'page' : undefined} className="truncate max-w-[60vw] sm:max-w-md">
                  {item.label}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
