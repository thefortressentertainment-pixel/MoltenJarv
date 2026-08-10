#!/usr/bin/env python3
"""
SINGLE-CELL Kaggle notebook — paste this ENTIRE file into one Kaggle notebook cell,
created with a GPU accelerator (e.g. 'GPU T4 x2'), and run it.

It will, in order:
  1. install()  — clone Tencent-Hunyuan/Hunyuan3D-2.1, install torch cu124 + the
                  repo requirements, compile the paint rasterizer, and fetch
                  Real-ESRGAN_x4plus.pth (first run only; ~a few minutes + weights).
  2. start()    — run the tiny paint HTTP server on :8000 and open a FREE
                  trycloudflare.com tunnel (no token needed), then print a
                  "COPY THIS URL" block.

On the M1 terminal, paste the printed URL:
    jarv-genie key set BLENDER_PAINT_URL https://xxxx.trycloudflare.com
    jarv-genie key set BLENDER_PAINT_TOKEN jarv-paint-dev
Then run the full 1:1 pipeline (craft + free-GPU paint):
    node scripts/blender/craft-one.mjs <your-image>.jpg --paint-remote

Keep this Kaggle cell running the whole time. MIT; uses open-source Hunyuan3D-2.1.
"""

import json
import os
import re
import subprocess
import sys
import tempfile
import threading
import time

# ------------------------- tunables ------------------------------------------
HOST = "0.0.0.0"
PORT = 8000
AUTH_TOKEN = "jarv-paint-dev"
HUNYUAN_GIT = "https://github.com/Tencent-Hunyuan/Hunyuan3D-2.1.git"
HUNYUAN_DIR = ""          # filled by install()
MAX_NUM_VIEW = 6
RESOLUTION = 512
LOW_VRAM = os.environ.get("BLENDER_PAINT_LOW_VRAM", "0") == "1"

_JOBS = {}
_job_counter = [0]


# ------------------------- Hunyuan3D-2.1 install ------------------------------
def install():
    global HUNYUAN_DIR
    print("[paint-host] installing Hunyuan3D-2.1 (clone + deps + compile)...")
    print("[paint-host] NOTE: this can take ~5-15 min on first run; the tunnel URL prints AFTER install.")
    if not os.path.isdir("Hunyuan3D-2.1"):
        try:
            subprocess.run(["git", "clone", "--depth", "1", HUNYUAN_GIT, "Hunyuan3D-2.1"], check=True)
        except Exception as exc:  # noqa: BLE001
            print(f"[paint-host] WARN: git clone failed: {exc}")
            print("[paint-host] continuing anyway — the paint stage needs the checkout; if this errors the tunnel still starts.")
    HUNYUAN_DIR = os.path.join(os.getcwd(), "Hunyuan3D-2.1")
    if not os.path.isdir(HUNYUAN_DIR):
        print("[paint-host] WARN: Hunyuan3D-2.1 dir missing; paint will fail but tunnel still starts.")
        return
    os.chdir(HUNYUAN_DIR)
    def _run(args, **kw):
        try:
            subprocess.run(args, check=False, **kw)
        except Exception as exc:  # noqa: BLE001
            print(f"[paint-host] WARN: step failed ({exc}) — continuing")
    _run([sys.executable, "-m", "pip", "install", "-q",
          "torch==2.5.1", "torchvision==0.20.1", "torchaudio==2.5.1",
          "--index-url", "https://download.pytorch.org/whl/cu124"])
    _run([sys.executable, "-m", "pip", "install", "-q", "-r", "requirements.txt"])
    _run(["bash", "compile_mesh_painter.sh"],
         cwd=os.path.join(HUNYUAN_DIR, "hy3dpaint", "DifferentiableRenderer"))
    _run([sys.executable, "-m", "pip", "install", "-q", "-e", "."],
         cwd=os.path.join(HUNYUAN_DIR, "hy3dpaint", "custom_rasterizer"))
    ckpt_dir = os.path.join(HUNYUAN_DIR, "hy3dpaint", "ckpt")
    os.makedirs(ckpt_dir, exist_ok=True)
    ckpt = os.path.join(ckpt_dir, "RealESRGAN_x4plus.pth")
    if not os.path.exists(ckpt):
        try:
            subprocess.run(["wget", "-q",
                            "https://github.com/xinntao/Real-ESRGAN/releases/download/v0.1.0/RealESRGAN_x4plus.pth",
                            "-O", ckpt], check=False)
        except Exception:  # noqa: BLE001
            pass
    print("[paint-host] install finished.")


# ------------------------- paint execution ------------------------------------
def _gpu_count():
    """Number of CUDA-visible GPUs (0 if torch absent/CPU)."""
    try:
        import torch
        return torch.cuda.device_count() if torch.cuda.is_available() else 0
    except Exception:  # noqa: BLE001
        return 0


def _run_paint(job_id, mesh_path, ref_path, out_path):
    try:
        sys.path.insert(0, HUNYUAN_DIR)
        sys.path.insert(0, os.path.join(HUNYUAN_DIR, "hy3dpaint"))
        from textureGenPipeline import Hunyuan3DPaintConfig, Hunyuan3DPaintPipeline
        _JOBS[job_id]["status"] = "running"
        config = Hunyuan3DPaintConfig(max_num_view=MAX_NUM_VIEW, resolution=RESOLUTION)
        paint = Hunyuan3DPaintPipeline(config)
        # Auto low-VRAM: half-cast models if LOW_VRAM OR a single GPU (paint wants ~21GB)
        use_low = LOW_VRAM or (_gpu_count() < 2)
        if use_low:
            _JOBS[job_id]["status"] = "running(low-vram)"
            try:
                for name in list(paint.models):
                    try:
                        paint.models[name] = paint.models[name].half()
                    except Exception:
                        pass
            except Exception as exc:  # noqa: BLE001
                print(f"[paint-host] low-vram cast warning: {exc}")
        paint(mesh_path=mesh_path, image_path=ref_path, output_mesh_path=out_path, save_glb=True)
        _JOBS[job_id]["status"] = "done"
        _JOBS[job_id]["out"] = out_path
    except Exception as exc:  # noqa: BLE001
        import traceback
        _JOBS[job_id]["status"] = "failed"
        _JOBS[job_id]["error"] = str(exc)
        print("[paint-host] PAINT JOB FAILED:")
        traceback.print_exc()
        print("---- end paint error ----")


# ------------------------- tiny HTTP server ------------------------------------
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer  # noqa: E402


def _gen_id():
    _job_counter[0] += 1
    return f"jarv-{int(time.time())}-{_job_counter[0]}"


def _require_auth(headers):
    token = headers.get("Authorization", "").replace("Bearer ", "")
    if AUTH_TOKEN and token != AUTH_TOKEN:
        raise PermissionError("bad token")


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
            part = part.lstrip(b"\r\n")
            if part.startswith(b"Content-Disposition"):
                head, _, body = part.partition(b"\r\n\r\n")
                name = re.search(r'name="([^"]+)"', head.decode(errors="ignore"))
                fn = re.search(r'filename="([^"]+)"', head.decode(errors="ignore"))
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
                mesh, ref = f.get("mesh"), f.get("reference")
                if not mesh or not ref:
                    return self._send(400, {"error": "need mesh + reference"})
                jid = _gen_id()
                wrk = tempfile.mkdtemp(prefix="jarvpaint_")
                mp = os.path.join(wrk, mesh[1]); rp = os.path.join(wrk, ref[1])
                op = os.path.join(wrk, "painted.glb")
                open(mp, "wb").write(mesh[0]); open(rp, "wb").write(ref[0])
                _JOBS[jid] = {"status": "queued", "out": op}
                threading.Thread(target=_run_paint, args=(jid, mp, rp, op), daemon=True).start()
                return self._send(200, {"job_id": jid})
            return self._send(404, {"error": "not found"})
        except PermissionError:
            return self._send(401, {"error": "unauthorized"})
        except Exception as exc:  # noqa: BLE001
            return self._send(500, {"error": str(exc)})

    def do_GET(self):  # noqa: N802
        try:
            _require_auth(self.headers)
            if self.path.rstrip("/").endswith("/ping"):
                return self._send(200, {"status": "ok"})
            m = re.match(r"^/jobs/([^/]+)$", self.path)
            if m:
                j = _JOBS.get(m.group(1))
                if j is None:
                    return self._send(404, {"error": "no such job"})
                resp = {"status": j["status"]}
                if j.get("error"):
                    resp["error"] = j["error"]
                return self._send(200, resp)
            m2 = re.match(r"^/jobs/([^/]+)/result$", self.path)
            if m2:
                j = _JOBS.get(m2.group(1))
                if not j or j["status"] != "done":
                    return self._send(202, {"error": "not ready"})
                return self._send(200, body=open(j["out"], "rb").read(), ctype="model/gltf-binary")
            return self._send(404, {"error": "not found"})
        except PermissionError:
            return self._send(401, {"error": "unauthorized"})
        except Exception as exc:  # noqa: BLE001
            return self._send(500, {"error": str(exc)})


def _ensure_cloudflared():
    import platform
    import urllib.request
    bin_dir = os.path.join(os.path.expanduser("~"), "bin")
    os.makedirs(bin_dir, exist_ok=True)
    exe = os.path.join(bin_dir, "cloudflared")
    if os.path.exists(exe):
        return exe
    base = "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared"
    try:
        print("[tunnel] downloading cloudflared...")
        subprocess.run(["curl", "-sL", "-o", exe, f"{base}-linux-amd64"], check=True)
        os.chmod(exe, 0o755)
        return exe
    except Exception as exc:  # noqa: BLE001
        print(f"[tunnel] download failed: {exc}")
        return None


# ------------------------- run -----------------------------------------------
# Start the HTTP server first, then open the tunnel and print the URL IMMEDIATELY
# (so you can copy it while Hunyuan3D-2.1 installs in the background). The paint
# stage becomes ready once install() completes and the first job runs.
print(">> Starting paint HTTP server + free tunnel (you'll get the URL in ~seconds)...")
server_thread = threading.Thread(
    target=lambda: ThreadingHTTPServer((HOST, PORT), _H).serve_forever(),
    daemon=True,
)
server_thread.start()
print(f"[paint-host] HTTP server listening on :{PORT} (token {AUTH_TOKEN})")

def _open_tunnel():
    exe = _ensure_cloudflared()
    if not exe:
        print("[tunnel] !! cloudflared missing — no tunnel. Install it or expose :8000 manually.")
        return
    print("[tunnel] opening a free trycloudflare tunnel to :8000 ... (up to ~90s)")
    proc = subprocess.Popen([exe, "tunnel", "--url", f"http://localhost:{PORT}"],
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    import time as _t
    deadline = _t.time() + 90
    for line in proc.stdout:
        m = re.search(r"https://[a-z0-9-]+\.trycloudflare\.com", line)
        if m:
            print("\n" + "=" * 64)
            print("KAGGLE IS LIVE. COPY THIS URL INTO THE M1 TERMINAL (once):")
            print("  jarv-genie key set BLENDER_PAINT_URL " + m.group(0))
            print("  jarv-genie key set BLENDER_PAINT_TOKEN " + AUTH_TOKEN)
            print("then run:  node scripts/blender/craft-one.mjs <img>.jpg --paint-remote")
            print("(the paint model is still installing — paste the URL now, craft after install done)")
            print("=" * 64 + "\n")
            break
        if _t.time() > deadline:
            print("[tunnel] WARN: no URL in 90s — check Internet egress / port 8000. Exposing :8000 you set it manually.")
            break
    try:
        proc.wait()
    except KeyboardInterrupt:
        proc.terminate()
    while True:
        _t.sleep(3600)

# Tunnel opens in the background and prints the URL fast; install runs in foreground.
tunnel_thread = threading.Thread(target=_open_tunnel, daemon=True)
tunnel_thread.start()

print(">> STEP: installing Hunyuan3D-2.1 (continues in background — paste the URL when you see it)...")
install()
print("[paint-host] install done. Server + tunnel are up; send jobs from the M1 now.")
