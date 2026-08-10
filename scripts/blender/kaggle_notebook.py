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
    if not os.path.isdir("Hunyuan3D-2.1"):
        subprocess.run(["git", "clone", HUNYUAN_GIT, "Hunyuan3D-2.1"], check=True)
    HUNYUAN_DIR = os.path.join(os.getcwd(), "Hunyuan3D-2.1")
    os.chdir(HUNYUAN_DIR)
    subprocess.run([sys.executable, "-m", "pip", "install", "-q",
                    "torch==2.5.1", "torchvision==0.20.1", "torchaudio==2.5.1",
                    "--index-url", "https://download.pytorch.org/whl/cu124"], check=False)
    subprocess.run([sys.executable, "-m", "pip", "install", "-q", "-r", "requirements.txt"], check=False)
    subprocess.run(["bash", "compile_mesh_painter.sh"],
                   cwd=os.path.join(HUNYUAN_DIR, "hy3dpaint", "DifferentiableRenderer"), check=False)
    subprocess.run([sys.executable, "-m", "pip", "install", "-q", "-e", "."],
                   cwd=os.path.join(HUNYUAN_DIR, "hy3dpaint", "custom_rasterizer"), check=False)
    ckpt = os.path.join(HUNYUAN_DIR, "hy3dpaint", "ckpt", "RealESRGAN_x4plus.pth")
    os.makedirs(os.path.dirname(ckpt), exist_ok=True)
    if not os.path.exists(ckpt):
        subprocess.run(["wget", "-q",
                        "https://github.com/xinntao/Real-ESRGAN/releases/download/v0.1.0/RealESRGAN_x4plus.pth",
                        "-O", ckpt], check=False)
    print("[paint-host] install done. Weights download on first paint run.")


# ------------------------- paint execution ------------------------------------
def _run_paint(job_id, mesh_path, ref_path, out_path):
    try:
        sys.path.insert(0, HUNYUAN_DIR)
        sys.path.insert(0, os.path.join(HUNYUAN_DIR, "hy3dpaint"))
        from textureGenPipeline import Hunyuan3DPaintConfig, Hunyuan3DPaintPipeline
        _JOBS[job_id]["status"] = "running"
        config = Hunyuan3DPaintConfig(max_num_view=MAX_NUM_VIEW, resolution=RESOLUTION)
        paint = Hunyuan3DPaintPipeline(config)
        if LOW_VRAM:
            try:
                for name in list(paint.models):
                    paint.models[name] = getattr(paint.models[name], "half", lambda: paint.models[name])()
            except Exception:
                pass
        paint(mesh_path=mesh_path, image_path=ref_path, output_mesh_path=out_path, save_glb=True)
        _JOBS[job_id]["status"] = "done"
        _JOBS[job_id]["out"] = out_path
    except Exception as exc:  # noqa: BLE001
        _JOBS[job_id]["status"] = "failed"
        _JOBS[job_id]["error"] = str(exc)


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
            m = re.match(r"^/jobs/([^/]+)$", self.path)
            if m:
                j = _JOBS.get(m.group(1))
                return self._send(404, {"error": "no such job"}) if j is None else self._send(200, {"status": j["status"]})
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


def start(tunnel=True):
    def _serve():
        ThreadingHTTPServer((HOST, PORT), _H).serve_forever()
    threading.Thread(target=_serve, daemon=True).start()
    print(f"[paint-host] listening :{PORT} (token {AUTH_TOKEN})")
    if not tunnel:
        return
    exe = _ensure_cloudflared()
    if not exe:
        return
    print("[tunnel] opening trycloudflare tunnel to :8000...")
    proc = subprocess.Popen([exe, "tunnel", "--url", f"http://localhost:{PORT}"],
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    for line in proc.stdout:
        m = re.search(r"https://[a-z0-9-]+\.trycloudflare\.com", line)
        if m:
            print("\n" + "=" * 60)
            print("COPY THIS URL INTO THE M1 TERMINAL (once):")
            print("  jarv-genie key set BLENDER_PAINT_URL " + m.group(0))
            print("  jarv-genie key set BLENDER_PAINT_TOKEN " + AUTH_TOKEN)
            print("then run:  node scripts/blender/craft-one.mjs <img>.jpg --paint-remote")
            print("=" * 60 + "\n")
    try:
        proc.wait()
    except KeyboardInterrupt:
        proc.terminate()


# ------------------------- run -----------------------------------------------
print(">> STEP 1/2: installing Hunyuan3D-2.1 (first run takes a few minutes)...")
install()
print(">> STEP 2/2: starting paint host + free tunnel...")
start(tunnel=True)
