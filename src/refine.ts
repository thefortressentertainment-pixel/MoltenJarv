/**
 * Budget-bounded self-refining step (Stanford DSPy "Assertions" harvest, MIT).
 *
 * The crown jewel from DSPy: attach a **deterministic**, local constraint
 * (predicate) to the output of a stage; if it fails, do not ship the output —
 * instead append a *corrective tail* (the failed output + WHY it failed) to the
 * next stage request and re-invoke, up to a bounded `budget` (DSPy's default
 * max_backtracks=2). `Assert` semantics halt after exhaust; `Suggest` semantics
 * log and return best-effort.
 *
 * Why this is ideal for Jarv (8GB M1, must coexist with Blender/Unreal):
 *  - The predicate is pure CPU (regex/TS symbol table / test runner) — ZERO LM
 *    cost in the happy path.
 *  - Each retry is ONE extra, near-identical completion (only the corrective
 *    tail is appended), so RAM stays flat and cost is bounded at 1–2 extra calls.
 *  - No Python, no resident model, no on-device weights.
 *
 * Jarv's existing deterministic spine plugs straight in as both predicate AND
 * feedback source:
 *   - `verify_change` → status 'fail'/'incomplete' + findings[].message/
 *     suggestedFix is the corrective tail.
 *   - `self_review`    → test/typecheck stderr is the corrective tail.
 */

export interface RefineGuard<T> {
  /** Deterministic predicate; `ok:false` triggers a retry with the feedback.
   *  May be async (e.g. a verify that reads files). */
  check(output: T): { ok: boolean; feedback?: string } | Promise<{ ok: boolean; feedback?: string }>;
}

export interface RefineResult<T> {
  /** The accepted output, or the last best-effort output if budget was exhausted
   *  and `soft` (Suggest semantics). */
  value: T | undefined;
  /** How many attempts (1..budget+1) were made. */
  attempts: number;
  /** True when the output passed the guard on the final attempt. */
  accepted: boolean;
  /** When `throwOnFail` (Assert semantics) and the budget was exhausted, the
   *  guard's last feedback is carried here instead of a thrown error. */
  feedback?: string;
}

export interface RefineOptions<T> {
  /** Produces the stage output. On retries (`attempt>0`), `feedback` is the
   *  corrective tail to append (may be undefined on the first attempt). */
  produce: (feedback: string | undefined) => Promise<T>;
  /** Deterministic local guard. */
  guard: RefineGuard<T>;
  /** Max retries after the first attempt (DSPy default max_backtracks=2). */
  budget?: number;
  /** Assert semantics: throw after budget exhausted. Default false (Suggest). */
  throwOnFail?: boolean;
}

/**
 * Run a stage with bounded corrective retries. Mirrors DSPy's backtrack_handler:
 * produce → guard → on fail append feedback + re-produce... up to `budget`.
 *
 * - Happy path: 1 attempt, guard passes, returns `{ accepted: true }`.
 * - Guard fails: reappends feedback (the failed output + reason), up to `budget`
 *   retries. `accepted` stays false for the final attempt unless it passes.
 * - After budget: if `throwOnFail`, throws with the last feedback; else returns
 *   the best-effort value with `accepted:false` (Suggest semantics).
 */
export async function refineStep<T>(opts: RefineOptions<T>): Promise<RefineResult<T>> {
  const budget = opts.budget ?? 2;
  const guard = opts.guard;
  let feedback: string | undefined;
  let lastValue: T | undefined;

  for (let attempt = 0; attempt <= budget; attempt++) {
    const out = await opts.produce(feedback);
    lastValue = out;
    const check = await guard.check(out);
    if (check.ok) {
      return { value: out, attempts: attempt + 1, accepted: true };
    }
    feedback = check.feedback;
  }

  // Budget exhausted.
  if (opts.throwOnFail) {
    throw new Error(`assertion failed after ${budget} backtracks: ${feedback ?? 'constraint not met'}`);
  }
  return { value: lastValue, attempts: budget + 1, accepted: false, feedback };
}

/**
 * Convenience guard builder: treat a boolean predicate (and optional failure
 * message) as a RefineGuard. Pure/CPU, no LM.
 */
export function guardFrom<T>(predicate: (out: T) => boolean, failMessage?: (out: T) => string): RefineGuard<T> {
  return {
    check(out) {
      const ok = predicate(out);
      return ok ? { ok } : { ok: false, feedback: failMessage ? failMessage(out) : undefined };
    },
  };
}

/** Compose a corrective request tail from the failed output and the reason, in
 *  the spirit of DSPy's injected `Past query/output` + `Instructions` fields. */
export function correctiveTail(outputPreview: string, reason: string): string {
  return `\n\n[correction]\nPrevious output was rejected because: ${reason}\nPrevious output started with: ${outputPreview}\nProduce a corrected output that satisfies: ${reason}`;
}
