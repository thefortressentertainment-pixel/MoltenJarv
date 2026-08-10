#!/usr/bin/env python3
"""
Free-GPU paint host — run inside a 0-cost GPU notebook (Kaggle dual-T4 or Colab T4).
This is the REMOTE side of Jarv's `bpy_paint_remote`: the M1 crafts a mesh here
can't paint (Hunyuan3D-2.1 paint needs ~21GB VRAM), so it uploads the mesh +
reference here; this notebook runs Hunyuan3D-2.1 Hunyuan3DPaintPipeline (PyTorch,
CUDA on the free T4) and returns the textured GLB.

Usage (one notebook cell — Kaggle with GPU accelerator, dual T4 = 32GB fits 21GB;
single T4 Colab may need --low_vram):
    import subprocess, paint_host
    # setup (first run only: clone + deps + compile rasterizer + weights)
    paint_host.install()
    paint_host.HUNYUAN_DIR = "/kaggle/working/Hunyuan3D-2.1"
    paint_host.start()

Expose port 8000 with a free tunnel (ngrok/cloudflared/Tailscale) and set on the M1:
    jarv-genie key set BLENDER_PAINT_URL <https://tunnel>
    jarv-genie key set BLENDER_PAINT_TOKEN <your-token>

The M1 then POSTs mesh GLB + reference and downloads /tmp/jarv_painted.glb.

LICENSE: MIT (adapted for Jarv's Blender Branch). Hunyuan3D-2.1 weights are MIT
(Tencent-Hunyuan); shapes+textures at 10GB/21GB VRAM respectively.
"""

import json
import os
import subprocess
import sys
import time
import threading
import tempfile

# --- tunables ---------------------------------------------------------------
HOST = "0.0.0.0"
PORT = 8000
AUTH_TOKEN = os.environ.get("BLENDER_PAINT_TOKEN", "jarv-paint-dev")
HUNYUAN_GIT = "https://github.com/Tencent-Hunyuan/Hunyuan3D-2.1.git"
HUNYUAN_DIR = ""  # set to /kaggle/working/Hunyuan3D-2.1 (or wherever cloned)
MAX_NUM_VIEW = 6
RESOLUTION = 512
# Paint needs ~21GB VRAM. On a single 16GB T4, enable lower-vram dtype/offload.
LOW_VRAM = os.environ.get("BLENDER_PAINT_LOW_VRAM", "0") == "1"

_JOBS = {}  # job_id -> {"status", "out": path}
_job_counter = [0]


def install():
    """One-time setup of Hunyuan3D-2.1 on the notebook. Run once, then start()."""
    print("[paint-host] setting up Hunyuan3D-2.1 (clone + deps + compile + weights)...")
    if not os.path.isdir(os.path.join(os.getcwd(), "Hunyuan3D-2.1")):
        subprocess.run(["git", "clone", HUNYUAN_GIT, "Hunyuan3D-2.1"], check=True)
    global HUNYUAN_DIR
    HUNYUAN_DIR = os.path.join(os.getcwd(), "Hunyuan3D-2.1")
    os.chdir(HUNYUAN_DIR)
    # PyTorch CUDA build + the repo requirements
    subprocess.run([sys.executable, "-m", "pip", "install", "-q", "torch==2.5.1",
                    "torchvision==0.20.1", "torchaudio==2.5.1",
                    "--index-url", "https://download.pytorch.org/whl/cu124"], check=False)
    subprocess.run([sys.executable, "-m", "pip", "install", "-q", "-r", "requirements.txt"], check=False)
    # compile the paint rasterizer (required for texture baking)
    subprocess.run(["bash", "compile_mesh_painter.sh"], cwd=os.path.join(HUNYUAN_DIR, "hy3dpaint", "DifferentiableRenderer"), check=False)
    subprocess.run([sys.executable, "-m", "pip", "install", "-q", "-e", "."],
                   cwd=os.path.join(HUNYUAN_DIR, "hy3dpaint", "custom_rasterizer"), check=False)
    # Real-ESRGAN upsampler checkpoint for the texture super-resolution stage
    ckpt_dir = os.path.join(HUNYUAN_DIR, "hy3dpaint", "ckpt")
    os.makedirs(ckpt_dir, exist_ok=True)
    ckpt = os.path.join(ckpt_dir, "RealESRGAN_x4plus.pth")
    if not os.path.exists(ckpt):
        subprocess.run(["wget", "-q",
                        "https://github.com/xinntao/Real-ESRGAN/releases/download/v0.1.0/RealESRGAN_x4plus.pth",
                        "-P", ckpt_dir], check=False)
    print("[paint-host] setup done. Weights are downloaded on first paint call (tencent/Hunyuan3D-2.1).")


def _gen_id():
    _job_counter[0] += 1
    return f"jarv-{int(time.time())}-{_job_counter[0]}"


def _require_auth(headers):
    token = headers.get("Authorization", "").replace("Bearer ", "")
    if AUTH_TOKEN and token != AUTH_TOKEN:
        raise PermissionError("bad token")


def _run_paint(job_id, mesh_path, ref_path, out_path):
    """Run the verified Hunyuan3D-2.1 paint flow on the free T4. Authoritative API:
       paint_pipeline = Hunyuan3DPaintPipeline(Hunyuan3DPaintConfig(max_num_view=6, resolution=512))
       paint_pipeline(mesh_path=..., image_path=..., output_mesh_path=..., save_glb=True)
    (paint uses ~21GB VRAM -> dual-T4 Kaggle fits; LOW_VRAM lowers dtype on single T4.)"""
    try:
        sys.path.insert(0, HUNYUAN_DIR)
        sys.path.insert(0, os.path.join(HUNYUAN_DIR, "hy3dpaint"))
        from textureGenPipeline import Hunyuan3DPaintConfig, Hunyuan3DPaintPipeline
        _JOBS[job_id]["status"] = "running"
        config = Hunyuan3DPaintConfig(max_num_view=MAX_NUM_VIEW, resolution=RESOLUTION)
        paint = Hunyuan3DPaintPipeline(config)
        if LOW_VRAM:
            try:
                for name in paint.models:
                    paint.models[name] = getattr(paint.models[name], "half", lambda: paint.models[name])()
            except Exception:
                pass
        # Writes a textured GLB to out_path when save_glb=True
        paint(mesh_path=mesh_path, image_path=ref_path, output_mesh_path=out_path, save_glb=True)
        _JOBS[job_id]["status"] = "done"
        _JOBS[job_id]["out"] = out_path
    except Exception as exc:  # noqa: BLE001
        _JOBS[job_id]["status"] = "failed"
        _JOBS[job_id]["error"] = str(exc)


# --- tiny HTTP server (stdlib only; no FastAPI dependency needed) -----------
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer  # noqa: E402


class _H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, code, obj=None, body=None, ctype="application/json"):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        if obj is not None:
            body = json.dumps(obj).encode()
        self.send_header("Content-Length", str(len(body or b"")))
        self.end_headers()
        if body:
            self.wfile.write(body)

    def _parse_multipart(self):
        ctype = self.headers.get("Content-Type", "")
        boundary = ctype.split("boundary=")[-1].encode()
        length = int(self.headers.get("Content-Length", 0))
        data = self.rfile.read(length)
        fields = {}
        for part in data.split(b"--" + boundary):
            if part.startswith(b"Content-Disposition"):
                head, _, body = part.partition(b"\r\n\r\n")
                head = head.decode(errors="ignore")
                import re
                name = re.search(r'name="([^"]+)"', head)
                fn = re.search(r'filename="([^"]+)"', head)
                if name:
                    if fn:
                        fields[name.group(1)] = (body.rstrip(b"\r\n"), fn.group(1))
                    else:
                        fields[name.group(1)] = body.decode(errors="ignore")
        return fields

    def do_POST(self):  # noqa: N802
        try:
            _require_auth(self.headers)
            if self.path.rstrip("/").endswith("/jobs"):
                f = self._parse_multipart()
                mesh = f.get("mesh")
                ref = f.get("reference")
                if not mesh or not ref:
                    return self._send(400, {"error": "need mesh + reference"})
                jid = _gen_id()
                workdir = tempfile.mkdtemp(prefix="jarvpaint_")
                mesh_path = os.path.join(workdir, mesh[1])
                ref_path = os.path.join(workdir, ref[1])
                out_path = os.path.join(workdir, "painted.glb")
                open(mesh_path, "wb").write(mesh[0])
                open(ref_path, "wb").write(ref[0])
                _JOBS[jid] = {"status": "queued", "out": out_path}
                threading.Thread(target=_run_paint, args=(jid, mesh_path, ref_path, out_path), daemon=True).start()
                return self._send(200, {"job_id": jid})
            return self._send(404, {"error": "not found"})
        except PermissionError:
            return self._send(401, {"error": "unauthorized"})
        except Exception as exc:  # noqa: BLE001
            return self._send(500, {"error": str(exc)})

    def do_GET(self):  # noqa: N802
        try:
            _require_auth(self.headers)
            import re
            m = re.match(r"^/jobs/([^/]+)$", self.path)
            if m:
                jid = m.group(1)
                if jid not in _JOBS:
                    return self._send(404, {"error": "no such job"})
                return self._send(200, {"status": _JOBS[jid]["status"]})
            m2 = re.match(r"^/jobs/([^/]+)/result$", self.path)
            if m2:
                jid = m2.group(1)
                if _JOBS.get(jid, {}).get("status") != "done":
                    return self._send(202, {"error": "not ready"})
                out = _JOBS[jid]["out"]
                data = open(out, "rb").read()
                return self._send(200, body=data, ctype="model/gltf-binary")
            return self._send(404, {"error": "not found"})
        except PermissionError:
            return self._send(401, {"error": "unauthorized"})
        except Exception as exc:  # noqa: BLE001
            return self._send(500, {"error": str(exc)})


def start():
    print(f"[paint-host] listening on {HOST}:{PORT} (token: {AUTH_TOKEN})")
    print("[paint-host] run a tunnel (ngrok http 8000) and set BLENDER_PAINT_URL on the M1.")
    ThreadingHTTPServer((HOST, PORT), _H).serve_forever()


if __name__ == "__main__":
    start()
