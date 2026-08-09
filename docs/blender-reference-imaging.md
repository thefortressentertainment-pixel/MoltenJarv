# Blender reference-imaging (for a text-only agent) — RAM-light

Goal: give Jarv real **visual/spatial ground-truth** when building in Blender (a
wreath, a Labrador, a chair) instead of symbolic guesswork ("ring + cones").

## The core problem

Jarv's model is text-only; it can't "see" a reference photo, so it builds from
symbolic knowledge with no way to reason about real proportions/arrangement.

## GitHub sweep → the mechanism

Best match: `blender-vision-agent` (unlicensed, use pattern) — an agentic
vision-to-Blender loop where a Vision-LLM emits a **structured JSON shape-spec**
(primitives + position + scale + rotation + material + boolean ops) that a text
model/engine turns into bpy. Companion patterns:
- `love2d3d` / `CubeSter` — pure-PIL silhouette→proportion kernels (aspect,
  center-of-mass, palette) for scale/placement without any 3D-reconstruction model.
- `blender-render-toolkit` (MIT) — render→verify loop (feed the render back).

Heavy image-to-3D models (TRELLIS, TripoSR, Meshy) are **out**: they need GPU/GBs of
RAM and can't coexist with Blender on this 8GB M1. Only the JSON-spec mechanism is
adopted.

## What was wired in (RAM-light)

A new `bpy_reference` tool in the isolated `blender_runner` toolset:
- Takes an absolute reference-image path.
- Uses Jarv's **already-installed local Ollama vision** (llava/moondream) to turn the
  image into a structured shape spec: `shape_summary`, `proportions`
  (width/height, depth/width, aspect), `parts[]` (name, primitive, position, scale,
  rotation_deg, parent), `boolean_operations[]`.
- Returns that JSON spec to the text model, which then builds with `bpy_exec` from
  real proportions.
- The system prompt now tells the model to call `bpy_reference` FIRST whenever a
  task names a real thing or implies a reference image.

RAM impact: ~zero — reuses the already-running Ollama vision endpoint; no extra
models, no GPU, no new resident process. The runner stays isolated (no memory/RAG/
84-tools), so the light footprint is unchanged.

`src/blender/reference.ts`: `describeToSpec()` (vision → spec),
`parseSpecJson()` (tolerant JSON extraction), `extractShapeIntent()` (pure-PIL
proportion fallback via headless Blender's bundled numpy).

## Verified

- `bpy_reference` registered in the 9-tool Blender toolset.
- Executed against a real image: `ok:true`, returns `{ok, summary, parts,
  proportions, raw, note}`.
- Vision (llava) reachable; spec pipeline live. Full suite 378 passing,
  typecheck + build clean.

Attribution: JSON spec contract and render-verify loop adapted from the surveyed
projects (patterns only; MIT-safe, reimplemented — not copied wholesale).
