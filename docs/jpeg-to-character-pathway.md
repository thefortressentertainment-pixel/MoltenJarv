# JPEG → In-Game Character — Continuity Brief

**Project:** MoltenJarv / Valtherion-Online
**Target:** A 3D character reconstructed from a single JPEG, textured, rigged with
armatures, and imported into the Valtherion-Online game — ready to plug into the
existing backend build.
**Frame of reference / tone for this repo:** 1:1 reconstruction "down to every detail
we can manage with this build." No hope-coding, no fluff — substance over vibes.

This doc is the continuity + pathway for the next session, the game's chat, or any
context-limited recovery. It records WHAT happened, WHAT state we are in, and WHAT
comes next.

---

## 1. The full pathway (JPEG → in-game character)

```
JPEG (one or more angles)
  -> 1) SHAPE / MESH RECONSTRUCTION      (TRELLIS or Hunyuan3D-2.1 shape stage)
  -> 2) TEXTURE / MATERIAL BAKE          (multi-view diffusion -> PBR albedo+MR)
  -> 3) GLB EXPORT with UV + material    (trimesh / TRELLIS to_glb)
  -> 4) BLENDER IMPORT + mesh cleanup    (existing bpy-* skills, headless -b -P)
  -> 5) ARMATURE / RIG                  (auto-rig humanoid — Mixamo-style stage)
  -> 6) EXPORT FBX + import into Valtherion-Online (existing backend frame)
```

**Two reconstruction backends exist; TRELLIS is the new/current candidate; Hunyuan
is the proven-but-lower-fidelity fallback.**

---

## 2. Where we are right now (the live branch)

### Goal in flight: de-risk Microsoft TRELLIS on a free Kaggle T4
We are finishing a **standalone spike** (`scripts/blender/trellis-spike.py`) to prove
TRELLIS (MIT, 13.4k★, microsoft/TRELLIS-image-large 1.2B) actually runs end-to-end on a
16GB Kaggle T4 — replacing Hunyuan's lower-fidelity shape+paint.

**STATUS — reached, all confirmed by real output:**
- GOT T4 GPU on (was CPU-only — left-panel Settings -> Accelerator -> GPU T4 x2).
- Made it fully self-contained install into `/kaggle/working/trellis_libs` (avoids the
  box's broken two-python split where /usr/bin/python3 pip installs to a different
  site-packages than torchvision resolves).
- torch = 2.4.0+cu121, torchvision = 0.19.0, torchaudio = 2.4.0, xformers = 0.0.27
  (matched; a stray torch 2.3.1 / newest torch 2.13 kept breaking: `torchvision::nms` /
  `register_fake` errors).
- spconv = 2.3.8 (spconv-cu120 has NO py3.12 wheel; plain spconv does). SPCONV_OK.
- kaolin (from NVIDIA torch-2.4.0_cu121 wheel index) — OK.
- nvdiffrast (git + `--no-build-isolation`), diffoctreerast (separate clone), and
  diff-gaussian-rasterization — all compiled/import OK.
- rembg, open3d, plyfile, utils3d, easydict, xatlas, pyvista, transformers, etc. — in.
- DINOv2 image encoder: bypassed torch.hub (which pings github on EVERY call before any
  cache check -> RemoteDisconnected) — pip-installed `dinov2` locally (`--no-deps`,
  its setup.py pins torch==2.0.0) + pre-downloaded `dinov2_vitl14_pretrain.pth` into
  `/kaggle/working/dinov2_ckpt`, and monkeypatched `TrellisImageTo3DPipeline.
  _init_image_cond_model` to load it fully local.
- **`[trellis] model loaded in 46 s`** and **`[gpu after-load]`: GPU0 used 5607 MiB /
  free ~9305 MiB** -> the 1.2B pipeline FITS on the T4 with ~9GB headroom for inference.

**THE LAST BLOCKER (about to be cleared):**
- `pipe.run(image)` fails because **rembg downloads its `u2net.onnx` from github on
  first use** -> `RemoteDisconnected`. FIXED in spike: pre-download u2net.onnx to
  `~/.u2net/u2net.onnx` from multiple mirrors before `pipe.run`.
- Next run should produce `[gpu after-pipeline]` and `[trellis] WROTE
  /kaggle/working/trellis_orc.glb`.

### The tunnel / how we run it
- Kaggle notebook cell does the install+run (fetch `trellis-spike.py` from the repo
  main, `!python trellis-spike.py`). Internet ON, T4x2, Persistence ON, NOT pinned to
  original env.
- The reference image is uploaded as a Kaggle dataset/input; the spike auto-finds it
  under `/kaggle/input`.

---

## 3. The earlier, proven pipeline (Hunyuan — WORKING, shipped textured GLB)

`scripts/blender/kaggle_notebook.py` on a free Kaggle cell does M1 craft + remote
Hunyuan3D-2.1 paint:
- M1 `scripts/blender/craft-one.mjs <img> --paint-remote` -> `/tmp/jarv_crafted.glb`
- Kaggle cell runs the notebook over a trycloudflare tunnel (set BLENDER_PAINT_URL /
  BLENDER_PAINT_TOKEN) — Hunyuan3D-2.1 paint -> textured GLB at `/tmp/jarv_painted.glb`
  (verified: materials+textures+TEXCOORD_0, ~4.3MB). It WORKS end-to-end.
- Detail is gated by env knobs: BLENDER_PAINT_TARGET_FACES (default 180000 — stops the
  40k-face decimation that caused the "chiseled/crumpled" look), BLENDER_PAINT_RESOLUTION
  (768), BLENDER_PAINT_MAX_VIEW (8).

---

## 4. Every wall cleared (so it's not re-debugged)

**Hunyuan paint pipeline (all committed in kaggle_notebook.py + the `paint-pipeline`
skill):**
1. numpy.strings missing on numpy 1.26 -> alias to numpy.char.
2. newest scipy star-import recursion -> pin scipy==1.13.1 + stub scipy._lib.array_api_compat.
3. fast_simplification wants a REDUCTION RATIO not a face count -> rewrite simplify_mesh_utils.
4. mesh_utils imports bpy -> bpy-free trimesh/numpy load_mesh/save_mesh sys.modules stub.
5. import custom_rasterizer resolved to wrong namespace folder -> add the real package +
   built .so dirs to sys.path.
6. meshVerticeInpaint is a C++ pybind module -> pure-numpy port, stub in sys.modules.
7. scoping: helper fns used bare `trimesh` / `torch` not bound in that frame -> import
   inside the function / bind `_mu_trimesh` locally.
8. newest Pillow's ImageText imports `_Ink` -> pin Pillow 10.4.0 (re-pin last).
9. trimesh drops textures on bare GLB export -> canonical pattern: PBRMaterial owns
   image, TextureVisuals(uv, material), export via mesh.scene().
10. `__import__('PIL.Image', fromlist=['Image']).Image.fromarray` returns the MODULE not
   class -> `from PIL.Image import fromarray`. (This was THE silent unpainted-GLB root
   cause for many cycles.)
11. Ground-truth gate: after export, assert GLB has materials + TEXCOORD_0, else raise.

**TRELLIS spike (all committed in trellis-spike.py):**
- torch/torchvision/torchaudio/torch version mismatch (`torchvision::nms`,
  `register_fake`, two-python split, xformers re-bumping torch) -> self-contained
  `--target` libs dir + matched pins + PYTHONPATH/sys.path.
- spconv no py3.12 wheel -> spconv==2.3.8.
- nvdiffrast not on PyPI / build isolation hides torch -> git clone + `--no-build-isolation`.
- diffoctreerast not in TRELLIS submodules -> separate clone.
- torch.hub pings github unconditionally -> bypass with local dinov2 install +
  monkeypatch `_init_image_cond_model` (no torch.hub, no fallback that re-hits github).
- rembg u2net.onnx first-use github download -> pre-download to `~/.u2net/`.

---

## 5. Roadmap — what's next

1. **Finish the spike:** confirm `u2net.onnx ready (True)` -> `[gpu after-pipeline]` ->
   `[trellis] WROTE /kaggle/working/trellis_orc.glb`. If `pipe.run` OOMs (unlikely with
   ~9GB headroom vs 5.6GB load), drop to `TRELLIS-image-base` (342M) + lower sampler
   steps/render size — a config change, not new deps.
2. **Wire TRELLIS into Jarv:** not a destructive swap — add a TRELLIS execution path that
   feeds our mesh (or does image->3D) and yields a PBR-textured GLB, alongside the working
   Hunyuan path. Multi-angle: `pipe.run(images=[v1,v2,...])` = true multi-image -> one
   solid (the Mesh.ai `MultiImageTo3D` equivalent). Single JPEG = the Wizard rework.
3. **Blender import + mesh cleanup:** existing `bpy-cheatsheet` / `bpy-verify` /
   `bpy-render` skills, headless `blender --background --python`.
4. **Armature / rig:** TRELLIS does NOT auto-rig. Use an auto-rig stage (Mixamo-style
   humanoid + FBX). This is the step that gives "armatures and all" for Valtherion.
5. **Export FBX -> import into Valtherion-Online** backend already framed.
6. **Postmortem-fix quality:** keep the ground-truth gate discipline (verify the output,
   never trust a success string), and keep updating `paint-pipeline` +
   `trellis-spike`-adjacent docs as new walls fall.

---

## 6. Values / working agreements for this repo
- Predict via evidence before editing (the "Dr Strange" ask): enumerate the probable
  outcomes of the current state first; only then choose the highest-EV edit. A warm
  artifact that never gets consulted (torch.hub cache) is proof the model was wrong.
- No silent failure: convert any suspicious success into a loud gate/assert.
- Fully pinned, self-contained deps; never fight a broken global env — isolate.
- Verify the actual output bytes (GLB materials/TEXCOORD / face counts), not the log.
