import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {closeDb} from '@/lib/db';
import {getCallStats, listAiCallsByDay, recordAiCall} from '@/lib/repo';
import {analyzeBatch, DeepSeekFatalError, setAiCallSink, type AiCallRecord} from '@/lib/deepseek';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'poly-site-aicall-'));
  process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');
  process.env.DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || 'test-key';
  closeDb();
});

afterEach(() => {
  setAiCallSink(null);
  closeDb();
  fs.rmSync(tmpDir, {recursive: true, force: true});
});

const okFetch = (async () => ({
  ok: true,
  status: 200,
  json: async () => ({
    model: 'deepseek-chat',
    choices: [
      {
        message: {
          content: JSON.stringify({
            analyses: [
              {
                marketId: 'm-1',
                outcomes: [
                  {outcome: 'Yes', predicted: 0.7},
                  {outcome: 'No', predicted: 0.3}
                ],
                reasonRu: 'r',
                reasonEn: 'r'
              }
            ]
          })
        }
      }
    ],
    usage: {prompt_tokens: 111, completion_tokens: 77}
  }),
  text: async () => ''
})) as unknown as typeof fetch;

const noBalanceFetch = (async () => ({
  ok: false,
  status: 402,
  json: async () => ({}),
  text: async () => '{"error":{"message":"Insufficient Balance"}}'
})) as unknown as typeof fetch;

describe('ai_calls journal', () => {
  it('records successful calls with usage and phase', async () => {
    const journal: AiCallRecord[] = [];
    setAiCallSink((record) => journal.push(record));

    await analyzeBatch('marketId=m-1 question="Q?" outcomes=[Yes, No]', {items: 2}, okFetch);

    expect(journal).toHaveLength(1);
    expect(journal[0]).toMatchObject({
      phase: 'analysis',
      status: 200,
      ok: true,
      items: 2,
      inputTokens: 111,
      outputTokens: 77,
      model: 'deepseek-chat',
      error: null
    });
  });

  it('records failed calls with status and error text', async () => {
    const journal: AiCallRecord[] = [];
    setAiCallSink((record) => journal.push(record));

    await expect(analyzeBatch('prompt', {}, noBalanceFetch)).rejects.toBeInstanceOf(
      DeepSeekFatalError
    );

    expect(journal).toHaveLength(1);
    expect(journal[0]).toMatchObject({ok: false, status: 402, inputTokens: null});
    expect(journal[0].error).toContain('Insufficient Balance');
  });

  it('does not write anywhere when no sink is installed', async () => {
    // no setAiCallSink call — unit tests must never touch a real DB
    await expect(analyzeBatch('prompt', {}, noBalanceFetch)).rejects.toBeInstanceOf(
      DeepSeekFatalError
    );
    expect(getCallStats().total).toBe(0);
  });

  it('persists rows and aggregates them per day and phase', () => {
    recordAiCall({
      phase: 'analysis',
      status: 200,
      ok: true,
      items: 3,
      inputTokens: 100,
      outputTokens: 50,
      model: 'deepseek-chat',
      error: null
    });
    recordAiCall({
      phase: 'reasons',
      status: 402,
      ok: false,
      items: 2,
      inputTokens: null,
      outputTokens: null,
      model: 'deepseek-chat',
      error: 'Insufficient Balance'
    });

    const stats = getCallStats();
    expect(stats).toMatchObject({
      total: 2,
      ok: 1,
      failed: 1,
      byStatus402: 1,
      inputTokens: 100,
      outputTokens: 50
    });

    const byDay = listAiCallsByDay();
    expect(byDay).toHaveLength(2);
    const analysis = byDay.find((row) => row.phase === 'analysis')!;
    expect(analysis).toMatchObject({calls: 1, ok: 1, err402: 0});
    const reasons = byDay.find((row) => row.phase === 'reasons')!;
    expect(reasons).toMatchObject({calls: 1, failed: 1, err402: 1});
  });

  it('getCallStats respects the since filter', () => {
    recordAiCall({
      phase: 'analysis',
      status: 200,
      ok: true,
      items: 1,
      inputTokens: 10,
      outputTokens: 5,
      model: 'deepseek-chat',
      error: null
    });
    const future = new Date(Date.now() + 60_000).toISOString();
    expect(getCallStats(future).total).toBe(0);
    expect(getCallStats().total).toBe(1);
  });
});
