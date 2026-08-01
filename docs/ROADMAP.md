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
- [x] App-style chat UI (`jarv-genie ui`) — local web app, no terminal prompt

## UI across devices

The app UI is a self-hosted local web app (`src/ui/`), so the same interface can
migrate to any device:

- **Now**: macOS browser on `http://127.0.0.1:3001`; `--host 0.0.0.0` already
  makes it reachable from phones/tablets on the LAN.
- **Done — Hub + global install**: the UI server can run as a hub
  (`jarv-genie hub --host 0.0.0.0`) with bearer-token auth on `/api/*`
  (token auto-generated in `~/.jarv-genie/auth.json`, 0600). Any machine pairs
  once (`jarv-genie link <url> <token>`) and then runs `jarv-genie --remote`
  for REPL, one-shot, or `--doctor` against the hub. Tailscale is the
  recommended private mesh so the hub is reachable even when the Mac sleeps at
  home. `jarv-genie` is installable globally (`npm i -g`), so `--remote` works
  from any machine's terminal/editor.
- **Done — Native shell**: a Tauri app (`desktop/`) wraps the web app as a real
  macOS dock app; on launch it starts `jarv-genie hub` and shows the chat in its
  own window. Streaming replies (SSE) land token-by-token in both the web UI
  and the terminal REPL for a smooth feel.
- **Later**: the v3 device sidecars let each device run its own front-end against
  one shared hub.

## v2 — Voice (done, push-to-talk)

The goal: talk to Jarv Genie the way you'd talk to a butler. Local-first,
sub-second, private. Shipped (`jarv-genie voice`):

- [x] Speech-to-text — whisper.cpp (`whisper-cli`, local), OpenAI API fallback
- [x] Text-to-speech — macOS `say`, sentence-streamed with barge-in (`stopSpeaking`)
- [x] VAD-ish auto-stop — sox `rec` silence detection (2s default)
- [x] Push-to-talk loop, `--remote` (talk to the hub from any machine)
- [x] `speak_text` agent tool (the agent can speak from any surface)
- [ ] Wake word — openwakeword / Picovoice for hands-free always-on
- [ ] Streaming STT and faster TTS (Kokoro/Piper) for sub-second replies

## v3 — Computer use & device reach

- [x] Screen awareness (`screen_capture` → vision model describes the screen;
      macOS screen-recording permission)
- [x] `open_app` (launch any app)
- [x] Scoped control with explicit approval: `run_apple_script`
      (System Events / Accessibility) gated behind `computer.allowControl`
- [ ] Device sidecars: a lightweight daemon on each device connecting back to
      one hub over an authenticated channel (the `--remote`/`voice --remote`
      channel is the current stand-in)
- [ ] Delegate GUI work to a computer-use model where no API exists

## v4 — Proactive & scheduled

- [x] Always-on background agent (`jarv-genie agent`) with cron schedules
- [x] Missed-run catch-up (fires briefings/reminders after the Mac sleeps)
- [x] Deliveries: macOS notifications, spoken replies, stdout
- [x] `agent schedule / list / run / once / remove`
- [ ] Long-horizon monitors (watch a directory, a web page, a metric)
- [ ] Notifications through multiple channels (terminal, push to phone)

## v5 — Learning

- Improve the local configuration from usage traces (OpenJarvis-style
  local-first spec search: frontier model proposes edits at "search" time, the
  optimized local spec runs at "inference" time)
- Optional on-device fine-tuning / personalization that never leaves the machine

## Principles

- **Local-first**: on-device by default, cloud only when necessary.
- **Private**: personal data stays in `~/.jarv-genie/`.
- **Standalone**: no external dependencies or affiliation — this repo is the product.
