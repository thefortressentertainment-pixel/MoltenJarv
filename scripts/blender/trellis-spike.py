"""
TRELLIS spike — prove it runs on a Kaggle T4 (16GB) before we swap it into Jarv.

De-risk only. Loads microsoft/TRELLIS-image-large (1.2B, MIT), runs a SINGLE image
through the image->3D pipeline, and exports a textured GLB. Prints GPU/VRAM and
clear failures. If this OOMs, TRELLIS is a no-go on the T4 and we stay on Hunyuan.

Run on Kaggle (GPU T4x2 / 30GB) as a notebook, then point Jarv at the produced GLB.
Does NOT touch the working Hunyuan pipeline.
"""

import os
os.environ["SPCONV_ALGO"] = "native"
# Use xformers (more likely to have a wheel on Kaggle) rather than flash-attn.
os.environ["ATTN_BACKEND"] = "xformers"

import gc
import subprocess
import sys
import time


def sh(cmd, **kw):
    print(f">> {cmd}", flush=True)
    return subprocess.run(cmd, shell=True, text=True, capture_output=True, **kw)


def log_gpu(tag):
    r = sh("nvidia-smi --query-gpu=index,memory.total,memory.used,memory.free --format=csv,nounits")
    if r.returncode != 0:
        print("[trellis] WARNING: nvidia-smi not found — this looks like a CPU-only Kaggle session.", flush=True)
        print("Enable GPU: notebook right panel -> Settings -> Accelerator -> 'GPU T4 x2', then Restart Session.", flush=True)
    else:
        print(f"[gpu {tag}]\n{r.stdout}", flush=True)
        print(r.stderr[-500:] if r.stderr else "", flush=True)


def main():
    global trellis_libs
    trellis_libs = "/kaggle/working/trellis_libs"
    log_gpu("start")
    print(f"[trellis] interpreter: {sys.version.split()[0]} at {sys.executable}", flush=True)

    # Reference image. On Kaggle, upload the file (left panel "+ Add Input" -> Upload,
    # or add a Dataset) so it lands at /kaggle/input/<name>/3D-wizard.jpeg, then point
    # IMG here. Also honors an env override or a CLI arg.
    img = (
        os.environ.get("TRELLIS_IMG")
        or (sys.argv[1] if len(sys.argv) > 1 else None)
    )
    if not img or not os.path.exists(img):
        # Auto-discover the first image under /kaggle/input so the exact dataset
        # slug/filename don't have to be guessed.
        import fnmatch
        img = None
        root = "/kaggle/input"
        print(f"[trellis] no valid image passed; scanning {root} ...", flush=True)
        for base, _dirs, files in os.walk(root):
            for f in sorted(files):
                if f.lower().endswith((".jpg", ".jpeg", ".png", ".webp")):
                    img = os.path.join(base, f)
                    print(f"[trellis] found candidate: {img}", flush=True)
                    break
            if img:
                break
        if not img:
            print(f"[trellis] FATAL: no image under {root}", flush=True)
            print("Upload it via the Kaggle notebook left panel (+ Add Input / Upload a Dataset),", flush=True)
            print("then re-run. You can also pass the exact path: !python trellis-spike.py /kaggle/input/<name>/file.jpg", flush=True)
            sys.exit(1)
    from PIL import Image
    im = Image.open(img).convert("RGB")
    print("image", im.size, im.mode, flush=True)
    del im

    # 2. Clone TRELLIS (recursive for submodules) and install --basic --xformers only.
    #    Skip flash-attn/spconv/kaolin/nvdiffrast/diffoctreerast to reduce build fragility.
    if not os.path.isdir("/kaggle/working/TRELLIS"):
        t0 = time.time()
        r = sh("git clone --recurse-submodules https://github.com/microsoft/TRELLIS.git /kaggle/working/TRELLIS",
               timeout=1800)
        print(r.stdout[-1000:], r.stderr[-1500:], flush=True)
        print("clone+submodules", round(time.time() - t0), "s", flush=True)
    os.chdir("/kaggle/working/TRELLIS")

    # 3. Install deps in the CURRENT interpreter (Kaggle already has torch/CUDA).
    #    setup.sh creates a conda env which is awkward on Kaggle; do a pip subset instead.
    pip = [sys.executable, "-m", "pip", "install", "-q"]

    print("[trellis] installing base torch + deps (this can be slow)", flush=True)
    # The box has TWO pythons and a stray torch (2.3.1) that torchvision resolves to,
    # separate from what /usr/bin/python3 -m pip installs. Fiddling with the global
    # env is a losing battle, so install a SELF-CONTAINED matched set into one dir and
    # force it onto sys.path by appending to PYTHONPATH (subprocess + our own process).
    #   torch 2.4.0 <-> torchvision 0.19.0 <-> torchaudio 2.4.0, xformers 0.0.27 (cu121).
    trellis_libs = "/kaggle/working/trellis_libs"
    os.makedirs(trellis_libs, exist_ok=True)
    os.environ.setdefault("PYTHONPATH", trellis_libs + ":" + os.environ.get("PYTHONPATH", ""))
    _pip = f"{sys.executable} -m pip install -q --target {trellis_libs}"
    r = sh(
        _pip + " torch==2.4.0 torchvision==0.19.0 torchaudio==2.4.0"
        + " --index-url https://download.pytorch.org/whl/cu121",
        timeout=2400,
    )
    print("pip torch rc", r.returncode, r.stderr[-800:], flush=True)
    # Full TRELLIS --basic python deps (from setup.sh) + utils3d (git pin) + a few we
    # know import path chokes on, all into the self-contained libs dir in ONE resolve:
    #   pillow imageio imageio-ffmpeg tqdm easydict opencv-python-headless scipy ninja
    #   rembg onnxruntime trimesh open3d xatlas pyvista pymeshfix igraph transformers
    #   einops matplotlib ipywidgets plyfile xformers==0.0.27
    #   git+https://github.com/EasternJournalist/utils3d.git@9a4eb15e4021b67b12c460c7057d642626897ec8
    r = sh(
        _pip + " pillow imageio imageio-ffmpeg tqdm easydict opencv-python-headless scipy ninja"
        + " rembg onnxruntime trimesh open3d xatlas pyvista pymeshfix igraph transformers"
        + " einops matplotlib ipywidgets plyfile 'xformers==0.0.27'",
        timeout=2400,
    )
    print("pip deps rc", r.returncode, r.stderr[-800:], flush=True)
    r = sh(
        f"{sys.executable} -m pip install -q --target {trellis_libs}"
        + " 'git+https://github.com/EasternJournalist/utils3d.git@9a4eb15e4021b67b12c460c7057d642626897ec8'",
        timeout=1200,
    )
    print("pip utils3d rc", r.returncode, r.stderr[-800:], flush=True)
    # sanity: confirm the same PYTHONPATH resolves a consistent torch+tv pair.
    r = sh(
        f"PYTHONPATH={trellis_libs} {sys.executable} -W ignore -c "
        "'import torch, torchvision; "
        "print(\"torch\", torch.__version__, \"tv\", torchvision.__version__, torch.__file__.split(\"site-packages/\")[-1] if \"site-packages\" in torch.__file__ else torch.__file__)'",
    )
    print("TORCH CHECK:\n" + r.stdout + r.stderr[-600:], flush=True)

    # CUDA extensions TRELLIS needs at import (kaolin for FlexiCubes mesh, nvdiffrast/
    # diffoctreerast/diff-gaussian for the renderers). Prebuilt wheels are far more
    # reliable than building submodule setup.py from source on Kaggle. kaolin comes
    # from NVIDIA's index for this exact torch (2.4.0) + cu121 build.
    # spconv is REQUIRED by the sparse-structure models ("Backend: spconv"); provide
    # the cu120 wheel (setup.sh uses spconv-cu120 for CUDA 12.x).
    r = sh(
        f"{sys.executable} -m pip install -q --target {trellis_libs} spconv-cu120",
        timeout=1800,
    )
    print("pip spconv rc", r.returncode, r.stderr[-600:], flush=True)
    # CUDA render extensions. nvdiffrast needs --no-build-isolation (its setup.py
    # requires torch visible, which build isolation hides) and diffoctreerast is cloned
    # separately by TRELLIS's setup.sh (it is NOT in the submodules dir).
    if not os.path.isdir("/kaggle/working/nvdiffrast"):
        sh("git clone --depth 1 https://github.com/NVlabs/nvdiffrast.git /kaggle/working/nvdiffrast", timeout=600)
    r = sh(
        f"PYTHONPATH={trellis_libs} {sys.executable} -m pip install -q --no-build-isolation "
        + f"--target {trellis_libs} /kaggle/working/nvdiffrast",
        timeout=1800,
    )
    print("pip nvdiffrast rc", r.returncode, r.stderr[-600:], flush=True)
    if not os.path.isdir("/kaggle/working/diffoctreerast"):
        sh("git clone --recurse-submodules https://github.com/JeffreyXiang/diffoctreerast.git /kaggle/working/diffoctreerast", timeout=600)
    r = sh(
        f"PYTHONPATH={trellis_libs} {sys.executable} -m pip install -q --no-build-isolation "
        + f"--target {trellis_libs} /kaggle/working/diffoctreerast",
        timeout=1800,
    )
    print("pip diffoctreerast rc", r.returncode, r.stderr[-600:], flush=True)
    r = sh(
        f"{sys.executable} -m pip install -q --target {trellis_libs} "
        + "kaolin -f https://nvidia-kaolin.s3.us-east-2.amazonaws.com/torch-2.4.0_cu121.html",
        timeout=1800,
    )
    print("pip kaolin rc", r.returncode, r.stderr[-600:], flush=True)
    if not os.path.isdir("/kaggle/working/diff-gaussian-rasterization"):
        sh(
            "git clone --recursive https://github.com/graphdeco-inria/diff-gaussian-rasterization.git /kaggle/working/diff-gaussian-rasterization",
            timeout=600,
        )
    r = sh(
        f"{sys.executable} -m pip install -q --target {trellis_libs} /kaggle/working/diff-gaussian-rasterization",
        timeout=1800,
    )
    print("pip diff-gaussian rc", r.returncode, r.stderr[-600:], flush=True)

    # 4. Run image->3D and export a textured GLB.
    # Our self-contained matched torch/torchvision live in trellis_libs; make sure
    # THIS process imports from there (PYTHONPATH set mid-process won't change
    # sys.path for the already-running interpreter, so prepend it directly).
    sys.path.insert(0, "/kaggle/working/TRELLIS")
    sys.path.insert(0, trellis_libs)
    gc.collect()
    log_gpu("after-install")
    from trellis.pipelines import TrellisImageTo3DPipeline
    from trellis.utils import postprocessing_utils
    from PIL import Image as PImage

    print("[trellis] loading TRELLIS-image-large (1.2B)...", flush=True)
    t0 = time.time()
    pipe = TrellisImageTo3DPipeline.from_pretrained("microsoft/TRELLIS-image-large")
    pipe.cuda()
    print("[trellis] model loaded in", round(time.time() - t0), "s", flush=True)
    log_gpu("after-load")

    image = PImage.open(img).convert("RGB")
    print("[trellis] running pipeline (image->mesh+gs)...", flush=True)
    t0 = time.time()
    outputs = pipe.run(image, seed=1)  # MULTI-ANGLE (single solid): pipe.run(images=[v1,v2,...])
    print("[trellis] pipeline done in", round(time.time() - t0), "s", flush=True)
    print("output keys:", list(outputs.keys()), flush=True)

    glb = postprocessing_utils.to_glb(
        outputs["gaussian"][0], outputs["mesh"][0],
        simplify=0.95, texture_size=1024,
    )
    glb.export("/kaggle/working/trellis_orc.glb")
    print("[trellis] WROTE /kaggle/working/trellis_orc.glb", flush=True)
    log_gpu("done")


if __name__ == "__main__":
    main()
