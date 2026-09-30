import {describe, expect, it} from 'vitest';
import {
  buildEventsQuery,
  normalizeEvent,
  normalizeMarket,
  outcomePrice,
  parseJsonArray,
  toNumber
} from '@/lib/polymarket';
import type {GammaEvent} from '@/lib/types';

const gammaEvent: GammaEvent = {
  id: '74788',
  slug: 'guinea-bissau-presidential-election',
  title: 'Guinea-Bissau Presidential Election',
  image: 'https://polymarket-upload.s3.us-east-2.amazonaws.com/flag.png',
  icon: 'https://polymarket-upload.s3.us-east-2.amazonaws.com/flag.png',
  endDate: '2026-11-01T00:00:00Z',
  volume: '12345.67',
  liquidity: '9876',
  volume24hr: 500,
  tags: [{label: 'Politics'}],
  markets: [
    {
      id: '508483',
      question: 'Will the incumbent win?',
      outcomes: '["Yes","No"]',
      outcomePrices: '["0.35","0.65"]',
      closed: false
    },
    {
      id: '508484',
      question: 'Closed market',
      outcomes: '["Yes","No"]',
      outcomePrices: '["1","0"]',
      closed: true
    }
  ]
};

describe('toNumber', () => {
  it('parses numbers and numeric strings', () => {
    expect(toNumber(12)).toBe(12);
    expect(toNumber('12.5')).toBe(12.5);
    expect(toNumber(null)).toBe(0);
    expect(toNumber('abc', -1)).toBe(-1);
  });
});

describe('parseJsonArray', () => {
  it('handles JSON-encoded strings, arrays and CSV fallbacks', () => {
    expect(parseJsonArray('["Yes","No"]')).toEqual(['Yes', 'No']);
    expect(parseJsonArray(['Yes', 'No'])).toEqual(['Yes', 'No']);
    expect(parseJsonArray('Yes, No')).toEqual(['Yes', 'No']);
    expect(parseJsonArray(undefined)).toEqual([]);
  });
});

describe('normalizeMarket / normalizeEvent', () => {
  it('parses outcomes and prices into arrays of numbers', () => {
    const market = normalizeMarket(gammaEvent.markets![0]);
    expect(market.outcomes).toEqual(['Yes', 'No']);
    expect(market.prices).toEqual([0.35, 0.65]);
  });

  it('keeps images, liquidity, volume and tags; drops closed markets', () => {
    const event = normalizeEvent(gammaEvent);
    expect(event.image).toContain('flag.png');
    expect(event.liquidity).toBe(9876);
    expect(event.volume).toBe(12345.67);
    expect(event.category).toBe('Politics');
    expect(event.markets).toHaveLength(1);
    expect(event.url).toBe('https://polymarket.com/event/guinea-bissau-presidential-election');
  });

  it('builds the polymarket url from the event slug', () => {
    expect(normalizeEvent(gammaEvent).slug).toBe('guinea-bissau-presidential-election');
  });
});

describe('buildEventsQuery', () => {
  const now = new Date('2026-09-30T00:00:00.000Z');

  it('shifts end_date_min by minHoursToEnd (skips ultra-short markets)', () => {
    const query = buildEventsQuery({minHoursToEnd: 6, maxDaysAhead: 30, limit: 40}, now);
    expect(query.get('end_date_min')).toBe('2026-09-30T06:00:00.000Z');
    expect(query.get('end_date_max')).toBe('2026-10-30T00:00:00.000Z');
    expect(query.get('limit')).toBe('40');
    expect(query.get('active')).toBe('true');
    expect(query.get('closed')).toBe('false');
    expect(query.get('order')).toBe('endDate');
    expect(query.get('ascending')).toBe('true');
  });

  it('defaults come from config without any arguments', () => {
    const query = buildEventsQuery({}, now);
    const min = Date.parse(query.get('end_date_min')!);
    const max = Date.parse(query.get('end_date_max')!);
    expect(min).toBeGreaterThan(now.getTime());
    expect(max).toBeGreaterThan(min);
  });
});

describe('outcomePrice', () => {
  it('returns the price of the requested outcome', () => {
    const event = normalizeEvent(gammaEvent);
    expect(outcomePrice(event, '508483', 'yes')).toBeCloseTo(0.35, 5);
    expect(outcomePrice(event, '508483', 'No')).toBeCloseTo(0.65, 5);
  });

  it('returns null for unknown markets or outcomes', () => {
    const event = normalizeEvent(gammaEvent);
    expect(outcomePrice(event, 'nope', 'Yes')).toBeNull();
    expect(outcomePrice(event, '508483', 'Maybe')).toBeNull();
  });
});
