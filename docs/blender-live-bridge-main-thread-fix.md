# Blender live bridge — main-thread fix (no more freeze on scene edits)

## Problem

After the live-scene bridge was added, **creating simple shapes worked** but a
task like "delete all objects" froze Blender (the Rainbow Wheel) while the hub was
fast and correct.

## Root cause

Blender REQUIRES that `bpy.ops` / `bpy.data` mutations run on **Blender's main
(UI) thread**. The bridge's HTTP handler ran on a `ThreadingHTTPServer` **worker
thread** and called `bpy.ops.object.delete(...)` directly there. Individual
`bpy.ops.mesh.primitive_*_add` calls happen to tolerate this, but scene-modifying
operators (delete, transform_apply, etc.) fault/hang Blender when invoked from a
worker thread → the freeze. The hub emitted the correct result, but the Blender
side was wedged.

## Fix (in the Blender 5.1 extension `__init__.py`)

The bridge is now **main-thread-safe**:
- The HTTP handler only **enqueues** the bpy `code` onto a `queue.Queue` and
  **blocks** (with a 60s timeout) for a result slot.
- A Blender main-thread timer (`bpy.app.timers.register(_execute_on_main_thread)`)
  drains the queue every ~50ms and runs `execute_live_bpy(code)`, then fills the
  result slot. Because the timer runs on Blender's main thread, `bpy.ops` executes
  safely and the UI updates.
- `execute_live_bpy` also `tag_redraw()`s the areas so the user SEES the change.

## Verified

Simulated the exact delete path on the main-thread drain:
```
BEFORE 6  →  AFTER 0
SLOT {'ok': True, 'error': None, 'objects': []}
```
Delete-all completes instantly and correctly and returns the (now empty) scene
object list to the hub. The hub then reports "Deleted all objects; scene is
empty" — no freeze.

Note: `--background` Blender doesn't fire `bpy.app.timers`, so the bridge's live
exec must be tested via the manual main-thread drain or in a real GUI session.
In the user's GUI Blender, the registered timer does the work automatically.

## Scope

This fix is in the **runtime extension** (`~/Library/Application Support/Blender/
5.1/extensions/user_default/jarv_blender/__init__.py`). A versioned copy of the
add-on lives in the MoltenJarv repo at `scripts/blender/jarv_blender/` — deploy
updates by copying `__init__.py` + `blender_manifest.toml` over the extensions
dir entry and restarting Blender. The extension is authoritative.

## Auto-shade safety net (never flat-gray)

Added `_ensure_shading()` called after every successful `execute_live_bpy`: every
MESH with zero materials gets a neutral visible Principled material
(`MAT_AutoShade`, light-gray, roughness 0.6) and a SUN light is added if none
exists. Only objects the model did NOT already shade are touched (their material
is left intact), so a build is guaranteed to have color + light even if the model
skips its FINALIZE material pass. Confirmed in Blender: three new cubes were
auto-assigned MAT_AutoShade while a pre-existing default-Material cube was
untouched.
