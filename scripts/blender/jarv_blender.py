# Jarv Genie ⇄ Blender Bridge
#
# Prompt Jarv Genie directly from inside Blender — one node, no chain of daemons.
# This add-on POSTs a prompt to the running Jarv hub (`POST /api/blender`) and shows
# the reply in a panel. The hub is the single always-on Node process bound to
# http://127.0.0.1:3001 (optionally --host 0.0.0.0); this add-on talks to it the
# same way the web UI does.
#
# Install:  Blender > Edit > Preferences > Add-ons > Install…  select this file,
#           then enable "Development: Jarv Blender Bridge".
#           (Or drop it in <config>/scripts/addons/ and enable it.)
# Usage:    Sidebar (N) > "Jarv" tab > type a request > "Ask Jarv".
#
# Does NOT require Telegram/heartbeat daemons; the always-on hub alone is enough.

bl_info = {
    "name": "Jarv Blender Bridge",
    "author": "Jarv Genie",
    "version": (0, 1, 0),
    "blender": (3, 0, 0),
    "location": "Sidebar (N) > Jarv",
    "description": "Prompt the Jarv Genie AI assistant from inside Blender",
    "category": "Development",
}

import json
import os
import urllib.request
from pathlib import Path

import bpy

# Default hub URL. The hub is bound to 0.0.0.0:3001 in the launchd service, so
# 127.0.0.1 works locally; override in addon prefs if you run it elsewhere.
DEFAULT_HUB = "http://127.0.0.1:3001"
AUTH_FILE = Path.home() / ".jarv-genie" / "auth.json"


def _read_token():
    """Read the bearer token the hub generated (see ~/.jarv-genie/auth.json)."""
    try:
        data = json.loads(AUTH_FILE.read_text())
        tok = data.get("token")
        return tok if isinstance(tok, str) and tok else None
    except Exception:
        return None


def _ask_jarv(hub, token, message, timeout=180):
    """POST a prompt to the hub's /api/blender (non-stream) and return the reply text."""
    url = (hub or DEFAULT_HUB).rstrip("/") + "/api/blender"
    payload = json.dumps({"message": message}).encode("utf-8")
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = "Bearer " + token
    req = urllib.request.Request(url, data=payload, headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        body = json.loads(resp.read().decode("utf-8"))
    # /api/blender (non-stream) returns TaskResult: { text, steps, toolCalls, provider, model }
    text = body.get("text") or ""
    if isinstance(body.get("error"), str):
        return "[error] " + body["error"]
    return text


def _safe_repr(text):
    """Store the reply where the panel can render it without operators failing."""
    return (text or "").replace("\t", " " * 4)


class JARV_OT_ask(bpy.types.Operator):
    bl_idname = "jarv.ask"
    bl_label = "Ask Jarv"
    bl_description = "Send the prompt in the Jarv panel to the Jarv Genie hub"

    def execute(self, context):
        scn = context.scene
        message = scn.jarv_prompt.strip()
        if not message:
            self.report({"WARNING"}, "Type a prompt first")
            return {"CANCELLED"}

        prefs = context.preferences.addons[__name__].preferences
        hub = prefs.hub_url.strip() or DEFAULT_HUB
        token = prefs.token.strip() or _read_token()

        scn.jarv_reply = "..."
        scn.jarv_status = f"asking {hub}…"
        try:
            reply = _ask_jarv(hub, token, message)
        except Exception as exc:  # the hub is down or unreachable
            reply = f"[could not reach Jarv hub at {hub}] {exc}"
            scn.jarv_status = "connection failed"
            self.report({"ERROR"}, "Jarv hub unreachable — is `jarv-genie hub` running?")
        scn.jarv_reply = _safe_repr(reply or "(no reply)")
        scn.jarv_status = "done"
        return {"FINISHED"}


class JARV_PT_panel(bpy.types.Panel):
    bl_label = "Jarv"
    bl_idname = "JARV_PT_panel"
    bl_space_type = "VIEW_3D"
    bl_region_type = "UI"
    bl_category = "Jarv"

    def draw(self, context):
        layout = self.layout
        scn = context.scene

        row = layout.row(align=True)
        row.prop(scn, "jarv_prompt", text="")
        row.operator("jarv.ask", text="Ask Jarv", icon="GHOST_ENABLED")

        if scn.jarv_status:
            layout.label(text=scn.jarv_status)
        if scn.jarv_reply:
            box = layout.box()
            col = box.column()
            col.scale_y = 0.9
            for line in scn.jarv_reply.splitlines():
                col.label(text=line)


class JarvAddonPreferences(bpy.types.AddonPreferences):
    bl_idname = __name__

    hub_url: bpy.props.StringProperty(
        name="Hub URL",
        description="Base URL of the Jarv hub (/api/blender is appended)",
        default=DEFAULT_HUB,
    )
    token: bpy.props.StringProperty(
        name="Auth Token (optional)",
        description="Leave blank to auto-read ~/.jarv-genie/auth.json. Needed when the hub is bound beyond loopback.",
        default="",
    )

    def draw(self, context):
        layout = self.layout
        layout.prop(self, "hub_url")
        layout.prop(self, "token")
        tok = self.token.strip() or _read_token()
        layout.label(text="token: " + ("<auto-detected>" if tok else "<none — hub must be loopback-only>"))


# ---------------------------------------------------------------------------
# Registration
# ---------------------------------------------------------------------------

CLASSES = (JarvAddonPreferences, JARV_OT_ask, JARV_PT_panel)


def register():
    for cls in CLASSES:
        bpy.utils.register_class(cls)
    bpy.types.Scene.jarv_prompt = bpy.props.StringProperty(
        name="Prompt",
        description="What do you want Jarv to do?",
        default="",
    )
    bpy.types.Scene.jarv_reply = bpy.props.StringProperty(
        name="Reply",
        default="",
    )
    bpy.types.Scene.jarv_status = bpy.props.StringProperty(
        name="Status",
        default="",
    )


def unregister():
    for cls in reversed(CLASSES):
        bpy.utils.unregister_class(cls)
    del bpy.types.Scene.jarv_prompt
    del bpy.types.Scene.jarv_reply
    del bpy.types.Scene.jarv_status


if __name__ == "__main__":
    register()
