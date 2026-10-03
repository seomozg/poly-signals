import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {closeDb} from '@/lib/db';
import {countSignals} from '@/lib/repo';
import {analyzeEventsBatch, enrichReasons} from '@/lib/analyze';
import {collectSignals} from '@/lib/collect';
import {DeepSeekFatalError} from '@/lib/deepseek';
import type {NormalizedEvent, SignalCandidate} from '@/lib/types';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'poly-site-fatal-'));
  process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');
  process.env.DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || 'test-key';
  closeDb();
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpDir, {recursive: true, force: true});
});

function makeEvent(id: string): NormalizedEvent {
  const now = Date.now();
  return {
    id,
    slug: `event-${id}`,
    title: `Test event ${id}`,
    startDate: new Date(now).toISOString(),
    endDate: new Date(now + 48 * 3600_000).toISOString(),
    volume: 1000,
    liquidity: 1000,
    volume24hr: 10,
    tags: ['Sports'],
    category: 'Sports',
    url: `https://polymarket.com/event/event-${id}`,
    markets: [
      {
        id: `m-${id}`,
        question: `Will ${id} happen?`,
        outcomes: ['Yes', 'No'],
        prices: [0.4, 0.6],
        volume: 100,
        liquidity: 100,
        closed: false
      }
    ]
  };
}

function candidate(id: string): SignalCandidate {
  return {
    eventId: `e-${id}`,
    eventSlug: `slug-${id}`,
    marketId: `m-${id}`,
    title: `Event ${id}`,
    question: `Question ${id}?`,
    outcome: 'Yes',
    marketPrice: 0.4,
    predictedPrice: 0.7,
    edge: 0.3,
    recommendation: 'BUY',
    reasonRu: 'кратко',
    reasonEn: 'brief',
    volume: 100,
    liquidity: 100,
    category: 'Sports',
    tags: [],
    url: 'https://polymarket.com/event/x'
  };
}

/** Strips already-normalised events back to the raw Gamma shape the mock serves. */
function asGamma(events: NormalizedEvent[]) {
  return events.map((event) => ({
    ...event,
    markets: event.markets.map((market) => ({
      id: market.id,
      question: market.question,
      outcomes: market.outcomes,
      outcomePrices: market.prices,
      closed: market.closed,
      volume: market.volume,
      liquidity: market.liquidity
    }))
  }));
}

/** Fetch mock: Gamma events on GET, DeepSeek answers on POST (calls counted). */
function makeFetch(mode: 'success' | '402', events: NormalizedEvent[]) {
  const state = {postCalls: 0};
  const impl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/events')) {
      const offset = new URL(url).searchParams.get('offset') ?? '0';
      return {
        ok: true,
        status: 200,
        json: async () => (offset === '0' ? events : []),
        text: async () => ''
      } as unknown as Response;
    }

    state.postCalls++;
    if (mode === '402') {
      return {
        ok: false,
        status: 402,
        json: async () => ({}),
        text: async () => '{"error":{"message":"Insufficient Balance"}}'
      } as unknown as Response;
    }

    const content = JSON.stringify({
      analyses: events.map((event) => ({
        marketId: `m-${event.id}`,
        outcomes: [
          {outcome: 'Yes', predicted: 0.7},
          {outcome: 'No', predicted: 0.3}
        ],
        reasonRu: 'r',
        reasonEn: 'r'
      }))
    });

    return {
      ok: true,
      status: 200,
      json: async () => ({
        model: 'deepseek-chat',
        choices: [{message: {content}}],
        usage: {prompt_tokens: 111, completion_tokens: 77}
      }),
      text: async () => ''
    } as unknown as Response;
  }) as typeof fetch;

  return {impl, state};
}

describe('fail-fast on fatal DeepSeek errors', () => {
  it('does not split a batch when the API answers 402 (one request only)', async () => {
    const {impl, state} = makeFetch('402', []);

    await expect(
      analyzeEventsBatch([makeEvent('1'), makeEvent('2'), makeEvent('3')], {}, impl)
    ).rejects.toBeInstanceOf(DeepSeekFatalError);

    expect(state.postCalls).toBe(1);
  });

  it('stops enrichment after the first fatal chunk', async () => {
    const {impl, state} = makeFetch('402', []);
    const candidates = [candidate('1'), candidate('2'), candidate('3'), candidate('4')];

    await expect(enrichReasons(candidates, impl, 1)).rejects.toBeInstanceOf(
      DeepSeekFatalError
    );

    expect(state.postCalls).toBe(1); // no further chunks, no splitting
  });

  it('collectSignals aborts after the first fatal request', async () => {
    const {impl, state} = makeFetch(
      '402',
      asGamma([
        makeEvent('1'),
        makeEvent('2'),
        makeEvent('3'),
        makeEvent('4'),
        makeEvent('5'),
        makeEvent('6')
      ]) as unknown as NormalizedEvent[]
    );

    const result = await collectSignals(
      {target: 5, pageLimit: 100, maxOffset: 100, concurrency: 1, batchSize: 3},
      impl
    );

    expect(result.errors[0]).toMatch(/^fatal:/);
    expect(result.stored).toBe(0);
    expect(result.signals).toBe(0);
    expect(countSignals()).toBe(0);
    // first batch aborted the run → second batch and enrichment never requested
    expect(state.postCalls).toBe(1);
  });

  it('still splits ordinary (non-fatal) failures', async () => {
    const failing = (async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;

    await expect(
      analyzeEventsBatch([makeEvent('1'), makeEvent('2')], {}, failing)
    ).rejects.toThrow('network down');
  });
});
