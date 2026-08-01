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
"New" button to reset the conversation. Because it is just a local web app, the
same interface can later be pointed at from any device on your network — the
first step toward running on all your devices.

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
