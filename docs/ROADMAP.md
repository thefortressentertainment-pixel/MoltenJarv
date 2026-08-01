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
- [x] Wake word — hands-free `jarv-genie voice --wake`: keeps listening and only
      answers when "hey jarv" (or a custom `--wake-phrase`) is heard; wake word
      alone prompts for the request; "stop"/"goodbye" sleeps again. Fully local
      (transcript keyword match with whisper-proof synonyms)
- [x] Streaming STT — `jarv-genie voice --live`: live captions show what is being
      heard while you speak (rolling whisper partials over the raw mic pipe)
- [x] Faster neural TTS — `jarv-genie voice --setup-piper` installs Piper into a
      private venv (`~/.jarv-genie/piper-venv`) and downloads an English voice;
      `speak()` prefers it for sub-second replies, falling back to macOS `say`

## v3 — Computer use & device reach

- [x] Screen awareness (`screen_capture` → vision model describes the screen;
      macOS screen-recording permission)
- [x] `open_app` (launch any app)
- [x] Scoped control with explicit approval: `run_apple_script`
      (System Events / Accessibility) gated behind `computer.allowControl`
- [x] Device sidecars: `jarv-genie sidecar` runs on any device, registers with
      the hub over the authenticated channel, and long-polls for pushed events
      (notifications / spoken replies). `jarv-genie notify "<text>"` fans out to
      connected devices; the scheduled agent pushes deliveries to sidecars too.
      Pending events persist in `~/.jarv-genie/events.json` until a device
      connects (nothing is lost while a device is offline).
- [ ] Delegate GUI work to a computer-use model where no API exists

## v4 — Proactive & scheduled

- [x] Always-on background agent (`jarv-genie agent`) with cron schedules
- [x] Missed-run catch-up (fires briefings/reminders after the Mac sleeps)
- [x] Deliveries: macOS notifications, spoken replies, stdout
- [x] `agent schedule / list / run / once / remove`
- [x] Long-horizon monitors (`jarv-genie monitor`): watch a directory, a web
      page, or a command's output; fires the agent the moment the target changes
      (e.g. "tell me when files land in ~/Downloads"). Persisted snapshots mean
      nothing fires until the target actually changes.
- [x] Notifications through multiple channels — device sidecars (`jarv-genie
      sidecar`) deliver pushes to any machine; `jarv-genie notify` fans out; the
      agent daemon pushes deliveries to sidecars when running with `--remote`

## v5 — Learning

- Improve the local configuration from usage traces (OpenJarvis-style
  local-first spec search: frontier model proposes edits at "search" time, the
  optimized local spec runs at "inference" time)
- Optional on-device fine-tuning / personalization that never leaves the machine

## Principles

- **Local-first**: on-device by default, cloud only when necessary.
- **Private**: personal data stays in `~/.jarv-genie/`.
- **Standalone**: no external dependencies or affiliation — this repo is the product.
