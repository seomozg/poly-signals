import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {closeDb} from '@/lib/db';
import {
  countAnalyzed,
  countSignals,
  filterUnanalyzed,
  getBySlug,
  listSignals,
  listSignalsForStats,
  markAnalyzed
} from '@/lib/repo';
import {collectSignals} from '@/lib/collect';

let tmpDir: string;

const longRu = ('Анализ рынка: ключевые факторы, цифры и риски. ').repeat(25); // > 600 chars
const longEn = ('Market analysis: key drivers, numbers and risks. ').repeat(25);

function gammaEvent(id: string, category: string) {
  const now = Date.now();
  return {
    id,
    slug: `event-${id}`,
    title: `Test event ${id}`,
    description: 'Context for the model.',
    image: 'https://example.com/x.png',
    startDate: new Date(now).toISOString(),
    endDate: new Date(now + 48 * 3600_000).toISOString(),
    active: true,
    closed: false,
    liquidity: 5000,
    volume: 10000,
    category,
    tags: [{label: category}],
    markets: [
      {
        id: `m-${id}`,
        question: `Will event ${id} happen?`,
        outcomes: '["Yes","No"]',
        outcomePrices: '["0.4","0.6"]',
        closed: false,
        volume: 1000,
        liquidity: 1000
      }
    ]
  };
}

const EVENTS = [gammaEvent('1', 'Sports'), gammaEvent('2', 'Politics'), gammaEvent('3', 'Weather')];

function jsonResponse(data: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => data,
    text: async () => JSON.stringify(data)
  } as unknown as Response;
}

/** Routes Gamma list/detail calls and DeepSeek phase-1/phase-2 replies. */
function mockFetch(): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);

    if (url.includes('/events')) {
      const offset = Number(new URL(url).searchParams.get('offset') ?? '0');
      return jsonResponse(offset === 0 ? EVENTS : []);
    }

    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as {
        messages: Array<{role: string; content: string}>;
      };
      const system = body.messages[0]?.content ?? '';
      const user = body.messages[1]?.content ?? '';
      const marketIds = [...user.matchAll(/marketId=(\S+)/g)].map((m) => m[1]);

      if (system.includes('senior prediction-market analyst')) {
        // phase 2 — long published analyses
        return jsonResponse({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  reasons: marketIds.map((marketId) => ({
                    marketId,
                    reasonRu: longRu,
                    reasonEn: longEn
                  }))
                })
              }
            }
          ]
        });
      }

      // phase 1 — estimates without market prices
      return jsonResponse({
        choices: [
          {
            message: {
              content: JSON.stringify({
                analyses: marketIds.map((marketId) => ({
                  marketId,
                  outcomes: [
                    {outcome: 'Yes', predicted: 0.9},
                    {outcome: 'No', predicted: 0.1}
                  ],
                  reasonRu: 'Краткое обоснование.',
                  reasonEn: 'Brief summary.'
                }))
              })
            }
          }
        ]
      });
    }

    throw new Error(`Unexpected request: ${url}`);
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'poly-site-collect-'));
  process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');
  closeDb();
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpDir, {recursive: true, force: true});
});

describe('collectSignals', () => {
  it('grows the catalog to the target, analyses each event once and enriches texts', async () => {
    const phases: string[] = [];

    const result = await collectSignals(
      {
        target: 2,
        pageLimit: 100,
        maxOffset: 100,
        concurrency: 1,
        batchSize: 3,
        onProgress: (info) => phases.push(info.phase)
      },
      mockFetch()
    );

    expect(result.errors).toEqual([]);
    expect(result.signals).toBe(2);
    expect(result.target).toBe(2);
    // all three events were analysed even though only two signals fit the quota
    expect(result.analysedEvents).toBe(3);
    expect(countAnalyzed()).toBe(3);
    expect(countSignals()).toBe(2);

    // stored signals carry the full-length published analysis
    const stored = listSignalsForStats();
    expect(stored).toHaveLength(2);
    const first = listSignals({pageSize: 10}).items[0];
    const row = getBySlug(first.slug)!;
    expect(row.reason_ru.length).toBeGreaterThan(600);
    expect(row.reason_en.length).toBeGreaterThan(600);

    expect(phases).toContain('sweep');
    expect(phases).toContain('analyse');
    expect(phases).toContain('enrich');
    expect(phases.at(-1)).toBe('done');
  }, 20_000);

  it('skips events that were analysed before', async () => {
    markAnalyzed(EVENTS.map((event) => event.id));

    const result = await collectSignals(
      {target: 2, pageLimit: 100, maxOffset: 100, concurrency: 1, batchSize: 3},
      mockFetch()
    );

    expect(result.freshEvents).toBe(0);
    expect(result.signals).toBe(0);
    expect(countSignals()).toBe(0);
  }, 20_000);
});

describe('analyzed_events bookkeeping', () => {
  it('filters already analysed ids and is idempotent', () => {
    expect(filterUnanalyzed(['a', 'b', 'c'])).toEqual(['a', 'b', 'c']);
    markAnalyzed(['a', 'b']);
    expect(filterUnanalyzed(['a', 'b', 'c'])).toEqual(['c']);
    markAnalyzed(['b']);
    expect(countAnalyzed()).toBe(2);
  });
});
