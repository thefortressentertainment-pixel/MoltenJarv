# blender-cli — natural language to Blender, local models only

`blender-cli.sh` takes a plain-English prompt, asks a **local** Qwen model
(via Ollama on this Mac) to write Blender Python (`bpy`), then runs it
headless in Blender and verifies the result.

## Usage

```sh
# 4B primary (default)
/Users/tfe/MoltenJarv/scripts/blender-cli.sh --name my-build "build a wooden table with four legs"

# 2B explicitly
/Users/tfe/MoltenJarv/scripts/blender-cli.sh --model qwen3.5:2b --name my-build "build a wooden table"
```

Env overrides: `JARV_MODEL` (default `qwen3.5:4b`), `JARV_MODEL_FALLBACK`
(default `qwen3.5:2b`), `OLLAMA_URL` (default `http://127.0.0.1:11434`).

## What it does, step by step

1. **Generate** — POSTs to Ollama `/api/chat` with `think: false` (Qwen3.5
   is a thinking model; with thinking on it burns the whole token budget on
   a reasoning trace and returns no code), `temperature 0.1`,
   `num_predict 4096`. Retries once after 15 s on an Ollama HTTP 500
   (the MLX runner 500s intermittently under RAM pressure on this 8 GB M1).
2. **Extract** the single ```python block from the reply. If the primary
   model fails or returns no code, falls back to `qwen3.5:2b` once.
3. **Sanitize** — fixes the small models' repeatable bpy mistakes before
   Blender ever sees the script:
   - `x = bpy.ops...` → call + `x = bpy.context.active_object` (operators
     return `{'FINISHED'}`, not an object);
   - drops stray `save_as_mainfile`/`save_as_mainpath` lines (the runner
     does the save — a model save writes a stray `output.blend`);
   - drops bad `scene.world = <light>` assignments and `.link(data=...)`.
4. **Run** headless: `/Applications/Blender.app/Contents/MacOS/Blender
   --background --python <script>`, saving `<name>.blend`.
5. **Repair** — if Blender rejects the script, the same model gets ONE
   repair pass with the traceback, then Blender re-runs.
6. **Verify** (bpy-verify skill): reopens the `.blend`, prints the object
   list, and renders a 640×480 Workbench PNG still.

## Outputs

`~/.jarv-genie/blender/cli/<name>-<YYYYMMDD-HHMMSS>/` — the generated
`.py`, the wrapped `.run.py`, `<name>.blend`, `<name>.png`, `blender.log`,
`verify.log`, and the raw Ollama replies (`reply-*.txt`, `ollama-*.json`).

## Skills wired in

- `bpy-cheatsheet` (`~/.jarv-genie/skills/bpy-cheatsheet/SKILL.md`) —
  verified headless-safe snippets are embedded in the system prompt.
- `bpy-verify` (`~/.jarv-genie/skills/bpy-verify/SKILL.md`) — the object
  count + render check after every run.

## Model policy

Local Qwen only: primary `qwen3.5:4b`, fallback `qwen3.5:2b`, both via
Ollama at `http://127.0.0.1:11434`. No cloud models, no DeepSeek. The
MoltenJarv hub runner (`src/blender/runner.ts`) was patched the same way:
its `forceLocal` path used to point at `qwen2.5:0.5b`, which is not
installed; it now points at `qwen3.5:2b`.

## Known limits (measured 2026-11-13)

- **Slow.** 4B generation of ~450 tokens takes ~3–4 min on this 8 GB M1
  (model load + ~2–3 tok/s under RAM pressure). 2B is faster. This is a
  "start it and come back" tool, not interactive.
- **Ollama HTTP 500s happen** (MLX runner, RAM pressure). The retry usually
  covers it; if both attempts 500, wait a minute and re-run.
- **Reference-image builds need a vision model** (`llava`/`moondream`
  in `~/.jarv-genie/config.json`) — neither is installed in Ollama, so
  photo-reference shape specs are best-effort and will fail gracefully.
  Text-only builds are unaffected.
- Blender here is **5.1.1** at `/Applications/Blender.app` (not the
  Homebrew cask, which would be 5.3.0). No install was needed.

## Test evidence (2026-11-13)

- 4B: "create a cube and a sphere" → `cube-sphere-20261113-152016/cube-sphere.blend`
  (106,920 bytes), objects Cube + Sphere, render PNG 296,365 bytes. PASS.
- 2B: "create a cube and a sphere" → `cube-sphere-2b-20261113-154142/cube-sphere-2b.blend`
  (105,628 bytes), objects Cube + Sphere, render PNG 306,733 bytes. PASS
  (first try with sanitizer v10; no repair pass needed).

## The Telegram blender-bot + hub (live bridge)

The CLI above is the headless path. The Telegram path is different: the
`blender-bot` polls Telegram as @JarvBlender_bot and POSTs each prompt to
the always-on hub (`POST http://127.0.0.1:3001/api/blender`), which drives
the **live GUI Blender scene** through the Jarv add-on bridge (port 3937).
That path needs the Blender GUI open with the add-on enabled — headless
Blender cannot serve the bridge (its main-thread timer never fires).

Verified 2026-11-13: with the GUI Blender open and the bridge live, the
hub built Unit_Cube + Unit_Sphere in the live scene in 3 steps via
qwen3.5:4b (scene went from 3 to 5 objects). With Blender closed the same
call answers "Blender is not open (no live bridge)" and builds nothing.

## Always-on services (launchd)

Three jobs, all `RunAtLoad + KeepAlive`, logs in `~/.jarv-genie/logs/`:

- `com.fortress.moltenjarv-hub` — `node dist/index.js hub --no-open` (:3001)
- `com.fortress.moltenjarv-blenderbot` — `node --max-old-space-size=1024 dist/index.js blender-bot` (@JarvBlender_bot)
- `com.fortress.moltenjarv-telegram` — `node --max-old-space-size=1024 dist/index.js telegram` (@MoltenJarvbot)

Check them with `launchctl list | grep moltenjarv`. If the blender-bot
ever reports Telegram `Conflict: terminated by other getUpdates`, another
unmanaged `blender-bot` process is polling the same token — find it with
`ps aux | grep 'dist/index.js blender-bot'` and kill the extra one; only
one poller can own a bot token at a time.
