#!/usr/bin/env node
/**
 * One-shot craft runner for the M1: reference photo -> real mesh GLB via the
 * native MLX Hunyuan3D binary (staged at ~/.jarv-genie/craft/).
 *
 * Usage:
 *   node scripts/blender/craft-one.mjs <image.png> [--octree 192] [--quantize 4]
 *
 * RAM CRITICAL: the craft is a multi-GB Metal compute. It MUST run with Blender
 * (and any other memory hogs) closed. This script refuses if the Blender bridge
 * is live.
 */
import path from 'node:path';
import fs from 'node:fs';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(process.env.HOME, '.jarv-genie', 'craft');
const bin = path.join(root, 'hy3d');
const weights = path.join(root, 'weights', 'shape-small');

const args = process.argv.slice(2);
const image = args.find((a) => !a.startsWith('--'));
if (!image) {
  console.error('usage: craft-one.mjs <image.png> [--octree N] [--quantize 4|8] [--steps N]');
  process.exit(2);
}
const flag = (k, d) => { const i = args.indexOf(k); return i >= 0 ? Number(args[i + 1]) : d; };
const octree = flag('--octree', 192);
const quantize = flag('--quantize', 4);
const steps = flag('--steps', 30);

if (!fs.existsSync(bin)) { console.error('[craft] hy3d binary missing at', bin); process.exit(1); }
if (!fs.existsSync(path.join(weights, 'model.fp16.safetensors'))) { console.error('[craft] shape weights missing'); process.exit(1); }
if (!fs.existsSync(image)) { console.error('[craft] image not found:', image); process.exit(1); }

// Guard: Blender bridge live -> refuse.
const stateFile = path.join(process.env.HOME, '.jarv-genie', 'blender-state.json');
try {
  const s = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  if (s.live === true) {
    console.error('[craft] Blender bridge is LIVE. The craft needs several GB of RAM and cannot share the machine with Blender. Close Blender, then retry.');
    process.exit(3);
  }
} catch { /* no state file — proceed */ }

const out = '/tmp/jarv_crafted.glb';
try { fs.unlinkSync(out); } catch {}

// Free-RAM pre-flight via macOS's authoritative memory_pressure free percentage.
// (vm_stat "Pages free" undercounts — macOS keeps most RAM as reclaimable cache.)
let freePct = Infinity;
try {
  const mp = execFileSync('memory_pressure', [], { encoding: 'utf8' });
  const pm = /System-wide memory free percentage:\s+(\d+)%/.exec(mp);
  if (pm) freePct = Number(pm[1]);
} catch {}
if (freePct !== Infinity && freePct < 25) {
  console.error(`[craft] RAM is tight (~${freePct}% memory free). Close Docker Desktop / large VMs / editors and retry.`);
  process.exit(3);
}

console.log(`[craft] hy3d shape image=${image} quantize=${quantize} octree=${octree} steps=${steps} (memory free ≈${freePct === Infinity ? 'n/a' : freePct}%)`);
console.log('[craft] this is a multi-GB Metal compute — please be patient (30s-few min).');
const started = Date.now();
promisify(execFile)(bin, ['shape', image, '-o', out, '--weights', weights, '--quantize', String(quantize), '--octree', String(octree), '--steps', String(steps)],
  { timeout: 15 * 60_000, maxBuffer: 8 * 1024 * 1024 },
).then(async (res) => {
  const created = fs.existsSync(out) && fs.statSync(out).size > 0;
  const secs = Math.round((Date.now() - started) / 1000);
  if (!created) { console.error('[craft] ran but produced no GLB. stdout tail:\n' + (res.stdout || '').slice(-800)); process.exit(1); }
  // Post-process the raw mesh: strip the fused "breakaway-tray" base + apply a green
  // base color, so the GLB imports clean and colored no matter how it is opened.
  try {
    console.log('[craft] cleaning mesh (removing breakaway tray, applying green base)...');
    const cleaned = await directClean(out);
    if (!cleaned.ok) console.warn('[craft] cleanup skipped:', cleaned.error || '');
    console.log(`[craft] DONE in ${secs}s -> ${out} (${(fs.statSync(out).size / 1e6).toFixed(1)} MB). Tray removed + green base applied. Load in Blender: File>Import>glTF 2.0.`);
  } catch (err) {
    console.warn('[craft] cleanup failed (craft itself succeeded):', err instanceof Error ? err.message : String(err));
    console.log(`[craft] DONE in ${secs}s -> ${out} (${(fs.statSync(out).size / 1e6).toFixed(1)} MB). Load via bpy_import_craft to strip the tray + color.`);
  }
}).catch((err) => {
  const secs = Math.round((Date.now() - started) / 1000);
  console.error(`[craft] failed after ${secs}s:`, err.killed ? 'timed out (15m)' : err.message);
  console.error((err.stdout || '') + (err.stderr || ''));
  process.exit(1);
});

/** Strip the breakaway tray + apply green via a quick headless Blender pass. */
async function directClean(glb) {
  const blender = '/Applications/Blender.app/Contents/MacOS/Blender';
  if (!fs.existsSync(blender)) return { ok: false, error: 'Blender not found' };
  const script = `import bpy, os, bmesh, math, collections
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=${JSON.stringify(glb)})
meshes=[o for o in bpy.data.objects if o.type=='MESH']
if not meshes: raise SystemExit('NO_MESH')
mesh=meshes[-1]
bpy.ops.object.select_all(action='DESELECT'); mesh.select_set(True); bpy.context.view_layer.objects.active=mesh
_verts=[v.co for v in mesh.data.vertices]; _lo=min(v.z for v in _verts)
_hist=collections.Counter(round(v.z,2) for v in _verts)
def _wa(z):
    vs=[v for v in _verts if abs(v.z-z)<0.02]
    return max((math.hypot(v.x,v.y) for v in vs), default=0.0)
_tt=_lo
for z in sorted(_hist):
    if z-_lo>0.20: break
    if _wa(z)>0.5: _tt=z
_cut=_tt+0.04
bm=bmesh.new(); bm.from_mesh(mesh.data)
bmesh.ops.delete(bm, geom=[v for v in bm.verts if v.co.z<_cut], context='VERTS')
bm.to_mesh(mesh.data); bm.free(); mesh.data.update()
mat=bpy.data.materials.new('MAT_Crafted'); mat.use_nodes=True
b=mat.node_tree.nodes.get('Principled BSDF'); b.inputs['Base Color'].default_value=(0.12,0.45,0.18,1.0)
if len(mesh.data.materials)==0: mesh.data.materials.append(mat)
else: mesh.data.materials[0]=mat
bpy.ops.object.select_all(action='SELECT')
bpy.ops.export_scene.gltf(filepath=${JSON.stringify(glb)}, use_selection=False, export_format='GLB')
print('CLEAN_OK', len(mesh.data.vertices))
`;
  const tmp = '/tmp/jarv_clean_glb.mjs_tmp.py';
  fs.writeFileSync(tmp, script);
  try { await promisify(execFile)(blender, ['--background', '--python', tmp], { timeout: 120_000 }); return { ok: fs.statSync(glb).size > 0 }; }
  catch (err) { return { ok: false, error: err?.message }; }
  finally { try { fs.unlinkSync(tmp); } catch {} }
}
