# Roadmap

Jarv Genie is being built in phases. This file records what exists and what is
planned, along with the concrete technology that each phase will use.

## v1 — Agent core (this release)

- [x] Tool-calling agent loop with step budget
- [x] Local-first model routing with cloud fallback
- [x] Durable semantic memory (facts + embeddings + keyword fallback)
- [x] Persistent conversation sessions
- [x] Built-in tools: time, sandboxed files, memory, web search
- [x] MCP server (stdio + streamable HTTP) exposing all tools
- [x] MCP client importing external servers as tools
- [x] Interactive REPL, one-shot mode, `--doctor` diagnostics

## v2 — Voice

The goal: talk to Jarv Genie the way you'd talk to a butler. Local-first,
sub-second, private.

- Wake word detection — `openwakeword` / Picovoice Porcupine, on-device
- Voice activity detection — Silero VAD
- Speech-to-text — `faster-whisper` / Whisper.cpp (local), or streaming STT
- Text-to-speech — Kokoro / Piper (local, tens of ms on CPU)
- Barge-in (interrupt while it speaks) and sentence-level streaming TTS
- Reference pipeline: `wake → VAD → STT → agent → TTS`, target < 2s end-to-end
  (see `src/voice/`)

## v3 — Computer use & device reach

- Screen awareness (screenshot → agent) and keyboard/mouse control via
  accessibility APIs, scoped per-app with explicit approval
- Device sidecars: a lightweight daemon on each device connecting back to one
  hub over an authenticated channel, so Jarv Genie can act across laptop, phone,
  and desktop (your `JarvGenie` macOS/desktop app becomes the front door)
- Where beneficial, delegate GUI work to a computer-use model
  (Claude Computer Use / an equivalent) for tasks that have no API

## v4 — Proactive & scheduled

- Always-on background agent with scheduled briefings (morning digest, reminders)
- Long-horizon monitors (watch a directory, a web page, a metric)
- Notifications and approvals through multiple channels (terminal, push)

## v5 — Learning

- Improve the local configuration from usage traces (OpenJarvis-style
  local-first spec search: frontier model proposes edits at "search" time, the
  optimized local spec runs at "inference" time)
- Optional on-device fine-tuning / personalization that never leaves the machine

## Principles

- **Local-first**: on-device by default, cloud only when necessary.
- **Private**: personal data stays in `~/.jarv-genie/`.
- **Standalone**: no external dependencies or affiliation — this repo is the product.
