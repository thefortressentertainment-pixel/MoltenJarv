# Grok Build — Harvest & Re-Optimization Plan

Reference source: `xai-org/grok-build` (Apache-2.0). Not "the Grok model" — it is
the **Rust source for Grok Build**, xAI's terminal coding-agent harness/TUI
(~70 crates, 2,478 `.rs` files). It can't be `npm install`ed into Jarv (which is
TypeScript). So this plan "harvests" the repo by **reading its best engineering
patterns and porting the portable ones** into Jarv's own architecture.

No first-party grok-build code is copied verbatim here; each item borrows a
*pattern* (idea + shape) and re-expresses it in Jarv's existing TS style, in
keeping with Apache-2.0 (attribution note at the bottom).

---

## Where Jarv is now (baseline, from code)

- **Loop** (`src/agent/taskrunner.ts`): plan → execute → observe `while` loop
  with a step budget, batch consent gate, reflex layer (`src/reflexes.ts`),
  working-context trimming, and durable checkpoints. Leans on a strong model
  (deepseek-chat) — the same "strong model deliberates" posture grok-build uses.
- **Tools** (`src/tools/registry.ts`): flat `Map<string, ToolDefinition>` with
  `inputSchema` = loose JSON-schema-ish object. Handlers validate args ad hoc.
- **Memory** (`src/memory/`): `facts.json` + a JSON vector cache; `SemanticSearch`
  does cosine KNN with a keyword fallback. No access metering, no temporal
  decay, no chunking, no consolidation.
- **Reflexes** (`src/reflexes.ts`): hard-coded immune blocks + a `FAST_SAFE`
  allowlist. Not user-configurable.
- **Config** (`src/config/index.ts`): JSON, `deepMerge` of defaults.
- **MCP** (`src/mcp/`): server + client already present.

---

## Highest-value ports (code changes, in priority order)

### 1. Structured, lenient tool-arg validation (+ path-bearing errors)

**From grok-build:** `params_validation.rs` (structured error categories with a
field path + the exact bad value) and `schema.rs` (lenient deserializers:
numbers-or-numeric-strings, whole floats for ints, tolerate `null`).

**Why it matters for Jarv today:** `taskrunner.ts:165` only checks *required*
args exist; it does no type coercion. A model emitting `"30000.0"` for an int or
wrapping a path in quotes creates a retry loop. This is the single biggest
reliability win for the least code.

**Port (in `src/tools/registry.ts` + a new `src/tools/validate.ts`):**
- Coerce: number-or-numeric-string → number; whole-float → int; tolerate `null`
  for optionals.
- On failure return a **structured** error: `{ ok:false, result: { error, path,
  expected, got } }` so the model can fix itself in one shot instead of looping.

### 2. Finalize-time toolset consistency check

**From grok-build:** `requirements.rs` — at config-finalize time, assert the
enabled toolset is internally coherent (e.g. "if the scheduler tool is enabled
with background running, the kill-tasks tool must also be present").

**Why:** `taskrunner.ts` hides memory tools per-input and gates code tools. The
model currently gets whatever the registry has; nothing guarantees the exposed
set is self-consistent (e.g. a tool whose system prompt references a sibling
that isn't loaded).

**Port:** a `validateToolset(tools)` pass run before finalizing the advertised
tool list. Start with the *spirit*, not the full `Expr` tree: a small registry of
declarative rules (`tool X enabled with flag F ⇒ tool Y present`), checked in
`usableTools()`.

### 3. Memory scoring: hybrid fusion + temporal decay + access boost + MMR

**From grok-build `xai-grok-memory`:** the highest-ROI recall machinery.

- **Hybrid fusion rule** (`search.rs:278-290`): keyword (BM25) + vector scores
  combined with `max(hybrid, fts)` so a keyword hit is never drowned by vector
  noise. Directly fixes Jarv's current all-or-nothing split (vector *or* keyword,
  never both: `search.ts:88`).

- **Temporal decay + evergreen exemption** (`search.rs:108-134`): `e^(−ln2/
  halfLife × ageDays)` on session-scoped facts; evergreen/global facts never
  decay. One `exp()` per result.

- **Access-frequency boost** (`search.rs:337`): `1 + ln(1+count) × 0.05`.
  Requires Jarv's `facts.json` to track an `accessCount`. Gives "rehearsal
  strengthens memory" semantics for free.

- **Raw vs display score split** (`search.rs:344-361`): keep the unbounded raw
  score for ranking; clamp only the displayed one. Jarv's `recall` currently
  returns a single `score`; add `rawScore`.

- **MMR diversity re-rank** (`mmr.rs`): after scoring, penalize results similar
  to already-selected ones, using token-Jaccard (no embeddings needed). Prevents
  5 near-identical facts crowding out the answer.

**Port:** extend `src/memory/store.ts` (add `accessCount`, `createdAt` is likely
already there) and rewrite the core of `src/memory/search.ts`. Pure logic, no
native deps. This is the biggest *feel* win for "Jarv actually remembers."

### 4. "Dream" — LLM background consolidation of memories

**From grok-build `xai-grok-memory/dream.rs`:** instead of raw facts piling up,
an LLM pass periodically merges session logs into a curated long-term store —
resolving contradictions (newer wins), discarding ephemera, preserving
decisions/architecture/preferences. The system prompt at `dream.rs:88-112` is
directly reusable as-is.

**Why Jarv:** `addFact` is append-only; facts never get consolidated or culled.
Over time the vector index grows noisy and recall dilutes.

**Port (in `src/memory/` + maybe a scheduled tool):**
- A `consolidate()` that reads new session-scoped facts, calls the primary model
  with the dream prompt, and writes a curated `MEMORY.md` (or replaces the
  noisy facts) — destructive-by-design with a **recency guard** (skip anything
  written <5min ago) and a simple lock so it can't race an in-flight session.
- Wire it into the existing scheduler once a week / when facts exceed a count.

### 5. User-configurable deny-by-default permission rules (replace hard-coded reflex blocks)

**From grok-build:** `config-types/permission.rs` (rule grammar
`{action: allow|deny|ask, tool, pattern, pattern_mode: glob|domain}` with
**Deny as the default action**) + the hooks `pre_tool_use` **gate** with
fail-open semantics (`dispatcher.rs:49-59` — a broken rule never silently blocks;
only an explicit deny does).

**Why Jarv:** `reflexes.ts` hard-codes immune blocks and the `FAST_SAFE`
allowlist. Users can't add "never let me `run_shell` a `rm -rf` in a path with
`backup` in it" or grant an extra fast-path without editing source.

**Port:**
- Add `permissions: PermissionRule[]` to `JarvGenieConfig`.
- Refactor `reflex()` to (a) keep the un-forgeable security invariants
  (credentials/secrets), then (b) consult configurable rules. Deny-default so an
  unset rule never flips to allow. Keep the existing `fast`/`blocked`/`pass`
  result shape, `taskrunner.ts:150` calls it as-is.

### 6. Concurrency-safe file edit lock

**From grok-build:** `editor_infra/file_operation_lock.rs` — same-path reader
serialization + exclusive writer, no writer starvation.

**Why Jarv:** the agent can dispatch multiple tool calls in a round
(`taskrunner.ts:318`); parallel `code_edit`/`file_*` calls could corrupt the same
file.

**Port:** a ~60-line `AsyncMutex`-based per-path lock in `src/tools/filesystem.ts`
guarding writes.

---

## Medium-value / structural

### 7. Stable advertised tool list + meta-dispatch for MCP tools

**From grok-build:** `use_tool/` + `search_tool/` — keep the model's tool list
**stable across turns** even when MCP tools load dynamically, via a
`use_tool { tool_name, tool_input }` indirection, plus a "corrective error" when
the model routes a native tool through it.

**Why Jarv:** `mcp.servers` can add tools at startup; if that list varies between
turns it invalidates the KV cache and confuses the model.

**Port (in `src/mcp/` + tool registry):** namespace MCP tools `server__tool`
(already the case), and if they're dynamic, funnel them through a stable
`use_tool` meta-tool instead of growing the schema per turn.

### 8. Capability-mode partial order (plan mode / read-only sub-rate)

**From grok-build:** `capability.rs` — `ReadOnly < ReadWrite < Execute < All`
with `is_subset_of`, used to filter toolsets so a child session can't widen a
parent's capability.

**Why Jarv:** gives a cheap, principled "plan mode" or read-only mode without
hand-editing `FAST_SAFE`.

**Port:** a `Capability` enum + `kindAllowed(capability, toolKind)` in the
registry; a session-level mode that `usableTools()` respects.

### 9. Skills as folder convention

**From grok-build plugin-marketplace scanner:** skills live at
`plugins/<name>/skills/<skill>/SKILL.md`.

**Port (cheap):** support Jarv reading extra instructions from a
`JARV_HOME/skills/<skill>/SKILL.md` convention the user can drop in — zero-code
extensibility, future-proof for a marketplace.

---

## Explicitly NOT borrowing (over-engineered for a local TS assistant)

- **ACP / client-mediated I/O** (`xai-acp-lib`) — Jarv owns its own FS/terminal;
  wrong model unless embedded in a host.
- **The 2,200-line event-driven session actor + 45 host extensions + goal
  orchestration + workflow/leader/telemetry/marketplace** — productized
  multi-host machinery.
- **bash_command_splitting / exec-risk decompiler** — hundreds of lines;
  over-fitting.
- **OAuth + credential store + signed managed config + MDM** — enterprise fleet
  features.
- **sqlite-vec C-extension KNN** — Jarv's JSON cosine is fine; the *scoring* is
  what we borrow, not the vector store.
- **Doom-loop detection** — server-signaled; irrelevant to this client.

---

## Proposed sequencing

1. **[done] #1 structured/lenient arg validation** — smallest, biggest reliability win.
2. **[done] #3 memory scoring overhaul** — hybrid/temporal/access/MMR now live in
   `src/memory/search.ts`; rehearsal counters in `src/memory/store.ts`.
3. **[done] #5 configurable permission rules** — `permissions: PermissionRule[]`
   in config, evaluate deny/allow/fast rules before built-ins; credential/secret
   invariants stay non-overridable (`src/permission.ts`, `src/reflexes.ts`).
4. **[done] #4 dream consolidation** — `src/memory/dream.ts` + `jarv-genie dream`
   CLI: LLM background consolidation (gates cheapest-first, mtime+PID single-flight
   lock with stale reclaim, recency guard, fail-open JSON validation, destructive
   rewrite keeping ids of unchanged facts so vectors stay valid).
5. **[done] #2 +#6 +#7 hardening batch** —
   - #2 `validateToolset()` (TOOLSET_CONSTRAINTS) finalized in `buildAgent`.
   - #6 per-path async file-op lock (`src/tools/filelock.ts`) wrapping file
     write/read/delete + `code_edit`.
   - #7 `use_tool` meta-dispatch (`src/tools/useTool.ts`), `mcpServer` tag on
     imported MCP tools, corrective native-vs-external errors, `ToolContext.tools`
     handle back to the registry.
6. **[done] #8 +#9 structural polish** —
   - #8 capability modes (`src/capability.ts`): `read-only ⊂ {read-write, execute} ⊂ all`
     partial order; `ToolRegistry.setCapability/listInMode` + execute-time enforcement;
     `TaskRunnerOptions.capability` for read-only "plan mode".
   - #9 skills folder convention (`src/skills.ts`): `JARV_HOME/skills/<name>/SKILL.md`
     loaded and injected into the system prompt (config `agent.skillsPath`).

All items #1–#9 from this plan are implemented and green (247 tests).

Each lands with tests (`npm test`, 176+ now) and a `self_review`. Consent is
obtained before any behavior-affecting change behind the Telegram gate.

---

## Attribution

Patterns are derived from reading xAI's `grok-build` (Apache-2.0), notably the
crates `xai-grok-tools`, `xai-grok-memory`, `xai-grok-hooks`,
`xai-grok-config-types`, `xai-grok-workspace`, and `xai-hooks-plugins-types`.
No first-party source is copied into this repo; concepts are re-implemented in
Jarv's own TypeScript style. grok-build's third-party ports (opencode/codex tool
impls) remain under their own licenses and are not being brought in.
