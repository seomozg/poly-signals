import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {closeDb} from '@/lib/db';
import {
  applyMarketUpdate,
  buildSlug,
  countSignals,
  getBySlug,
  listCategories,
  listSignals,
  upsertSignal
} from '@/lib/repo';
import type {SignalCandidate} from '@/lib/types';

let tmpDir: string;

function candidate(overrides: Partial<SignalCandidate> = {}): SignalCandidate {
  return {
    eventId: 'event-1',
    eventSlug: 'will-it-rain',
    marketId: 'm-1',
    title: 'Will it rain tomorrow?',
    question: 'Will it rain tomorrow?',
    outcome: 'Yes',
    marketPrice: 0.4,
    predictedPrice: 0.55,
    edge: 0.15,
    recommendation: 'BUY',
    reasonRu: 'Причины на русском.',
    reasonEn: 'Reasons in English.',
    image: 'https://example.com/img.png',
    volume: 1200,
    liquidity: 500,
    category: 'Weather',
    tags: ['weather'],
    url: 'https://polymarket.com/event/will-it-rain',
    ...overrides
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'poly-site-test-'));
  process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');
  closeDb(); // force a fresh connection with the temp path
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpDir, {recursive: true, force: true});
});

describe('buildSlug', () => {
  it('creates a url-safe slug from the event slug and market id', () => {
    expect(buildSlug('Will it RAIN?', '42')).toBe('will-it-rain-42');
    expect(buildSlug('  --Weird--  ', '7')).toBe('weird-7');
  });

  it('falls back to "event" when the slug is empty', () => {
    expect(buildSlug('!!!', '9')).toBe('event-9');
  });
});

describe('upsertSignal', () => {
  it('inserts a signal and reads it back by slug', () => {
    const signal = upsertSignal(candidate());
    expect(signal.slug).toBe('will-it-rain-m-1');
    expect(signal.edge).toBeCloseTo(0.15, 5);
    expect(signal.status).toBe('pending');
    expect(getBySlug('will-it-rain-m-1')).not.toBeNull();
    expect(countSignals()).toBe(1);
  });

  it('updates the same (event, market) instead of duplicating it', () => {
    upsertSignal(candidate());
    upsertSignal(candidate({edge: 0.3, predictedPrice: 0.7, reasonEn: 'Updated'}));

    expect(countSignals()).toBe(1);
    const stored = getBySlug('will-it-rain-m-1')!;
    expect(stored.edge).toBeCloseTo(0.3, 5);
    expect(stored.reason_en).toBe('Updated');
    // created_at must stay stable, updated_at moves forward
    expect(stored.updated_at >= stored.created_at).toBe(true);
  });
});

describe('listSignals', () => {
  beforeEach(() => {
    upsertSignal(
      candidate({eventId: 'e1', eventSlug: 'alpha', marketId: 'm1', edge: 0.05})
    );
    upsertSignal(
      candidate({
        eventId: 'e2',
        eventSlug: 'beta',
        marketId: 'm2',
        edge: 0.4,
        category: 'Politics'
      })
    );
    upsertSignal(
      candidate({eventId: 'e3', eventSlug: 'gamma', marketId: 'm3', edge: 0.2})
    );
  });

  it('sorts by edge descending', () => {
    const {items} = listSignals({sort: 'edge'});
    expect(items.map((i) => i.edge)).toEqual([0.4, 0.2, 0.05]);
  });

  it('sorts by date descending (newest first)', () => {
    const {items} = listSignals({sort: 'date'});
    // all created in the same ms window: stable secondary order by edge
    expect(items).toHaveLength(3);
    expect(items[0].created_at >= items[2].created_at).toBe(true);
  });

  it('paginates', () => {
    const page1 = listSignals({sort: 'edge', page: 1, pageSize: 2});
    expect(page1.items).toHaveLength(2);
    expect(page1.totalPages).toBe(2);
    expect(page1.total).toBe(3);

    const page2 = listSignals({sort: 'edge', page: 2, pageSize: 2});
    expect(page2.items).toHaveLength(1);
    expect(page2.items[0].edge).toBeCloseTo(0.05, 5);
  });

  it('filters by category', () => {
    const {items, total} = listSignals({category: 'Politics'});
    expect(total).toBe(1);
    expect(items[0].event_slug).toBe('beta');
  });

  it('lists distinct categories', () => {
    expect(listCategories()).toEqual(['Politics', 'Weather']);
  });
});

describe('applyMarketUpdate', () => {
  it('updates current price and resolves status from final prices', () => {
    upsertSignal(candidate());

    applyMarketUpdate('event-1', {
      prices: new Map([['m-1|Yes', 0.62]]),
      volume: 4200
    });
    let signal = getBySlug('will-it-rain-m-1')!;
    expect(signal.current_price).toBeCloseTo(0.62, 5);
    expect(signal.volume).toBe(4200);
    expect(signal.status).toBe('pending');

    // Market resolved against the prediction -> incorrect
    applyMarketUpdate('event-1', {
      prices: new Map([['m-1|Yes', 0]]),
      finalPrices: new Map([['m-1|Yes', 0]])
    });
    signal = getBySlug('will-it-rain-m-1')!;
    expect(signal.status).toBe('incorrect');
    expect(signal.current_price).toBe(0);
  });

  it('ignores unknown events', () => {
    expect(applyMarketUpdate('nope', {prices: new Map()})).toBe(0);
  });
});
