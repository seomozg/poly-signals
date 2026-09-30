import {afterEach, describe, expect, it, vi} from 'vitest';
import {buildReasonPrompt, generateReasons, parseReasonResponse} from '@/lib/deepseek';
import {enrichReasons, enrichStoredSignals} from '@/lib/analyze';
import type {SignalCandidate} from '@/lib/types';

const longRu = Array(30).fill('анализ').join(' ');
const longEn = Array(30).fill('analysis').join(' ');

// The API key is read lazily; make sure mocked calls are never blocked.
process.env.DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || 'test-key';

function candidate(over: Partial<SignalCandidate> = {}): SignalCandidate {
  return {
    eventId: 'e1',
    eventSlug: 'quake',
    marketId: 'm1',
    title: 'Biggest earthquake?',
    question: 'Will the biggest earthquake be 5.5 to 5.6?',
    outcome: 'Yes',
    marketPrice: 0.11,
    predictedPrice: 0.35,
    edge: 0.24,
    recommendation: 'BUY',
    reasonRu: 'короткое обоснование',
    reasonEn: 'brief summary',
    description: 'A magnitude 5.5-5.6 earthquake is expected.',
    volume: 1000,
    liquidity: 500,
    category: 'Weather',
    tags: [],
    url: 'https://polymarket.com/event/quake',
    ...over
  };
}

/** Mocks the DeepSeek endpoint: resolves with `content` as the model reply. */
function fetchReturning(content: unknown): typeof fetch {
  return (async () => ({
    ok: true,
    status: 200,
    json: async () => ({choices: [{message: {content: typeof content === 'string' ? content : JSON.stringify(content)}}]}),
    text: async () => ''
  })) as unknown as typeof fetch;
}

const failingFetch = (async () => {
  throw new Error('network down');
}) as unknown as typeof fetch;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('buildReasonPrompt', () => {
  it('includes price, estimate, edge and the event context', () => {
    const prompt = buildReasonPrompt([
      {
        eventId: 'e1',
        eventTitle: 'Biggest earthquake?',
        eventDescription: 'Magnitude context',
        marketId: 'm1',
        question: 'Will it be 5.5 to 5.6?',
        outcome: 'Yes',
        marketPrice: 0.11,
        predicted: 0.35,
        edge: 0.24
      }
    ]);

    expect(prompt).toContain('marketId=m1');
    expect(prompt).toContain('market price: 0.110 (11%)');
    expect(prompt).toContain('model estimate: 0.350 (35%)');
    expect(prompt).toContain('edge: 24.0 percentage points');
    expect(prompt).toContain('Magnitude context');
  });
});

describe('parseReasonResponse', () => {
  const valid = JSON.stringify({
    reasons: [{marketId: 'm1', reasonRu: longRu, reasonEn: longEn}]
  });

  it('parses a valid reply', () => {
    const parsed = parseReasonResponse(valid);
    expect(parsed.reasons[0].marketId).toBe('m1');
    expect(parsed.reasons[0].reasonRu.length).toBeGreaterThan(50);
  });

  it('salvages JSON with trailing text', () => {
    expect(parseReasonResponse(valid + '\nDone.').reasons).toHaveLength(1);
  });

  it('rejects malformed JSON', () => {
    expect(() => parseReasonResponse('{oops')).toThrow(/invalid JSON/);
  });

  it('coerces numeric market ids and non-string texts', () => {
    const raw = JSON.stringify({
      reasons: [{marketId: 5122389, reasonRu: longRu, reasonEn: longEn}]
    });
    const parsed = parseReasonResponse(raw);
    expect(parsed.reasons[0].marketId).toBe('5122389');
  });
});

describe('enrichReasons', () => {
  it('replaces the brief text with the long analysis', async () => {
    const target = candidate();

    const enriched = await enrichReasons(
      [target],
      fetchReturning({
        reasons: [{marketId: 'm1', reasonRu: longRu, reasonEn: longEn}]
      })
    );

    expect(enriched).toBe(1);
    expect(target.reasonRu).toBe(longRu);
    expect(target.reasonEn).toBe(longEn);
  });

  it('keeps the brief text when the model call fails', async () => {
    const target = candidate();

    const enriched = await enrichReasons([target], failingFetch);

    expect(enriched).toBe(0);
    expect(target.reasonRu).toBe('короткое обоснование');
    expect(target.reasonEn).toBe('brief summary');
  });

  it('ignores replies for unknown markets', async () => {
    const target = candidate();

    const enriched = await enrichReasons(
      [target],
      fetchReturning({reasons: [{marketId: 'other', reasonRu: longRu, reasonEn: longEn}]})
    );

    expect(enriched).toBe(0);
    expect(target.reasonRu).toBe('короткое обоснование');
  });

  it('returns 0 for an empty selection without calling the API', async () => {
    const spy = vi.fn();
    expect(await enrichReasons([], spy as unknown as typeof fetch)).toBe(0);
    expect(spy).not.toHaveBeenCalled();
  });

  it('splits a failing chunk down to single signals', async () => {
    const first = candidate({marketId: 'm1'});
    const second = candidate({marketId: 'm2', title: 'Other event', eventId: 'e2'});

    // The mock rejects any request carrying more than one market.
    const oneAtATime = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {messages: Array<{content: string}>};
      const user = body.messages[1]?.content ?? '';
      const ids = [...user.matchAll(/marketId=(\S+)/g)].map((m) => m[1]);
      if (ids.length > 1) throw new Error('too many markets in one request');
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  reasons: ids.map((id) => ({marketId: id, reasonRu: longRu, reasonEn: longEn}))
                })
              }
            }
          ]
        }),
        text: async () => ''
      };
    }) as unknown as typeof fetch;

    const updated = await enrichReasons([first, second], oneAtATime);

    expect(updated).toBe(2);
    expect(first.reasonRu).toBe(longRu);
    expect(second.reasonEn).toBe(longEn);
  });
});

describe('enrichStoredSignals', () => {
  it('backfills brief texts in the database', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const {closeDb} = await import('@/lib/db');
    const {upsertSignal, getBySlug} = await import('@/lib/repo');

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'poly-site-enrich-'));
    process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');
    closeDb();

    try {
      const stored = upsertSignal(candidate());
      expect(stored.reason_ru.length).toBeLessThan(600);

      const result = await enrichStoredSignals(
        600,
        fetchReturning({reasons: [{marketId: 'm1', reasonRu: longRu, reasonEn: longEn}]})
      );

      expect(result).toEqual({checked: 1, updated: 1});
      const reloaded = getBySlug(stored.slug)!;
      expect(reloaded.reason_ru).toBe(longRu);
      expect(reloaded.reason_en).toBe(longEn);
    } finally {
      closeDb();
      fs.rmSync(tmpDir, {recursive: true, force: true});
    }
  });
});

describe('generateReasons', () => {
  it('sends a request and validates the reply', async () => {
    const result = await generateReasons(
      [
        {
          eventId: 'e1',
          eventTitle: 'Biggest earthquake?',
          marketId: 'm1',
          question: 'Will it be 5.5 to 5.6?',
          outcome: 'Yes',
          marketPrice: 0.11,
          predicted: 0.35,
          edge: 0.24
        }
      ],
      {},
      fetchReturning({reasons: [{marketId: 'm1', reasonRu: longRu, reasonEn: longEn}]})
    );
    expect(result.reasons[0].reasonEn).toBe(longEn);
  });
});
