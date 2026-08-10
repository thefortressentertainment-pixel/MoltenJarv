---
name: paint-pipeline
description: DSPy-style few-shot corrective log for the MoltenJarv free-GPU paint pipeline (M1 craft + Kaggle Hunyuan3D-2.1 remote paint). Each resolved wall is recorded as a (failure trace -> root cause -> fix) example so regressions are fixed fast and recognized up front instead of re-debugged. RAM-light (advisory only).
---

# Paint Pipeline — Resolved Few-Shot Walls

The end-to-end path: M1 `craft-one.mjs` builds a glb (octree, auto-refine), then
hands mesh + reference image to a free Kaggle cell running `kaggle_notebook.py`
(dual-T4 Hunyuan3D-2.1) over a trycloudflare tunnel. The paint host exposes
`/ping`, `POST /jobs`, `GET /jobs/<id>`, `/jobs/<id>/result`. Token `jarv-paint-dev`.

When a `--paint-remote` job fails, the job error is returned as
`remote paint job failed: <msg>\n<full traceback>`. NEVER re-derive a known wall:
match the error line against the log below and apply its fix directly, then only
re-run. Each fix below is committed to `scripts/blender/kaggle_notebook.py`
(GitHub `main`; the cell re-fetches it via a fetch+exec bootstrap snippet and re-
installs ~15 min).

## Debugging loop (apply before any change)
1. Grep the traceback for a known line/fix in this file. If matched, apply and re-run.
2. Unknown wall: get the FULL traceback (the notebook's job error now includes
   `traceback.format_exc()`). Identify the innermost frame, not the CJ->summary.
3. Choose a fix that keeps numpy==1.26.4 + scipy 1.13.1 pinned (torch/rembg/opencv
   need numpy 1.x here). Prefer a small sys.modules stub before any import.
4. Commit to `kaggle_notebook.py`, push to `main`, have the cell re-fetch,
   re-install, then re-run `craft-one.mjs <img> --paint-remote`.
5. On success, add a one-line entry below (the new wall) so it's few-shot next time.

## Resolved walls (failure trace -> root cause -> fix)

1. `importerror: No module named 'numpy.strings'` during diffusers import
   -> numpy is pinned to 1.26.4; diffusers >=0.31 does `import numpy.strings`
      which only exists on numpy 2.x.
   -> In `_run_paint`, alias: if `import numpy.strings` fails, synthesize a
      `numpy.strings` module backed by `numpy.char` (sys.modules) + rec/recarray
      aliases. (numpy shim block.)

2. `RecursionError: maximum recursion depth exceeded` deep in `numpy.__init__.py`
   `__getattr__` when trimesh->scipy.spatial imports
   -> newest scipy's `array_api_compat` does `clone_module`/`from numpy import *`
      into a fresh namespace, which recurses on numpy 1.26.
   -> Pin `scipy==1.13.1` (numpy 1.26-compatible) AND pre-stub
      `scipy._lib.array_api_compat` in sys.modules (is_array_api_obj, size, .numpy)
      before any scipy import.

3. `ValueError: ``target_reduction`` must be between 0 and 1`
   -> Hunyuan's `simplify_mesh_utils.mesh_simplify_trimesh` calls
      `simplify_quadric_decimation(target_count=40000)` (a FACE COUNT), but
      `fast_simplification` re-implements it to take a REDUCTION RATIO (0..1).
   -> Rewrite `hy3dpaint/utils/simplify_mesh_utils.py` wholesale to call
      `fast_simplification.simplify(verts, faces, 1 - target_count/face_num)`.
      (Fragile string .replace() fails; do a full-file rewrite + pop the cached
      module from sys.modules.)

4. `NameError: name 'load_mesh' is not defined` in `MeshRender.load_mesh`
   -> `MeshRender.py` does `from .mesh_utils import load_mesh, save_mesh`; that
      module does `import bpy` which fails on Kaggle (swallowed by try/except).
   -> Pre-register `DifferentiableRenderer.mesh_utils` in sys.modules with a
      bpy-free trimesh/numpy implementation of load_mesh/save_mesh/save_obj_mesh
      (convert_obj_to_glb stays a no-op; we GLB-export via trimesh, save_glb=False).

5. `AttributeError: module 'custom_rasterizer' has no attribute 'rasterize'`
   -> `import custom_rasterizer as cr` resolved to the repo-ROOT namespace folder
      (has setup.py/lib/, no __init__.py/render.py) instead of the real package at
      `custom_rasterizer/custom_rasterizer/` (whose render.py exposes rasterize/
      interpolate re-exported from the built `custom_rasterizer_kernel.so`).
   -> Add `hy3dpaint/custom_rasterizer` and `hy3dpaint/custom_rasterizer/custom_rasterizer`
      to sys.path and pop stale cached modules before importing textureGenPipeline.

6. `NameError: name 'meshVerticeInpaint' is not defined` in `MeshRender.uv_inpaint`
   -> `from .mesh_inpaint_processor import meshVerticeInpaint` fails because that
      is a C++ pybind11 module (compiled by compile_mesh_painter.sh), which isn't
      importable on Kaggle; swallowed by try/except.
   -> Pre-register `DifferentiableRenderer.mesh_inpaint_processor` in sys.modules
      with a pure-numpy port of the C++ "smooth" inpainting algorithm, matching
      shape contracts: texture[H,W,C] float, mask[H,W] uint8.

7. `NameError: cannot access free variable 'trimesh' ... enclosing scope` in the
   notebook's injected mesh_utils save_mesh
   -> The notebook's helper fns referenced `trimesh`, which is only `import trimesh`
      LATER in `_run_paint` (after paint() returns) -> unbound free variable at save time.
   -> Bind `import trimesh as _mu_trimesh` INSIDE the stub block (before the helper
      defs) and use the local alias in load_mesh/save_mesh.

7. `NameError: cannot access free variable 'trimesh' ... enclosing scope` in the
   notebook's injected mesh_utils save_mesh
   -> The notebook's helper fns referenced `trimesh`, which is only `import trimesh`
      LATER in `_run_paint` (after paint() returns) -> unbound free variable at save time.
   -> Bind `import trimesh as _mu_trimesh` INSIDE the stub block (before the helper
      defs) and use the local alias in load_mesh/save_mesh.

8. Silent UNPAINTED GLB (job returns "remote-painted GLB at ..." but the GLB has
   `materials:0 textures:0 images:0`, only POSITION, ~776KB, byte-identical every run)
   -> MULTIPLE candidate root causes, all silent. Do NOT trust a "success" — verify the
      GLB in the returned bytes. Debug in this order:
      a) trimesh SILENTLY drops UV/texture if pillow isn't importable (mikedh/trimesh#2333,
         only a buried log.debug). Probe `import PIL` at save time; raise if missing.
      b) `MeshRender.save_mesh` receives `texture_data = self.get_texture()`; if the paint
         bake set no `self.tex`, texture is None -> attach is skipped and a bare GLB falls
         through with NO error. ASSERT texture is not None in save_mesh (log shape/min/max/
         UV/faces; raise with a loud message).
      c) A bare `Trimesh.export(glb)` is known to drop textures; the canonical test-backed
         path is PBRMaterial owns image + TextureVisuals(uv, material) + export via
         mesh.scene() (see trimesh test_gltf.py test_material_primary_colors / test_tex_export).
      d) Ground-truth gate: after export, re-open the GLB and assert it has a `materials`
         section AND `TEXCOORD_0`; raise if not (turns the silent miss into a loud job fail).

9. `pip: error: subprocess-exited-with-error ... Getting requirements to build wheel did
   not run successfully. exit code: 1` at install time, plus a wall of "X requires
   numpy>=2, but you have numpy 1.26" conflicts
   -> `pip install -r requirements.txt` (Hunyuan's own, unpinned) triggers a SOURCE wheel
      build that fails under the numpy-1.26/py3.12 combo. Half the Kaggle base image is
      numpy-2-only. This is an environment fragility, not a code bug. It can silently
      break downstream deps (e.g. leave pillow/opencv unusable) even though the notebook
      "finishes". Watch for it; a failed wheel build may need a pinned prebuilt wheel or
      an explicit compatible dep list rather than raw requirements.txt.

## Standing rules
- Keep numpy==1.26.4 and scipy==1.13.1 and Pillow==10.4.0 pinned; re-pin last.
- NEVER trust a "remote-painted GLB at ..." success string — parse the returned GLB and
  confirm `materials` + `TEXCOORD_0` present before importing in Blender.
- Every bpy-dependent `DifferentiableRenderer` module needs a bpy-free sys.modules
  stub; when a new NameError appears with "from .X import Y", X is a C++/bpy
  module -> stub it in sys.modules.
- Full traceback beats summary: rely on `format_exc()` in the job error.
- Any silent failure (no error but wrong output) should be converted to a loud assertion
  (gate) before re-running, so we stop guessing.
