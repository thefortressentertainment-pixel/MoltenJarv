# Kimi-K3-in-C — Harvest Note (assessed, not adopted on this hardware)

Reference: `FareedKhan-dev/kimi-k3-in-c` (Apache-2.0, 3.8k★) — a 2.78-trillion-parameter
Kimi K3 running inference on one CPU in ~8 GB RAM by streaming MoE experts from disk.

## Assessment: NOT viable as Jarv's local model on THIS machine

| Requirement | kimi-k3-in-c | This Mac (M1, 8 GB) |
|---|---|---|
| Disk | ~1.7 TB (1.56 TB ckpt + 109 GB trunk) | 22 GB free ❌ |
| OS | Linux x86-64 only (`O_DIRECT`, `posix_memalign`, `getrusage`) | macOS Arm64 ❌ |
| Speed @ 8 GB preset | ~26.5 s/token (streams off disk) | not sub-second ❌ |
| RAM | Peak RSS 8.24 GB (whole machine) | must coexist with Blender/GUI ❌ |
| Tool-calling | None (base model, no chat template) | Jarv needs function-calling ❌ |
| LLM transport | Standalone C binary, no OpenAI-compatible server | Jarv talks Ollama `/v1` ❌ |

Even ignoring RAM: it is **Linux-only** (this is a Mac), needs **1.7 TB disk**, its
8.24 GB RSS would claim the entire machine (no Blender coexistence), and it has no
function-calling — it cannot drive Jarv's tools or answer quickly. It is a
proof-of-concept for "huge model on tiny RAM via disk streaming," not a drop-in
agent model.

## What IS transferable (structure for later, T2/T3)

The core pattern — **MoE-on-disk + reset-model streaming** — is a real future
upgrade when there's a **fast NVMe + spare RAM + a Linux host or bigger hub**:
stream a much smarter local model from disk so Jarv gets a bigger brain without
16+ GB resident. Requires ~1.7 TB free + Linux; does not fit this 8 GB Mac's job
(Blender-simultaneous, low-RAM, tool-calling, fast).

## Decision

Do not integrate now. Keep the current stack: DeepSeek cloud (primary) +
qwen2.5:0.5b (RAM-light default local). For a smarter local fallback that still
coexists with Blender, prefer an OpenAI-compatible, tool-capable 1b–3b Ollama GGUF
(not disk-streaming). Logged here so disk-streaming is a known path, not a
re-discovery, when hardware allows.

Attribution: engine/presets read from `FareedKhan-dev/kimi-k3-in-c` (Apache-2.0).
Patterns only.
