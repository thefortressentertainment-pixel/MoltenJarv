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
    # ONE resolve with --force-reinstall so pip actually downgrades from a stray
    # newer torch (2.13) that a prior split install left behind. torch/torchvision/
    # torchaudio must match exactly (2.4.0 <-> 0.19.0 <-> 2.4.0); use xformers 0.0.27
    # which supports torch 2.4 (0.0.35 needs torch>=2.10 and re-bumps torch). Installing
    # them all together prevents the xformers->torch upgrade from re-breaking the pair.
    _pip = f"{sys.executable} -m pip install --force-reinstall -q"
    r = sh(
        _pip
        + " torch==2.4.0 torchvision==0.19.0 torchaudio==2.4.0"
        + " --index-url https://download.pytorch.org/whl/cu121",
        timeout=1800,
    )
    print("pip torch rc", r.returncode, r.stderr[-800:], flush=True)
    r = sh(
        _pip
        + " einops imageio imageio-ffmpeg matplotlib ninja numpy pillow scipy tqdm trimesh ipywidgets"
        + " 'xformers==0.0.27'",
        timeout=1800,
    )
    print("pip deps rc", r.returncode, r.stderr[-800:], flush=True)
    # sanity: print what's actually importable so we catch a stale torch before the model loads
    r = sh(f"{sys.executable} -c 'import torch, torchvision; print(\"torch\", torch.__version__, \"tv\", torchvision.__version__)'")
    print(r.stdout, r.stderr[-400:], flush=True)

    # build the local submodules that have wheels / are light; catch failures non-fatally
    for sub in ["diffoctreerast", "spconv", "kaolin", "nvdiffrast", "mipgaussian"]:
        setup = f"/kaggle/working/TRELLIS/submodules/{sub}/setup.py"
        if os.path.exists(setup):
            print(f"[trellis] building submodule {sub}...", flush=True)
            r = sh(f"{sys.executable} setup.py build_ext --inplace", cwd=os.path.dirname(setup), timeout=1500)
            print(f"[trellis] {sub} rc={r.returncode} {r.stderr[-500:]}", flush=True)

    # 4. Run image->3D and export a textured GLB.
    sys.path.insert(0, "/kaggle/working/TRELLIS")
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
