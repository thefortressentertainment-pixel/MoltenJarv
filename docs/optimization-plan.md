<!-- Top-of-file comment added by Jarv Genie on 2026-08-04. -->
<!-- NOTE: This file is managed by Jarv Genie. Optimization items are tracked here and reviewed via self_review. -->

<!-- Self-optimization plan for Jarv Genie. The soul is injected into the system prompt at src/agent/agent.ts:68 via composeSystemPrompt (src/config/soul.ts:60). -->
<!-- Reviewed 2026-08-04 by Jarv Genie. -->
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

## Process

Deliberation happens in VSCodium (`/Users/tfe/jarv-genie`) on demand. Jarv reads
this file, the source, and the tests; proposes a change; gets consent; applies
it; runs `self_review`; and reports back. Iterate.

## Current health

- Tests: 119 passing
- Model: deepseek-chat (primary) / qwen2.5:3b (local fallback)
- Tools: 53; consent gate armed via Telegram (@MoltenJarvbot)
- Services: hub (always-on, 0.0.0.0), heartbeat (schedules), telegram bridge
  (keep-awake), keepawake — all with full PATH via launchd
