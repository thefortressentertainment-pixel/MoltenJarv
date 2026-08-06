# Architecture

Jarv is architected as a living system — a body plan, not a flat pile of
features. Every component maps to an organ. See
[`docs/ANATOMY.md`](ANATOMY.md) for the full body map (nervous system, senses,
organs, limbs, immune system, the soul). The high-level shape:

```
                    ┌─────────────────────────────────────────────┐
                    │     LIMBIC SYSTEM / SOUL  (SOUL.md)         │
                    │   identity · instincts · moral anchors      │
                    └───────────────────┬─────────────────────────┘
                                        │
                    ┌───────────────────▼─────────────────────────┐
                    │          NEOCORTEX (conscious reason)       │
                    │   system prompt + history + tools           │
                    │   loop: plan → call tools → observe → reply │
                    └───────┬───────────────────────┬─────────────┘
                            │                       │
              ┌─────────────▼───────────┐   ┌───────▼──────────────┐
              │ SPINAL CORD (reflexes)  │   │  PERIPHERAL NERVES   │
              │  hard blocks + fast     │   │   Tool Registry      │
              │  path, pre-cortex       │   │   dispatch           │
              └─────────────┬───────────┘   └───────┬──────────────┘
                            │                       │
        ┌───────────────────▼───────────────────────▼─────────────┐
        │          AUTONOMIC NERVOUS SYSTEM                       │
        │   sense() vitals · regulate() → clean/compact/backoff   │
        └────────────┬──────────────────────────────┬─────────────┘
                     │                              │
   ┌─────────────────▼──────────┐   ┌───────────────▼───────────┐
   │  SENSES · ORGANS · LIMBS   │   │   Model Router            │
   │  eyes ears hands memory    │   │   primary → fallback      │
   │  immune barrier            │   │   (local-first)           │
   └────────────────────────────┘   └───────────────┬───────────┘
                                                    │
                     ┌──────────────────────────────▼───────────┐
                     │  OpenAI-compatible providers + MCP        │
                     │  (cloud + Ollama) · MCP server/client     │
                     └──────────────────────────────────────────┘
```

## Modules

| Module | Responsibility |
| --- | --- |
| `src/agent` | Types (`ChatMessage`, `ToolDefinition`, `MemoryService`) and the agent loop. |
| `src/providers` | `Provider` interface, OpenAI-compatible implementation, and the `ModelRouter`. |
| `src/memory` | Durable fact store, session store, embeddings, and semantic/keyword search. |
| `src/tools` | The tool registry and built-in tools (time, sandboxed files, memory, web search). |
| `src/mcp` | An MCP *server* that exposes the tool registry, and an MCP *client* that imports external servers as tools. |
| `src/config` | Defaults, env overrides, deep merge of `~/.jarv-genie/config.json`, API-key resolution. |
| `src/cli` | Interactive REPL, one-shot mode, doctor. |
| `src/index.ts` | Entry point: argument parsing and mode dispatch. |
| `src/voice`, `src/computer` | Stubs for the planned voice and computer-use interfaces. |
| `src/resource.ts` | The **autonomic nervous system** — `sense()` vitals and `regulate()` (cleanup, compaction, backoff). |
| `src/agent/taskrunner.ts` | The **neocortex + spinal cord** — planning loop with a reflex layer (hard blocks, fast path) before each model call. |

> **Body plan:** every tool carries a `system` tag (`sense | effector | memory |
> voice | autonomic | immune | integration`), and the registry exposes
> `bySystem()`, `senses()`, `effectors()`, `organs()`. See `docs/ANATOMY.md`.

## Data flow

1. The user sends a prompt (REPL, one-shot, or a remote MCP host).
2. The `Agent` assembles messages: system prompt + persisted session history +
   the new user turn.
3. The `ModelRouter` asks the primary provider for a completion with the current
   tool list attached.
4. If the model returns `toolCalls`, each is executed by the `ToolRegistry`
   against a `ToolContext` (memory, config, sandboxed workspace), and the results
   are fed back to the model. This repeats up to `agent.maxSteps`.
5. The final text is returned. New turns are appended to the session store so
   the next run continues where the last one left off.

## Local-first routing

The router tries the **primary** provider first. If it throws (server down,
network error, bad key), it transparently retries on the **fallback** provider.
The provider you configure can be any OpenAI-compatible endpoint, so "primary"
might be a 3B local model for speed and privacy, with a frontier cloud model as
the fallback for the hard stuff.

## MCP design

- **Server**: every tool in the registry is registered on an MCP server. Run it
  with `--mcp` (stdio) or `--mcp --transport http` (streamable HTTP). Any MCP
  host can then invoke Jarv Genie's memory and file tools.
- **Client**: external MCP servers listed in `mcp.servers` are connected at
  startup; their tools are namespaced as `<server>__<tool>` and merged into the
  registry so the agent can call them natively.

## Extension points

- **Add a tool**: implement a `ToolDefinition` and register it. It automatically
  appears for the agent *and* on the MCP server.
- **Add a provider**: implement the `Provider` interface in `src/providers`.
- **Swap memory backend**: implement `MemoryService` in `src/agent/types.ts`.
