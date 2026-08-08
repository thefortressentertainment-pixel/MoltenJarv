# JARVIS Blueprint — Closing the Gap Between Jarv Genie and J.A.R.V.I.S.

Master planning document (supersedes ad-hoc gaps). It is intentionally written
so Jarv can **keep upgrading when the hardware upgrades** — every line below is
tagged with a hardware tier so work that is impossible on the current 8 GB Mac
is scoped, not dropped.

**Hardware tiers**

- **T1 — now**: Apple M1 MacBook Pro, 8 GB RAM (`T1` = feasible today).
- **T2 — near**: a second machine / more RAM (≥16 GB) or a headless hub + pi.
- **T3 — future**: a dedicated AI hub (more unified memory, always-on), which is
  where heavyweight ambient capture and large local models become home-base.

Status legend: `[x]` done · `[ ]` open · `Δ` planned-in-blueprint-only.

---

## A. J.A.R.V.I.S. capability matrix vs Jarv Genie

Synthesized from the MCU wiki's J.A.R.V.I.S. "Capabilities" canon (36 distinct
functions). Each is classified: **Covered** (Jarv already does it), **Partial**
(has the substrate, missing the polish), **Gap** (missing — the harvest target),
or N/A (unrealistic for a personal device — e.g. driving a piloted flight suit).

| # | J.A.R.V.I.S. capability | Jarv status | Notes / harvest hook |
|---|---|---|---|
| 1 | Natural-language + voice UI | **Covered** | whisper STT + Piper/`say` TTS, wake word `--wake`, streaming `--live`. |
| 2 | Scheduling, organizing, relaying comms | **Covered** | calendar, reminders, scheduler, `telegram_send`. |
| 3 | Business/company admin | **Covered** | email, Moltbook, Delivery Track Record. |
| 4 | Diagnostics / status | **Covered** | `system_status`, `self_review`, `judge`. |
| 5 | Info retrieval / queries | **Covered** | web_search/read, file_find, `recall`. |
| 6 | Security / authorization | **Covered** | consent gate, risk model, fail-closed, hash-chained delivery log. |
| 7 | Lab / engineering / code work | **Covered** | `code_edit/search`, `run_shell`, TaskRunner plan→execute→report. |
| 8 | Research & experiments | **Covered** | taskrunner + checkpoints + consolidation. |
| 9 | Suit/manufacturing oversight + est. completion | **Partial** | → `watchman`/progressive task status + ETA surfacing in TaskRunner. |
| 10 | Power / energy monitoring | **Partial** | `system_status` battery/sys. → add per-app energy (`tv`/`powermetrics`). |
| 11 | Biometric / vitals monitoring | **Partial** | Apple Watch/Health integration (T2). |
| 12 | **Ambient hearing / conversation parsing** | **Gap** | see §B2 — constraint-free always-on voice (T1-optional, T2-default). |
| 13 | **Computer-use decision model (see + click)** | **Gap** | see §C1 — coordinate localization for reliable GUI driving. |
| 14 | **Environment / home / IoT control** | **Gap (Δ)** | home-assistant via ha-mcp — documented, not installed (T2/T3). |
| 15 | **Life memory (automatic extract-and-recollect)** | **Gap** | see §C4 — memory extraction loop + temporal/provenance facts. |
| 16 | **Personal knowledge ingestion (RAG over own files)** | **Gap** | see §C5 — local doc/email index (LlamaIndex pattern, T1). |
| 17 | **Self-learning: successful run → reusable skill** | **Gap** | see §C6 — OS-Copilot skill-caching closed by `judge`. |
| 18 | Concurrent multi-agent delegation | **Gap** | see §C7 — sub-agent fan-out (T2). |
| 19 | Satellite / remote sensing | **N/A** for a Mac. | |
| 20 | Piloting armored flight suit / Iron Legion | **N/A** (security-theater only). | |
| 21 | Self-destruction / Clean-Slate | **Partial/N-A** → safely mirrored as `shutdown_mac` (already fail-closed). | |

---

## B. Making talking to Jarv constraint-free (ambient listening)

**Goal (per owner):** still be able to talk to Jarv freely, on the **current**
hardware, without the current constraints (holding push-to-talk, or relying on a
single keyword). This is the #1 quality-of-life gap.

### B1. What already exists (the substrate, T1 — reuse, don't rebuild)
From `src/voice/index.ts` + `src/voice/wake.ts`:
- Mic record: `sox rec` (silence-detected auto-stop) → WAV.
- STT: `whisper-cli` local (fallback OpenAI), `--np` no-print, rolling partials.
- TTS: Piper (neural, `~/.jarv-genie/piper-venv`) or macOS `say`; barge-in.
- Wake word: transcript keyword match (`--wake`) — fully local.

### B2. Recommended design — a Jarv-native "always-ready listen" loop (T1, opt-in) — ✅ landed
Because it is **off by default**, it imposes no constraints now; owners who want
freer talk enable it. Lightweight, event-driven, no new heavy runtime:

1. **Continuous low-power mic monitor** — a `jarv-genie listen` daemon that runs
   `sox rec` in a loop writing a rolling ~3 s ring buffer, sampling energy/voice
   activity (already-isolated silence detection). Idle keeps CPU ~0 — fits 8 GB.
2. **Wake-word-gated capture (not always-recording)** — the daemon only commits
   audio to disk + transcribes once the wake phrase is heard; the ring buffer
   is in-memory and discarded. This is the privacy-preserving version of
   "always listening": Jarv is *reachable*, but it does not store ambient audio.
   This is what makes it usable "without constraints" — speech is captured the
   moment you start a request, no button, and `--wake` already accepts alias
   synonyms for reliable phrase match.
3. **Speaker label + spoken-instruction store (durable memory)** — each captured,
   transcribed utterance is written into a new `voice-log` memory that feeds
   `recall()`, so Jarv can recollect what you told it out loud (the
   "life memory" seed, §C4). Diarization deferred to T2 (`screenpipe` style).
   → `jarv-genie listen` (`src/cli/listen.ts`) runs the wake-word loop and persists
   each spoken instruction as a durable `source:'voice'` fact; `--once` for
   automation. 3 tests.
4. **Barge-in + transcript hand-back** — reuse the streaming partials so Jarv can
   acknowledge ("yes?") the instant the wake phrase triggers, then listen for
   the full request (extend the existing recording window).

**Constraint-free baseline that stays true today:** a single wake-word utterance
(the documented default) already routes into the full voice pipeline with no
phone/hands needed. The listen daemon *removes* the need to hold the button.

**Privacy framing (see `docs/PRIVACY.md`):** default off; audio only materializes
inside the event loop, never logged raw beyond the transcribed text; `deny-by-
default` reflexes gate anything that would exfiltrate it.

### B3. Future (T2/T3): screenpipe as a companion daemon
`screenpipe` (source-available, 8 GB-friendly event-driven capture; whisper-V3
local + speaker diarization + FTS + MCP) is the *heavy* route. Document it here
as the upgrade path when hardware/JARVIS-drive-level comfort arrives. **Not**
built now — avoids the privacy + weight cost on the daily driver.

---

## C. Prioritized harvests (tiered, per source)

Each becomes its own `docs/<source>-harvest-plan.md` (the established
convention) when picked up. Ranked by leverage + feasibility on T1.

### P1. Computer-use decision model — `anthropics/claude-quickstarts` → `computer-use-best-practices` (T1) — ✅ coordinate localization landed
MIT. Native-macOS reference. Jarv already can screenshot + UI-click/type; what's
missing is the **decision model** to make "see → click" reliable.
- Port the **coordinate localization round-trip** (the vision model must be shown
  the image at the size/scale it will click; translate predicted pixels back to
  real coordinates). Highest-ROI fix for `screen_capture`+`ui_click`.
  → `src/computer/locate.ts` (pure + testable: `mapPointToReal`, `normalizeToReal`,
  `bboxToPoint`, sent-width/height — the Anthropic round-trip); `screen_capture`
  now returns real `width`/`height` + invites a point; new `ui_click_at(x, y)`
  drives a real click at screen pixels; `screenDimensions()` helper. Tests:
  6 new (`test/locate.test.ts`).
- **Batched UI actions** (`computer_batch`) to chain predictable clicks in one turn. (deferred)
- **Screenshot-token pruning** (interval screenshots) to keep token cost/latency
  flat on 8 GB. (deferred)
- **Trajectory recording** (per-run click/screenshot log) → feed the `judge`
  tool so Jarv can score its own GUI runs against a task. (deferred)

### P2. Environment/home control — `homeassistant-ai/ha-mcp` (Δ / T2–T3, doc only)
MIT, 88 tools over MCP. Document-only per owner decision (Home Assistant is not
installed; heavy for 8 GB). Two patterns worth porting to Jarv **independent of
HA**: (a) **search-based tool discovery / BM25 tool-pinning** so a *small local
model* isn't overwhelmed by ~91 schemas; (b) **read-vs-write tool policy split**
(auto-approve reads, prompt writes). These two help Jarv on T1 immediately even
without installing HA. — ✅ BOTH PATTERNS PORTED:
- BM25 tool-pinning → `src/tools/pinning.ts` (`bm25ScoreTools`, `pinTools` with
  always-keep `CORE_TOOLS`), wired into `TaskRunner.usableTools()` gated by
  config `agent.toolPinning.maxTools` (opt-in; off by default). 6 tests.
- Read/write policy split → `src/risk.ts` `policyFor`/`isMutating`
  (read = auto-approve, mutating = consent-gated), with defense-in-depth: a
  READ_ONLY_TOOLS tool is never classed mutating even if mis-flagged
  consequential. 2 tests. Full suite 342 passing, typecheck + build clean.

### P3. Ambient/hearing + life-memory companion — `screenpipe` (T2/T3, doc only)
See §B3. Not built now (privacy + 8 GB). Its event-driven capture + diarization +
FTS + "pipes" (day-recap, meeting-summary) are the reference for B2 grown up.

### P4. Life memory / memory extraction — `mem0` (T1, pattern reuse) — ✅ implemented
Apache-2.0. Jarv has semantic memory of *explicit facts* (`remember`/`recall`),
but no **automatic extract-and-recollect loop** that pulls durable facts from
conversations/task runs and stores them as small retrievable memories.
- Port the **ADD-only extraction** LLM call (turn task-run transcripts + user
  messages into candidate facts → write via the existing `FactStore`, applying
  the update-don't-duplicate rule). Fully local (Ollama + local embeddings).
  → `src/memory/extract.ts` (`extractFacts`), CLI `jarv-genie extract "<text>"`,
  `source:'extraction'` provenance, dedup vs existing, fail-open. Tests:
  4 new (`test/extract.test.ts`).
- Adopt the **temporal/provenance schema from `getzep/graphiti` as a concept**:
  facts carry validity windows + episode provenance, and *stale facts are
  invalidated, not blindly overwritten* — implement in the existing JSON store,
  not a graph DB (avoids Neo4j). (Validity windows deferred to a follow-up; the
  `extraction` source tag is the provenance seed.)

### P5. Personal knowledge ingestion / RAG — LlamaIndex pattern (T1) — ✅ landed
MIT. Jarv reads files on demand but has no **queryable index over one's own
docs/emails/exports**. Port the lightweight pipeline
`SimpleDirectoryReader → vector index → query_engine`, fully local (Ollama +
the installed `nomic-embed-text`). Lazily index `~/Documents`, email exports,
etc. — paired with MinerU (already surveyed) for messy/scanned PDFs.
→ `src/rag.ts` (chunkText/discoverFiles/buildIndex/queryIndex, cosine+Jaccard
fallback, mtime-keyed incremental index so only changed files re-embed) +
`src/tools/rag.ts` (`rag_index`/`rag_query`/`rag_status`, local embeddings via
config). Index persisted to `~/.jarv-genie/rag/index.json`. Tests: 7 new
(`test/rag.test.ts`). PDFs/DOCX (heavy parsing) deferred to a MinerU-backed
T3 pass. Full suite 358 passing, typecheck + build clean.

### P6. Self-learning skills — `OS-Copilot/FRIDAY` (T1/T2) — ✅ landed (T1 read/write)
MIT. Watch how a task completes; on success, **record a reusable procedure/skill**
(like taste-skill's SKILL.md, but auto-generated from a verified run). Jarv's
`judge` + `deliverylog` already certify "done"; close the loop by letting a
verified run slot a SKILL.md into `~/.jarv-genie/skills/` — this is how Jarv
starts to genuinely "learn by doing" (T2 for full GUI-trajectory variant).
→ `src/learn.ts` (saveSkill/skillSlug/composeSkill/shouldLearn with a judge-score
gate) + `src/tools/learn.ts` (`learn_skill` tool, consequential, writes a SKILL.md
into the skills dir, refuses to generalize from low-judge runs), registered at
`config.agent.skillsPath`. Tests: 9 new (`test/learn.test.ts`). Full suite 351
passing, typecheck + build clean. (Full GUI-trajectory auto-capture → T2.)

### P7. Concurrent sub-agents — orchestrator shape from `microsoft/JARVIS`/HuggingGPT (T2)
MIT. Jarv is single-brain. Port only the **controller's task-DAG planning**
shape (plan → assign subtasks to parallel workers → merge) re-expressed as
Jarv spawning bounded, capability-restricted sub-runners — not the Python/VLLM
runtime. T2: needs the extra RAM/cores.

---

## D. Sequencing and roadmap (hardware-aware)

**Phase 1 — T1, high-leverage, no new heavy runtimes** (in dependency order)
1. P4 memory-extraction loop ✅ `src/memory/extract.ts` + `jarv-genie extract` —
   automatic durable-fact discovery from conversations/transcripts (ADD-only,
   dedup, fail-open, `extraction` provenance). 328 tests passing.
2. P1 computer-use localization ✅ `src/computer/locate.ts` + `ui_click_at` +
   `screen_capture` dimensions — the "see → click" coordinate round-trip and a
   real screen-pixel click path. 334 tests passing, typecheck + build clean.
3. P2 portable patterns ✅ BM25 tool-pinning (`src/tools/pinning.ts`, wired into
   `TaskRunner` behind `agent.toolPinning.maxTools` = 12) + read/write policy split
   (`src/risk.ts` `policyFor`). 342 tests passing.
4. P5 personal-knowledge RAG ✅ `src/rag.ts` + `rag_index/rag_query/rag_status`
   (local Ollama-embedding index over the user's own files). 358 tests passing.
5. B2 **`jarv-genie listen`** ✅ `src/cli/listen.ts` — wake-word constraint-free
   voice loop that persists each spoken instruction as a durable `voice` fact
   (`--once` for automation). 361 tests passing.

**Phase 2 — T1/T2**
6. P6 self-learning skill caching ✅ `src/learn.ts` + `learn_skill` tool — verified
   run → reusable SKILL.md, judge-score gated. 351 tests passing.
7. B2 spoken-instruction store maturity — ✅ the `listen` loop persists each spoken
   instruction as a durable `voice` fact (recallable). **Diarization** (who spoke
   when) is deferred to the T2/T3 screenpipe companion — the memory store it
   would feed already exists and is ready.

**Phase 3 — T2/T3 (hardware gates, documented not built)**
8. P3 screenpipe companion (ambient room capture + life memory + speaker diarization).
9. P7 concurrent sub-agents (needs the extra RAM/cores).
10. P2 Home Assistant control (via ha-mcp) — when HA lives off this Mac.

## Hardware-upgrade roadmap (how Jarv upgrades with the machine)

Every T1 pattern below was built to serve double duty: it is lean today and
*composed* so a bigger machine unlocks more without a rewrite.

| Capability (T1, shipped) | On 8 GB today | What upgrading unlocks (natural next step) |
|---|---|---|
| BM25 tool-pinning (maxTools 12) | Tight schema for the local fallback/cloud model | Raise `maxTools` toward ~30 and/or run a bigger local model; the pinner is model-agnostic |
| `learn_skill` caching | Verified run → reusable SKILL.md | Whole GUI-trajectory auto-capture (OS-Copilot full variant); more skills per machine |
| RAG (`rag_index/query`) | Plain-text corpus, local `nomic-embed-text` | MinerU pass for PDFs/DOCX + bigger embedding/long-context model; index grows with RAM |
| `listen` voice loop | Wake-word, single utterance, `voice` memory facts | screenpipe companion: true ambient room capture + diarization + day-recap pipes |
| P6 self-learning + `judge` | Judge-gated skill creation | Concurrent skill authors (sub-agents) + richer trajectories |

**Upgrade triggers (concrete):** ≥16 GB unified memory → enable sub-agents (P7),
screenpipe diarization, and MinerU document parsing (T2). Dedicated always-on hub
machine → full ambient home-base (T3). No code rewrite: the T1 modules are
already composed to take larger context/models by configuration.

Each harvest lands with tests (`npm test`), a `self_review`, and consent behind
the Telegram gate, tracked in its own `*-harvest-plan.md`. This blueprint is the
index; individual harvests are the units of work.

---

## E. Explicitly NOT targeting (scope guard-rails)

- **Physically driving hardware** (suits, robots, weapons) — impossible on a Mac;
  security-theater only.
- **Always-on raw ambient audio recording by default** — violates PRIVACY.md;
  the listen daemon is event-gated.
- **Cloud/large-model local inference** — unrealistic at 8 GB; routing stays
  local-first with cloud fallback, and heavy local models wait for T2/T3.
- **Multi-user / multi-owner identity** — Jarv remains single-owner by design.

## Attribution

Capability list synthesized from the Marvel Cinematic Universe Wiki
("J.A.R.V.I.S.", "Capabilities" section) analysis. Harvest candidates surveyed
from their public repos under the licenses noted (all patterns re-expressed in
Jarv's own TypeScript — nothing copied wholesale). Successor to the
`cortex/openworker/grok-build/taste-skill` harvests; each future `*-harvest-plan.md`
carries its own attribution.
