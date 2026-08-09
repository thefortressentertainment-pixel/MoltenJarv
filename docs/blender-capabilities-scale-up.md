# Blender capability scale-up (beyond object creation) — RAM-light

Goal: give Jarv Blender skills beyond primitives (materials, modifiers, shaders,
rendering, verification) WITHOUT increasing agent RAM. All additions are **pure
bpy executed in the already-running Blender** via the live bridge — the agent
only marshals a string + reads JSON over one HTTP round-trip. RAM impact: ~zero.

## Sources (GitHub sweep, MIT-safe where noted)

- `mlolson/blender-orchestrator` (unlicensed → reimplement, don't vendor) — full
  bpy handlers for materials/shaders (toon/skin/glass), modifiers, sculpt,
  armature/skinning, curves, scene queries, lighting, rendering (viewport
  screenshot via `bpy.ops.render.opengl`), HDRI world, and a whole scripted
  orchestration (`create_david.py`).
- `huggingface/meshgen` (MIT) — main-thread task-queue bridge + verification
  tools (`get_scene_info`, AABB/bounds via `mathutils`).
- `arjun988/blender-skills` (MIT) — skill segmentation + PBR value tables + QA
  verdict workflow. (Guidance, not code; its BlenderMCP path is not used.)
- `gd3kr/BlenderGPT` (MIT) — the minimal "emit bpy → exec" system-prompt guard.
- `k-telux/OpticalModeler` (MIT) — "measurable gate / render-audit-before-beauty"
  verification discipline.

Heavy infra (Docker, Qdrant, LLaMA-Mesh GGUF, native add-ons) was excluded to keep
RAM flat.

## What was added to Jarv

New lean skills in `~/.jarv-genie/skills/` (pure-bpy, bridge-executable):
- `bpy-material` — version-aware Principled BSDF + PBR value tables + node-graph
  essentials.
- `bpy-modifiers` — boolean(EXACT)/subdiv/bevel/mirror/solidify + mesh edits +
  `temp_override` context note.
- `bpy-verify` — object count/info, AABB + polycounts, viewport screenshot back,
  and the "measurable gate before PASS" rule.
- `bpy-render` — engine/AgX version guard, render-to-file (save/restore
  settings), HDRI world graph, lights, FBX/GLTF/OBJ/STL export.

Total always-on skill prompt: ~16.5k chars (~4.1k tokens) across 7 skills —
acceptable; RAM is governed by the isolated runner (no memory/RAG/84-tools), not
prompt size.

## Bridge fix uncovered while testing

`execute_live_bpy` used `exec(code, {"bpy":bpy}, {})` — an empty locals broke
*comprehensions* (e.g. `[o.matrix_world @ mu.Vector(c) for c in o.bound_box]`
couldn't see the earlier `bb`/`mu` names) and `print()` went to real stdout, not
the captured buffer. Fixed to a **single shared namespace** (`exec(code, ns, ns)`)
plus a `sys.stdout` swap for `print` capture. This makes ALL multi-line bpy
(including the new skills) work reliably.

## Verified in real Blender

- Material: Principled BSDF assigned to a cube → ok.
- Modifiers: bevel modifier applied → ok.
- Verify: `AABB (-1,-1,-1)…(1,1,1) verts 8` returned via stdout capture → ok.
- Render: PNG written (196KB) → ok.
- Full TS suite green; RAM unchanged.

Attribution: patterns/snippets adapted (MIT-safe, reimplemented where the source
was unlicensed) — no wholesale source copying.
