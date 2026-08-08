# Cortex — Harvest & Re-Optimization Plan (the Judge Loop)

Reference source: `qibin0506/Cortex` (Apache-2.0, 2.7k★) — a from-scratch LLM
pipeline (pretrain → midtrain → SFT → DPO/GRPO/PPO). The value is **not** its
weight-training math (that's for fine-tuning a model, which Jarv doesn't do).
The harvestable core is its **reward/feedback layer** — how a model gets a
measurable, explainable signal on its own output. That is precisely the missing
piece in Jarv's self-optimization loop: Jarv can already change its own code and
run `self_review`, but there is *no score* telling it "this change made you
better or worse."

Nothing is copied as-is. Each item borrows a **pattern** and re-expresses it in
Jarv's TypeScript style, in keeping with Apache-2.0 (attribution below). The
prior harvests (grok-build, openworker, taste-skill) already covered risk gates,
compaction, memory revision, roots sandbox, inbox/self-wake, and output quality
skills. Cortex is orthogonal: it adds the **scoring signal** on top.

---

## The gap it fills

Today `self_review` (`src/tools/selfreview.ts`) reports tests + typecheck +
open optimization items, then Jarv deliberates on its own and proposes a change.
That is:

- **Unscored** — no signal on whether a chosen change was good.
- **Self-evaluated** — Jarv is judge and party, so it can't see its own drift or
  regressions in judgment.
- **Stateless** — no persistent record of "my quality used to be X, now it's Y."

Cortex's `reward_func` + `call_llm_judge` (`train_ppo.py`) solves all three with
a **hybrid, decomposable, explainable scoring loop**. The winning idea — the one
that makes it stable — is that **deterministic checks score first (cheap, objective)
and an LLM judge only adds the subjective quality signal on top**. Delegating the
entire score to an LLM is fragile; keeping the objective checks in code is what
anchors the loop.

---

## Highest-value ports (code, priority order)

### P1. `judge` tool — strict `<score>` contract + decomposed components

**From `train_ppo.py` (`call_llm_judge`, `reward_func`):**
- A judge prompt that ends with a **parseable `<score>N</score>` tag** and is
  otherwise freeform critique (`call_llm_judge`, lines ~40-100).
- Scores **clamped** to a band (`max(min(score,5),-5)`), so an outlier judge
  output can't explode the signal.
- **Cosmetic rewriting before judging** — Jarv analog: the judge gets a
  version-neutral transcript (no internal delimiters that could confuse it), the
  same way Cortex strips `<think>`/`<answer>` tokens into plain brackets.

**Port:** add `src/judge.ts` exposing:
- `judgeOutput(input: { task, work, criteria? }) → { score, brief, bounds }`
- Score decomposition modeled on Cortex's `format + length_bonus + rm` — but
  mapped to Jarv's real checks:
  `total = compliance + completeness + judge_score`
  where `compliance` and `completeness` are **deterministic** (did it follow the
  task contract? did it claim done-only-when-done?) and the LLM judge score is a
  `judge_score` the model weights on top. Decomposition is the whole point: a low
  total must tell Jarv *which* component failed, not just "you scored 2."

### P2. Wire the judge into `self_review` — scored self-review

**From `train_ppo.py` `get_eval_prompt` + `reward_func` logging:**
- A **standing eval battery**: a fixed set of representative prompts the model
  scores itself against each review, so results are comparable across runs
  (Cortex's fixed `eval_prompts`).
- Pair each completed self-improvement with a judgment of **before vs after**, so
  a change's value is measurable rather than asserted.

**Port:** extend `self_review` (`src/tools/selfreview.ts`) to return a
`quality` block: decompose the existing deterministic checks (tests pass,
typecheck clean, crash-loop count) as **objective components**, then read the
last `judge` score for the prior change as the subjective component. Keep output
shape backward compatible (add fields; don't remove `tests`/`typecheck`).

### P3. Persistent taste/review log — "did I get better over time"

**From `reward_func` logging to `./log/reward.txt`:**
- A human-readable append-only decision trail, per review: task/work preview,
  per-component breakdown, fatal flag. This is the audit log that makes
  self-optimization *reviewable* and catches preference drift.

**Port:** a `reviews.json` store (mirroring `FactStore`'s JSON-file pattern in
`src/memory/store.ts`) OR append to a log file. Each entry: `{ id, ts, kind,
compliance, completeness, judgeScore, total, fatal, note }` plus a `totalScore?`
delta vs the previous review so `self_review` can report trend ("quality 6.2 →
6.8").

### P4. Graceful judge degradation (robustness)

**From `call_llm_judge` error handling:**
- Judge failure → **neutral score** (`0.0`), not a poisoned extreme; never let a
  flaky evaluator crash the loop or skew the trend.
- A hard **fatal flag** for genuinely broken output (`OS_ERROR`, empty work) that
  short-circuits the LLM call entirely and scores negative — the same
  "format-fatal" concept that lets Cortex skip the judge for structurally doomed
  samples. On balance/429-type infrastructure errors, **fail closed and mark the
  review inconclusive** rather than recording a misleading number.

---

## Medium / structural

### P5. Deterministic-first scoring ladder

The ordering that makes Cortex robust: enforce structure **before** calling the
judge; only samples that pass objective gates get an LLM score; the LLM signal is
weighted below the deterministic total. Port as a small `scoreCompliance()` that
runs first and can early-return when a fatal contract break is found. This
simplifies the judge prompt and saves API cost (exactly why Cortex routes
format-fatal samples away from the judge).

---

## Explicitly NOT porting (weight-training concerns Jarv doesn't have)

- **PPO/GRPO/DPO gradient backprop, value models, KL anchors, ref checkpoints**
  (`train_ppo.py`, `train_dpo.py`, `get_ppo_config`) — Jarv isn't fine-tuning its
  weights; it improves itself by editing its own source. The *signal* transfers;
  the *optimizer* does not.
- **DeepSpeed/transformers config, MoE/attention models, dataset streaming**
  (`utils.py`, `file_dataset.py`) — hardware/training machinery, irrelevant.
- **LLM-as-judge-for-RL alignment of a base model** — Jarv's "training" is its
  own code edits + memory, so the judge feeds self-review, not a loss function.

---

## Proposed sequencing

1. **P3 review log store** first — it's storage-only, no behavior change, and
   everything else writes to it. Mirrors the existing `FactStore` pattern.
2. **P1 `judge` tool** — the scorer, clamped + decomposed, with P4 degradation
   built in from the start.
3. **P5 deterministic ladder** — objective-first ordering.
4. **P2 wire into `self_review`** — surface the `quality` block + trend.

Each lands with tests (`npm test`) and a `self_review`, consent-gated behind the
Telegram approval gate. Track completion in this file's **Status** section below
(as the openworker harvest does) and report deltas in the plan.

---

## Status

- [x] P1 `src/judge/{judge,llmJudge}.ts` + `src/tools/judge.ts` — `judge` tool with
      strict `<score>` contract, decomposed `{compliance, completeness,
      judgeScore, total}`, clamps, injectable LLM judge, and persistence into the
      `ReviewStore`. Tests: 10 new (`test/judge-tools.test.ts`).
- [x] P2 `self_review` quality block + trend — `src/tools/selfreview.ts` now reads
      `readQuality(reviewsFile)` (ReviewStore.summary): review count, latest total,
      signed delta vs the previous review. Wired into `self_review` output.
      Tests: 2 new (`test/selfreview.test.ts`).
- [x] P3 `reviews.json` taste/review log — `src/judge/types.ts` + `src/judge/store.ts`
      (`ReviewStore`), append-only JSON store mirroring `FactStore`, `summary()` +
      `totalDelta()` trend for self-review. Tests: 6 new (`test/judge.test.ts`).
- [x] P4 graceful degradation + fatal short-circuit — built into `judgeOutput`
      (judge failure → neutral + `inconclusive`; fatal → judge skipped).
- [x] P5 deterministic-first scoring ladder — `judgeOutput` runs lifecycle: fatal
      contract break short-circuits the LLM judge; judge only runs on non-fatal.

## Changelog

- **2026-08-08 — P2 landed**: `self_review` now returns a `quality` block (review
  count, latest total, signed delta trend) via `readQuality()`, fed by the shared
  `reviews.json` store. Daily 07:30 self-review can now report whether Jarv is
  measurably improving. Full suite 324 tests passing, typecheck + build clean.
- **2026-08-08 — P1, P4, P5 landed (with P3)**: the `judge` tool is registered at
  `src/cli/index.ts` (`...judgeTools(path.join(config.memory.dir, 'reviews.json'))`),
  writes every verdict to the P3 review log. `judgeOutput` implements the hybrid
  deterministic + LLM-judge score with graceful degradation (P4) and the
  deterministic-first ladder (P5). Full suite now 322 tests passing (was 312),
  typecheck + build clean.
- **2026-08-08 — P3 landed**: `ReviewStore` persisted to `reviews.json`,
  decomposed `{compliance, completeness, judgeScore, total, fatal}` shape,
  `summary()/totalDelta()` for the "did I get better over time" trend.

---

## Attribution

Patterns derived from reading `qibin0506/Cortex` (Apache-2.0), notably
`train_ppo.py` (`reward_func`, `call_llm_judge`, `get_eval_prompt`),
`train_dpo.py`, and `utils.py`. No source code is copied; the **hybrid
deterministic + LLM-judge scoring loop** and its **strict parseable score
contract** are re-expressed in Jarv's own TypeScript as a feedback signal for
Jarv's existing `self_review`.
