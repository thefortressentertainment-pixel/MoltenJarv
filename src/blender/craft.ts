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
    '--octree', String(opts.octree ?? 192),
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
    // Post-process the raw mesh GLB: strip the fused breakaway-tray base and apply
    // a green base material, so the output is a clean, colored figure regardless of
    // how it is later imported (manual File>Import or bpy_import_craft).
    const cleaned = await cleanCraftedGlb(out);
    if (!cleaned.ok) {
      // On cleanup failure, fall back to the raw mesh (don't silently drop the craft).
      return { ok: true, glb: out, note: 'craft done but cleanup skipped: ' + (cleaned.error ?? ''), durationMs: Date.now() - start };
    }
    return { ok: true, glb: out, note: 'craft done; tray removed + green base color applied', durationMs: Date.now() - start };
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

/** Clean the raw crafted mesh GLB in place: strip the fused flat "breakaway tray"
 *  base disc and apply a green base material, via a short headless Blender pass.
 *  RAM-light (spawn-and-exit; Blender must NOT be open). Returns ok + the GLB. */
export async function cleanCraftedGlb(glb: string = craftGlbPath()): Promise<{ ok: boolean; error?: string }> {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const fs = await import('node:fs');
  let blenderBin = 'blender';
  if (!fs.existsSync('/Applications/Blender.app/Contents/MacOS/Blender')) {
    return { ok: false, error: 'Blender not found for GLB cleanup' };
  }
  blenderBin = '/Applications/Blender.app/Contents/MacOS/Blender';
  const script = `import bpy, os, bmesh, math, collections
bpy.ops.wm.read_factory_settings(use_empty=True)
glb=${JSON.stringify(glb)}
bpy.ops.import_scene.gltf(filepath=glb)
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
bpy.ops.export_scene.gltf(filepath=glb, use_selection=False, export_format='GLB')
print('CLEAN_OK', len(mesh.data.vertices))
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
