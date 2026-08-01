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

Requirements: Node.js 20+.

```bash
git clone <your-remote> ~/jarv-genie   # or copy this repo wherever you like
cd ~/jarv-genie
npm install
npm run build
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
