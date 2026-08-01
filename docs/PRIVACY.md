# Privacy

Jarv Genie is designed to be local-first. Here is exactly what that means in
practice.

## What stays on your machine

- Your conversation history — `~/.jarv-genie/memory/sessions/*.jsonl`
- Your remembered facts — `~/.jarv-genie/memory/facts.json`
- Embedding vectors for semantic search — `~/.jarv-genie/memory/facts.vectors.json`
- The file-tool workspace — `~/.jarv-genie/workspace`
- The config file — `~/.jarv-genie/config.json` (contains no secrets)

## What leaves your machine

Only the traffic you explicitly configure:

1. **Model endpoints.** Every prompt, tool schema, and tool result is sent to
   whatever endpoint you point the agent at. The default primary is a *local*
   server (`http://127.0.0.1:11434`), so with Ollama running nothing goes to the
   internet at all. The fallback and embeddings endpoints are only contacted when
   you configure them (or when the primary is unreachable).
2. **External MCP servers.** Servers listed under `mcp.servers` in the config
   are the only external integrations the agent can reach, and only their tools
   are exposed.

## API keys

Keys are read from environment variables (e.g. `OPENAI_API_KEY`), never written
to `~/.jarv-genie/config.json`. No key material is stored in this repository.

## Recommendations

- Run a local model server (Ollama / LM Studio / llama.cpp) for the primary
  endpoint; your conversations never leave the machine.
- Only add a cloud fallback if you need frontier reasoning, and be aware that
  prompts and results will transit that provider.
- Review the `mcp.servers` list in your config — each entry can see the context
  the agent shares with it.
- The file tools are sandboxed to `agent.workdir`; paths outside it are rejected.
