# Jarv Genie — Self-Optimization Plan

Goal: Jarv can do anything the user can do on this Mac, from anywhere, with
explicit consent from Telegram — and can keep improving itself.

Status of each item: `[x]` done, `[ ]` open, `[~]` needs a key/config.

## Capability: full Mac control (Jarv "at the wheel")

- [x] Consent gate — consequential tools wait for explicit Telegram yes/no
- [x] Shell execution (`run_shell`), full filesystem read/write/delete
- [x] UI control: activate / click / type / keys / quit / list windows
- [x] Open Clock → Alarms (`open_alarms`)
- [x] Draw shapes (`draw_shape`, ImageMagick) and open them
- [x] Reminders (create/list/delete) and scheduler (cron, names accepted)
- [x] Web (search + read), email (SMTP/IMAP), Moltbook, voice, memory, monitors
- [x] `jarv-genie perms` one-time macOS permission setup (Accessibility OK)
- [x] Reliability: TaskRunner (plan→execute→report), honest failures, empty-output
      nudge, no fake tool calls

## Capability: model that can actually think

- [~] Make DeepSeek the working brain. The local `qwen2.5:3b` is too weak for
      real self-optimization (it fakes work, invents args, gives up).
      Unlock: `jarv-genie key set DEEPSEEK_API_KEY <key>` — already configured
      as the fallback provider. Decide routing: DeepSeek for tool-heavy tasks,
      local model for casual chat.
- [ ] Route the TaskRunner planner/report to the strong model only, keeping the
      local model for chat — the deliberation runs on DeepSeek.

## Capability: proactive (not just reactive)

- [ ] `telegram_send` tool so Jarv can message the owner on its own (scheduled
      results, alerts, optimization reports) instead of only replying.
- [ ] Self-review scheduled task: open VSCodium at the repo, run `npm test`,
      review status, report to the owner, propose next optimization.

## Process

Deliberation happens in VSCodium (`/Users/tfe/jarv-genie`). Jarv reads this
file, the source, and the tests; proposes a change; gets consent; applies it;
runs `npm test`; and reports back. Iterate.

## Current health

- Tests: 101 passing
- Model: qwen2.5:3b (primary) / deepseek-chat (fallback, awaiting key)
- Tools: 40+; consent gate armed via Telegram (@MoltenJarvbot)
