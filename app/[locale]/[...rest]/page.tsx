import {notFound} from 'next/navigation';

/**
 * Catch-all for unknown routes inside /[locale]/ (the official next-intl
 * pattern): without it Next serves its built-in 404 document, which skips our
 * layout — no header, no Yandex.Metrika counter.
 */
export default function CatchAllPage() {
  notFound();
}
