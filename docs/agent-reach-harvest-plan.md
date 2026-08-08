# Agent Reach — Harvest & Re-Optimization Plan

Reference source: `Panniantong/Agent-Reach` (MIT, 68.6k★) — "give your AI agent
eyes to see the entire internet." It's a **Python capability layer** (not one tool):
it selects, installs, health-checks, and routes the best-available **upstream
backend** per platform — Jina Reader (web), yt-dlp (YouTube captions), feedparser
(RSS), gh CLI (GitHub), Exa (semantic search), bili-cli (Bilibili), OpenCLI
(Twitter/Reddit/Instagram/Facebook) — then the agent calls those directly. No
wrapping layer; an ordered backend list per channel + `doctor` self-diagnosis.

## Why it's relevant to Jarv

Jarv already has `web_search` (DuckDuckGo HTML) and `web_read` (Jina Reader — the
*exact* backend Agent-Reach picks for web). The harvest isn't "import the repo"
(we won't ship Python). It's two genuinely portable designs:

1. **Multi-backend routing** — a `channels/`-style layer where each internet
   capability has an ordered backend list, probed in turn at `doctor` time; the
   first that actually works wins. Platform breakages (e.g. yt-dlp blocked by
   Bilibili) become a one-line list reorder, not a code rewrite.
2. **`doctor` self-diagnosis CLI** — one command that tells Jarv which channel is
   up, which backend it's currently using, and how to fix a broken one.

Everything else is "which free CLI to shell out to," which Jarv's existing
`run_shell` already enables — so we implement small, well-described tools that
call the best available backend (yt-dlp for YouTube transcripts, feedparser for
RSS, gh for GitHub, Exa via MCP for semantic search), each behind the routing +
doctor pattern.

---

## Highest-value ports (code, priority order)

### A1. Per-platform channel tools with ordered-backend routing

Add tools Jarv can already route onto via `run_shell`, each with a backend list:

- **`internet_read` funnel** — generalize `web_read` (Jina) + route fallback if Jina is down.
- **`youtube_transcript`/search** — via `yt-dlp` (already likely on many Macs); no key.
- **`read_rss`** — parse an RSS/Atom feed (feedparser or a tiny TS XML parse).
- **`github_read`/`github_search`** — via `gh` CLI (already installed on this Mac).
- **`semantic_search`** — Exa via MCP (free, no key) fallback to DuckDuckGo.
- **`search_reddit`/`read_reddit`** — only when a login backend exists; default "doctor says not configured."

Each tool surfaces the backend it used so `doctor`/the user can see the current route.

### A2. `doctor` for internet channels

A `jarv-genie doctor`-style check (extend the existing doctor) that probes each
channel's ordered backends, reports which is active, and gives a one-line fix
hint — mirroring `agent-reach doctor`. This is the highest-value, lowest-risk,
most testable piece: a pure probed-backend table + a report.

### A3. Credential hygiene passthrough

Agent-Reach's rules: cookies/tokens live only in `~/.agent-reach/config.yaml`,
0600, `--dry-run` by default, one dedicated channel per platform. Port: any new
Jarv social tool reads credentials from the existing secret/trust store (never the
prompt), keeps `--dry-run`/read-only defaults, and warns to use a throwaway
account for cookie-based platforms.

## Explicitly NOT porting

- **The Python package / install flow** (`agent-reach install`), the SKILL.md
  auto-writer, `mcporter`, and any upstream CLI we don't need.
- **China-specific channels** (Bilibili, XiaoHongShu main focus) unless wanted.
- **The big `.env`/config.yaml matrix** — Jarv uses its secret store.

## Proposed sequencing

1. **A2 doctor for internet channels** — pure, testable, zero-risk; gives the
   `channels/` active-backend table Jarv can trust.
2. **A1 tools** — `youtube_transcript`, `read_rss`, `github_search/read`,
   `internet_read` funnel (each routed via `run_shell`/fetch, backend list in code).
3. **A3 credential passthrough** — wire any platform creds through the secret store.

Each lands with tests (`npm test`, currently 281) + `self_review`, behind the
consent gate. Nothing is implemented yet; working tree clean at `503f96f`.

## Status

- **A2 done** `src/web/channels.ts` — multi-backend channel table + `doctor` wired
  into `jarv-genie --doctor`. Injectable probes.
- **A1 done** `src/tools/network.ts` + 4 new tools on `webTools()`:
  `youtube_transcript` (yt-dlp), `read_rss` (feedparser), `github_search`/`github_read`
  (gh CLI). Each routes through `activeBackend()` and returns a clean "backend not
  configured" hint when the route is down. Verified live via `gh` on this Mac.
  289 tests passing.
- **A3 (credential passthrough)** — remaining: wire any platform creds through the
  secret store (never the prompt), read-only defaults.
