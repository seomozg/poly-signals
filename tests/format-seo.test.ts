import {describe, expect, it} from 'vitest';
import {compactNumber, formatShortDate, pct, signedPct} from '@/lib/format';
import {alternates, localeUrl} from '@/lib/seo';

describe('format helpers', () => {
  it('formats percentages for both locales', () => {
    expect(pct(0.173, 'en')).toMatch(/17(\.3)?%/);
    expect(pct(0.173, 'ru')).toMatch(/17/);
  });

  it('signs the edge', () => {
    expect(signedPct(0.126, 'en').startsWith('+')).toBe(true);
    expect(signedPct(-0.05, 'en').startsWith('−')).toBe(true);
  });

  it('compacts big numbers', () => {
    expect(compactNumber(1_250_000, 'en')).toMatch(/1\.25M/);
    expect(compactNumber(null, 'en')).toBeNull();
  });

  it('formats ISO dates', () => {
    expect(formatShortDate('2026-09-30T12:00:00Z', 'en')).toBeTruthy();
    expect(formatShortDate('not-a-date', 'en')).toBeNull();
    expect(formatShortDate(null, 'en')).toBeNull();
  });
});

describe('seo helpers', () => {
  it('builds absolute locale urls', () => {
    expect(localeUrl('en', '/signal/x')).toMatch(/^https?:\/\/.+\/en\/signal\/x$/);
    expect(localeUrl('ru', '/')).toMatch(/^https?:\/\/[^/]+\/ru$/);
  });

  it('exposes canonical + hreflang alternates incl. x-default', () => {
    const alt = alternates('en', '/signal/x');
    expect(alt.canonical).toContain('/en/signal/x');
    expect(Object.keys(alt.languages)).toEqual(expect.arrayContaining(['ru', 'en', 'x-default']));
    expect(alt.languages.ru).toContain('/ru/signal/x');
  });
});
