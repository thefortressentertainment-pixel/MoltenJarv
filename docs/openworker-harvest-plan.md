# OpenWorker — Harvest & Re-Optimization Plan

Reference source: `andrewyng/openworker` (MIT, 13.7k★) — Andrew Ng's open-source
AI coworker. A **Python** backend (agent engine, connectors, memory, automations)
+ React/Tauri desktop shell. This is far closer to Jarv's mission (deliver
finished work, not just chat) than grok-build was.

Unlike grok-build (Rust harness), openworker's *ideas* are directly comparable to
Jarv's TypeScript pieces. Nothing is copied — each item borrows a **pattern** and
re-expresses it in Jarv's style, in keeping with MIT (attribution below).

Jarv already has (from the grok-build harvest): structured lenient validation,
hybrid/temporal/access/MMR memory scoring, dream consolidation, deny-by-default
permission rules, per-path file lock, `use_tool` meta-dispatch, capability modes,
and a SKILL.md convention. OpenWorker's value is what it does **differently**.

---

## Highest-value ports (code, priority order)

### P1. Explicit 4-class `risk` model + a single `is_consequential()` gate

**From `coworker/risk.py` (58 lines, the cleanest thing in the repo):**
- Four `RiskClass` values: `READ`, `WRITE_LOCAL`, `EXEC`, `EXTERNAL`.
- `classify()` precedence: user override → by-name base table → metadata
  `requires_approval` → default `READ`. `is_consequential() = risk is not READ`.

**Why Jarv needs it:** today Jarv's reflex fast-path is an allowlist
(`FAST_SAFE` in `reflexes.ts`) and consequential-ness is a `consequential` flag on
individual tools. That's scattered. A declared `risk` field per tool + one
`isConsequential()` gate makes "does this need the consent engine?" a single,
data-driven decision, and gives a clean hook for future "unattended" routing
(EXTERNAL = the parked-ask trigger).

**Port:** add `risk?: 'read'|'write-local'|'exec'|'external'` to `ToolDefinition`;
`classifyTool()` in `src/capability.ts` (or a new `src/risk.ts`); replace the
`consequential` boolean reads in `taskrunner.ts`/`agent.ts` with the risk gate.

### P2. Auto-compaction: outbound-only transform (supersedes the crude trim)

**From `coworker/compaction.py` (the single best module).** Jarv's
`trimWorkingContext` (taskrunner.ts:199) drops oldest *complete rounds* on a hard
char budget — losing intent. openworker instead:
- **Trigger** = `min(0.8 × window, cap)` token budget — compacts *early*, not at
  the wall (`compaction.py:60-79`).
- **Boundary** = mechanical, zero-LLM: the earliest turn-start whose verbatim tail
  fits the keep budget; prefer user boundaries, never lead with a `tool` msg
  (`:147-174`).
- **Replacement** = `[system] + LLM summary block + verbatim tail`, applied only to
  the *outbound* view; the persisted transcript is never mutated (`:524-540`).
- **Mechanical state extraction** = files edited, shell commands + exit status,
  artifacts, tools used — pulled from tool records, zero hallucination (`:219-266`).
- **User messages preserved verbatim** (capped newest 40, `:284-298`).
- **No-LLM trim fallback** (`:455-498`): if the summarizer fails, still advance the
  boundary ~10% + emit mechanical block + a "trimmed" note.
- **8-section summary prompt + continuation contract** (`:312-334`) directly reusable.

**Port:** replace `trimWorkingContext` with a compaction module; keep the task
running budget math but add the summary/mechanical-state/verbatim-user-messages
block. This is the biggest upgrade to long-task reliability.

### P3. Memory as a revision toolset + two-tier injection

**From `coworker/memory/`** (`base.py`, `tools.py`, `sqlite_store.py`):
- **`remember`/`memory_update`/`memory_forget` by `[#id]`**, update-don't-duplicate
  so corrections replace stale facts instead of piling up (`tools.py:109-138`).
- **Two-tier injection**: below ~8k chars inject all memories in full; above it,
  flip to *index mode* — newest 10 in full, the rest as one-line summaries + a note
  telling the agent to call `memory_read` (`base.py:71-136`). No LLM needed.
- **`summary` field written at save time** (`tools.py:63-86`) — makes index mode
  work.
- **Undo / `on_saved` event** + a live `saving_enabled` check (`tools.py:54, 38`).

**Why Jarv:** `addFact` is append-only; a wrong fact can't be corrected, only
deleted, and recall has no read sub-tool. Port the id-based update/forget + a
`memory_read(id)` tool + two-tier injection + summary gist.

### P4. Writable-roots sandbox (shared list + per-root `writable`) for file/shell

**From `coworker/roots.py` + `workspace_trust.py` + `permissions.py`:**
- A **shared mutable roots list** (primary scratch dir + other `RootDir{path,
  writable, label}`) passed by reference to the permission engine, the file
  toolkit, and the context injector (`roots.py:18-31`).
- `render_context()` literally **tells the model** which dirs it may use and which
  are writable (`roots.py:61-75`) — the sandbox is both enforced *and* communicated.
- Writes must resolve under a writable root (`permissions.py:136-140`).

**Why Jarv:** Jarv sandboxes reads to `workdir` but has no per-root writable
distinction and never tells the model the boundary. On top of the existing per-path
lock this gives real directory sandboxing the model can't silently widen.

### P5. Shell-operator rejection + tokenized-prefix command allow (security)

**From `permissions.py:21-25, 216-238`:** an allow-listed `git status` must never
auto-run as the head of `git status && rm -rf ~`. Any `command` containing
`; & | > < \ $( ( \n` disqualifies it from auto-fast-path, and allow matching is on
**shlex-tokenized argv prefix** (`git status` matches `git status -s` but never
`git statusfoo`), never substring.

**Why Jarv:** the existing `run_shell` reflex only blocks secret-paths, not
chained-command escalation. This closes a real auto-approval hole in Jarv's
fast-path/allow rules.

---

## Medium / structural

### P6. The Inbox — persisted, idempotent "parked ask" queue

**From `coworker/inbox.py`:**
- Blocking actions (approval/question/plan) become first-class `pending → resolved`
  items keyed by `(session_id, tool_call_id)` for idempotency (`inbox.py:56-63,
  176-180`).
- **Visibility** `inline` (attended, redelivered on reconnect) vs `inbox`
  (unattended, cross-session queue) (`:56-63`).
- **First-responder-wins** resolution; `inbox_approver` turns a permission request
  into an item and suspends the agent (`:280-294, 382-406`).

**Why Jarv:** Jarv blocks in-process (Telegram/web consent). Making the ask a
durable, resumable item means a proactive/scheduled run can park a question and
suspend instead of dying or auto-acting. Combined with P8 it routes to the existing
Telegram surface.

### P7. Self-wake: agent-initiated suspend/resume

**From `coworker/selfwake.py`:** tools `sleep_for`/`sleep_until`/`wake_on(job)`/
`wake_on_event` (`selfwake.py:158-196`); a `WakeStore` of `pending → due → fired`,
consumed by the scheduler tick (`scheduler.py:28`). Turns "always-on" into
event-driven at ~zero idle cost.

**Why Jarv:** Jarv's daemon ticks every 30s and runs schedules. Adding
`wake_on(job)` lets a long task wait on a background process without burning
context, and the existing cron loop is the natural consumer.

### P8. Unattended = "where you're reached", not "how autonomous"

**From `coworker/unattended.py` + `inbox_routing.py`:** a per-session flag that
only **reroutes** blocked approvals/questions to the Inbox (mirroring them to a
channel with an `[id]` token; an inbound reply correlating the id resolves the
item, `inbox_routing.py:148-167`). It never changes the autonomy ceiling (that's
the permission mode).

**Why Jarv:** Jarv already has Telegram/web. Porting just the "park an ask to the
inbox and mirror it to Telegram with `[jarv:<id>]` correlation" is very small and
makes the P6/P7 triad coherent.

### P9. Split the single agent into intents via trait flags (`chat`/`code`/`cowork`)

**From `agents/base.py:43-56` + `catalog.expand()`:** an agent is *data* (a prompt +
a curated tool catalog + trait flags `family`/`messaging`/`connectors`), not code.
`chat` = no tools; `code` = git/search/shell; `cowork` = multi-root files for
deliverables.

**Why Jarv:** Jarv has one generic agent + a CODE_PLAYBOOK gate. Splitting the tool
surface by intent (light no-tools mode vs workspace mode) as *data* gives cleaner
prompts and less tool-schema bloat per task. The trait-flag mechanism is the
portable bit, not four files.

---

## Lower-value / conditional

- **Persona-as-data** (`personas/manifest.py`): a SKILL.md that also declares tools/
  connectors/permission-mode in frontmatter, with a registry + install-consent. 
  Extends Jarv's #9. Portable *concept*; skip the git-install/catalog machinery.
- **Automations-with-transcripts**: natural-language instructions + a fresh
  continuable transcript per fire + standing `"tool target"` grants
  (`automation/models.py`) so recurring jobs don't re-prompt every run. Jarv's cron
  could adopt the transcript + standing-grant framing. Medium value.
- **Dead-letter / unrouted store** (`unrouted.py`): capped, read-only record of
  errored background turns / unroutable messages — "nothing vanishes silently."
  Cheap insurance for proactive runs.

## Explicitly NOT porting (over-engineered for a local single-user assistant)

- **The 25+ connector setup-wizard / OAuth / relay ecosystem** (`connectors`,
  `cloud.py`, `relay_client.py`). Jarv already has Telegram/Moltbook; if more
  integrations are wanted, reuse Jarv's MCP client at vendor MCP URLs with a
  **pinned tool allowlist** (the `tool_defs.py:306-361` pattern).
- **Multi-inbox named routing**, PKCE/Auth0 sign-in, personas marketplace/git-install.
- **The full SQLite multi-tenant memory/session store** — Jarv's JSON+vector cache
  is fine; borrow the *API* (update/forget/read-by-id), not the store.
- **Windows ACL / screenshot pipeline** machinery.

---

## Proposed sequencing

1. **P1 risk model + `is_consequential` gate** — smallest, biggest clarity/safety win.
2. **P2 auto-compaction** (outbound summary + mechanical state + verbatim tail) —
   replaces `trimWorkingContext`. Biggest long-task reliability win.
3. **P3 memory revision tools** (`memory_update`/`forget`/`read`-by-id, two-tier
   injection, summary field).
4. **P5 shell-operator + tokenized-prefix rejection** — security hardening.
5. **P4 writable-roots sandbox** — real dir sandboxing on top of the per-path lock.
6. **P6 + P7 + P8 Inbox + self-wake + unattended** — the proactive/parked triad,
   incrementally on the existing scheduler + Telegram surface.

Each lands with tests (`npm test`) and a `self_review`, consent-gated behind the
Telegram approval gate. Current baseline: 247 tests passing.

## Status — all implemented

- **P1 done** `src/risk.ts` — 4-class risk + `isConsequential()`, behavior-preserving.
- **P5 done** `src/permission.ts` — shell-operator + tokenized-prefix command-allow gate.
- **P2 done** `src/agent/compaction.ts` — outbound summary + mechanical state + verbatim
  tail; wired into `TaskRunner.prepareContext`, replacing the crude char-drop fallback.
- **P3 done** `src/memory/` — `memory_update`/`memory_read` tools, `summary` field,
  update-don't-duplicate `FactStore.update`.
- **P4 done** `src/roots.ts` — writable-roots sandbox (per-root writable flag),
  write-scoping on file tools, boundary injected into both system prompts.
- **P6–8 done** `src/inbox.ts` + `src/selfwake.ts` + `src/unattended.ts` (+
  `sleep_until`/`wake_on_job`/`wake_cancel` tools, daemon self-wake poll).

Final: 275 tests passing, typecheck + build clean.

---

## Attribution

Patterns derived from reading `andrewyng/openworker` (MIT), notably
`coworker/{risk,permissions,compaction,roots,workspace_trust,selfwake,unattended,
inbox,inbox_routing}.py`, `coworker/memory/`, `coworker/tools/{shell,ask,subagent,
registry,plan,todo}.py`, `coworker/agents/`, `coworker/automation/`, and
`coworker/personas/`. No source is copied; concepts are re-implemented in Jarv's
own TypeScript. openworker itself builds on aisuite (also `andrewyng`, Apache-2.0);
we do not import aisuite.
