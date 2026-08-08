/**
 * Production LLM-judge client: scores Jarv's work with the strict `<score>N`
 * contract against the configured primary provider (any OpenAI-compatible
 * endpoint). Separated from src/judge/judge.ts so the scoring logic stays pure
 * and injectable for tests; this module only supplies the network round-trip.
 *
 * Mirrors Cortex's `call_llm_judge`: a terse judge prompt that must terminate
 * with a parseable `<score>N</score>` tag, scores clamped, and graceful
 * degradation (a network/API-level error becomes a neutral 0.0 — never a
 * poisoned extreme) except on hard infrastructure failures.
 */
import type { EndpointConfig } from '../config/index.js';
import { resolveApiKey } from '../config/index.js';
import { parseJudgeScore } from './judge.js';

export interface LlmJudgeClient {
  baseUrl: string;
  model: string;
}

interface JudgeCall {
  task: string;
  work: string;
  criteria?: string;
}

const SCORE_PROMPT = `You are a cold, objective scoring machine. Grade a single piece of work produced by an agent.

Response rules:
- You may write one or two sentences of brief critique, but your message MUST end with an XML tag: <score>N</score> where N is a number from -1.0 (terrible) to +1.0 (excellent). Output only the number between the tags.
- If the work is empty, gibberish, or wholly off-task, output <score>-1.0</score>.
- A perfect completion on the stated task scores +1.0.`;

async function runJudge(baseUrl: string, model: string, key: string, input: JudgeCall): Promise<{ score: number; note: string }> {
  const userContent = [
    input.criteria ? `Task:\n${input.task}\n\nCriteria:\n${input.criteria}\n\nWork:\n${input.work}` : `Task:\n${input.task}\n\nWork:\n${input.work}`,
    `\n\nScore the work now. End with <score>N</score>.`,
  ].join('');
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: SCORE_PROMPT },
        { role: 'user', content: userContent },
      ],
      temperature: 0.3,
      max_tokens: 800,
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(`judge HTTP ${res.status}: ${body.slice(0, 300)}`);
    (err as { status?: number }).status = res.status;
    throw err;
  }
  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string | null } }> };
  const content = data.choices?.[0]?.message?.content;
  if (!content || !content.trim()) throw new Error('judge returned empty content');
  return parseJudgeScore(content);
}

/**
 * Build a judge function bound to an OpenAI-compatible endpoint. `makeJudge` is
 * the factory; `judgeLLM` is the callable. The factory splits config resolution
 * from the call so callers can pass an already-resolved key/base.
 */
export function makeLlmJudge(cfg: EndpointConfig, key: string): (input: JudgeCall) => Promise<{ score: number; note: string }> {
  const baseUrl = (cfg.baseUrl ?? 'http://127.0.0.1:11434/v1').replace(/\/+$/, '');
  const model = cfg.model;
  return (input) => runJudge(baseUrl, model, key, input);
}

/** Resolve the primary provider's key and build a judge for it. */
export function makePrimaryJudge(primary: EndpointConfig): (input: JudgeCall) => Promise<{ score: number; note: string }> {
  const key = resolveApiKey(primary) ?? 'not-set';
  return makeLlmJudge(primary, key);
}

export type { JudgeCall };
