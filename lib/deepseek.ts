/**
 * DeepSeek chat-completions client with strict JSON validation.
 * The model returns analyses for a batch of events in one call, in both
 * languages (ru/en), so a second translation request is never needed.
 */
import {z} from 'zod';
import {config} from './config';

/** One market analysis as produced by the model. */
const MarketAnalysis = z.object({
  marketId: z.string(),
  outcomes: z
    .array(
      z.object({
        outcome: z.string(),
        predicted: z.number().min(0).max(1)
      })
    )
    .min(1),
  reasonRu: z.string().min(1),
  reasonEn: z.string().min(1)
});

const AnalysisResponse = z.object({
  analyses: z.array(MarketAnalysis).min(1)
});

export type MarketAnalysis = z.infer<typeof MarketAnalysis>;
export type AnalysisResponse = z.infer<typeof AnalysisResponse>;

export const SYSTEM_PROMPT = `You are a professional prediction-market analyst.
You are given several Polymarket events with their markets.
IMPORTANT: market prices are deliberately NOT shown to you — estimate every probability
from first principles, using your own knowledge of the topic. Do not guess what "the market
thinks"; do not default to 50/50. If your reasoned view differs from the crowd, trust your view.

For EVERY market of every event, estimate the fair probability of each listed outcome
as a number between 0 and 1, well calibrated (0.65 means it should happen ~65 times out of 100).
Then write two short justifications of your reasoning — one in Russian (reasonRu) and one in
English (reasonEn), each max 20 words, explaining the key drivers behind your estimate.

Answer ONLY with JSON of the shape:
{"analyses":[{"marketId":"...","outcomes":[{"outcome":"Yes","predicted":0.62}],"reasonRu":"...","reasonEn":"..."}]}
Include every market you were given, and nothing else.`;

/**
 * Builds the user message for one batch of events.
 * Prices are intentionally omitted so the model cannot anchor on them (see SYSTEM_PROMPT).
 */
export function buildUserPrompt(
  events: Array<{
    id: string;
    title: string;
    description?: string;
    markets: Array<{id: string; question: string; outcomes: string[]}>;
  }>
): string {
  const blocks = events.map((event) => {
    const markets = event.markets
      .map((m) => `  - marketId=${m.id} question="${m.question}" outcomes=[${m.outcomes.join(', ')}]`)
      .join('\n');
    const description = event.description
      ? `\nContext: ${event.description.slice(0, 600)}`
      : '';
    return `Event id=${event.id} title="${event.title}"${description}\nMarkets:\n${markets}`;
  });
  return `Analyse these events and estimate fair probabilities:\n\n${blocks.join('\n\n')}`;
}

/**
 * Extracts the first balanced JSON object from a model reply.
 * The model occasionally appends commentary or gets truncated — we salvage
 * what we can instead of failing the whole batch.
 */
export function extractJsonObject(raw: string): string {
  const cleaned = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const start = cleaned.indexOf('{');
  if (start < 0) return cleaned;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < cleaned.length; i++) {
    const char = cleaned[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth++;
    else if (char === '}') {
      depth--;
      if (depth === 0) return cleaned.slice(start, i + 1);
    }
  }
  return cleaned.slice(start);
}

/**
 * Validates and normalises a raw model reply.
 * Exported separately from the network call so it can be unit-tested.
 */
export function parseAnalysisResponse(raw: string): AnalysisResponse {
  const json = extractJsonObject(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw new Error(
      `DeepSeek returned invalid JSON: ${(error as Error).message}; preview=${raw.slice(0, 200)}`
    );
  }
  return AnalysisResponse.parse(parsed);
}

export interface DeepSeekOptions {
  temperature?: number;
  maxTokens?: number;
}

/**
 * Shared chat-completions call: sends a system+user pair, extracts the JSON
 * object out of the reply and validates it with the given schema.
 */
async function chatJson<T extends z.ZodTypeAny>(
  system: string,
  user: string,
  schema: T,
  options: DeepSeekOptions = {},
  fetchImpl: typeof fetch = fetch
): Promise<z.infer<T>> {
  if (!config.deepseekApiKey) {
    throw new Error('DEEPSEEK_API_KEY is not set');
  }

  const response = await fetchImpl(config.deepseekApiUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${config.deepseekApiKey}`
    },
    body: JSON.stringify({
      model: config.deepseekModel,
      temperature: options.temperature ?? 0.2,
      max_tokens: options.maxTokens ?? 8000,
      response_format: {type: 'json_object'},
      messages: [
        {role: 'system', content: system},
        {role: 'user', content: user}
      ]
    })
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`DeepSeek API error ${response.status}: ${detail.slice(0, 300)}`);
  }

  const payload = (await response.json()) as {
    choices?: Array<{message?: {content?: string}}>;
  };
  const content = payload.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error('DeepSeek returned an empty response');
  }

  const json = extractJsonObject(content);
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw new Error(
      `DeepSeek returned invalid JSON: ${(error as Error).message}; preview=${content.slice(0, 200)}`
    );
  }
  return schema.parse(parsed) as z.infer<T>;
}

/** Single chat-completions request. Returns parsed, validated analyses. */
export function analyzeBatch(
  userPrompt: string,
  options: DeepSeekOptions = {},
  fetchImpl: typeof fetch = fetch
): Promise<AnalysisResponse> {
  return chatJson(SYSTEM_PROMPT, userPrompt, AnalysisResponse, options, fetchImpl);
}

/* ------------------------------------------------------------------ *
 * Phase 2: the long, published analysis text for the selected signals
 * ------------------------------------------------------------------ */

const ReasonResponse = z.object({
  reasons: z
    .array(
      z.object({
        marketId: z.string(),
        reasonRu: z.string().min(1),
        reasonEn: z.string().min(1)
      })
    )
    .min(1)
});

export type ReasonResponse = z.infer<typeof ReasonResponse>;

export const REASON_SYSTEM_PROMPT = `You are a senior prediction-market analyst writing the final
analysis that will be published on a website next to a Polymarket signal.

For each market you receive: the event, the market question, the outcome in question, the current
market price, our model's probability estimate and the resulting edge (estimate minus price).

Write a thorough, concrete analysis for each market:
- reasonRu: 150-220 words in Russian; reasonEn: 150-220 words in English.
- Use 3-4 short paragraphs: (1) what this market resolves on and the current situation;
  (2) the key drivers, numbers and facts behind our estimate; (3) why the market price may be
  mispriced and what has to happen for the outcome to win; (4) the main risks and what would
  invalidate the idea.
- Be specific, reference the numbers from the input, no filler, no hype, no disclaimers.
- Plain text paragraphs separated by a blank line. No markdown, no headers, no bullet points.

Answer ONLY with JSON of the shape
{"reasons":[{"marketId":"...","reasonRu":"...","reasonEn":"..."}]}
covering every market you were given, and nothing else.`;

export interface ReasonRequest {
  eventId: string;
  eventTitle: string;
  eventDescription?: string;
  marketId: string;
  question: string;
  outcome: string;
  marketPrice: number;
  predicted: number;
  edge: number;
}

/** Builds the phase-2 prompt — unlike phase 1, prices are included on purpose. */
export function buildReasonPrompt(items: ReasonRequest[]): string {
  const blocks = items.map((item) => {
    const context = item.eventDescription
      ? `\nEvent context: ${item.eventDescription.slice(0, 600)}`
      : '';
    return [
      `marketId=${item.marketId}`,
      `event="${item.eventTitle}"${context}`,
      `market question="${item.question}"`,
      `outcome in question: ${item.outcome}`,
      `market price: ${item.marketPrice.toFixed(3)} (${Math.round(item.marketPrice * 100)}%)`,
      `model estimate: ${item.predicted.toFixed(3)} (${Math.round(item.predicted * 100)}%)`,
      `edge: ${(item.edge * 100).toFixed(1)} percentage points`
    ].join('\n');
  });
  return `Write the published analyses for these signals:\n\n${blocks.join('\n\n')}`;
}

/** Validates a phase-2 reply (exported for unit tests). */
export function parseReasonResponse(raw: string): ReasonResponse {
  const json = extractJsonObject(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw new Error(
      `DeepSeek returned invalid JSON: ${(error as Error).message}; preview=${raw.slice(0, 200)}`
    );
  }
  return ReasonResponse.parse(parsed);
}

/** Phase-2 request: long analysis texts for a small chunk of signals. */
export function generateReasons(
  items: ReasonRequest[],
  options: DeepSeekOptions = {},
  fetchImpl: typeof fetch = fetch
): Promise<ReasonResponse> {
  return chatJson(REASON_SYSTEM_PROMPT, buildReasonPrompt(items), ReasonResponse, options, fetchImpl);
}
