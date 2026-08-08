# Blender Agent Skills — GitHub sweep + installed skills

Sweep of GitHub for open-source **agent skills** that help an LLM drive Blender,
kept RAM-light so Jarv runs fine alongside Blender on an 8GB M1.

## Key finding

Most "Blender agent skill" repos (`arjun988/blender-skills`, `blender-open-mcp`,
`better-blender-mcp`, `OpenClaw_BlenderMCP-Skill`, `blender-assistant-mcp`) execute
through the **BlenderMCP GUI add-on** — a heavy Blender-side socket server that
contradicts Jarv's lean, headless model. Their *domain prose* is transferable;
their *execution path* is not.

The two that **match Jarv's `run_shell → blender --background --python` model**
(greenfield, RAM-light, spawn-and-exit):

1. **`mkopr/bpy-assistant`** — the headless **write-run-fix loop** + an
   **introspect_api anti-hallucination** habit: query the live bpy signature
   before writing code (a cheap headless subprocess, not prompt tokens). Solves
   the bpy-API-changes/hallucination problem without bloating the prompt.
2. **`AleBrito124356/blender-python-toolkit`** (MIT) — **verified, version-aware,
   headless-safe bpy helpers** (clean scene, camera -Z aim, lights, AgX engine,
   sRGB→linear, FBX export) you can lift directly.

## Installed skills (runtime, `~/.jarv-genie/skills/`)

| Skill | Est. chars | Purpose |
|---|---|---|
| `blender-drive` | ~2,500 | Headless `-b -P` loop + introspect-before-you-type rule + scene-state probe |
| `bpy-cheatsheet` | ~3,300 | Verified snippets: clean scene, mesh/collection/apply, camera, lights, engine/AgX, color, FBX/render, naming+discipline |
| `output` | ~2,600 | (pre-existing) full-output enforcement |

Total injected into the system prompt: **~8,400 chars (~2,100 tokens)** — light,
well under the ~10k budget. RAM impact: none beyond a few hundred KB of prompt
text; Blender work runs as short-lived headless subprocesses.

## Verified on this machine

`blender --background --python <script> -- <in> <out> <result>` runs correctly and
returns parseable JSON (scene object list + cube create). The pattern Jarv will
use with `run_shell` works end-to-end, RAM-light.

## Why not the rest

- BlenderMCP add-ons → heavy, GUI-coupled, excluded.
- 94-file skill catalogs → would inject 60k+ chars on every call; adopts only the
  thin verified parts instead.
- Docker/Qdrant/RAG "assistant" infra → inverse of lean; only the loop/introspect
  *pattern* is taken.
- UI-automation/AppleScript keymaps → prefer headless; reserve GUI automation as
  last resort.

Attribution: patterns/verified snippets adapted from `mkopr/bpy-assistant` and
`AleBrito124356/blender-python-toolkit` (and `arjun988/blender-skills` references),
re-expressed concisely. No source copied wholesale.
