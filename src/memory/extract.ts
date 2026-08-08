import type { ModelRouter } from '../providers/index.js';
import type { Memory } from './index.js';
import type { MemoryFact } from './types.js';
import { parseJsonArray } from './dream.js';
import { extractTriplet, TRIPLET_SYSTEM, tripletPrompt } from './triplet.js';

/**
 * "Extraction" — automatic durable-fact discovery (JARVIS blueprint §C4, ported
 * from the mem0 extract-and-recollect loop; Apache-2.0 pattern).
 *
 * Jarv's memory today only stores what the agent is explicitly told to remember
 * (`remember`) or consolidates what is already there (dream). This adds the
 * missing direction: run a conversation/transcript through an LLM that pulls out
 * the *durable* facts (preferences, decisions, commitments, names, architecture)
 * and ADD-s them to the fact store automatically — so Jarv recollects what the
 * user said even without being asked to remember it.
 *
 * Safety properties (mirror dream.ts):
 *  - **Dedup**: candidate facts are not written when they substantially match an
 *    existing fact (substring / near-equal) — ADD-only, update-don't-duplicate.
 *  - **Fail-open**: any model/network/parse error aborts WITHOUT touching the
 *    store. Extraction is never destructive.
 *  - **Provenance**: every extracted fact is tagged `source: 'extraction'` so its
 *    origin is audit-able alongside `user`/`session`/`consolidated` facts.
 */

export interface ExtractOptions {
  /** Input cap (chars) for the text given to the model. Default 16_000. */
  maxInputChars?: number;
  /** Upper bound on facts extracted in one pass. Default 12. */
  maxFacts?: number;
  /** Only extract facts about the user's world (preferences/decisions/people),
   *  skip transient chatter. Pass system instructions override for tests. */
  systemPrompt?: string;
}

export interface ExtractResult {
  /** Candidate facts the model returned (before dedup). */
  candidates: string[];
  /** Facts actually written to the store. */
  added: string[];
  /** Existing durable facts the candidates were judged equal to (skipped). */
  skipped: string[];
  /** When false, extraction did not run (empty input, model failure, or parse). */
  ran: boolean;
  reason?: string;
}

const DEFAULT_SYSTEM = `You extract durable, useful facts from a personal assistant conversation or transcript so it can remember them later.

Return ONLY a JSON array of strings — the memorable facts worth keeping.
Include facts like:
- The user's stated preferences, likes, dislikes, habits.
- Decisions reached, commitments, upcoming appointments or plans.
- Names, relationships, and important context about people.
- Technical/architecture facts about projects or the user's machines.
Exclude ephemera: greetings, small talk, transient "current state" notes, counts,
one-off requests, idle chatter, and anything trivial or temporary.
Be precise and self-contained in each fact (no "he/she" — use names).
Never invent facts that are not in the input. Do not add explanation, markdown, or commentary — only the JSON array.
If nothing is worth keeping, return: []`;

/** Normalise for comparison: trim, lowercase, collapse whitespace. */
function norm(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** True when `b` substantially duplicates an existing fact text (substring or
 *  near-equality), so ADD-only extraction does not pile up near-duplicates. */
function isDuplicate(candidate: string, facts: MemoryFact[]): boolean {
  const c = norm(candidate);
  if (!c) return true;
  for (const f of facts) {
    const ft = norm(f.text);
    if (ft === c) return true;
    // Guard against a candidate that is just a fragment of an existing fact or
    // vice-versa (shorter side is the whole of the other).
    const short = c.length <= ft.length ? c : ft;
    const long = c.length <= ft.length ? ft : c;
    if (short.length >= 12 && long.includes(short)) return true;
  }
  return false;
}

/**
 * Extract durable facts from `input` and write the new ones to the store.
 * Returns candidates (all found), added (written), and skipped (duplicates).
 * Fail-open: on empty input, model error, or invalid response it returns
 * `{ ran:false, reason }` and leaves the store untouched.
 */
export async function extractFacts(
  memory: Memory,
  router: ModelRouter,
  input: string,
  opts: ExtractOptions = {},
): Promise<ExtractResult> {
  const text = input.trim();
  if (!text) return { ran: false, candidates: [], added: [], skipped: [], reason: 'no input text' };

  const maxInput = opts.maxInputChars ?? 16_000;
  const truncated = text.length > maxInput ? text.slice(0, maxInput) + '\n[truncated]' : text;
  const system = opts.systemPrompt ?? DEFAULT_SYSTEM;
  const maxFacts = opts.maxFacts ?? 12;

  let raw = '';
  try {
    const chat = await router.chat({
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: `Extract durable facts from this conversation/transcript:\n\n${truncated}\n\nReturn only the JSON array of fact strings.` },
      ],
    });
    raw = (chat.content ?? '').trim();
  } catch (err) {
    return { ran: false, candidates: [], added: [], skipped: [], reason: `model unavailable: ${err instanceof Error ? err.message : String(err)}` };
  }

  const parsed = parseJsonArray(raw);
  if (parsed === null) {
    // Invalid/unparseable response → fail-open, store untouched (like dream).
    return { ran: false, candidates: [], added: [], skipped: [], reason: 'model returned invalid JSON — store untouched (fail-open)' };
  }
  const candidates = parsed.slice(0, maxFacts);
  if (candidates.length === 0) {
    // A valid empty array is "nothing worth keeping" — not an error, but no store write.
    return { ran: true, candidates, added: [], skipped: [], reason: undefined };
  }

  const existing = await memory.factStore.list();
  const added: string[] = [];
  const skipped: string[] = [];
  const seen = new Set<string>();
  const provenance = truncated.length > 600 ? truncated.slice(0, 600) + '…' : truncated;
  for (const candidate of candidates) {
    const c = norm(candidate);
    if (!c || seen.has(c)) continue;
    seen.add(c);
    if (isDuplicate(candidate, existing)) {
      skipped.push(candidate);
      continue;
    }
    // GRAPH: attach an entity triplet + provenance to each extracted durable fact
    // so it is subject-scoped/traversable, not just a flat string.
    const { triplet } = await extractTriplet(candidate, async (fact) => {
      const chat = await router.chat({
        messages: [
          { role: 'system', content: TRIPLET_SYSTEM },
          { role: 'user', content: tripletPrompt(fact) },
        ],
      });
      return chat.content ?? '';
    });
    await memory.addFactMeta(candidate, {
      source: 'extraction',
      provenance,
      subject: triplet?.subject,
      relationship: triplet?.relationship,
      object: triplet?.object,
    });
    added.push(candidate);
    // Dedup against what we just added in this batch too.
    existing.push({ id: '', text: candidate, source: 'extraction', createdAt: '', updatedAt: '' });
  }

  return { ran: true, candidates, added, skipped };
}
