/**
 * `bpy_craft` — true image-to-3D mesh craft via Hunyuan3D-Swift (MLX, Apple M1).
 *
 * This wraps the native `hy3d` binary (ZimengXiong/Hunyuan3D-Swift, MIT) that runs
 * the Hunyuan3D-2 shape diffusion model on Apple Silicon Metal via MLX — the one
 * image->mesh path that runs on this M1. It produces a REAL mesh GLB from a
 * reference photo (not primitives), which Jarv then imports into Blender and
 * refines/textures.
 *
 * RAM CRITICAL CONSTRAINT: the shape craft peaks ~5.6GB (fp16) and a few GB at
 * Q4. That canNOT share an 8GB machine with Blender open — so `bpy_craft` refuses
 * to run while the live Blender bridge is up, and the caller must close Blender,
 * run the craft, then reopen Blender to load the crafted GLB.
 *
 * Setup (done once): build `hy3d` + download weights into ~/.jarv-genie/craft/.
 */

import path from 'node:path';

export interface CraftEnv {
  binary: string;
  shapeWeights: string;
}

/** Resolve the crafted asset root (isolated under ~/.jarv-genie/craft/). */
export function craftRoot(): string {
  return path.join(process.env.HOME ?? '/', '.jarv-genie', 'craft');
}
export function craftBinary(): string {
  return path.join(craftRoot(), 'hy3d');
}
export function craftShapeWeights(): string {
  return path.join(craftRoot(), 'weights', 'shape-small');
}
export function craftGlbPath(): string {
  return '/tmp/jarv_crafted.glb';
}

/** The colocated Metal kernel library MLX needs. Without it the craft fails with
 *  "Failed to load the default metallib". It lives next to the hy3d binary. */
export function craftMetallib(): string {
  return path.join(craftRoot(), 'mlx.metallib');
}

/** True when a real `hy3d` binary + colocated metallib + weights are ready. */
export async function craftReady(): Promise<boolean> {
  try {
    const fs = await import('node:fs');
    return (
      fs.existsSync(craftBinary()) &&
      fs.existsSync(craftMetallib()) &&
      fs.existsSync(path.join(craftShapeWeights(), 'model.fp16.safetensors'))
    );
  } catch {
    return false;
  }
}

/** Current system-wide memory pressure as a FREE PERCENTAGE (0-100), using macOS's
 *  authoritative `memory_pressure` tool — NOT `vm_stat`'s "Pages free", which reads
 *  a tiny cached-window number and badly undercounts RAM that macOS can reclaim.
 *  Returns null if it can't be read. Used to refuse a craft only when truly tight. */
export async function freeMemPct(): Promise<number | null> {
  try {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const out = await promisify(execFile)('memory_pressure', [], { timeout: 5000 });
    const m = /System-wide memory free percentage:\s+(\d+)%/.exec(out.stdout);
    if (!m) return null;
    const pct = Number(m[1]);
    return Number.isFinite(pct) ? Math.max(0, Math.min(100, pct)) : null;
  } catch {
    return null;
  }
}

export interface CraftResult {
  ok: boolean;
  glb?: string;
  error?: string;
  detail?: string;
  durationMs?: number;
  note?: string;
}

/**
 * Run `hy3d shape <image> -o <glb>` with bounded settings (Q4, smaller octree)
 * to keep the craft as RAM-light as possible. Spawns the native MLX binary. The
 * caller must ensure Blender is CLOSED and the machine is otherwise quiet (RAM).
 */
export async function runCraft(
  imagePath: string,
  opts: { quantize?: number; octree?: number; steps?: number; guidance?: number } = {},
): Promise<CraftResult> {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const fs = await import('node:fs');
  const bin = craftBinary();
  const weights = craftShapeWeights();
  const out = craftGlbPath();
  if (!fs.existsSync(bin)) return { ok: false, error: 'hy3d binary not installed — run the one-time craft setup' };
  if (!fs.existsSync(craftMetallib())) return { ok: false, error: 'mlx.metallib not colocated with the hy3d binary — the craft needs it beside the binary or MLX fails with "default metallib not found"' };
  if (!fs.existsSync(path.join(weights, 'model.fp16.safetensors'))) return { ok: false, error: 'hy3d shape weights missing' };

  // RAM guard: a Q4 shape craft needs a few GB of headroom. Refuse BEFORE spawning
  // RAM guard via macOS's authoritative memory_pressure free PERCENTAGE. Only
  // refuse when the machine is genuinely tight (< ~25% free => less than ~2GB
  // reclaimable on 8GB). The old vm_stat "Pages free" read near-zero even on an
  // otherwise-idle machine, wrongly blocking crafts that had plenty of headroom.
  const free = await freeMemPct();
  if (free !== null && free < 25) {
    return {
      ok: false,
      error: `RAM is tight (~${free}% memory free). Close memory-heavy apps (Docker Desktop, large VMs/editors) so this machine is quiet, then retry.`,
    };
  }

  const args = [
    'shape', imagePath, '-o', out,
    '--weights', weights,
    '--quantize', String(opts.quantize ?? 4),
    '--octree', String(opts.octree ?? 256),
    '--steps', String(opts.steps ?? 30),
  ];
  if (opts.guidance !== undefined) args.push('--guidance', String(opts.guidance));

  const start = Date.now();
  const execFileAsync = promisify(execFile);
  try {
    // VERY generous timeout; a shape craft on an M1 takes tens of seconds to a few
    // minutes. It is a single heavy computation (not a hang), so allow it to run.
    const res = await execFileAsync(bin, args, { timeout: 15 * 60_000, maxBuffer: 8 * 1024 * 1024 });
    const created = fs.existsSync(out) && fs.statSync(out).size > 0;
    if (!created) return { ok: false, error: 'craft ran but produced no GLB', detail: (res.stdout || '').slice(0, 800), durationMs: Date.now() - start };
    // Post-process the raw mesh: strip any true breakaway disc. NOTE: procedural
    // ColorRamp materials do NOT survive GLB export (GLTF drops them), so the GLB
    // stays a clean mesh; the reference-matched coloring is applied on LIVE import
    // (bpy_import_craft / the bot) where the material renders in EEVEE.
    const cleaned = await cleanCraftedGlb(out, []);
    if (!cleaned.ok) {
      // On cleanup failure, fall back to the raw mesh (don't silently drop the craft).
      return { ok: true, glb: out, note: 'craft done but cleanup skipped: ' + (cleaned.error ?? ''), durationMs: Date.now() - start };
    }
    return {
      ok: true,
      glb: out,
      note: 'craft done; clean mesh (breakaway handled). Color it on import so the reference-matched palette renders — open Blender, then use bpy_import_craft.',
      durationMs: Date.now() - start,
    };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; killed?: boolean };
    return {
      ok: false,
      error: e.killed ? 'craft timed out (15m) or was killed' : `craft failed: ${err instanceof Error ? err.message : String(err)}`,
      detail: ((e.stdout ?? '') + ' ' + (e.stderr ?? '')).slice(0, 800),
      durationMs: Date.now() - start,
    };
  }
}

/** Extract the dominant color of a reference image as [r,g,b] in 0-1 linear-ish
 *  space, using a short headless Blender pass (PIL is bundled with Blender).
 *  Returns null if it can't be determined. Used to color the crafted mesh so it
 *  matches the reference (a green orc -> green model, not a hard-coded default). */
/** Extract the dominant color of a reference image as [r,g,b] in 0-1 linear-ish
 *  space, using a short headless Blender pass (PIL is bundled with Blender).
 *  Returns null if it can't be determined. Used to color the crafted mesh so it
 *  matches the reference (a green orc -> green model, not a hard-coded default). */
export async function dominantColorFromImage(imagePath: string): Promise<[number, number, number] | null> {
  const colors = await regionColorsFromImage(imagePath);
  return colors && colors.length > 0 ? (colors[0] as [number, number, number]) : null;
}

/** Extract the top ~2-3 DISTINCT dominant colors of a reference image as [r,g,b]
 *  0-1, via coarse color-quantization in a headless Blender numpy pass. Returns an
 *  array (this lets the crafted mesh get skin/armor/trim regions colored to match
 *  the photo instead of one flat color). Empty if it can't be determined. */
export async function regionColorsFromImage(imagePath: string): Promise<Array<[number, number, number]>> {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const fs = await import('node:fs');
  const blender = '/Applications/Blender.app/Contents/MacOS/Blender';
  if (!fs.existsSync(blender)) return [];
  const script = `import bpy, numpy as np, json
img=${JSON.stringify(imagePath)}
im = bpy.data.images.load(img)
w,h = im.size
px = np.asarray(im.pixels, dtype=float).reshape((h, w, 4))[..., :3]
# quantize to 8 levels/channel, then count
q = np.floor(px*8).astype(int)
flat = q.reshape(-1,3)
uniq,counts = np.unique(flat, axis=0, return_counts=True)
order = np.argsort(-counts)
# merge near-duplicate bins into up to 3 distinct colors
picked=[]
for idx in order:
    c = (uniq[idx]+0.5)/8.0
    keep = all(np.linalg.norm(c-p)>0.18 for p in picked)
    if keep:
        picked.append(c)
    if len(picked)>=3: break
print('REGIONCOLORS'+json.dumps([[round(float(x),4) for x in c] for c in picked]))
`;
  const tmp = '/tmp/jarv_domcolor.py';
  await fs.promises.writeFile(tmp, script, 'utf8');
  try {
    const res = await promisify(execFile)(blender, ['--background', '--python', tmp], { timeout: 30_000 });
    await fs.promises.unlink(tmp).catch(() => {});
    const m = /REGIONCOLORS(\[\[[0-9.\-, \[\]]+\]\])/.exec(res.stdout);
    if (m?.[1]) {
      try {
        const raw = JSON.parse(m[1]) as unknown;
        if (Array.isArray(raw)) {
          const arr = raw
            .filter((row): row is unknown[] => Array.isArray(row) && row.length >= 3)
            .map((row) => row.slice(0, 3).map(Number))
            .filter((row) => row.every((n) => Number.isFinite(n)))
            .slice(0, 3);
          if (arr.length > 0) return arr as Array<[number, number, number]>;
        }
      } catch { /* fall through */ }
    }
    return [];
  } catch {
    await fs.promises.unlink(tmp).catch(() => {});
    return [];
  }
}

/** Clean the raw crafted mesh GLB in place: strip the fused flat "breakaway tray"
 *  base disc, via a short headless Blender pass. Optionally applies a base color
 *  ONLY if one is explicitly requested (default: no color baked in — the figure
 *  keeps its own appearance and is textured/colored per character later). RAM-light
 *  (spawn-and-exit; Blender must NOT be open). Returns ok + the GLB. */
export async function cleanCraftedGlb(
  glb: string = craftGlbPath(),
  colors: Array<[number, number, number]> = [],
): Promise<{ ok: boolean; error?: string }> {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const fs = await import('node:fs');
  let blenderBin = 'blender';
  if (!fs.existsSync('/Applications/Blender.app/Contents/MacOS/Blender')) {
    return { ok: false, error: 'Blender not found for GLB cleanup' };
  }
  blenderBin = '/Applications/Blender.app/Contents/MacOS/Blender';
  // Build a ColorRamp material from the region colors (up to 3), mapped by height
  // (bottom->top) so legs/torso/head get reference-matching colors.
  const c0 = colors[0], c1 = colors[1], c2 = colors[2];
  const colorBake = c0
    ? [
        `mat=bpy.data.materials.new('MAT_Crafted'); mat.use_nodes=True`,
        `nt=mat.node_tree; nt.nodes.clear()`,
        `out=nt.nodes.new('ShaderNodeOutputMaterial')`,
        `pos=nt.nodes.new('ShaderNodeTexCoord'); bs=nt.nodes.new('ShaderNodeBsdfPrincipled')`,
        `attr=nt.nodes.new('ShaderNodeAttribute'); attr.attribute_name='position'; attr.attribute_type='GEOMETRY'`,
        `sep=nt.nodes.new('ShaderNodeSeparateXYZ'); nt.links.new(attr.outputs['Vector'], sep.inputs['Vector'])`,
        `m=nt.nodes.new('ShaderNodeMapRange'); m.inputs[1].default_value=0.0; m.inputs[2].default_value=2.0; m.inputs[3].default_value=0.0; m.inputs[4].default_value=1.0`,
        `nt.links.new(sep.outputs['Z'], m.inputs[0]); ramp=nt.nodes.new('ShaderNodeValToRGB')`,
        `ramp.color_ramp.elements[0].color=(${c0[0]},${c0[1]},${c0[2]},1.0)`,
        `nt.links.new(m.outputs[0], ramp.inputs[0])`,
        c1 && `e=ramp.color_ramp.elements.new(0.5); e.color=(${c1[0]},${c1[1]},${c1[2]},1.0)`,
        c2 && `e=ramp.color_ramp.elements.new(0.85); e.color=(${c2[0]},${c2[1]},${c2[2]},1.0)`,
        `nt.links.new(ramp.outputs['Color'], bs.inputs['Base Color'])`,
        `nt.links.new(bs.outputs['BSDF'], out.inputs['Surface'])`,
        `nt.links.new(pos.outputs['Generated'], attr.inputs['Vector'])`,
        `if len(mesh.data.materials)==0: mesh.data.materials.append(mat)`,
        `else: mesh.data.materials[0]=mat`,
      ]
        .filter(Boolean)
        .join('\n')
    : '';
  const script = `import bpy, os, bmesh, math, collections
bpy.ops.wm.read_factory_settings(use_empty=True)
glb=${JSON.stringify(glb)}
bpy.ops.import_scene.gltf(filepath=glb)
meshes=[o for o in bpy.data.objects if o.type=='MESH']
if not meshes: raise SystemExit('NO_MESH')
mesh=meshes[-1]
bpy.ops.object.select_all(action='DESELECT'); mesh.select_set(True); bpy.context.view_layer.objects.active=mesh
_verts=[v.co for v in mesh.data.vertices]; _lo=min(v.z for v in _verts)
# CONSERVATIVE base cleanup: only remove a genuinely-flat, thin cap at the very
# bottom IF it is clearly separate from the figure (a real "breakaway disc").
# Hunyuan3D's broad feet are NOT a disc, so we must NOT slice into them.
zlo=_lo; zhi=max(v.z for v in _verts)
# 1) bottom band flatness (thin sheet at the very bottom?)
band0=[v for v in _verts if v.z-zlo<0.02]
flat0 = (max(v.z for v in band0)-min(v.z for v in band0)) if band0 else 0.0
# 2) a thin co-planar sheet => a real breakaway disc; broad feet are NOT one
nplane=len([v for v in _verts if v.z-zlo < 0.004])
disc = nplane>50 and nplane> len(_verts)*0.004 and flat0<0.02
if disc:
    bm=bmesh.new(); bm.from_mesh(mesh.data)
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if v.co.z-zlo<0.004], context='VERTS')
    bm.to_mesh(mesh.data); bm.free(); mesh.data.update()
${colorBake}bpy.ops.object.select_all(action='SELECT')
bpy.ops.export_scene.gltf(filepath=glb, use_selection=False, export_format='GLB')
print('CLEAN_OK', len(mesh.data.vertices), 'disc_removed', disc)
`;
  const tmpScript = '/tmp/jarv_clean_glb.py';
  await fs.promises.writeFile(tmpScript, script, 'utf8');
  try {
    await promisify(execFile)(blenderBin, ['--background', '--python', tmpScript], { timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
    await fs.promises.unlink(tmpScript).catch(() => {});
    return { ok: fs.existsSync(glb) && fs.statSync(glb).size > 0 };
  } catch (err) {
    await fs.promises.unlink(tmpScript).catch(() => {});
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Reset/cleanup helper for tests: remove a stale crafted GLB. */
export async function resetCraftGlb(): Promise<void> {
  try {
    const fs = await import('node:fs');
    fs.unlinkSync(craftGlbPath());
  } catch {
    /* ignore */
  }
}
