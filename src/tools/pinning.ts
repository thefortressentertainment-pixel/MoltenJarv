/**
 * BM25 tool-pinning (JARVIS blueprint §C2, ported from ha-mcp's tool-search
 * pattern; MIT). Jarv exposes ~91 tools to the model every run. For a small
 * local model that's a lot of tool-schema tokens that mostly go unused — the
 * model can mis-pick or blow its context. BM25 pinning scores each tool's name
 * + description against the user's request and exposes only the top-K most
 * relevant tools (plus an always-on safety core), so the model sees a lean,
 * task-tuned toolset.
 *
 * Pure and deterministic so it is unit-testable without a model or a live task.
 */

export interface PinOptions {
  /** Max tools to expose after pinning. Default 24. */
  maxTools?: number;
  /** How many always-keep safety/core tools are included regardless of score. */
  pinCoreMax?: number;
  /** k1 / b BM25 parameters. */
  k1?: number;
  b?: number;
}

export interface ScoredTool {
  name: string;
  score: number;
}

/**
 * Deterministic BM25 scoring over tool name+description. `tools` are scored
 * against `query` (the user's request). Returns the scored tools sorted
 * high→low. Non-destructive: the returned names are the top matches.
 */
export function bm25ScoreTools(
  query: string,
  tools: Array<{ name: string; description: string }>,
  opts: PinOptions = {},
): ScoredTool[] {
  const k1 = opts.k1 ?? 1.5;
  const b = opts.b ?? 0.75;

  const qTerms = tokenize(query);
  if (qTerms.length === 0) return tools.map((t) => ({ name: t.name, score: 0 }));

  const docCount = tools.length;
  // Document = "name description", tokenized once.
  const docs = tools.map((t) => {
    const tokens = tokenize(`${t.name} ${t.description}`);
    const freqs = new Map<string, number>();
    for (const tok of tokens) freqs.set(tok, (freqs.get(tok) ?? 0) + 1);
    return { name: t.name, tokens, freqs, docLen: tokens.length };
  });

  const avgLen = docs.length > 0 ? docs.reduce((n, d) => n + d.docLen, 0) / docs.length : 1;
  // Document frequency is per unique term across docs.
  const df = new Map<string, number>();
  for (const d of docs) for (const tok of new Set(d.tokens)) df.set(tok, (df.get(tok) ?? 0) + 1);

  const idf = (term: string): number => {
    const f = df.get(term) ?? 0;
    // BM25 idf with smoothing; avoids log(0) for terms in every doc.
    return Math.log(1 + (docCount - f + 0.5) / (f + 0.5));
  };

  const score = (tor: Map<string, number>, docLen: number): number => {
    let s = 0;
    for (const qTerm of qTerms) {
      const tf = tor.get(qTerm) ?? 0;
      if (tf === 0) continue;
      s += idf(qTerm) * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * docLen) / Math.max(1, avgLen))));
    }
    return s;
  };

  return docs
    .map((d) => ({ name: d.name, score: score(d.freqs, d.docLen) }))
    .sort((a, b1) => b1.score - a.score || a.name.localeCompare(b1.name));
}

/** Tokenize for BM25: lowercase, split on non-alphanumerics, drop stop-ish short
 *  tokens (>= 2 chars; keep numbers). */
export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((t) => t.length >= 2);
}

/**
 * The always-keep safety/core tool names that should never be pinned away: the
 * agent always needs to be able to check its own health, judge its work, and
 * see status even when the task mentions none of them explicitly.
 */
export const CORE_TOOLS = ['self_review', 'judge', 'system_status', 'verify_change'];

/**
 * Pin the toolset to the top-K relevant tools for `input` (BM25), always
 * including the core set (up to `pinCoreMax`), capped at `maxTools` total.
 * When the toolset is small (≤ maxTools) we return it unchanged — pinning only
 * helps when there's real bloat to cut. Returns the pinned tool definitions.
 *
 * Optional `alwaysInclude` gives callers a way to force tools the task context
 * will definitely need regardless of BM25 score (e.g. multi-step follow-ons).
 *
 * Pinning is a *first-pass*, input-anchored reduction: it is stable per task
 * (the model always sees the same toolset for a given input), which keeps
 * multi-turn tool calling coherent without re-pinning on every step.
 */
export function pinTools<T extends { name: string; description: string }>(
  input: string,
  tools: T[],
  opts: PinOptions & { alwaysInclude?: string[] } = {},
): T[] {
  const maxTools = opts.maxTools ?? 24;
  const pinCoreMax = opts.pinCoreMax ?? 5;
  const alwaysInclude = opts.alwaysInclude ?? [];

  if (tools.length <= maxTools) return tools;

  const ranked = bm25ScoreTools(input, tools, opts);
  const pick = new Set<string>();
  // Always-keep core first (so they're never crowded out).
  for (const t of tools) {
    const forced = CORE_TOOLS.includes(t.name) || alwaysInclude.includes(t.name);
    if (forced && pick.size < maxTools && !pick.has(t.name)) pick.add(t.name);
  }
  // Then top BM25 matches until we run out of tool budget.
  for (const r of ranked) {
    if (pick.size >= maxTools) break;
    if (!pick.has(r.name)) pick.add(r.name);
  }
  // Preserve callers' original ordering for stability.
  return tools.filter((t) => pick.has(t.name));
}
