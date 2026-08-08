import { parseJsonArray } from './dream.js';

/**
 * Entity-triplet extraction (GRAPH / graphiti "context graph" pattern; Apache-2.0).
 *
 * Durable facts are more useful when structured as an explicit triple:
 *   (subject, relationship, object) — e.g. ("user", "prefers", "dark mode") or
 *   ("Alice", "has birthday on", "October 12th").
 * Storing the triplet lets recall do subject/object-scoped traversal (GRAPH's
 * "traverse from an entity") instead of flat embedding search. This module turns
 * a free-text durable fact into an optional triple using an injectable LLM call
 * (defaulting to the existing router), and is fail-open: no model/parse → no
 * triplet, the fact is still stored without one.
 */

export interface Triplet {
  subject: string;
  relationship: string;
  object: string;
}

const TRIPLET_SYSTEM = `You extract the most important entity relationship from one durable fact.

Return ONLY a JSON object with exactly three string keys: subject, relationship, object.
- subject: the primary entity (e.g. "user", "Alice", "project").
- relationship: the verb/relation (e.g. "prefers", "has birthday on", "works at").
- object: the related entity/value (e.g. "dark mode", "October 12th", "Fortress").
Prefer short noun or verb phrases. If the fact is a singular statement with no
meaningful relationship, return {"subject":"","relationship":"","object":""}.
Do not add explanation, markdown, or commentary — only the JSON object.`;

export function parseTriplet(raw: string): Triplet | null {
  const arr = parseJsonArray(raw);
  // parseJsonArray expects an array; for our object we tolerate a 1-element array
  // holding the object, or a bare JSON object.
  let obj: unknown;
  if (arr && arr.length === 1) {
    try { obj = JSON.parse(arr[0]!); } catch { return null; }
  } else {
    // Try to parse the raw as a JSON object directly.
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) return null;
    try { obj = JSON.parse(raw.slice(start, end + 1)); } catch { return null; }
  }
  if (!obj || typeof obj !== 'object') return null;
  const o = obj as Record<string, unknown>;
  const subject = String(o.subject ?? '').trim();
  const relationship = String(o.relationship ?? '').trim();
  const object = String(o.object ?? '').trim();
  if (!subject || !relationship || !object) return null;
  return { subject, relationship, object };
}

export interface TripletResult {
  triplet?: Triplet;
}

/**
 * Run the triplet extractor. `extract` is the LLM call: given a fact, it returns
 * the raw model text (JSON). Fail-open: any error → `{ triplet: undefined }`.
 * Injectable for tests.
 */
export async function extractTriplet(
  fact: string,
  extract: (fact: string) => Promise<string>,
): Promise<TripletResult> {
  try {
    const raw = (await extract(fact)).trim();
    if (!raw) return {};
    const triplet = parseTriplet(raw);
    return triplet ? { triplet } : {};
  } catch {
    return {};
  }
}

export function tripletPrompt(fact: string): string {
  return `Extract the triple from this fact:\n\n${fact}\n\nReturn only the JSON object.`;
}

export { TRIPLET_SYSTEM };
