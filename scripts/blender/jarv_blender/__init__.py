# Jarv Genie ⇄ Blender Bridge (Blender 4.2+ / 5.x extension)
#
# Prompt Jarv Genie from inside Blender and let Jarv take it away. This add-on
# POSTs a prompt to the always-on Jarv hub (`POST /api/chat`) and shows the reply
# in a Sidebar panel (N > Jarv). Your prompt routes through Jarv's full agent
# loop, so with the right resources (allowControl, tools) Jarv can act on Blender
# work too.
#
# Install is via the Extensions system (auto-loads from user_default):
#   Edit > Preferences > Add-ons > search "Jarv" > check it.
#
# This file is versioned in the MoltenJarv repo at scripts/blender/jarv_blender/.
# To deploy an updated copy, replace it in the Blender extensions dir, e.g.:
#   cp scripts/blender/jarv_blender/__init__.py \
#     "$HOME/Library/Application Support/Blender/5.1/extensions/user_default/jarv_blender/__init__.py"
# then restart Blender.

bl_info = {
    "name": "Jarv Blender Bridge",
    "author": "Jarv Genie",
    "version": (0, 1, 0),
    "blender": (4, 2, 0),
    "location": "Sidebar (N) > Jarv",
    "description": "Prompt the Jarv Genie AI assistant from inside Blender",
    "category": "Development",
    "support": "COMMUNITY",
}

import json
import os
import threading
import time
import urllib.request
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# Extension add-on: the add-ons preferences collection is keyed by the MODULE
# name, which in Blender 4.2+/5.x is the full extension namespace
# (bl_ext.user_default.jarv_blender), NOT the bare manifest id. Resolve the real
# name at module load so the preferences lookup (and AddonPreferences.bl_idname)
# match exactly. When run standalone, __name__ is __main__, so fall back to the id.
ADDON_ID = __name__ if not __name__.endswith("__main__") else "jarv_blender"

import bpy

# Default hub URL (the launchd hub binds 0.0.0.0:3001). Override in prefs.
DEFAULT_HUB = "http://127.0.0.1:3001"
DEFAULT_BRIDGE_PORT = 3937
AUTH_FILE = Path.home() / ".jarv-genie" / "auth.json"
STATE_FILE = Path.home() / ".jarv-genie" / "blender-state.json"


def _read_token():
    """Read the bearer token the hub generated (see ~/.jarv-genie/auth.json)."""
    try:
        data = json.loads(AUTH_FILE.read_text())
        tok = data.get("token")
        return tok if isinstance(tok, str) and tok else None
    except Exception:
        return None


def _ask_jarv(hub, token, message, timeout=300):
    """POST a prompt to the hub's /api/blender (RAM-light Blender handler) and return the reply text."""
    url = (hub or DEFAULT_HUB).rstrip("/") + "/api/blender"
    payload = json.dumps({"message": message}).encode("utf-8")
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = "Bearer " + token
    req = urllib.request.Request(url, data=payload, headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        body = json.loads(resp.read().decode("utf-8"))
    if isinstance(body.get("error"), str):
        return "[error] " + body["error"]
    return body.get("text") or "(no reply)"


def _safe_repr(text):
    return (text or "").replace("\t", " " * 4)


class JARV_OT_ask(bpy.types.Operator):
    bl_idname = "jarv.ask"
    bl_label = "Ask Jarv"
    bl_description = "Send the prompt in the Jarv panel to the Jarv Genie hub"

    _timer = None
    _thread = None
    _done = threading.Event()
    _result = {}
    # Module-level busy guard: while one request is in flight we IGNORE further
    # invocations, so pressing Enter AND clicking "Ask Jarv" cannot stack two runs.
    _running = False

    @classmethod
    def busy(cls):
        return cls._running

    def invoke(self, context, event):
        # Busy guard: if a request is already in flight, refuse to start another.
        if JARV_OT_ask._running:
            self.report({"WARNING"}, "Jarv is already working — wait for it to finish.")
            return {"CANCELLED"}
        scn = context.scene
        message = scn.jarv_prompt.strip()
        if not message:
            self.report({"WARNING"}, "Type a prompt first")
            return {"CANCELLED"}
        prefs = context.preferences.addons[ADDON_ID].preferences
        hub = prefs.hub_url.strip() or DEFAULT_HUB
        token = prefs.token.strip() or _read_token()

        JARV_OT_ask._running = True
        scn.jarv_prompt = ""
        scn.jarv_reply = "..."
        scn.jarv_status = f"asking {hub}… (do not press Enter again)"

        # Run the network call off the main (UI) thread so Blender never blocks,
        # and so closing Blender/disconnecting cleanly doesn't leave a stuck modal.
        # Only one request can be in flight thanks to the busy guard.
        self._done = threading.Event()
        self._result = {}

        def work():
            try:
                r = _ask_jarv(hub, token, message)
                self._result = {"reply": r}
            except Exception as exc:  # hub down, timeout, or Blender quitting
                self._result = {"error": str(exc)}
            finally:
                try:
                    self._done.set()
                except Exception:
                    pass

        self._thread = threading.Thread(target=work, daemon=True)
        self._thread.start()

        # Start a modal timer so we can poll the background thread and update the
        # panel without blocking the UI.
        wm = context.window_manager
        self._timer = wm.event_timer_add(0.4, window=context.window)
        wm.modal_handler_add(self)
        return {"RUNNING_MODAL"}

    def modal(self, context, event):
        if event.type == "TIMER":
            if not self._done.is_set():
                return {"RUNNING_MODAL"}
            # Thread finished (success or quit/error).
            wm = context.window_manager
            wm.event_timer_remove(self._timer)
            JARV_OT_ask._running = False
            scn = context.scene
            if "error" in self._result:
                scn.jarv_reply = "[error] " + self._result["error"][:500]
                scn.jarv_status = "connection failed"
                self.report({"ERROR"}, "Jarv hub request failed/quit mid-flight.")
            else:
                scn.jarv_reply = _safe_repr(self._result.get("reply", "(no reply)"))
                scn.jarv_status = "done"
            # Refresh the panel so the button re-enables and reply shows.
            if context.area:
                context.area.tag_redraw()
            return {"FINISHED"}
        return {"PASS_THROUGH"}

    def execute(self, context):
        # Kept for compatibility (invoke() handles the real path).
        return self.invoke(context, None)


class JARV_PT_panel(bpy.types.Panel):
    bl_label = "Jarv"
    bl_idname = "JARV_PT_panel"
    bl_space_type = "VIEW_3D"
    bl_region_type = "UI"
    bl_category = "Jarv"

    def draw(self, context):
        layout = self.layout
        scn = context.scene
        busy = JARV_OT_ask.busy()

        row = layout.row(align=True)
        row.prop(scn, "jarv_prompt", text="")
        row.operator("jarv.ask", text="Ask Jarv" if not busy else "Working…", icon="GHOST_ENABLED").enabled = not busy

        if scn.jarv_status:
            layout.label(text=scn.jarv_status)
        if scn.jarv_reply:
            box = layout.box()
            col = box.column()
            col.scale_y = 0.9
            for line in scn.jarv_reply.splitlines():
                col.label(text=line)


class JarvAddonPreferences(bpy.types.AddonPreferences):
    bl_idname = ADDON_ID

    hub_url: bpy.props.StringProperty(
        name="Hub URL",
        description="Base URL of the Jarv hub (/api/chat is appended)",
        default=DEFAULT_HUB,
    )
    token: bpy.props.StringProperty(
        name="Auth Token (optional)",
        description="Leave blank to auto-read ~/.jarv-genie/auth.json.",
        default="",
    )
    bridge_port: bpy.props.IntProperty(
        name="Live bridge port",
        description="Local port Jarv's hub uses to drive THIS Blender's live scene.",
        default=DEFAULT_BRIDGE_PORT,
        min=1024,
        max=65535,
    )
    detail_depth: bpy.props.FloatProperty(
        name="Sculpt detail depth",
        description="0 = off (default). >0 applies a bounded noise-based displacement modifier to organic meshes after each build, approximating sculpted surface detail. Higher = stronger bumps. RAM-safe (displacement is a lazy modifier).",
        default=0.0,
        min=0.0,
        max=1.0,
        step=0.1,
    )

    def draw(self, context):
        layout = self.layout
        layout.prop(self, "hub_url")
        layout.prop(self, "token")
        layout.prop(self, "bridge_port")
        tok = self.token.strip() or _read_token()
        layout.label(text="token: " + ("<auto-detected>" if tok else "<none — hub must be loopback-only>"))
        layout.label(text="live bridge: " + ("RUNNING" if _bridge_running else "stopped"))


# ---------------------------------------------------------------------------
# Live bpy bridge
#
# Jarv's hub POSTs bpy code to this local HTTP server, which executes it in the
# OPEN scene (not a throwaway headless subprocess) and returns JSON. This is how
# Jarv actually changes what you see in Blender. RAM-light: one small socket, no
# resident model. "live" state is advertised via ~/.jarv-genie/blender-state.json
# so the hub knows to target the running Blender instead of a headless one.
# ---------------------------------------------------------------------------
_bridge = None  # ThreadingHTTPServer instance (1 per process)
_bridge_thread = None
_bridge_running = False

# Blender REQUIRES bpy data/operator calls to run on the MAIN thread; running
# bpy.ops from a worker thread freezes Blender for scene-modifying ops. So the
# HTTP handler only enqueues code and waits; a main-thread timer drains the queue
# and actually executes it.
import queue as _queue
_bridge_q = _queue.Queue()
_bridge_timer = None


def _execute_on_main_thread():
    """Blender main-thread timer callback: run queued bpy code, put result back."""
    try:
        while True:
            code, result_slot = _bridge_q.get_nowait()
            try:
                result_slot.append(execute_live_bpy(code))
            except Exception as exc:  # noqa: BLE001
                result_slot.append({"ok": False, "error": str(exc)})
    except _queue.Empty:
        pass
    return 0.05  # keep polling every 50ms while bridge is running


class _BridgeHandler(BaseHTTPRequestHandler):
    def log_message(self, *_a):  # silence request logs
        pass

    def do_POST(self):  # noqa: N802
        body = b'{"ok":false,"error":"bad request"}'
        try:
            length = int(self.headers.get("Content-Length", 0))
            payload = json.loads(self.rfile.read(length).decode("utf-8") or "{}")
            code = payload.get("code", "")
            result_slot = []
            _bridge_q.put((code, result_slot))
            # Wait (with timeout) for the MAIN thread to run it and fill result_slot.
            deadline = time.monotonic() + 60
            while not result_slot and time.monotonic() < deadline:
                time.sleep(0.02)
            body = json.dumps(result_slot[0] if result_slot else {"ok": False, "error": "bpy exec timed out"}).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(body)
        except Exception as exc:  # noqa: BLE001
            body = json.dumps({"ok": False, "error": str(exc)}).encode("utf-8")
            self.send_response(500)
            self.end_headers()
            self.wfile.write(body)

    def do_GET(self):  # noqa: N802
        body = json.dumps({"ok": True, "live": True, "objects": len(bpy.data.objects)}).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(body)


def _ensure_shading():
    """Deterministic auto-shade: give every MESH with zero materials a neutral
    visible Principled material, and add a SUN light if none exists. Only touches
    objects the model did NOT already shade (those keep their material). Called
    after every successful bpy_exec so a build is never left flat-gray."""
    try:
        needs = [o for o in bpy.data.objects if o.type == "MESH" and not o.data.materials]
        if needs:
            default_mat = bpy.data.materials.get("MAT_AutoShade")
            if default_mat is None:
                default_mat = bpy.data.materials.new("MAT_AutoShade")
                default_mat.use_nodes = True
                bsdf = default_mat.node_tree.nodes.get("Principled BSDF")
                if bsdf:
                    bsdf.inputs["Base Color"].default_value = (0.55, 0.55, 0.55, 1)
                    bsdf.inputs["Roughness"].default_value = 0.6
            for o in needs:
                o.data.materials.append(default_mat)
        if not any(o.type == "LIGHT" for o in bpy.data.objects):
            light_data = bpy.data.lights.get("AutoSun") or bpy.data.lights.new("AutoSun", type="SUN")
            light_data.energy = 3.0
            if not any(o.type == "LIGHT" for o in bpy.data.objects):
                so = bpy.data.objects.new("AutoSun", light_data)
                bpy.context.scene.collection.objects.link(so)
                so.rotation_euler = (0.785, 0, 0.5)
        for area in bpy.context.screen.areas if bpy.context.screen else []:
            area.tag_redraw()
    except Exception:  # noqa: BLE001
        pass  # auto-shade is best-effort; never break the main exec result


def _ensure_detail():
    """Deterministic auto-detail so builds are never flat/blocky boxes. Called after
    every successful bpy_exec, mirroring _ensure_shading. Adds LAZY modifiers only
    (Subdivision Surface + Bevel), so Blender's stored geometry is untouched and RAM
    stays low — subsurf/bevel are applied at render/GLB-export time (which is how the
    hub viewer sees smooth results). Only touches meshes the model did NOT already
    give these modifiers (those keep the model's own intent). Gated by a per-object
    vertex budget so huge meshes are never subdivided."""
    try:
        # Vertex cap so a dense build can't blow up geometry on export/render.
        VERT_BUDGET = 200_000
        # Subdivide organic-eligible meshes if they lack a subsurf. Skip non-mesh,
        # skip meshes that already carry a SUBSURF or BEVEL (model's own choice).
        for o in bpy.data.objects:
            if o.type != "MESH" or not o.data or len(o.data.vertices) > VERT_BUDGET:
                continue
            names = {m.type for m in o.modifiers}
            if "SUBSURF" in names or "BEVEL" in names:
                continue  # model already detailed this; respect it
            # Most Jarv builds are organic/EQ primitives; a light subsurf + bevel
            # rounds hard edges and reads as "modeled", not "blocky boxes".
            subsurf = o.modifiers.new("Subsurf", "SUBSURF")
            subsurf.levels = 1
            subsurf.render_levels = 2
            bevel = o.modifiers.new("Bevel", "BEVEL")
            bevel.width = 0.02
            bevel.segments = 1
    except Exception:  # noqa: BLE001
        pass  # detail is best-effort; never break the main exec result


def _ensure_displacement(depth):
    """Optional sculpt-texture approximation. If detail_depth > 0, add a bounded
    noise-based displacement modifier to meshes (skip flat floor/ground planes and
    anything already displaced). Displacement is a LAZY modifier so RAM stays low.
    Deterministic and reversible (delete the modifier to go back to smooth)."""
    if not depth:
        return
    try:
        for o in bpy.data.objects:
            if o.type != "MESH" or not o.data or len(o.data.vertices) > 100_000:
                continue
            if any(m.type == "DISPLACE" for m in o.modifiers):
                continue
            # Skip objects that are basically flat (a floor/tile) — displacement
            # on those looks wrong. Detect via near-zero Z extent.
            nv = o.data.vertices
            if nv:
                zs = [v.co.z for v in nv]
                if (max(zs) - min(zs)) < 0.05:
                    continue
            disp = o.modifiers.new("Displace", "DISPLACE")
            disp.direction = "NORMAL"
            disp.strength = min(float(depth), 0.5)
            disp.mid_level = 0.0
            tex = bpy.data.textures.new("JarveNoise", type="NONE")
            tex.noise_basis = "BLENDER_ORIGINAL"
            disp.texture = tex
    except Exception:  # noqa: BLE001
        pass


def execute_live_bpy(code):
    """Run bpy code on the main thread in the LIVE open scene; returns dict.
    MUST be called from the main (UI) thread — see _execute_on_main_thread."""
    import io
    import traceback
    out = io.StringIO()
    objects_before = {o.name for o in bpy.data.objects}

    def _obj_meta():
        # Per-object spatial ground-truth so the model can reason about shape,
        # position and connectivity (not just names). World AABB + location.
        import mathutils as _mu
        meta = []
        for o in bpy.data.objects:
            loc = tuple(round(float(v), 2) for v in o.location)
            aabb = None
            try:
                bb = [o.matrix_world @ _mu.Vector(c) for c in o.bound_box]
                lo = tuple(round(min(v[i] for v in bb), 2) for i in range(3))
                hi = tuple(round(max(v[i] for v in bb), 2) for i in range(3))
                aabb = [lo, hi]
            except Exception:  # noqa: BLE001
                aabb = None
            meta.append({"name": o.name, "type": o.type, "location": loc, "bounds": aabb, "parent": o.parent.name if o.parent else None})
        return meta

    # Use a SINGLE shared namespace as both globals and locals so comprehensions
    # and multi-line code can reference names defined earlier in the snippet
    # (exec(code, g, {}) breaks that; exec can't see names in an empty locals
    # from within a comprehension's nested scope).
    ns = {"bpy": bpy, "__builtins__": __builtins__}
    # Redirect print() to the captured buffer.
    try:
        compile(code, "<live-bpy>", "exec")
    except SyntaxError as e:
        return {"ok": False, "error": f"SyntaxError: {e}", "stdout": "", "added_objects": [], "objects": _obj_meta()}
    # Temporarily swap stdout so `print` inside the snippet is captured.
    import sys as _sys
    _real = _sys.stdout
    try:
        _sys.stdout = out
        exec(compile(code, "<live-bpy>", "exec"), ns, ns)
        ok, err = True, None
    except Exception:  # noqa: BLE001
        ok, err = False, traceback.format_exc()
    finally:
        _sys.stdout = _real
    # AUTO-SHADE safety net (deterministic, so a build is never left flat-gray):
    # after any successful edit, give every MESH with ZERO materials a neutral
    # visible material and ensure a light exists. Safe: objects already shaded by
    # the model's FINALIZE are untouched (they HAVE a material), so nothing is
    # overridden — color is guaranteed even if the model skips the FINALIZE pass.
    if ok:
        _ensure_shading()
    # Deterministic auto-detail: guaranteed bounded subsurf+bevel so a build is
    # never flat/blocky (lazy modifiers, RAM-safe). Plus an OPT-IN sculpt-texture
    # displacement when the user raised detail_depth in the add-on prefs.
    if ok:
        _ensure_detail()
        try:
            prefs = bpy.context.preferences.addons[ADDON_ID].preferences if ADDON_ID in bpy.context.preferences.addons else None
            _ensure_displacement(prefs.detail_depth if prefs else 0.0)
        except Exception:  # noqa: BLE001
            pass
    stdout = out.getvalue()
    added = [o.name for o in bpy.data.objects if o.name not in objects_before]
    scene_objs = _obj_meta()
    for area in bpy.context.screen.areas if bpy.context.screen else []:
        area.tag_redraw()
    return {
        "ok": ok,
        "error": err,
        "stdout": stdout,
        "added_objects": added,
        "objects": scene_objs,
    }


def _write_state(live, port=None):
    try:
        STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
        STATE_FILE.write_text(json.dumps({"live": live, "port": int(port) if port else None}))
    except Exception:  # noqa: BLE001
        pass


def start_bridge(port):
    global _bridge, _bridge_thread, _bridge_running, _bridge_timer
    if _bridge_running:
        return True
    try:
        _bridge = ThreadingHTTPServer(("127.0.0.1", int(port)), _BridgeHandler)
        _bridge_thread = threading.Thread(target=_bridge.serve_forever, daemon=True)
        _bridge_thread.start()
        # Register a main-thread timer to actually run queued bpy code.
        _bridge_timer = bpy.app.timers.register(_execute_on_main_thread)
        _bridge_running = True
        _write_state(True, port)
        return True
    except Exception:  # noqa: BLE001  (port busy or Blender disallows) -> not live
        _bridge_running = False
        try:
            if _bridge_timer is not None:
                bpy.app.timers.unregister(_execute_on_main_thread)
        except Exception:  # noqa: BLE001
            pass
        _bridge_timer = None
        _write_state(False)
        return False


def stop_bridge():
    global _bridge, _bridge_running, _bridge_timer
    if _bridge_timer is not None:
        try:
            bpy.app.timers.unregister(_execute_on_main_thread)
        except Exception:  # noqa: BLE001
            pass
    _bridge_timer = None
    if _bridge:
        try:
            _bridge.shutdown()
        except Exception:  # noqa: BLE001
            pass
    _bridge = None
    _bridge_running = False
    _write_state(False)


CLASSES = (JarvAddonPreferences, JARV_OT_ask, JARV_PT_panel)


def register():
    for cls in CLASSES:
        bpy.utils.register_class(cls)
    bpy.types.Scene.jarv_prompt = bpy.props.StringProperty(default="")
    bpy.types.Scene.jarv_reply = bpy.props.StringProperty(default="")
    bpy.types.Scene.jarv_status = bpy.props.StringProperty(default="")
    # Start the live bridge so the hub can drive THIS Blender's open scene.
    prefs = bpy.context.preferences.addons[ADDON_ID].preferences if ADDON_ID in bpy.context.preferences.addons else None
    port = prefs.bridge_port if prefs else DEFAULT_BRIDGE_PORT
    start_bridge(port)


def unregister():
    stop_bridge()
    for cls in reversed(CLASSES):
        bpy.utils.unregister_class(cls)
    del bpy.types.Scene.jarv_prompt
    del bpy.types.Scene.jarv_reply
    del bpy.types.Scene.jarv_status


if __name__ == "__main__":
    register()
