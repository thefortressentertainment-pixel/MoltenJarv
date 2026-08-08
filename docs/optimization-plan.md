<!-- Top-of-file comment reviewed by Jarv Genie on 2026-08-04 (user requested this edit). -->
<!-- Top-of-file comment added by Jarv Genie on 2026-08-04. -->
<!-- NOTE: This file is managed by Jarv Genie. Optimization items are tracked here and reviewed via self_review. -->

<!-- Self-optimization plan for Jarv Genie. The soul is injected into the system prompt at src/agent/agent.ts:68 via composeSystemPrompt (src/config/soul.ts:60). -->
<!-- Reviewed 2026-08-05 by Jarv Genie. -->
# Jarv Genie — Self-Optimization Plan

Goal: Jarv can do anything the user can do on this Mac, from anywhere, with
explicit consent from Telegram — and can keep improving itself.

Status of each item: `[x]` done, `[ ]` open.

## Capability: full Mac control (Jarv "at the wheel")

- [x] Consent gate — consequential tools wait for explicit Telegram yes/no
- [x] Shell execution (`run_shell`), full filesystem read/write/delete
- [x] UI control: activate / click / type / keys / quit / list windows
- [x] Open Clock → Alarms (`open_alarms`)
- [x] Draw shapes (`draw_shape`, ImageMagick) and open them
- [x] Reminders (create/list/delete) and scheduler (cron, names accepted)
- [x] Web (search + read), email (SMTP/IMAP), Moltbook, voice, memory, monitors
- [x] `jarv-genie perms` one-time macOS permission setup (Accessibility OK)
- [x] Reliability: TaskRunner (plan→execute→report) on BOTH Telegram and the
      web hub; honest failures; empty-output nudge; no fake tool calls
- [x] Resource discipline: memory guard cleans up before tasks; busy-lock stops
      schedule pile-up; drawings self-prune

## Capability: model that can actually think

- [x] DeepSeek is the working brain (primary `deepseek-chat`), with the free
      local `qwen2.5:3b` as the offline fallback. Router only arms the fallback
      when a key is actually configured.
- [x] TaskRunner planner/report run on the strong model (DeepSeek), so the
      deliberation is real. `self_review` verified healthy on DeepSeek.

## Capability: proactive (not just reactive)

- [x] `telegram_send` tool so Jarv messages the owner on its own.
- [x] Self-review scheduled task (daily 07:30): Jarv runs `self_review`, reports
      health + the top next optimization to the owner on Telegram. VSCodium
      deliberation stays on-demand (auto-opening it daily is a nuisance).

## Hardening: no more crash-loops (implemented 2026-08-05)

Root cause of the 2026-08-05 meltdown: `com.fortress.jarvgenie-heartbeat.plist`
has `KeepAlive=true`, so a single unhandled throw in the agent daemon caused
`process.exit(1)` and launchd respawned it instantly — an infinite hot loop that
took the machine (and manual effort) to break. Five fixes now prevent this class
of failure entirely:

1. **Crash-loop breaker** (`src/scheduler/index.ts`): the daemon persists
   consecutive-crash counts and backs off exponentially (30s → … → 10 min cap)
   instead of spinning. A clean run resets the count.
2. **Dead-owner lock recovery** (`src/resource.ts`): a busy-lock left by a
   crashed task is auto-detected (owner PID no longer alive) and released, so a
   crash can't starve the heartbeat or schedule forever.
3. **Honest lock acquire** (`src/resource.ts`): `tryAcquireBusy` returns `false`
   on a write failure instead of pretending it acquired the lock (prevented a
   race where two processes both thought they held it).
4. **Tick isolation** (`src/index.ts`): each daemon tick is fully wrapped in
   try/catch, so a single bad schedule/backend call can never bubble out of the
   daemon and trigger an exit(1) crash-loop.
5. **Service hardening** (`scripts/install-services.sh`): the heartbeat service
   now has a 300s launchd `ThrottleInterval` (up from 60s) as launchd's own floor
   on respawn rate, complemented by the in-code breaker.

## Process

Deliberation happens in VSCodium (`/Users/tfe/jarv-genie`) on demand. Jarv reads
this file, the source, and the tests; proposes a change; gets consent; applies
it; runs `self_review`; and reports back. Iterate.

## Current health

- Tests: 361 (361 passing, 0 failing)
- Typecheck: clean · Build: clean
- Model: deepseek-chat (primary) / llama3.2 (local fallback) — BM25 tool-pinning
  active (agent.toolPinning.maxTools = 12) for the small local model
- Tools: ~98 registered; consent gate armed via Telegram; ~41 read-only tools,
  4-class risk + read/write policy (policyFor) split
- New capability (JARVIS blueprint, docs/jarvis-blueprint.md): memory-extraction
  (`jarv-genie extract`), coordinate-localization click (`ui_click_at`),
  personal-knowledge RAG (`rag_index/query/status`), self-learning skills
  (`learn_skill`), and constraint-free hearing (`jarv-genie listen` → durable
  `voice` memories). Index phase roadmaps live in the blueprint.
- Services: hub (always-on, 0.0.0.0), heartbeat (schedules), telegram bridge
  (keep-awake), keepawake — all with full PATH via launchd
- Hardening: crash-loop breaker + dead-lock recovery + tick isolation + service
  throttle (see above)
- Deliveries: Delivery Track Record maintained (SHA-256 hash chain), verifiable
  via deliverylog_verify

