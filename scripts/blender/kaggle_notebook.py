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
    print("[paint-host] NOTE: first run can take ~10-20 min (clone + heavy deps + CUDA compile).")
    # --- 0) build prerequisites for the CUDA rasterizer compile -----------------
    # Kaggle often lacks python3-config / build tools; without them the custom
    # rasterizer can't compile and every paint job fails. VERIFY it exists and
    # if apt fails, fall back to creating a python3-config shim from the python.
    import shutil
    print("[paint-host] ensuring build tools (python3-dev, build-essential)...")
    try:
        subprocess.run(["apt-get", "update", "-qq"], check=False)
    except Exception:  # noqa: BLE001
        pass
    try:
        subprocess.run(["apt-get", "install", "-y", "-qq", "--no-install-recommends",
                        "python3-dev", "build-essential", "gcc", "g++", "ninja-build"], check=True)
    except Exception as exc:  # noqa: BLE001
        print(f"[paint-host] WARN: apt-get build tools failed: {exc}")
    # Verify python3-config is now available; if not, create a shim.
    if shutil.which("python3-config") is None:
        print("[paint-host] python3-config still missing — creating a shim from the python binary.")
        try:
            py = sys.executable
            conf_dir = os.path.expanduser("~/bin")
            os.makedirs(conf_dir, exist_ok=True)
            conf = os.path.join(conf_dir, "python3-config")
            shim = (
                "#!/usr/bin/env python3\n"
                "import sys, sysconfig as s\n"
                "inc = s.get_paths().get('include','')\n"
                "lib = s.get_config_var('LIBDIR') or ''\n"
                "ver = s.get_config_var('LDVERSION') or '3'\n"
                "a = sys.argv[1] if len(sys.argv) > 1 else ''\n"
                "if a in ('--includes','-I','--cflags'): out = '-I' + inc\n"
                "elif a in ('--ldflags','--libs'): out = '-L' + lib + ' -lpython' + ver\n"
                "elif a == '--extension-suffix': out = s.get_config_var('EXT_SUFFIX') or ''\n"
                "else: out = (s.get_config_var('LIBS') or '') + ' ' + (s.get_config_var('SYSLIBS') or '')\n"
                "sys.stdout.write(out + '\\n')\n"
            )
            with open(conf, "w") as fh:
                fh.write(shim)
            os.chmod(conf, 0o755)
            if conf_dir not in os.environ.get("PATH", ""):
                os.environ["PATH"] = conf_dir + ":" + os.environ.get("PATH", "")
            print(f"[paint-host] created {conf} and added ~/bin to PATH")
        except Exception as exc:  # noqa: BLE001
            print(f"[paint-host] WARN: could not create python3-config shim: {exc}")
    print(f"[paint-host] python3-config -> {shutil.which('python3-config')}")
    # setuptools + ninja help torch CUDA extensions build (esp. setup.py develop)
    try:
        subprocess.run([sys.executable, "-m", "pip", "install", "-q", "setuptools", "ninja"], check=False)
    except Exception:  # noqa: BLE001
        pass

    if not os.path.isdir("Hunyuan3D-2.1"):
        try:
            subprocess.run(["git", "clone", "--depth", "1", HUNYUAN_GIT, "Hunyuan3D-2.1"], check=True)
        except Exception as exc:  # noqa: BLE001
            print(f"[paint-host] WARN: git clone failed: {exc}")
    HUNYUAN_DIR = os.path.join(os.getcwd(), "Hunyuan3D-2.1")
    if not os.path.isdir(HUNYUAN_DIR):
        print("[paint-host] WARN: Hunyuan3D-2.1 dir missing; paint will fail but tunnel still starts.")
        return
    os.chdir(HUNYUAN_DIR)
    def _run(args, **kw):
        try:
            return subprocess.run(args, check=False, **kw)
        except Exception as exc:  # noqa: BLE001
            print(f"[paint-host] WARN: step failed ({exc}) — continuing")
            return None

    _run([sys.executable, "-m", "pip", "install", "-q",
          "torch==2.5.1", "torchvision==0.20.1", "torchaudio==2.5.1",
          "--index-url", "https://download.pytorch.org/whl/cu124"])
    _run([sys.executable, "-m", "pip", "install", "-q", "-r", "requirements.txt"])
    # Explicit runtime deps the paint pipeline needs at import time (trimesh handles
    # mesh load/save/export; the source repo's requirements may not pin these).
    # PIN numpy<=1.26 — numpy 2.x + various deps throws
    # '_multiarray_umath has no attribute _blas_supports_fpe'; torch 2.5 + rembg/
    # opencv expect numpy 1.x here.
    _run([sys.executable, "-m", "pip", "install", "-q", "--upgrade",
          "numpy==1.26.4", "trimesh", "Pillow", "scipy", "rembg", "huggingface_hub"])
    # pymeshlab (mesh remesh for paint) + UV unwrap (xatlas) + misc
    _run([sys.executable, "-m", "pip", "install", "-q",
          "pymeshlab", "pygltflib", "opencv-python-headless", "xatlas", "open3d", "onnxruntime",
          "realesrgan", "basicsr"])
    # RE-PIN numpy LAST (see above)
    _run([sys.executable, "-m", "pip", "install", "-q", "numpy==1.26.4"])

    # --- compile the custom CUDA rasterizers (REQUIRED for paint) ---------------
    print("[paint-host] compiling mesh painter (DifferentiableRenderer + custom_rasterizer)...")
    print("[paint-host] OUTPUT BELOW IS THE BUILD LOG (scroll past this to see the result) ===========")
    for step, args, cwd in [
        ("mesh_painter", ["bash", "compile_mesh_painter.sh"],
         os.path.join(HUNYUAN_DIR, "hy3dpaint", "DifferentiableRenderer")),
        # build_ext --inplace surfaces the REAL gcc/nvcc error (pip install -e hides it)
        ("custom_rasterizer", [sys.executable, "setup.py", "build_ext", "--inplace"],
         os.path.join(HUNYUAN_DIR, "hy3dpaint", "custom_rasterizer")),
    ]:
        print(f"\n[paint-host {step}] running: {' '.join(args)} in {cwd}")
        try:
            r = subprocess.run(args, cwd=cwd, text=True, capture_output=True, timeout=600)
            print(f"[paint-host {step}] exit={r.returncode}")
            if r.stdout:
                print(r.stdout[-6000:])
            if r.stderr:
                print("[stderr] " + r.stderr[-6000:])
        except Exception as exc:  # noqa: BLE001
            print(f"[paint-host {step}] failed to run: {exc}")
    print("[paint-host] =============== end build log ===============")

    # --- verify the rasterizer actually built, else paint can't run --------------
    built = False
    for base in [
        os.path.join(HUNYUAN_DIR, "hy3dpaint", "DifferentiableRenderer"),
        os.path.join(HUNYUAN_DIR, "hy3dpaint", "custom_rasterizer"),
    ]:
        for root, _, files in os.walk(base):
            for f in files:
                # .so that is a torch extension (custom_rasterizer_kernel = built)
                if f.endswith(".so") and ("cuda" in f.lower() or "kernel" in f.lower()):
                    built = True
    if built:
        print("[paint-host] rasterizer compiled OK.")
    else:
        print("[paint-host] !! rasterizer compile may have failed — paint may error at runtime. Check the build output above.")

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
        # Compatibility: diffusers (needed by Hunyuan3D paint) does `import numpy.char`,
        # which was removed in numpy 2.x (renamed to numpy.strings). Alias it so the
        # import works regardless of the session's numpy version.
        try:
            import numpy
            import sys as _sys
            # numpy 2.x renamed numpy.char -> numpy.strings and numpy.rec -> numpy.recarray;
            # diffusers imports both. Alias so the imports work on any numpy version.
            try:
                import numpy.strings as _strings
                _sys.modules.setdefault("numpy.char", _strings)
            except Exception:  # noqa: BLE001
                pass
            try:
                import numpy.recarray
                _sys.modules.setdefault("numpy.rec", numpy.recarray)
            except Exception:  # noqa: BLE001
                # fallback: rec lives at numpy.core.records in some 2.x builds
                try:
                    import numpy.core.records as _rec
                    _sys.modules.setdefault("numpy.rec", _rec)
                except Exception:  # noqa: BLE001
                    pass
        except Exception:  # noqa: BLE001
            pass
        # torchvision 0.16+ removed transforms.functional_tensor (moved into
        # transforms.functional). basicsr/realesrgan still import functional_tensor;
        # alias it to the current functional module so those imports resolve.
        try:
            import sys as _tvs, torchvision, torchvision.transforms.functional as _fn
            _tvs.modules.setdefault("torchvision.transforms.functional_tensor", _fn)
            _tvs.modules.setdefault("torchvision.transforms.functional_pil", _fn)
        except Exception:  # noqa: BLE001
            pass
        # textureGenPipeline imports 'from DifferentiableRenderer.mesh_utils import
        # convert_obj_to_glb', and mesh_utils does `import bpy` at module load.
        # bpy pip isn't installable on Kaggle, so alias a stub bpy module so the
        # import succeeds; the bpy-using function is never CALLED because we export
        # the GLB via trimesh (save_glb=False). Only the name lookup must resolve.
        try:
            import sys as _s2, types as _types
            if "bpy" not in _s2.modules:
                class _Dummy:
                    def __getattr__(self, k):
                        # dunder/reflection must not recurse (deepcopy/pickle/hasattr)
                        if k.startswith("__") and k.endswith("__"):
                            raise AttributeError(k)
                        return _Dummy()
                    def __getitem__(self, k):
                        return _Dummy()
                    def __call__(self, *a, **k):
                        return _Dummy()
                    def __deepcopy__(self, memo):
                        return self
                    def __bool__(self):
                        return False
                    def __iter__(self):
                        return iter(())
                    def __eq__(self, other):
                        return isinstance(other, _Dummy)
                    def __hash__(self):
                        return id(self)
                _stub = _types.ModuleType("bpy")
                _stub.app = _types.ModuleType("bpy.app"); _stub.app.version = (4, 0, 0)
                _stub.data = _Dummy(); _stub.context = _Dummy(); _stub.ops = _Dummy()
                _stub.utils = _Dummy(); _stub.path = _Dummy(); _stub.types = _Dummy(); _stub.props = _Dummy()
                _s2.modules["bpy"] = _stub
                _s2.modules["bpy.data"] = _stub.data
                _s2.modules["bpy.context"] = _stub.context
                _s2.modules["bpy.ops"] = _stub.ops
                _s2.modules["bpy.app"] = _stub.app
                _s2.modules["bpy.utils"] = _stub.utils
                _s2.modules["bpy.path"] = _stub.path
                _s2.modules["bpy.types"] = _stub.types
                _s2.modules["bpy.props"] = _stub.props
            print("[paint-host] bpy stub:", "applied" if "bpy" in _s2.modules else "MISSING")
        except Exception as exc:  # noqa: BLE001
            print(f"[paint-host] bpy stub error: {exc}")
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
        # paint() writes an OBJ to out_path; convert to GLB with trimesh (bpy-based
        # convert_obj_to_glb would need bpy, which pip can't install on Kaggle).
        obj_path = out_path  # paint writes .obj here (output_mesh_path)
        paint(mesh_path=mesh_path, image_path=ref_path, output_mesh_path=obj_path, save_glb=False)
        # trimesh OBJ -> GLB
        import trimesh
        _m = trimesh.load(obj_path, force="mesh")
        if isinstance(_m, trimesh.Scene):
            export = trimesh.exchange.gltf.export_glb(_m)
            with open(out_path, "wb") as fh:
                fh.write(export)
        else:
            _m.export(out_path, file_type="glb")
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
# If port 8000 is already bound (previous session's server thread still alive), reuse
# it instead of erroring "Address already in use" and double-tunneling.
def _server_listening():
    import socket
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.settimeout(1)
        return s.connect_ex(("127.0.0.1", PORT)) == 0
    except Exception:  # noqa: BLE001
        return False

if _server_listening():
    print(f"[paint-host] server already listening on :{PORT} — reusing it.")
else:
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
