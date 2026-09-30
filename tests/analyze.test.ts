import {describe, expect, it} from 'vitest';
import {
  buildCandidates,
  eventDurationHours,
  groupKey,
  passesFilters,
  selectDiverse,
  trimMarkets
} from '@/lib/analyze';
import {parseAnalysisResponse} from '@/lib/deepseek';
import type {NormalizedEvent, SignalCandidate} from '@/lib/types';

function makeEvent(overrides: Partial<NormalizedEvent> = {}): NormalizedEvent {
  return {
    id: 'event-1',
    slug: 'fed-decision',
    title: 'Fed rate decision',
    volume: 50000,
    liquidity: 1000,
    volume24hr: 1000,
    tags: ['economy'],
    url: 'https://polymarket.com/event/fed-decision',
    markets: [
      {
        id: 'm-1',
        question: 'Will rates rise?',
        outcomes: ['Yes', 'No'],
        prices: [0.4, 0.6],
        volume: 1000,
        liquidity: 500,
        closed: false
      }
    ],
    ...overrides
  };
}

describe('passesFilters', () => {
  const options = {minLiquidity: 300, minMarketPrice: 0.01};

  it('accepts a liquid event with tradable prices', () => {
    expect(passesFilters(makeEvent(), options)).toBe(true);
  });

  it('rejects events below the liquidity threshold', () => {
    expect(passesFilters(makeEvent({liquidity: 100}), options)).toBe(false);
  });

  it('rejects events without markets', () => {
    expect(passesFilters(makeEvent({markets: []}), options)).toBe(false);
  });

  it('rejects events whose prices are all extreme', () => {
    const event = makeEvent();
    event.markets[0].prices = [0.005, 0.995];
    expect(passesFilters(event, options)).toBe(false);
  });

  it('rejects ultra-short events when a min duration is configured', () => {
    const short = makeEvent({
      startDate: '2026-09-30T12:00:00Z',
      endDate: '2026-09-30T12:05:00Z' // 5 minutes
    });
    expect(passesFilters(short, {...options, minDurationHours: 2})).toBe(false);

    const long = makeEvent({
      startDate: '2026-09-30T12:00:00Z',
      endDate: '2026-10-01T12:00:00Z' // 24 hours
    });
    expect(passesFilters(long, {...options, minDurationHours: 2})).toBe(true);
  });

  it('keeps events with unknown start date', () => {
    const unknown = makeEvent({endDate: '2026-10-01T12:00:00Z'});
    expect(passesFilters(unknown, {...options, minDurationHours: 2})).toBe(true);
  });

  it('drops events carrying an excluded tag or category', () => {
    const opts = {...options, excludedTags: ['5m', 'up or down']};
    expect(passesFilters(makeEvent({tags: ['Crypto', '5M']}), opts)).toBe(false);
    expect(passesFilters(makeEvent({category: 'Up or Down'}), opts)).toBe(false);
    expect(passesFilters(makeEvent({tags: ['Sports', 'MLB']}), opts)).toBe(true);
  });
});

describe('eventDurationHours', () => {
  it('computes duration between start and end', () => {
    const event = makeEvent({
      startDate: '2026-09-30T00:00:00Z',
      endDate: '2026-10-02T00:00:00Z'
    });
    expect(eventDurationHours(event)).toBe(48);
  });

  it('returns null when dates are missing', () => {
    expect(eventDurationHours(makeEvent())).toBeNull();
  });
});

describe('buildCandidates', () => {
  const options = {minEdge: 0.02, minMarketPrice: 0.01};

  it('computes edge and keeps the best BUY per event', () => {
    const event = makeEvent();
    const candidates = buildCandidates(
      [event],
      [
        {
          marketId: 'm-1',
          outcomes: [
            {outcome: 'Yes', predicted: 0.6}, // edge = 0.2
            {outcome: 'No', predicted: 0.65} // edge = 0.05
          ],
          reasonRu: 'Почему рост.',
          reasonEn: 'Why up.'
        }
      ],
      options
    );

    expect(candidates).toHaveLength(1);
    expect(candidates[0].outcome).toBe('Yes');
    expect(candidates[0].edge).toBeCloseTo(0.2, 5);
    expect(candidates[0].recommendation).toBe('BUY');
    expect(candidates[0].eventSlug).toBe('fed-decision');
    expect(candidates[0].question).toBe('Will rates rise?');
  });

  it('drops outcomes below the minimum edge', () => {
    const event = makeEvent();
    const candidates = buildCandidates(
      [event],
      [
        {
          marketId: 'm-1',
          outcomes: [
            {outcome: 'Yes', predicted: 0.41}, // edge = 0.01 < 0.02
            {outcome: 'No', predicted: 0.61} // edge = 0.01 < 0.02
          ],
          reasonRu: 'r',
          reasonEn: 'r'
        }
      ],
      options
    );
    expect(candidates).toHaveLength(0);
  });

  it('ignores hallucinated market ids and unknown outcomes', () => {
    const event = makeEvent();
    const candidates = buildCandidates(
      [event],
      [
        {marketId: 'unknown', outcomes: [{outcome: 'Yes', predicted: 0.9}], reasonRu: 'r', reasonEn: 'r'},
        {marketId: 'm-1', outcomes: [{outcome: 'Maybe', predicted: 0.9}], reasonRu: 'r', reasonEn: 'r'}
      ],
      options
    );
    expect(candidates).toHaveLength(0);
  });

  it('returns candidates ordered by edge', () => {
    const events = [
      makeEvent({
        id: 'e1',
        slug: 'a',
        markets: [
          {id: 'a1', question: 'A?', outcomes: ['Yes'], prices: [0.5], volume: 1, liquidity: 1, closed: false}
        ]
      }),
      makeEvent({
        id: 'e2',
        slug: 'b',
        markets: [
          {id: 'b1', question: 'B?', outcomes: ['Yes'], prices: [0.5], volume: 1, liquidity: 1, closed: false}
        ]
      })
    ];
    const candidates = buildCandidates(
      events,
      [
        {marketId: 'a1', outcomes: [{outcome: 'Yes', predicted: 0.6}], reasonRu: 'r', reasonEn: 'r'},
        {marketId: 'b1', outcomes: [{outcome: 'Yes', predicted: 0.9}], reasonRu: 'r', reasonEn: 'r'}
      ],
      options
    );
    expect(candidates.map((c) => c.marketId)).toEqual(['b1', 'a1']);
  });
});

describe('trimMarkets', () => {
  it('keeps only the highest-volume markets up to the limit', () => {
    const event = makeEvent();
    event.markets = [
      {id: 'm1', question: '1', outcomes: ['Yes'], prices: [0.5], volume: 10, liquidity: 1, closed: false},
      {id: 'm2', question: '2', outcomes: ['Yes'], prices: [0.5], volume: 900, liquidity: 1, closed: false},
      {id: 'm3', question: '3', outcomes: ['Yes'], prices: [0.5], volume: 50, liquidity: 1, closed: false}
    ];
    const trimmed = trimMarkets(event, 2);
    expect(trimmed.markets.map((m) => m.id)).toEqual(['m2', 'm3']);
    // original order of the kept markets is preserved
    expect(trimmed.markets[0].id).toBe('m2');
    // the input is not mutated
    expect(event.markets).toHaveLength(3);
  });

  it('does nothing when under the limit', () => {
    const event = makeEvent();
    expect(trimMarkets(event, 5)).toBe(event);
  });
});

describe('selectDiverse', () => {
  const make = (over: Partial<SignalCandidate>): SignalCandidate => ({
    eventId: 'e1',
    eventSlug: 'ev',
    marketId: 'm1',
    title: 'Game - 1st',
    question: 'q',
    outcome: 'Yes',
    marketPrice: 0.4,
    predictedPrice: 0.6,
    edge: 0.2,
    recommendation: 'BUY',
    reasonRu: 'r',
    reasonEn: 'r',
    volume: 1000,
    liquidity: 500,
    category: 'Sports',
    tags: [],
    url: 'https://polymarket.com/event/ev',
    ...over
  });

  it('groups titles by the part before " - "', () => {
    expect(groupKey('Phillies vs. Braves - 1st Inning Winner')).toBe('phillies vs. braves');
    expect(groupKey('Will it rain in Seattle?')).toBe('will it rain in seattle?');
  });

  it('caps signals per group and per category, keeping the strongest edges', () => {
    const candidates = [
      make({eventSlug: 'a', title: 'Game - 1st', edge: 0.3, category: 'Sports'}),
      make({eventSlug: 'b', title: 'Game - 2nd', edge: 0.25, category: 'Sports'}),
      make({eventSlug: 'c', title: 'Game - 3rd', edge: 0.2, category: 'Sports'}),
      make({eventSlug: 'd', title: 'Election 2026', edge: 0.1, category: 'Politics'}),
      make({eventSlug: 'e', title: 'Rain in Seattle', edge: 0.05, category: 'Weather'})
    ];

    const selected = selectDiverse(candidates, {
      limit: 10,
      maxPerGroup: 2,
      maxPerCategory: 1
    });

    expect(selected.map((c) => c.eventSlug)).toEqual(['a', 'd', 'e']);
  });

  it('respects the overall limit', () => {
    const candidates = [
      make({eventSlug: 'a', title: 'A', edge: 0.3, category: 'Sports'}),
      make({eventSlug: 'b', title: 'B', edge: 0.2, category: 'Politics'}),
      make({eventSlug: 'c', title: 'C', edge: 0.1, category: 'Weather'})
    ];
    const selected = selectDiverse(candidates, {limit: 2, maxPerGroup: 5, maxPerCategory: 5});
    expect(selected).toHaveLength(2);
    expect(selected[0].edge).toBeGreaterThan(selected[1].edge);
  });

  it('accounts for signals already stored in the catalog', () => {
    const candidates = [
      make({eventSlug: 'a', title: 'Game - 1st', edge: 0.3, category: 'Sports'}),
      make({eventSlug: 'b', title: 'Game - 2nd', edge: 0.2, category: 'Sports'}),
      make({eventSlug: 'c', title: 'Election', edge: 0.1, category: 'Politics'})
    ];

    const selected = selectDiverse(candidates, {
      limit: 10,
      maxPerGroup: 2,
      maxPerCategory: 2,
      initial: {
        groups: new Map([['game', 1]]),
        categories: new Map([['sports', 1]])
      }
    });

    // 'game' already has 1 of 2 slots → the strongest (a) takes the last slot,
    // b is blocked by the group cap, c fits its own category
    expect(selected.map((c) => c.eventSlug)).toEqual(['a', 'c']);
  });
});

describe('parseAnalysisResponse', () => {
  const valid = JSON.stringify({
    analyses: [
      {
        marketId: 'm-1',
        outcomes: [{outcome: 'Yes', predicted: 0.62}],
        reasonRu: 'Причина.',
        reasonEn: 'Reason.'
      }
    ]
  });

  it('parses plain JSON', () => {
    const parsed = parseAnalysisResponse(valid);
    expect(parsed.analyses[0].outcomes[0].predicted).toBe(0.62);
  });

  it('strips markdown fences', () => {
    const parsed = parseAnalysisResponse('```json\n' + valid + '\n```');
    expect(parsed.analyses).toHaveLength(1);
  });

  it('rejects malformed JSON', () => {
    expect(() => parseAnalysisResponse('{oops')).toThrow(/invalid JSON/);
  });

  it('salvages JSON followed by trailing commentary', () => {
    const withTail = valid + '\nHope this helps!';
    expect(parseAnalysisResponse(withTail).analyses).toHaveLength(1);
  });

  it('salvages JSON wrapped in fences with trailing text', () => {
    const messy = 'Sure!\n```json\n' + valid + '\n```\nDone.';
    expect(parseAnalysisResponse(messy).analyses).toHaveLength(1);
  });

  it('rejects out-of-range probabilities', () => {
    const bad = JSON.stringify({
      analyses: [{marketId: 'm', outcomes: [{outcome: 'Yes', predicted: 1.5}], reasonRu: 'r', reasonEn: 'r'}]
    });
    expect(() => parseAnalysisResponse(bad)).toThrow();
  });
});
