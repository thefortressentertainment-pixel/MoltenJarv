# J.A.R.V.I.S. — what we can implement, and what Jarv does

Source: J.A.R.V.I.S. ("Just a Rather Very Intelligent System"), the MCU AI
assistant voiced by Paul Bettany — created by Tony Stark, it ran the internal
systems of his buildings and suits, delivered diagnostics, and acted with
unflappable, quietly dry competence.

Status legend: `[x]` implemented · `[~]` partial/needs config · `[ ]` aspirational

## The core: a butler for a machine

| Jarvis quality | Jarv implementation | Status |
| --- | --- | --- |
| Always present, runs everything | Always-on launchd services (hub + heartbeat + Telegram + keep-awake) | `[x]` |
| Controls the internal systems | `run_shell`, full filesystem, UI control (`ui_activate/click/type/key/quit`), reminders, scheduler | `[x]` |
| Diagnostics on demand | `system_status` — battery, CPU, memory, disk, uptime, network | `[x]` |
| Calm, precise, unflappable voice | Soul persona (J.A.R.V.I.S. register): composed, dry, competence-first | `[x]` |
| Briefs the user | `daily_briefing` — time, calendar agenda, reminders, machine status | `[x]` |
| Proactive (doesn't wait to be asked) | Scheduled heartbeats, monitors, self-review, `telegram_send` | `[x]` |
| Protects the principal | Explicit-consent gate on every consequential action | `[x]` |
| Learns and remembers | Durable memory (facts + embeddings), session persistence | `[x]` |

## The "suit" — capability beyond chat

| Jarvis quality | Jarv implementation | Status |
| --- | --- | --- |
| Deploys armor/tech on command | Opens apps, launches actions, runs the machine on command | `[x]` |
| Works on code like an engineer | `code_search` + `code_edit` (precise, verified edits) + `run_shell` tests + `self_review` | `[x]` |
| Voice interaction | Microphone → transcription → speaks replies (Piper/say) | `[x]` |
| Sees the room | `screen_capture` + vision description; `ui_get_windows` | `[~]` needs vision model |
| Holographic UI | Web UI (hub) + status readouts; a dashboard is a future step | `[~]` |
| Distributes itself / survives | Cloud fallback (DeepSeek) so the brain works even if local fails | `[x]` |
| Physically present (Vision/android) | A real robot/embodied shell — the far horizon, not feasible here | `[ ]` |

## Deliberation & self-improvement

- Jarv reviews itself: `self_review` runs the test suite + typecheck and reads
  this repo's plan, on DeepSeek. It proposes the next change, applies it with
  consent, and re-runs to verify.
- The roadmap lives in `docs/optimization-plan.md`.

## Honest limits

- A 3B local model is too weak for hard reasoning; DeepSeek is the working
  brain, qwen2.5:3b the free/offline fallback.
- True embodied presence (Vision) is out of reach on this hardware.
- The holographic UI is a stretch goal; the web UI + Telegram are the
  interfaces today.
