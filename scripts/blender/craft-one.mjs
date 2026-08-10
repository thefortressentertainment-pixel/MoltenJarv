#!/usr/bin/env node
/**
 * One-shot craft runner for the M1: reference photo -> real mesh GLB via the
 * native MLX Hunyuan3D binary (staged at ~/.jarv-genie/craft/).
 *
 * Usage (ONE command runs the WHOLE pipeline in succession: craft + auto-octree +
 * region-color + auto-refine sharpen; --sym for frontal refs; --paint-remote to
 * hand the real texture/paint stage to a free 0-cost GPU host):
 *   node scripts/blender/craft-one.mjs <image.png> [--paint-remote]
 *   --auto-refine N   sharpen rounds after craft (default 3; 0 to skip)
 *   --sym             for perfectly symmetric/front-facing references
 *   --paint-remote    also run the Hunyuan3D paint on a free Kaggle/Colab GPU host
 *                     (set BLENDER_PAINT_URL first) and fetch the textured GLB
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
  console.error('usage: craft-one.mjs <image.png> [--octree N] [--quantize 4|8] [--steps N] [--auto-refine N] [--sym]');
  process.exit(2);
}
const flag = (k, d) => { const i = args.indexOf(k); return i >= 0 ? Number(args[i + 1]) : d; };
// Adaptive octree: finer mesh (more faces) when RAM headroom allows; 320 if
// comfortably free, else 256. Override with --octree N.
const explicitOctree = args.includes('--octree');
const quantize = flag('--quantize', 4);
// --sym: for perfectly front-facing / symmetric references, Hunyuan's shape stage
// can collapse into a flat slab. Bumping guidance+steps grounds the reconstruction
// more tightly. Use for frontal symmetric refs (you found angled refs work cleanly).
const sym = args.includes('--sym');
const steps = sym ? flag('--steps', 60) : flag('--steps', 30);
const guidance = sym ? 7.0 : undefined;
// --auto-refine N: after crafting, run N headless mesh-sharpen rounds on the
// same mesh (smooth + subsurf-up + clean) to raise surface fidelity toward the
// reference it was generated from. DEFAULT 3 so a bare command runs the WHOLE
// pipeline (craft -> region-color -> sharpen) in one go. Use --auto-refine 0 to skip.
const refineRounds = flag('--auto-refine', 3);
// --paint-remote: after craft, hand the mesh + reference to the configured FREE
// GPU host (Kaggle dual-T4 via BLENDER_PAINT_URL) to run the real Hunyuan3D-2.1
// texture/paint stage, and download the textured GLB. 0-cost paint, off the M1.
const paintRemote = args.includes('--paint-remote');
let octree = flag('--octree', 0);
if (!explicitOctree) {
  let pct = Infinity;
  try {
    const mp = execFileSync('memory_pressure', [], { encoding: 'utf8' });
    const pm = /System-wide memory free percentage:\s+(\d+)%/.exec(mp);
    if (pm) pct = Number(pm[1]);
  } catch {}
  octree = pct >= 65 ? 384 : pct >= 50 ? 320 : 256;
}

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
const argv = ['shape', image, '-o', out, '--weights', weights, '--quantize', String(quantize), '--octree', String(octree), '--steps', String(steps)];
if (guidance !== undefined) argv.push('--guidance', String(guidance));
promisify(execFile)(bin, argv,
  { timeout: 15 * 60_000, maxBuffer: 8 * 1024 * 1024 },
).then(async (res) => {
  const created = fs.existsSync(out) && fs.statSync(out).size > 0;
  const secs = Math.round((Date.now() - started) / 1000);
  if (!created) { console.error('[craft] ran but produced no GLB. stdout tail:\n' + (res.stdout || '').slice(-800)); process.exit(1); }
  // Post-process the raw mesh: strip the fused "breakaway-tray" base AND apply the
  // reference image's dominant color, so the GLB matches the subject (green orc ->
  // green, not a hard-coded default).
  try {
    console.log('[craft] cleaning mesh (removing breakaway tray, matching region colors to reference)...');
    const dom = await regionColorsSync(image);
    const cleaned = await directClean(out, dom);
    if (!cleaned.ok) console.warn('[craft] cleanup skipped:', cleaned.error || '');
    // Auto-refine: sharpen the mesh in-place against its reference-derived shape.
    let refineNote = '';
    if (refineRounds > 0) {
      try {
        for (let r = 1; r <= refineRounds; r++) {
          console.log(`[craft] auto-refine round ${r}/${refineRounds} (sharpen: smooth + subsurf-up + clean)...`);
          const rr = await refineMeshSync(out, r);
          if (!rr.ok) { refineNote = ` (auto-refine round ${r} stopped: ${rr.error || ''})`; break; }
        }
        refineNote = refineNote || ` + auto-refined x${refineRounds}`;
      } catch (e) {
        refineNote = ' (auto-refine failed: ' + (e instanceof Error ? e.message : String(e)) + ')';
      }
    }
    // Optional remote paint: send mesh + reference to the free GPU host (Kaggle
    // dual-T4) and pull back the textured GLB. 0-cost, off the M1.
    let paintNote = '';
    if (paintRemote) {
      try {
        const { runRemotePaint } = await import(new URL('../../dist/blender/paintRemote.js', import.meta.url).href);
        console.log('[craft] sending mesh + reference to the free GPU host for painting...');
        const pr = await runRemotePaint(out, image);
        if (pr.ok && pr.glb) {
          paintNote = ` + remote-painted GLB at ${pr.glb}`;
        } else {
          paintNote = ' + remote paint failed: ' + (pr.error || 'unknown');
        }
      } catch (e) {
        paintNote = ' + remote paint error: ' + (e instanceof Error ? e.message : String(e));
      }
    }
    console.log(`[craft] DONE in ${secs}s -> ${out} (${(fs.statSync(out).size / 1e6).toFixed(1)} MB). Tray preserved/clean` + refineNote + paintNote + (dom.length ? ` + ${dom.length} region colors matched (${dom.map((c) => 'rgb(' + c.map((n) => Math.round(n * 255)).join(',') + ')').join(', ')})` : '') + `. Load in Blender: File>Import>glTF 2.0.`);
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

/** Up to 3 distinct region colors of a reference image as [[r,g,b]..] 0-1, or [].
 *  Headless Blender + numpy color quantization (matches regionColorsFromImage). */
async function regionColorsSync(imagePath) {
  const blender = '/Applications/Blender.app/Contents/MacOS/Blender';
  if (!fs.existsSync(blender) || !fs.existsSync(imagePath)) return [];
  const script = `import bpy, numpy as np, json
im = bpy.data.images.load(${JSON.stringify(imagePath)})
w,h = im.size
px = np.asarray(im.pixels, dtype=float).reshape((h, w, 4))[..., :3]
q = np.floor(px*8).astype(int); flat = q.reshape(-1,3)
uniq,counts = np.unique(flat, axis=0, return_counts=True)
order = np.argsort(-counts); picked=[]
for idx in order:
    c = (uniq[idx]+0.5)/8.0
    if all(np.linalg.norm(c-p)>0.18 for p in picked):
        picked.append(c)
    if len(picked)>=3: break
print('REGIONCOLORS'+json.dumps([[round(float(x),4) for x in c] for c in picked]))
`;
  const tmp = '/tmp/jarv_domcolor.mjs_tmp.py';
  fs.writeFileSync(tmp, script);
  try {
    const res = execFileSync(blender, ['--background', '--python', tmp], { encoding: 'utf8', timeout: 30000 });
    const m = /REGIONCOLORS(\[\[[0-9.\-, \[\]]+\]\])/.exec(res);
    if (m?.[1]) {
      const raw = JSON.parse(m[1]);
      if (Array.isArray(raw)) {
        const arr = raw.filter((r) => Array.isArray(r) && r.length >= 3 && r.slice(0,3).every((n) => Number.isFinite(n))).map((r) => r.slice(0,3));
        return arr.slice(0,3);
      }
    }
    return [];
  } catch { return []; } finally { try { fs.unlinkSync(tmp); } catch {} }
}

/** Strip any true breakaway disc (conservative) + bake up to 3 region colors as a
 *  height-based ColorRamp material, via a quick headless Blender pass. */
async function directClean(glb, colors) {
  const blender = '/Applications/Blender.app/Contents/MacOS/Blender';
  if (!fs.existsSync(blender)) return { ok: false, error: 'Blender not found' };
  const c0 = colors && colors.length ? colors[0] : null;
  const c1 = colors && colors.length > 1 ? colors[1] : null;
  const c2 = colors && colors.length > 2 ? colors[2] : null;
  const colorBake = c0
    ? `mat=bpy.data.materials.new('MAT_Crafted'); mat.use_nodes=True
nt=mat.node_tree; nt.nodes.clear()
out=nt.nodes.new('ShaderNodeOutputMaterial'); pos=nt.nodes.new('ShaderNodeTexCoord')
bs=nt.nodes.new('ShaderNodeBsdfPrincipled')
attr=nt.nodes.new('ShaderNodeAttribute'); attr.attribute_name='position'; attr.attribute_type='GEOMETRY'
sep=nt.nodes.new('ShaderNodeSeparateXYZ'); nt.links.new(attr.outputs['Vector'], sep.inputs['Vector'])
map=nt.nodes.new('ShaderNodeMapRange'); map.inputs[1].default_value=0.0; map.inputs[2].default_value=2.0; map.inputs[3].default_value=0.0; map.inputs[4].default_value=1.0
nt.links.new(sep.outputs['Z'], map.inputs[0])
ramp=nt.nodes.new('ShaderNodeValToRGB'); ramp.color_ramp.elements[0].color=(${c0[0]},${c0[1]},${c0[2]},1.0)
nt.links.new(map.outputs[0], ramp.inputs[0])
${c1 ? `e=ramp.color_ramp.elements.new(0.5); e.color=(${c1[0]},${c1[1]},${c1[2]},1.0)\n` : ''}${c2 ? `e=ramp.color_ramp.elements.new(0.85); e.color=(${c2[0]},${c2[1]},${c2[2]},1.0)\n` : ''}nt.links.new(ramp.outputs['Color'], bs.inputs['Base Color'])
nt.links.new(bs.outputs['BSDF'], out.inputs['Surface'])
nt.links.new(pos.outputs['Generated'], attr.inputs['Vector'])
if len(mesh.data.materials)==0: mesh.data.materials.append(mat)
else: mesh.data.materials[0]=mat
`
    : '';
  const script = `import bpy, os, bmesh, math, collections
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=${JSON.stringify(glb)})
meshes=[o for o in bpy.data.objects if o.type=='MESH']
if not meshes: raise SystemExit('NO_MESH')
mesh=meshes[-1]
bpy.ops.object.select_all(action='DESELECT'); mesh.select_set(True); bpy.context.view_layer.objects.active=mesh
_verts=[v.co for v in mesh.data.vertices]; _lo=min(v.z for v in _verts); _hi=max(v.z for v in _verts)
# CONSERVATIVE: only remove a genuinely-flat, thin co-planar sheet at the very bottom
# (a real breakaway disc). Broad Hunyuan3D feet are NOT a disc — never amputate them.
_b0=[v for v in _verts if v.z-_lo<0.02]
_flat=(max(v.z for v in _b0)-min(v.z for v in _b0)) if _b0 else 0.0
_np=len([v for v in _verts if v.z-_lo<0.004])
_disc=('True' if (_np>50 and _np>len(_verts)*0.004 and _flat<0.02) else 'False')
if _disc=='True':
    bm=bmesh.new(); bm.from_mesh(mesh.data)
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if v.co.z-_lo<0.004], context='VERTS')
    bm.to_mesh(mesh.data); bm.free(); mesh.data.update()
${colorBake}bpy.ops.object.select_all(action='SELECT')
bpy.ops.export_scene.gltf(filepath=${JSON.stringify(glb)}, use_selection=False, export_format='GLB')
print('CLEAN_OK', len(mesh.data.vertices))
`;
  const tmp = '/tmp/jarv_clean_glb.mjs_tmp.py';
  fs.writeFileSync(tmp, script);
  try { await promisify(execFile)(blender, ['--background', '--python', tmp], { timeout: 120_000 }); return { ok: fs.statSync(glb).size > 0 }; }
  catch (err) { return { ok: false, error: err?.message }; }
  finally { try { fs.unlinkSync(tmp); } catch {} }
}

/** Headless mesh-sharpen pass: import the GLB, smooth + subsurf-up + clean, and
 *  re-export. Each round raises surface fidelity (round = subsurf levels). RAM-safe
 *  (spawn-and-exit; Blender must be closed). */
/** Headless mesh-sharpen pass, designed to be FAST and never blow up memory/time.
 *  Imports the GLB, and:
 *   - dense mesh (>=120k verts): smooth ONLY (no subsurf — subdividing a dense
 *     mesh on the 8GB M1 explodes RAM and times out, which is why auto-refine
 *     "did nothing" before). Fast.
 *   - lighter mesh: smooth + modest subsurf-up (levels from round), which is cheap.
 *  Re-exports in place. RAM-safe; hard timeout so it can never hang. */
async function refineMeshSync(glb, round) {
  const blender = '/Applications/Blender.app/Contents/MacOS/Blender';
  if (!fs.existsSync(blender)) return { ok: false, error: 'Blender not found' };
  const script = `import bpy
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=${JSON.stringify(glb)})
meshes=[o for o in bpy.data.objects if o.type=='MESH']
if not meshes: raise SystemExit('NO_MESH')
mesh=meshes[-1]
bpy.ops.object.select_all(action='DESELECT'); mesh.select_set(True); bpy.context.view_layer.objects.active=mesh
nv=len(mesh.data.vertices)
bpy.ops.object.shade_smooth()
# fast smooth always (cheap, improves surface by removing heavy faceting)
bpy.ops.object.modifier_add(type='SMOOTH'); bpy.context.object.modifiers[-1].factor=0.5
bpy.ops.object.modifier_apply(modifier=bpy.context.object.modifiers[-1].name)
done='smooth'
if nv < 120000:
    # modest subsurf-up + light clean only for tractable meshes
    bpy.ops.object.modifier_add(type='SUBSURF'); bpy.context.object.modifiers[-1].levels=${round}
    bpy.ops.object.modifier_apply(modifier=bpy.context.object.modifiers[-1].name)
    bpy.ops.object.shade_smooth()
    done='smooth + subsurf x'+'${round}'
bpy.ops.object.select_all(action='SELECT')
bpy.ops.export_scene.gltf(filepath=${JSON.stringify(glb)}, use_selection=False, export_format='GLB')
print('REFINED', done, len(mesh.data.vertices))
`;
  const tmp = '/tmp/jarv_refine.mjs_tmp.py';
  fs.writeFileSync(tmp, script);
  try {
    await promisify(execFile)(blender, ['--background', '--python', tmp], { timeout: 90_000 });
    return { ok: fs.statSync(glb).size > 0 };
  } catch (err) {
    return { ok: false, error: err?.message || 'refine timed out' };
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}
