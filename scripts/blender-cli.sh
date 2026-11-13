#!/bin/bash
# blender-cli — natural language -> local Qwen (Ollama) -> bpy -> headless Blender.
#
#   blender-cli.sh [--model qwen3.5:4b|qwen3.5:2b] [--name NAME] "prompt..."
#
# Models (LOCAL ONLY, per Matthew's policy — no cloud, no DeepSeek):
#   primary  qwen3.5:4b  (default)   fallback qwen3.5:2b (auto on failure)
# Blender: /Applications/Blender.app (5.1.1) headless --background --python.
# Skills wired in: ~/.jarv-genie/skills/bpy-cheatsheet (verified snippets are
# embedded in the system prompt) and bpy-verify (object count/AABB/render check).
# Defences: sanitize_code() fixes the small models' most common bpy mistakes
# (operator return values, stray saves, bad world/light lines) before Blender
# ever sees the script; on a Blender failure the model gets ONE repair pass
# with the error text. Outputs: ~/.jarv-genie/blender/cli/<name>-<timestamp>/
set -u
OLLAMA="${OLLAMA_URL:-http://127.0.0.1:11434}"
PRIMARY="${JARV_MODEL:-qwen3.5:4b}"
FALLBACK="${JARV_MODEL_FALLBACK:-qwen3.5:2b}"
MODEL="$PRIMARY"
NAME="build"
BLENDER_BIN=""
if command -v blender >/dev/null 2>&1; then BLENDER_BIN="$(command -v blender)"
elif [ -x /Applications/Blender.app/Contents/MacOS/Blender ]; then BLENDER_BIN="/Applications/Blender.app/Contents/MacOS/Blender"; fi

usage() { echo "Usage: blender-cli.sh [--model MODEL] [--name NAME] \"prompt...\"" >&2; exit 2; }
while [ $# -gt 0 ]; do
  case "$1" in
    --model) MODEL="$2"; shift 2;;
    --name) NAME="$(echo "$2" | sed 's/[^A-Za-z0-9_-]/_/g')"; shift 2;;
    --help|-h) usage;;
    --) shift; break;;
    -*) echo "unknown option: $1" >&2; usage;;
    *) break;;
  esac
done
PROMPT="$*"
[ -n "$PROMPT" ] || usage
[ -n "$BLENDER_BIN" ] || { echo "ERROR: no Blender binary found" >&2; exit 1; }
command -v curl >/dev/null || { echo "ERROR: curl not found" >&2; exit 1; }
command -v python3 >/dev/null || { echo "ERROR: python3 not found" >&2; exit 1; }

TS="$(date +%Y%m%d-%H%M%S)"
OUTDIR="$HOME/.jarv-genie/blender/cli/${NAME}-${TS}"
mkdir -p "$OUTDIR"
BLEND="$OUTDIR/$NAME.blend"
echo "[blender-cli] prompt : $PROMPT"
echo "[blender-cli] outdir : $OUTDIR"

# --- system prompt: verified bpy-cheatsheet snippets, headless-safe -----------
read -r -d '' SYSTEM <<'SYS_EOF'
You are a Blender Python (bpy) code generator. Output ONLY one ```python code block, nothing else.
Rules (verified against Blender 5.x headless --background):
- Always `import bpy` first.
- Clean the scene with EXACTLY this one line (never hand-roll bpy.data.*.remove loops):
  bpy.ops.wm.read_factory_settings(use_empty=True)
- NEVER assign the result of a bpy.ops call to a variable. Operators return a
  status set like {'FINISHED'}, NOT an object — `cube = bpy.ops.mesh...` then
  `cube.name = ...` CRASHES. The ONLY correct pattern is two lines:
  bpy.ops.mesh.primitive_cube_add(size=2, location=(0,0,1))
  cube = bpy.context.active_object
  cube.name = "Cube"
- Add meshes with bpy.ops.mesh.primitive_*_add(size=..., location=(x,y,z)).
  Examples: bpy.ops.mesh.primitive_cube_add(size=2, location=(0,0,1))
            bpy.ops.mesh.primitive_uv_sphere_add(radius=1, location=(2,0,1))
            bpy.ops.mesh.primitive_cylinder_add(radius=0.5, depth=2, location=(-2,0,1))
- Materials: a new material ALREADY contains a Principled BSDF node. NEVER call
  nodes.new() or links.new() and NEVER write .nodes[ — only change the existing
  node's inputs. This is the ONLY allowed material pattern, copy it exactly:
  mat = bpy.data.materials.new(name="Mat"); mat.use_nodes = True
  bsdf = mat.node_tree.nodes["Principled BSDF"]; bsdf.inputs["Base Color"].default_value = (1,0,0,1)
  obj.data.materials.append(mat)
- Camera (optional but good): create bpy.data.cameras.new + object, link to scene collection,
  set bpy.context.scene.camera, aim -Z at target with to_track_quat("-Z","Y").
- Light: bpy.data.lights.new(name="Sun", type='SUN'); link as object; set energy.
  Valid light types are only POINT, SUN, SPOT, AREA. There is no LIGHT_POWER type.
- NEVER assign anything to bpy.context.scene.world except a World datablock
  (no `scene.world = light_data`, no `scene.world.data = ...`). Skip the world if unsure.
- The runner injects the line BLEND_PATH = "<path>" BEFORE your code and appends the save
  block AFTER it — do NOT save the file yourself and do NOT call sys.exit.
- Keep it simple and deterministic: no randomness, no external files, no network.
SYS_EOF

# --- ask Ollama for bpy code (model, raw-json path, prompt text) ---------------
gen_code() {
  local model="$1" raw="$2" prompt_text="$3"
  python3 - "$OLLAMA" "$model" "$prompt_text" "$SYSTEM" "$raw" <<'PYEOF'
import json, sys, time, urllib.request, urllib.error
ollama, model, prompt, system, raw_path = sys.argv[1:6]
body = json.dumps({
  "model": model, "stream": False, "think": False,
  "messages": [
    {"role": "system", "content": system},
    {"role": "user", "content": prompt},
  ],
  "options": {"temperature": 0.1, "num_predict": 4096},
}).encode()
req = urllib.request.Request(ollama + "/api/chat", data=body,
                             headers={"Content-Type": "application/json"})
last = None
for attempt in (1, 2):
    try:
        with urllib.request.urlopen(req, timeout=300) as r:
            data = json.load(r)
        break
    except Exception as e:
        last = e
        print(f"OLLAMA_ERROR attempt {attempt}: {e}", file=sys.stderr)
        if attempt == 1:
            time.sleep(15)
else:
    print(f"OLLAMA_ERROR {last}", file=sys.stderr); sys.exit(10)
open(raw_path, "w").write(json.dumps(data))
content = (data.get("message") or {}).get("content", "")
print(f"model={data.get('model')} done={data.get('done')} "
      f"prompt_tokens={(data.get('prompt_eval_count'))} "
      f"gen_tokens={(data.get('eval_count'))}", file=sys.stderr)
print(content)
PYEOF
}
extract_code() { # $1=raw reply text file, $2=dest .py ; exit 0 if bpy code found
  python3 - "$1" "$2" <<'PYEOF'
import re, sys
raw = open(sys.argv[1]).read()
dest = sys.argv[2]
m = re.search(r"```(?:python|py)?\s*\n(.*?)```", raw, re.S)
code = m.group(1) if m else (raw if "import bpy" in raw else "")
if "import bpy" not in code:
    sys.exit(1)
open(dest, "w").write(code)
PYEOF
}
sanitize_code() { # $1=.py in place: fix the small models' repeatable bpy mistakes
  python3 - "$1" <<'PYEOF'
import re, sys
path = sys.argv[1]
lines = open(path).read().splitlines()
out, dropped = [], []
data_vars = set()  # vars holding datablocks (camera/light/world data), not objects
add_vars = set()   # vars holding objects fresh from an _add() call (already linked)
nonmesh_vars = set()  # add-created vars that are NOT meshes (camera/light objects)
light_vars = set()  # add-created vars that are LIGHT objects (only they take .energy)
poisoned = set()   # vars defined by a dropped line: later uses are dropped too
# `x = bpy.context.active_object` is only wrong when it comes BEFORE the add
# call that creates the object (x is None there). Track the most recent add:
# an assignment right after an uncaptured add is correct and stays in place;
# one with no add behind it waits for the next _add() call instead.
pending_assign, pending_uses = {}, []
last_add_kind, add_uncaptured = None, False
def poison(line):
    m = re.match(r"\s*(\w+)\s*=", line)
    if m:
        poisoned.add(m.group(1))
def add_kind(call):
    if "camera_add" in call:
        return "camera"
    if "light_add" in call:
        return "light"
    return "mesh"
def flush_pending(call=""):
    global add_uncaptured, last_add_kind
    kind = add_kind(call) if call else None
    for var, ln in pending_assign.items():
        out.append(ln)
        add_vars.add(var)
        if kind in ("camera", "light"):
            nonmesh_vars.add(var)
        if kind == "light":
            light_vars.add(var)
    pending_assign.clear()
    out.extend(pending_uses)
    pending_uses.clear()
def bad_obj_attr(s):
    """Object-level attribute that does not exist on add-created objects."""
    m = re.match(r"(\w+)\.(target)\s*=", s)
    if m and m.group(1) in add_vars:
        return True
    m = re.search(r"\b(\w+)\.to_track_quat\(", s)
    if m and m.group(1) in add_vars:
        return True
    m = re.search(r"\b(\w+)\.data\.materials\b", s)
    if m and m.group(1) in nonmesh_vars:
        return True
    return False
for ln in lines:
    s = ln.strip()
    m = re.match(r"(\w+)\s*=\s*bpy\.data\.(?:cameras|lights|worlds)\.new\(", s)
    if m:
        data_vars.add(m.group(1))
    # A use of a poisoned var is dead code — drop it (and poison what it defines).
    if poisoned and re.search(r"\b(" + "|".join(sorted(poisoned)) + r")\b", s):
        dropped.append(("poisoned-use", ln)); poison(ln); continue
    # Runner does the save — any model save line writes a stray file elsewhere.
    if "save_as" in s:
        dropped.append(("stray-save", ln)); poison(ln); continue
    # scene.world must be a World datablock, never a light or anything else.
    if re.match(r"bpy\.context\.scene\.world\s*=", s) and "bpy.data.worlds.new" not in s:
        dropped.append(("bad-world", ln)); poison(ln); continue
    # Invented APIs: no .link(data=...), no scene.add_light()/scene.lighting/
    # scene.add_object(), no bpy.ops.*.new() operator, no
    # .aim()/.orient_to_light()/.link_to_collection() methods.
    if (re.search(r"\.link\(data=", s) or "scene.add_light(" in s or "scene.lighting" in s
            or "scene.add_object(" in s
            or re.search(r"bpy\.ops\.\w+\.new\(", s) or ".aim(" in s or ".orient_to_light(" in s
            or ".link_to_collection(" in s):
        dropped.append(("bad-api", ln)); poison(ln); continue
    # Only OBJECTS go in collections — never raw camera/light/world data.
    mL = re.search(r"objects\.link\(\s*(\w+)\s*\)", s)
    if mL and mL.group(1) in data_vars:
        dropped.append(("link-data", ln)); poison(ln); continue
    # An object fresh from _add() is already linked — linking again crashes.
    if mL and mL.group(1) in add_vars:
        dropped.append(("already-linked", ln)); poison(ln); continue
    # Datablocks have no transform, no node_tree: those live on objects/materials.
    # (search, not match: the bad access can sit on the right of an assignment.)
    if data_vars and re.search(r"\b(" + "|".join(sorted(data_vars)) + r")\.(location|rotation_euler|rotation_quaternion|scale|node_tree)\b", s):
        dropped.append(("data-attr", ln)); poison(ln); continue
    # scene.camera needs an OBJECT, not camera data.
    m3 = re.match(r"bpy\.context\.scene\.camera\s*=\s*(\w+)", s)
    if m3 and m3.group(1) in data_vars:
        dropped.append(("camera-data", ln)); poison(ln); continue
    # Object attributes that do not exist on add-created objects.
    if bad_obj_attr(s):
        dropped.append(("bad-obj-attr", ln)); poison(ln); continue
    # `x = active_object` (or `x = scene.camera`, same intent — scene.camera is
    # NOT set by camera_add, so rewrite it to active_object): if it follows an
    # uncaptured _add(), it is correct — emit in place. Otherwise it is early
    # and waits for the next _add().
    mA = re.match(r"(\s*)(\w+)\s*=\s*bpy\.context\.(active_object|scene\.camera)\s*$", ln)
    if mA:
        indent, var = mA.group(1), mA.group(2)
        if add_uncaptured:
            out.append(f"{indent}{var} = bpy.context.active_object")
            add_vars.add(var)
            if last_add_kind in ("camera", "light"):
                nonmesh_vars.add(var)
            if last_add_kind == "light":
                light_vars.add(var)
            add_uncaptured = False
        else:
            pending_assign[var] = f"{indent}{var} = bpy.context.active_object"
            dropped.append(("deferred-assign", ln))
        continue
    # A line using a pending var waits for the add too (it belongs after it).
    if pending_assign and re.search(r"\b(" + "|".join(sorted(pending_assign)) + r")\b", s):
        pending_uses.append(ln)
        dropped.append(("deferred-use", ln)); continue
    # var = bpy.ops....(...) -> the call, then var = bpy.context.active_object
    m4 = re.match(r"(\s*)(\w+)\s*=\s*(bpy\.ops\..*)$", ln)
    if m4:
        indent, var, call = m4.groups()
        out.append(f"{indent}{call}")
        out.append(f"{indent}{var} = bpy.context.active_object")
        add_vars.add(var)
        if add_kind(call) in ("camera", "light"):
            nonmesh_vars.add(var)
        if add_kind(call) == "light":
            light_vars.add(var)
        dropped.append(("ops-assign-fixed", ln))
        if "_add(" in call:
            flush_pending(call)
            add_uncaptured = False
            last_add_kind = add_kind(call)
        continue
    # .energy lives on light DATA: light.energy -> light.data.energy. On any
    # other object it does not exist at all — drop the line.
    mEn = re.match(r"(\s*)(\w+)\.energy(\s*=.*)$", ln)
    if mEn and mEn.group(2) in add_vars:
        if mEn.group(2) in light_vars:
            ln = f"{mEn.group(1)}{mEn.group(2)}.data.energy{mEn.group(3)}"
            dropped.append(("energy-to-data", ln))
        else:
            dropped.append(("energy-nonlight", ln)); poison(ln); continue
    out.append(ln)
    if re.search(r"bpy\.ops\..*_add\(", s):
        flush_pending(s)
        add_uncaptured = True
        last_add_kind = add_kind(s)
# Leftover pending assigns (no _add() ever followed): register them as
# add-created objects so the post-pass rules below can see them.
for _var in pending_assign:
    add_vars.add(_var)
out.extend(pending_assign.values())
out.extend(pending_uses)
# Post-pass: lines buffered as deferred uses skipped the rules above.
final = []
for ln in out:
    st = ln.strip()
    if ".link_to_collection(" in st or ".aim(" in st or ".orient_to_light(" in st \
            or "scene.add_light(" in st or "scene.lighting" in st or "scene.add_object(" in st \
            or re.search(r"bpy\.ops\.\w+\.new\(", st):
        dropped.append(("postpass-bad-api", ln)); poison(ln); continue
    if poisoned and re.search(r"\b(" + "|".join(sorted(poisoned)) + r")\b", st):
        dropped.append(("postpass-poisoned", ln)); poison(ln); continue
    if bad_obj_attr(st):
        dropped.append(("postpass-bad-obj-attr", ln)); poison(ln); continue
    # Link checks (deferred uses skipped the main-loop versions): never link
    # raw data, and never re-link an object fresh from _add().
    mLP = re.search(r"objects\.link\(\s*(\w+)\s*\)", st)
    if mLP and (mLP.group(1) in add_vars or mLP.group(1) in data_vars):
        dropped.append(("postpass-link", ln)); poison(ln); continue
    # .energy lives on light DATA: light.energy -> light.data.energy. On a
    # camera or other object it does not exist — drop the line.
    mE = re.match(r"(\s*)(\w+)\.energy(\s*=.*)$", ln)
    if mE and mE.group(2) in add_vars:
        if mE.group(2) in light_vars:
            ln = f"{mE.group(1)}{mE.group(2)}.data.energy{mE.group(3)}"
            dropped.append(("energy-to-data", ln))
        else:
            dropped.append(("postpass-energy-nonlight", ln)); poison(ln); continue
    final.append(ln)
out = final
open(path, "w").write("\n".join(out) + "\n")
for why, ln in dropped:
    print(f"[sanitize] {why}: {ln.strip()[:100]}", file=sys.stderr)
PYEOF
}
wrap_script() { # builds $WRAPPED from $OUTDIR/$NAME.py
  WRAPPED="$OUTDIR/$NAME.run.py"
  {
    printf 'BLEND_PATH = "%s"\n' "$BLEND"
    cat "$OUTDIR/$NAME.py"
    cat <<'SAVE_EOF'

# --- injected save + report (blender-cli) ---
import json as _json
bpy.ops.wm.save_as_mainfile(filepath=BLEND_PATH)
_info = [{"name": o.name, "type": o.type} for o in bpy.data.objects]
print("BLENDER_CLI_RESULT " + _json.dumps({"blend": BLEND_PATH, "objects": _info, "count": len(_info)}))
SAVE_EOF
  } > "$WRAPPED"
}
run_blender_once() { # $1=logfile ; exit 0 iff .blend exists afterwards
  "$BLENDER_BIN" --background --python "$WRAPPED" > "$1" 2>&1
  grep -E "BLENDER_CLI_RESULT|Error|Traceback" "$1" | head -20
  [ -f "$BLEND" ]
}

MODEL_USED=""
FIRST_TRY=1
for TRY_MODEL in "$MODEL" "$FALLBACK"; do
  # Skip the fallback pass when it is the same model already tried.
  if [ "$FIRST_TRY" = 0 ] && [ "$TRY_MODEL" = "$MODEL" ]; then break; fi
  FIRST_TRY=0
  echo "[blender-cli] generating bpy with $TRY_MODEL ..."
  if ! gen_code "$TRY_MODEL" "$OUTDIR/ollama-$TRY_MODEL.json" "$PROMPT" > "$OUTDIR/reply-$TRY_MODEL.txt" 2>"$OUTDIR/ollama-$TRY_MODEL.err"; then
    echo "[blender-cli] $TRY_MODEL request failed:"; cat "$OUTDIR/ollama-$TRY_MODEL.err" >&2
    continue
  fi
  cat "$OUTDIR/ollama-$TRY_MODEL.err" >&2
  if extract_code "$OUTDIR/reply-$TRY_MODEL.txt" "$OUTDIR/$NAME.py"; then MODEL_USED="$TRY_MODEL"; break; fi
  echo "[blender-cli] $TRY_MODEL reply had no usable bpy code, trying fallback..." >&2
done
[ -n "$MODEL_USED" ] || { echo "ERROR: no model produced usable bpy code" >&2; exit 1; }
echo "[blender-cli] model used: $MODEL_USED"
echo "[blender-cli] script: $OUTDIR/$NAME.py"
sanitize_code "$OUTDIR/$NAME.py"
wrap_script

echo "[blender-cli] running Blender headless ($BLENDER_BIN) ..."
if ! run_blender_once "$OUTDIR/blender.log"; then
  echo "[blender-cli] first run failed — asking $MODEL_USED to fix its script..."
  ERR_TXT="$(grep -A4 -E 'Traceback|Error:' "$OUTDIR/blender.log" | head -12)"
  REPAIR_PROMPT="$PROMPT

Your previous script failed in Blender with this error:
$ERR_TXT
Fix the script and output ONLY the corrected python code block."
  if gen_code "$MODEL_USED" "$OUTDIR/ollama-repair.json" "$REPAIR_PROMPT" > "$OUTDIR/reply-repair.txt" 2>"$OUTDIR/ollama-repair.err" \
     && extract_code "$OUTDIR/reply-repair.txt" "$OUTDIR/$NAME.py"; then
    sanitize_code "$OUTDIR/$NAME.py"
    wrap_script
    echo "[blender-cli] retrying Blender with repaired script..."
    run_blender_once "$OUTDIR/blender-retry.log" || { echo "ERROR: Blender run failed after repair, see $OUTDIR/blender.log and $OUTDIR/blender-retry.log" >&2; exit 1; }
  else
    echo "ERROR: repair produced no usable bpy code; see $OUTDIR/blender.log" >&2; exit 1
  fi
fi

# --- verify (bpy-verify skill): object count + PNG still -----------------------
cat > "$OUTDIR/verify.py" <<VERIFY_EOF
import bpy, json, os
bpy.ops.wm.open_mainfile(filepath="$BLEND")
objs = [{"name": o.name, "type": o.type} for o in bpy.data.objects]
print("VERIFY objects:", json.dumps(objs))
scene = bpy.context.scene
scene.render.engine = 'BLENDER_WORKBENCH'
scene.render.resolution_x = 640; scene.render.resolution_y = 480
scene.render.filepath = "$OUTDIR/$NAME.png"
scene.render.image_settings.file_format = 'PNG'
try:
    bpy.ops.render.render(write_still=True)
    print("VERIFY render:", "$OUTDIR/$NAME.png", os.path.getsize("$OUTDIR/$NAME.png"), "bytes")
except Exception as e:
    print("VERIFY render failed (non-fatal):", e)
VERIFY_EOF
"$BLENDER_BIN" --background --python "$OUTDIR/verify.py" > "$OUTDIR/verify.log" 2>&1
grep -E "VERIFY|Error|Traceback" "$OUTDIR/verify.log" | head -10

echo "[blender-cli] DONE model=$MODEL_USED blend=$BLEND"
ls -la "$OUTDIR"
