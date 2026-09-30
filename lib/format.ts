/** Locale-aware formatting helpers for prices, edge and dates. */

/** Formats a probability/price as a percentage: 0.173 -> "17.3%". */
export function pct(value: number, locale: string): string {
  return new Intl.NumberFormat(locale === 'ru' ? 'ru-RU' : 'en-US', {
    style: 'percent',
    maximumFractionDigits: 1,
    minimumFractionDigits: 0
  }).format(value);
}

/** Formats edge as a signed percentage: 0.126 -> "+12.6%". */
export function signedPct(value: number, locale: string): string {
  const formatted = pct(Math.abs(value), locale);
  return `${value >= 0 ? '+' : '−'}${formatted}`;
}

/** Formats big numbers: 1250000 -> "1.25M". */
export function compactNumber(value: number | null | undefined, locale: string): string | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  return new Intl.NumberFormat(locale === 'ru' ? 'ru-RU' : 'en-US', {
    notation: 'compact',
    maximumFractionDigits: 2
  }).format(value);
}

/** Formats an ISO date for humans: 2026-09-30T12:00:00Z -> "30 сент. 2026". */
export function formatDate(iso: string | null | undefined, locale: string): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat(locale === 'ru' ? 'ru-RU' : 'en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'UTC'
  }).format(date);
}

/** Just a date without time (for list cards). */
export function formatShortDate(iso: string | null | undefined, locale: string): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat(locale === 'ru' ? 'ru-RU' : 'en-US', {
    dateStyle: 'medium',
    timeZone: 'UTC'
  }).format(date);
}
