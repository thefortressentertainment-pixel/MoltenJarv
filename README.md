# Jarv Genie

A standalone, local-first personal AI assistant for your own devices.

Jarv Genie is a single-purpose project. It is not affiliated with, derived from,
or a fork of any other software project. Everything lives in this repository.

## What it is

Jarv Genie is an agentic personal assistant built on three pillars:

1. **Agent core** — a tool-calling agent loop that plans, calls tools, reads
   results, and answers. Works with any OpenAI-compatible endpoint.
2. **Memory** — durable, semantic memory. Facts you teach it are embedded and
   retrievable by meaning, and conversations persist across sessions.
3. **MCP** — the Model Context Protocol. Jarv Genie *exposes* its tools as an
   MCP server (any MCP host can drive it) and *consumes* external MCP servers as
   tools (calendar, files, databases, whatever you connect).

The default configuration is **local-first**: it points at a local model server
(e.g. [Ollama](https://ollama.com)) and only falls back to a cloud endpoint when
the local one is unreachable. Your data stays on your machine by default.

## Quickstart

Requirements: Node.js 20+ (brew: `npm i -g jarv-genie` once built), and for voice:
`brew install sox whisper-cpp` plus a whisper model (see *Voice*).

```bash
git clone <your-remote> ~/jarv-genie   # or copy this repo wherever you like
cd ~/jarv-genie
npm install
npm run build
npm install -g .   # optional but recommended: `jarv-genie` works from anywhere
```

Start a conversation:

```bash
npm start
```

Or, with a local model server already running (e.g. `ollama serve` + `ollama
pull llama3.2`), everything works out of the box. To use a cloud fallback, set
`OPENAI_API_KEY` in your environment.

## Usage

### App-style UI

Jarv Genie ships with a chat app, not just a prompt box. Start it and your
browser opens it automatically:

```bash
npm start -- ui              # or: jarv-genie ui
npm start -- ui --port 4000  # custom port
npm start -- ui --host 0.0.0.0 --no-open   # reachable from your LAN, no auto-open
```

The UI is a local web app served by Jarv Genie itself on `127.0.0.1` (default
`http://127.0.0.1:3001`). It has chat bubbles, a typing indicator, suggested
prompts, a details panel (model switch, tools, memory count, status), and a
"New" button to reset the conversation.

### One brain, all your devices

Jarv Genie can run as a **hub**: the chat app and the agent live on one machine
(usually your desktop), and every other machine calls that one brain. The hub
is reachable over your LAN (or over [Tailscale](https://tailscale.com) so it is
reachable even when you're away from home), and every request is authenticated
with a bearer token.

On the hub machine, start the brain bound to your network:

```bash
jarv-genie hub --host 0.0.0.0 --no-open   # reachable from your LAN
```

> On a Mac that sleeps, install Tailscale so the hub is reachable from any of
> your devices regardless of network.

The hub now requires a token on all API routes. Print it and pair each client
machine:

```bash
jarv-genie hub --token                    # on the hub machine
# on each client machine:
jarv-genie link http://<hub-ip>:3001 <token>
jarv-genie --remote "what time is it?"    # one-shot against the hub
jarv-genie --remote                       # interactive session against the hub
jarv-genie --remote --doctor              # check the hub from here
```

Loopback traffic (`127.0.0.1`, `localhost`) stays token-free by default. To
require a token even on loopback, start with `--no-auth` disabled explicitly:
`jarv-genie hub --host 127.0.0.1 --auth` (see *Hub security* below).

```bash
jarv-genie unlink                         # forget the hub on this machine
jarv-genie --remote http://<other-ip>:3001   # use a specific hub without relinking
```

Client machines store only `{url, token}` in `~/.jarv-genie/link.json` (0600).
The hub keeps its token in `~/.jarv-genie/auth.json` (0600); rotate it any time
with `jarv-genie hub --new-token`.

Because the hub is just the same Jarv Genie agent, all tools, memory, and the
MCP server still work — they now answer to every paired device.

### Hub security

- When the hub is bound beyond loopback, `/api/*` routes require
  `Authorization: Bearer <token>`; static UI assets stay public.
- The token is generated once and stored with `0600` permissions; rotate it
  with `jarv-genie hub --new-token`.
- Pairing stores the token on the client with `0600` permissions. Rotating the
  hub token invalidates every linked client until you re-link them.

### Native dock app (macOS) — click to open, talk to use

The fastest way to use Jarv Genie is the native app: double-click it, and a
chat window opens with a **microphone button** — click it, say your command, and
Jarv Genie answers out loud. It starts the hub for you, so there is no terminal
involved.

```bash
# once (first time):
npm install -g .                 # install the hub globally (from the repo root)
jarv-genie voice --setup-piper   # optional: fast neural TTS for replies

# open the app:
open desktop/src-tauri/target/release/bundle/macos/JarvGenie.app
# or drag desktop/src-tauri/target/release/bundle/dmg/JarvGenie_0.1.0_aarch64.dmg
# onto Applications to install it like any other app.
```

In the app window:

- **🎙 mic button** — click and talk; it auto-stops when you pause, transcribes,
  answers in the chat, and reads the reply aloud (Piper or macOS `say`).
- **Voice toggle** — hands-free mode: after each reply it keeps listening, so
  you can keep talking without touching anything. Click the mic again to stop.
- If the hub isn't installed globally yet, the window tells you to run
  `jarv-genie hub` once from a terminal.

Rebuild the app after hub upgrades: `cd desktop && npm run build` (or `npx tauri
build`). The app needs Microphone (and optionally Screen Recording) permission
the first time you use voice.

### Task links — click a link, Jarv Genie runs it

The app registers the `jarvgenie://` URL scheme, so any hyperlink — on a web
page, in a doc or email, or from the terminal — can launch the app and hand it
a task to run. No typing:

```
jarvgenie://run?task=<url-encoded command>
```

```html
<a href="jarvgenie://run?task=Start%20my%20music">Start my music</a>
<a href="jarvgenie://run?task=Remind%20me%20to%20stretch%20in%20an%20hour">Stretch reminder</a>
<a href="jarvgenie://run?task=What's%20on%20my%20screen%3F">What's on my screen?</a>
```

Clicking the link starts the app (or brings it to the front), makes sure the
hub is running, then sends the task straight into the chat. From the terminal:

```bash
open "jarvgenie://run?task=Start%20my%20music"
```

Any command you can type in the chat — questions, reminders, tool calls,
monitors, anything on this machine — can ride in on a link. Same for voice:
the mic button and hands-free mode work for everything the machine can do.

### Updating — publish once, every machine gets prompted

Jarv Genie is self-hosted, so "updates" are something you publish, and every
other machine (on your tailnet, or anywhere a hub is linked to yours) picks
them up automatically.

**Publish a new build** on the machine that distributes it (usually your host):

```bash
jarv-genie update publish JarvGenie_0.1.1_aarch64.dmg --version 0.1.1 --notes "what changed"
```

That stages the installer and a manifest where the hub can serve them. The hub
then exposes it at `GET /api/update`.

**Everyone else gets prompted automatically.** A hub checks for updates:

- against its own published manifest (the machine that published it), or
- against any update server you point it at — e.g. your host over Tailscale:

```bash
jarv-genie hub --update-url http://<your-host>:3001
```

When a newer version exists, the chat window shows a banner: *"Jarv Genie vX is
available"* with a **Download & update** button. Clicking it pulls the new
installer from the host into `~/Downloads` and opens it. From a terminal you can
check too:

```bash
jarv-genie update list                 # what this machine has published
jarv-genie update check                # up to date? (checks linked hub / local manifest)
jarv-genie update check --url http://<your-host>:3001
```

### Voice — talk to it out loud

A fully local voice loop on the hub machine: mic → transcription → agent →
spoken reply. The same pipeline powers the app's mic button via the hub
(`POST /api/voice/transcribe` + `POST /api/voice/speak`), so voice works in any
browser, too.

```bash
brew install sox whisper-cpp
# download a whisper model (or point JARV_GENIE_WHISPER_MODEL at one):
curl -L -o ~/.cache/whisper/ggml-base.en.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin

jarv-genie voice            # press Enter to talk; it stops after a pause
jarv-genie voice --remote   # talk to a linked hub from another machine
jarv-genie voice --live     # live captions while you speak (streaming STT)
jarv-genie voice --wake     # hands-free: answers when you say "hey jarv"
jarv-genie voice --setup-piper  # optional: install neural TTS for faster replies
```

Press Enter to start recording (it auto-stops after ~2s of silence), `!` toggles
speaking, `/new` resets the session. Transcriptions use local whisper.cpp;
macOS `say` does the talking (184+ voices, sentence-streamed with barge-in).
If no whisper model is available it falls back to the OpenAI transcription API.
The agent can also speak on demand from any surface via the `speak_text` tool.

- **`--live` (streaming STT)** — captions appear in near-real-time as you speak
  (rolling whisper partials over the raw mic pipe), so you see what is heard
  before the final pass.
- **`--wake` (wake word, hands-free)** — it keeps listening and only responds
  when you say "hey jarv" (or `--wake-phrase "…"`, repeatable). Say the wake
  word alone and it prompts for the request; "stop"/"goodbye" puts it back to
  sleep. All local — no cloud keyword spotting.
- **`--setup-piper` (faster neural TTS)** — installs Piper into a private venv
  (`~/.jarv-genie/piper-venv`) and downloads an English voice
  (`~/.jarv-genie/voices/`). Replies then use Piper (sub-second, natural) with
  macOS `say` as fallback.

### Scheduled agent — briefings and reminders

Run a lightweight daemon that fires prompts on a cron schedule and delivers the
answer as a macOS notification, speech, or both:

```bash
jarv-genie agent schedule "@daily" "Give me a 3-line morning briefing" --notify
jarv-genie agent schedule "*/30 * * * *" "Remind me to stand up" --speak
jarv-genie agent list        # show schedules + last run
jarv-genie agent run <id>    # fire one now
jarv-genie agent once "…" --notify
jarv-genie agent             # run the daemon (fires missed runs after sleep)
```

Schedules live in `~/.jarv-genie/agent.json`; missed runs (e.g. the Mac was
asleep) fire once on wake.

### Device sidecars — push to any machine

A sidecar connects a device to the hub and listens for pushes, so Jarv Genie can
reach you anywhere, not just on the hub machine:

```bash
# on the hub machine (the brain already runs as a hub):
jarv-genie hub --host 0.0.0.0 --port 3001

# on each device you want to reach (same network or Tailscale):
jarv-genie link http://<hub>:3001 <token>
jarv-genie sidecar --speak      # keep it running; delivers pushes on this device

# from anywhere, push a message to connected devices:
jarv-genie notify "Stand up and stretch" --device imac --speak
```

`jarv-genie sidecar` registers the machine with the hub and long-polls for
events (notifications by default, `--speak` also reads replies aloud). The
scheduled agent pushes its deliveries to sidecars when it runs with `--remote`,
so briefings land on the machines you're actually using. Undelivered events
persist in `~/.jarv-genie/events.json` until a device comes back online.

### Monitors — long-horizon watches

Watch a directory, a web page, or a command's output and get the agent's take
the moment it changes:

```bash
jarv-genie monitor add dir ~/Downloads "Summarize what just landed" --every 60 --notify
jarv-genie monitor add web https://status.example.com "Is the service having trouble?"
jarv-genie monitor add metric "df -h / | tail -1" "Tell me if the disk is getting full" --every 600 --speak
jarv-genie monitor list      # show watches
jarv-genie monitor remove <id>
jarv-genie monitor           # run the daemon (checks every 30s, fires on change)
```

Monitors snapshot their target on add and fire only when it actually changes
(new/modified files, different page content, changed command output). Works
locally or with `--remote` against a hub. Config lives in
`~/.jarv-genie/monitors.json`.

### Computer use

The agent can see and control the hub machine (macOS):

- `screen_capture` — captures the screen and describes it via a vision model
  (default `llama3.2-vision` on the primary endpoint). Requires macOS
  Screen Recording permission.
- `open_app` — opens any app by name.
- `run_apple_script` — runs AppleScript/System Events. **Gated**: set
  `"computer": { "allowControl": true }` in `~/.jarv-genie/config.json` first
  and grant Accessibility permission. This is the on-ramp to full agentic
  desktop control with explicit approval.

### Interactive session

```bash
npm start
```

```
jarv-genie> remember my favorite coffee is an americano
jarv-genie> what do I like to drink?
```

In-session commands:

| Command | Effect |
| --- | --- |
| `/help` | Show available commands |
| `/new` | Start a fresh conversation (memory is kept) |
| `/model <name>` | Switch the primary model, e.g. `/model llama3.2:3b` |
| `/tools` | List all tools available to the agent |
| `/memory` | Show how many facts the agent remembers |
| `/quit` | Exit |

### One-shot

```bash
npm start -- "what time is it?"
```

### Diagnostics

```bash
npm run doctor
```

Prints whether each configured endpoint (primary, fallback, embeddings) is
reachable and what model it resolves to.

### Manage API keys securely

Instead of editing config files or exporting secrets by hand, store keys in the
protected secrets file with the `key` command:

```bash
jarv-genie key set OPENAI_API_KEY        # prompts — input is hidden
jarv-genie key set GROQ_API_KEY groq-…   # or pass the value directly
jarv-genie key list                       # names only; values are masked
jarv-genie key rm OPENAI_API_KEY
```

Keys are written to `~/.jarv-genie/secrets.json` with `0600` permissions, never
to `config.json`, and never logged. Precedence when resolving a key: config
value → secrets file → environment variable.

### Run as an MCP server

Expose Jarv Genie's tools (memory, files, time, web search) to any MCP host:

```bash
# stdio transport (works with Claude Desktop, ChatGPT, etc.)
npm start -- --mcp

# streamable HTTP transport
npm start -- --mcp --transport http --port 3000
```

### Consume external MCP servers as tools

Add servers to the config and the agent can call their tools:

```json
{
  "mcp": {
    "servers": [
      { "name": "calendar", "command": "npx", "args": ["-y", "@some/calendar-mcp"] }
    ]
  }
}
```

## Configuration

On first run, Jarv Genie writes a config file to `~/.jarv-genie/config.json`.
Environment variables and config values override the defaults:

| Setting | Env var | Default |
| --- | --- | --- |
| Primary endpoint | `JARV_GENIE_PRIMARY_BASE_URL` | `http://127.0.0.1:11434/v1` (Ollama) |
| Primary model | `JARV_GENIE_PRIMARY_MODEL` | `llama3.2` |
| Fallback endpoint | `JARV_GENIE_FALLBACK_BASE_URL` | `https://api.openai.com/v1` |
| Fallback model | `JARV_GENIE_FALLBACK_MODEL` | `gpt-4o-mini` |
| Fallback API key | `OPENAI_API_KEY` | — |
| Embeddings model | `JARV_GENIE_EMBEDDINGS_MODEL` | `nomic-embed-text` (local) |
| Workspace dir | `JARV_GENIE_WORKDIR` | `~/.jarv-genie/workspace` |
| Memory dir | `JARV_GENIE_MEMORY_DIR` | `~/.jarv-genie/memory` |

Any OpenAI-compatible endpoint works for the primary or fallback: OpenAI,
Ollama, LM Studio, vLLM, Groq, Together, DeepSeek, local gateways, etc. Just
point `baseUrl` at it and pick a model. API keys are read from the secrets file
(see *Manage API keys securely*), environment variables, or a config value —
secrets are never written to the config file.

## Data & privacy

- Memory, sessions, and the file-tool workspace live under `~/.jarv-genie/`.
- Nothing leaves your machine except calls you configure: the model endpoint(s)
  and any external MCP servers you add.
- Embeddings default to a local model (`nomic-embed-text` via your local server)
  so semantic memory works offline and privately.

See [docs/PRIVACY.md](docs/PRIVACY.md), [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md),
and [docs/ROADMAP.md](docs/ROADMAP.md).

## License

MIT. See [LICENSE](LICENSE).
