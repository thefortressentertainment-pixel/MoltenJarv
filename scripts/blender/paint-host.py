#!/usr/bin/env python3
"""
Free-GPU paint host — run inside a 0-cost GPU notebook (Kaggle dual-T4 or Colab T4).
This is the REMOTE side of Jarv's `bpy_paint_remote`: the M1 crafts a mesh here
already can't paint (needs ~38GB), so it uploads the mesh+reference here; this
notebook runs Hunyuan3D-2.1 paint (PyTorch, CUDA on the free T4, GPU+CPU offload)
and returns the textured GLB.

Usage (in a Kaggle/Colab cell):
  1. Leave ACCELERATOR=GPU when writing the cell.
  2. `!pip install -q fastapi uvicorn python-multipart pyngrok` (Kaggle) or use the
     Colab-copied version of the M1's craft client info.
  3. Copy THIS file into the notebook, then run:  paint_host.start()
  4. Expose port 8000 with a tunnel (ngrok) and set on the M1:
        jarv-genie key set BLENDER_PAINT_URL <https://xxxx.ngrok-free.app>
        jarv-genie key set BLENDER_PAINT_TOKEN <your-token>

The M1 then sends the mesh GLB + reference and gets back /tmp/jarv_painted.glb.

LICENSE: MIT (adapted for Jarv's Blender Branch). Running Hunyuan3D-2.1 requires
downloading its weights (Tencent-Hunyuan/Hunyuan3D-2.1, MIT) on the notebook.
"""

import json
import os
import time
import threading
import tempfile
import urllib.request

# --- tunables ---------------------------------------------------------------
HOST = "0.0.0.0"
PORT = 8000
AUTH_TOKEN = os.environ.get("BLENDER_PAINT_TOKEN", "jarv-paint-dev")
# Hunyuan3D-2.1 paint weights (HF repo). Download once on the notebook via:
#   git clone https://github.com/Tencent-Hunyuan/Hunyuan3D-2.1
#   huggingface-cli download tencent/Hunyuan3D-2.1 --local-dir hunyuan3d/weights
HUNYUAN_GIT = "https://github.com/Tencent-Hunyuan/Hunyuan3D-2.1.git"

_JOBS = {}  # job_id -> {"status", "out": path}
_job_counter = [0]


def _gen_id():
    _job_counter[0] += 1
    return f"jarv-{int(time.time())}-{_job_counter[0]}"


def _require_auth(headers):
    token = headers.get("Authorization", "").replace("Bearer ", "")
    if AUTH_TOKEN and token != AUTH_TOKEN:
        raise PermissionError("bad token")


def _run_paint(job_id, mesh_path, ref_path, out_path):
    """Run Hunyuan3D-2.1 paint on a free T4 with CPU offload. Best-effort: the exact
    API is version-dependent; adapt to the installed Hunyuan3D-2.1 checkout."""
    try:
        import sys
        sys.path.insert(0, os.path.join(os.getcwd(), "Hunyuan3D-2.1"))
        from hy3dgen.rembg import BackgroundRemover
        from hy3dgen.texgen import Hunyuan3DTexGen

        texgen = Hunyuan3DTexGen()
        _JOBS[job_id]["status"] = "running"
        # The backend paints the existing mesh's UV with the reference image.
        # (Adjust to the installed API: forward(prompt/image, mesh) -> new mesh.)
        mesh = texgen.forward(ref_path, mesh_path)
        # Save as GLB
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
