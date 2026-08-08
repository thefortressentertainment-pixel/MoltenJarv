# DSPy (stanfordnlp/dspy) — Harvest Note (Assertions / self-refinement)

Reference: `stanfordnlp/dspy` (MIT, 36.7k★) — "programming, not prompting"
framework for declarative, self-improving LM pipelines.

## What was harvested: budget-bounded self-refining steps (DSPy Assertions)

DSPy's **crown jewel** and the single highest-value, lowest-cost pattern to port:
an in-pipeline, budget-bounded **retry-with-feedback** loop. You attach a
*deterministic* local predicate to a stage's output; on failure, append a
corrective tail (the **failed output + why it failed**) to the next request and
re-invoke, up to a `max_backtracks` budget (default 2). `Assert` halts after
exhaust; `Suggest` logs and returns best-effort.

**Why it's ideal for Jarv on the 8GB M1 alongside Blender/Unreal:**
- The predicate is **pure CPU** (regex / TS symbol table / test runner) → **zero
  LM cost** on the happy path.
- Each retry is **one** extra, near-identical completion (only the corrective
  tail is added) → RAM stays flat, cost bounded at 1–2 extra calls.
- **No Python, no resident model, no on-device weights.**

## Implementation (T1, TS, RAM-light)

- `src/refine.ts` — `refineStep<T>()` (the DSPy backtrack loop), `guardFrom()`
  (build a guard from a boolean predicate + failure message), `correctiveTail()`
  (the injected `[correction]` block: rejected reason + failed-output preview).
  Exposes `Assert` (throwOnFail) and `Suggest` (best-effort) semantics.
- `src/tools/refine.ts` — `refineCode()` / `refine_code` tool: produces a code
  draft (LLM or a custom producer), guards it deterministically with the existing
  `verify_change` spine, and on failure feeds the verify findings (`message` +
  `suggestedFix`) back as a corrective tail into bounded retries. Returns the
  accepted source (does not write the file). Verified live: a phantom-import
  draft is correctly rejected and re-drafted to pass.
- Wired: `refine_code` registered, added to `CORE_TOOLS` (never pinned away) and
  `READ_ONLY_TOOLS`.
- Tests: 8 (`test/refine.test.ts`). Full suite **370 passing**, typecheck +
  build clean.

## Not ported (deliberately — heavy)

- **Optimizers** (GEPA, MIPROv2, BootstrapFewShot): fire many LM calls to tune
  prompts; OUT for the low-RAM/Blender constraint.
- **Module/signature + adapters**: a Python runtime concept; Jarv's tools/skills
  already serve as typed modules. The principle (separate author/optimize/infer,
  cache aggressively) is already how `learn_skill` works.
- **The Python framework itself**: Jarv is TypeScript; only the backtracking
  pattern transfers.

## Attribution

Pattern derived from DSPy Assertions (arXiv 2312.13382) and its successor
`Refine`, read from `stanfordnlp/dspy` (MIT). Re-expressed in Jarv's own
TypeScript over the existing `verify_change` deterministic spine; no source
copied.
