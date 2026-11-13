import type { ToolDefinition, ToolCall, ChatMessage } from '../agent/types.js';
import type { ModelRouter } from '../providers/index.js';
import { ToolRegistry } from '../tools/registry.js';
import { systemTools } from '../tools/system.js';
import { fileTools } from '../tools/filesystem.js';
import { webTools } from '../tools/web.js';
import { extractTextToolCalls } from '../agent/agent.js';
import type { JarvGenieConfig } from '../config/index.js';
import { describeToSpec, extractAbsoluteImagePath } from './reference.js';
import { BASE_HUMANOID_SNIPPET } from './basemesh.js';
import { searchPolyHavenAssets, resolvePolyHavenFile, downloadPolyHavenFile } from './polyhaven.js';
import { craftReady, runCraft, craftGlbPath } from './craft.js';
import { runRemotePaint } from './paintRemote.js';
import { loadBlenderSnapshot, renderBlenderSnapshot, saveBlenderSnapshot, loadProjectNotes, renderProjectContext, recordProjectNote } from './state.js';

/**
 * Dedicated RAM-light Blender runner.
 *
 * WHY THIS EXISTS: the full `TaskRunner` + 84-tool registry + memory/RAG/judge
 * is memory-heavy and spawns lots of concurrent work. When Blender (and the GUI)
 * are already eating RAM on an 8GB M1, firing that at a "replicate Spyro" prompt
 * saturates memory → the Rainbow Wheel.
 *
 * This runner is deliberately minimal and memory-bounded:
 *  - A SCOPED tool registry with only Blender-relevant tools (run_shell,
 *    file read/write, web_search, screen_capture) — tiny schema, tiny context.
 *  - NO memory search, NO RAG, NO judge, NO skill bloat in the loop.
 *  - A fresh, isolated ModelRouter pointed at the SMALL local model (qwen3.5:2b)
 *    so work happens without a big cloud/context footprint.
 *  - Sequential single-step execution with a small step budget.
 *
 * The Blender add-on hits this handler (not /api/chat) so "he focuses only on
 * Blender at that moment."
 */

/** Only the tools a Blender prompt needs. `run_shell` drives headless blender;
 *  file read/write saves scripts/results; web finds assets; screen shows output. */
const BLENDER_TOOL_NAMES = new Set<string>([
  'run_shell',
  'bpy_exec',
  'bpy_base_mesh',
  'bpy_polyhaven',
  'bpy_craft',
  'bpy_import_craft',
  'bpy_reference',
  'bpy_render_report',
  'bpy_compare',
  'bpy_paint_remote',
  'file_read', 'file_write', 'file_list', 'file_delete',
  'web_search', 'web_read',
  'screen_capture',
]);

/** Module-level last-known reference path (set by runBlenderTask from the prompt),
 *  so bpy_compare can auto-target the current reference without being passed args. */
let lastReferencePath: string | undefined;

/** Read the live Blender bridge state. The add-on writes `blender-state.json`,
 *  but that file can go stale (e.g. after a hub bounce or a Blender reopen) while
 *  the bridge is actually still serving on port 3937. So we treat the state file
 *  as a hint for the PORT, then CONFIRM liveness by probing the bridge itself —
 *  a self-healing check that avoids "Blender not open" false negatives. */
export async function liveBridgeState(): Promise<{ live: boolean; port: number } | null> {
  let port = 3937;
  let fileSaysLive = false;
  let filePort: number | null = null;
  try {
    const fs = await import('node:fs/promises');
    const home = process.env.HOME ?? '/';
    const raw = await fs.readFile(home + '/.jarv-genie/blender-state.json', 'utf8');
    const s = JSON.parse(raw) as { live?: boolean; port?: number | null };
    fileSaysLive = s.live === true;
    filePort = Number(s.port ?? 3937);
    if (filePort > 0) port = filePort;
  } catch {
    // no state file — still probe the default port below
  }
  // Probe the bridge directly: if it answers {live:true}, it's genuinely up even
  // if the file is stale/absent. A short timeout so a wedged port can't hang us.
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2500) });
    const body = (await res.json().catch(() => ({}))) as { live?: boolean };
    return { live: body.live === true, port };
  } catch {
    // Bridge unreachable — trust the file only if it says live and has a port.
    return fileSaysLive && filePort ? { live: true, port } : { live: false, port };
  }
}

/** Execute bpy code against the LIVE open Blender scene (via the add-on bridge),
 *  or fall back to headless if no Blender is live. Returns a Jarv-friendly result. */
export async function runLiveBpy(code: string, timeoutMs = 15_000): Promise<{ ok: boolean; result: unknown; mode: 'live' | 'headless' | 'no-blender' }> {
  const state = await liveBridgeState();
  if (state?.live) {
    try {
      const res = await fetch(`http://127.0.0.1:${state.port}/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
        // Short timeout so a bridge whose main-thread timer isn't firing (e.g.
        // Blender in --background, or a wedged session) can't hang the runner for
        // the full 60s the add-on handler would otherwise block. Heavy work (GLB
        // export, big renders) passes a longer budget via timeoutMs.
        signal: AbortSignal.timeout(timeoutMs),
      });
      const data = (await res.json().catch(() => ({ ok: false, error: `http ${res.status}` }))) as { ok?: boolean; error?: string };
      return { ok: data.ok === true, result: data, mode: 'live' };
    } catch (err) {
      return { ok: false, result: { error: `live bridge unreachable: ${err instanceof Error ? err.message : String(err)}` }, mode: 'live' };
    }
  }
  // No live Blender → fall back to a headless background run (no visible scene).
  if (state !== null && !state.live) return { ok: false, result: { error: 'Blender is not open (no live bridge) — headless fallback unavailable for scene edits' }, mode: 'no-blender' };
  const shell = await runBlenderShell({} as JarvGenieConfig, code);
  return { ok: shell.ok, result: shell.ok ? JSON.parse(shell.output || '{}') : { error: shell.output }, mode: 'headless' };
}

/** A bpy_exec tool: executes bpy in the LIVE open scene when Blender is running,
 *  else reports cleanly that Blender isn't open (rather than doing invisible work). */
function bpyExecTool(config: JarvGenieConfig): ToolDefinition {
  return {
    name: 'bpy_exec',
    system: 'sense',
    description:
      'Execute a bpy Python snippet in the LIVE Blender scene and return the new scene object list + AABB/positions. Build visually coherent models: put the WHOLE silhouette in one snippet, REUSE existed named objects (do not spawn disconnected duplicates), and PARENT parts so nothing ends up loose/dissected. Return the object list so you can verify counts and connectivity.',
    inputSchema: {
      type: 'object',
      properties: { code: { type: 'string', description: 'A bpy Python snippet (safe, no file writes).' } },
      required: ['code'],
    },
    handler: async (args) => {
      const code = String(args.code ?? '').trim();
      if (!code) return { ok: false, error: 'code is required' };
      const r = await runLiveBpy(code);
      // Persist the named-parts snapshot so a FOLLOW-UP prompt can refine the same
      // build (isolated to the Blender runner; no bleed into Jarv's memory).
      if (r.ok && r.mode === 'live' && r.result && typeof r.result === 'object') {
        const res = r.result as { objects?: Array<{ name: string; type?: string; location?: number[]; bounds?: number[][]; parent?: string | null }> };
        if (res.objects) {
          try {
            const parents: Record<string, string> = {};
            for (const o of res.objects) if (o.name && o.parent) parents[o.name] = o.parent;
            void saveBlenderSnapshot(res.objects, parents);
          } catch { /* best-effort */ }
        }
      }
      return { ok: r.ok, mode: r.mode, result: r.result };
    },
  };
}

/** A bpy_base_mesh tool: drop a real-topology base humanoid into the live scene as
 *  a single smooth `Base_Humanoid` mesh, so character/creature builds start from a
 *  proper silhouette (limbs attached, tapered) instead of a cluster of boxes.
 *  The model then COLORS + SCULPTS + POSES it to match the reference — far closer
 *  to 1:1 than rebuilding a biped from parts. RAM-light (one joined mesh). */
function bpyBaseMeshTool(config: JarvGenieConfig): ToolDefinition {
  return {
    name: 'bpy_base_mesh',
    system: 'sense',
    description:
      'Add a real-topology low-poly base humanoid to the live scene as ONE smooth mesh named "Base_Humanoid" (head, neck, torso, pelvis, shoulders, both arms+hands, both legs+feet). Use this FIRST for any humanoid/creature/character build (orc, human, goblin, elf, warrior...) instead of assembling many disconnected boxes — starting from this silhouette gives proper limb junctions and a smooth body. Then COLOR it (green orc skin), SCULPT/tune the named proportions (broaden shoulders, add a snout/tusks/ears), and POSE it. Additive: never deletes existing objects; if Base_Humanoid already exists it is left alone.',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => {
      const r = await runLiveBpy(BASE_HUMANOID_SNIPPET);
      if (!r.ok) return { ok: false, mode: r.mode, result: r.result };
      return {
        ok: true,
        mode: r.mode,
        note: 'Base_Humanoid created. Now color it to match the task (e.g. green orc skin), then sculpt/tune named parts (broaden shoulders for an orc, add tusks/snout/ears) and pose it. Reuse Base_Humanoid by name; keep the joined body connected.',
      };
    },
  };
}

/** A bpy_polyhaven tool: fetch a real CC0 PBR texture or HDRI from PolyHaven and
 *  apply it in the live scene (real materials + realistic environment lighting),
 *  which makes a reference-driven render far more photographic than a flat color.
 *  RAM-light: on-demand HTTP download straight into the already-open Blender. */
function bpyPolyHavenTool(config: JarvGenieConfig): ToolDefinition {
  return {
    name: 'bpy_polyhaven',
    system: 'sense',
    description:
      'Pull a real CC0 (public-domain) PBR texture or HDRI from PolyHaven and apply it in the live Blender scene. Pass a material/lighting keyword (e.g. "leather", "wood", "grass", "metal", "studio"). For a texture, it downloads the actual Diffuse map and builds a material named mat_<asset> with a texture node you can assign to an object (e.g. bpy.data.materials["mat_..."]). For an HDRI it sets the world environment for realistic lighting. Use this to give a build real materials + lighting for a photoreal render. Returns the asset name + the material/HDRI to use.',
    inputSchema: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: 'Material or lighting keyword to search PolyHaven (e.g. "leather", "grass", "studio", "forest").' },
        kind: { type: 'string', description: '"textures" (default) to get a PBR material, or "hdris" to set world lighting.' },
      },
      required: ['keyword'],
    },
    handler: async (args) => {
      const keyword = String(args.kind === 'hdris' ? args.keyword ?? '' : args.keyword ?? 'leather').trim();
      const kind = String(args.kind ?? 'textures') === 'hdris' ? 'hdris' : 'textures';
      if (!keyword) return { ok: false, error: 'keyword is required' };
      try {
        const search = await searchPolyHavenAssets(keyword, kind);
        if (!search.ok) return { ok: false, error: search.error ? `no results for '${keyword}': ${search.error}` : `no PolyHaven ${kind} matched '${keyword}'` };
        // Prefer an exact/name match, else first result.
        const asset = search.assets.find((a) => a.name.toLowerCase().includes(keyword.toLowerCase())) ?? search.assets[0];
        if (!asset) return { ok: false, error: `no PolyHaven ${kind} matched '${keyword}'` };
        const resolved = await resolvePolyHavenFile(asset.id, kind, '1k');
        if (!resolved.ok || !resolved.url) return { ok: false, error: resolved.error ?? 'no downloadable file' };
        const dest = `/tmp/jarv_ph_${asset.id.replace(/[^a-zA-Z0-9_-]/g, '_')}.${resolved.ext ?? 'jpg'}`;
        await downloadPolyHavenFile(resolved.url, dest);
        const applyCode =
          kind === 'hdris'
            ? [
                'import bpy',
                `world = bpy.context.scene.world`,
                `if world is None:`,
                `    world = bpy.data.worlds.new("World")`,
                `    bpy.context.scene.world = world`,
                `world.use_nodes = True`,
                `n = world.node_tree.nodes.get("JarvHDRI") or world.node_tree.nodes.new("ShaderNodeTexEnvironment")`,
                `n.name = "JarvHDRI"`,
                `n.image = bpy.data.images.load("${dest}")`,
                `bg = world.node_tree.nodes.get("Background") or world.node_tree.nodes.new("ShaderNodeBackground")`,
                `for c in world.node_tree.links:`,
                `    if c.from_node == n:`,
                `        world.node_tree.links.remove(c)`,
                `world.node_tree.links.new(n.outputs["Color"], bg.inputs["Color"])`,
              ].join('\n')
            : [
                'import bpy, os',
                `mat = bpy.data.materials.get("mat_${asset.id}") or bpy.data.materials.new(name="mat_${asset.id}")`,
                `mat.use_nodes = True`,
                `ns = mat.node_tree.nodes; ns.clear()`,
                `out = ns.new("ShaderNodeOutputMaterial")`,
                `bsdf = ns.new("ShaderNodeBsdfPrincipled")`,
                `tex = ns.new("ShaderNodeTexImage")`,
                `tex.image = bpy.data.images.load("${dest}")`,
                `mat.node_tree.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])`,
                `mat.node_tree.links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])`,
              ].join('\n');
        const r = await runLiveBpy(applyCode);
        if (!r.ok) return { ok: false, mode: r.mode, result: r.result };
        return {
          ok: true,
          mode: r.mode,
          asset: asset.name,
          material: kind === 'textures' ? `mat_${asset.id}` : undefined,
          kind,
          note:
            kind === 'textures'
              ? `Material "${asset.name}" created as mat_${asset.id}. Assign it to objects, e.g. for o in bpy.data.objects: if o.type=='MESH': o.data.materials.append(bpy.data.materials["mat_${asset.id}"])`
              : `HDRI "${asset.name}" applied to the world for realistic lighting.`,
        };
      } catch (err) {
        return { ok: false, error: `polyhaven failed: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  };
}

/** A bpy_craft tool: run the native MLX Hunyuan3D shape diffuser to turn a
 *  reference photo into a REAL mesh GLB (not primitives) — the closest thing to
 *  1:1 on this Apple Silicon M1. RAM-critical: refuses to run while the live
 *  Blender bridge is up (shape peaks several GB; can't share 8GB with Blender). */
function bpyCraftTool(config: JarvGenieConfig): ToolDefinition {
  return {
    name: 'bpy_craft',
    system: 'sense',
    description:
      'Turn a reference IMAGE into a REAL high-fidelity mesh GLB using the native MLX Hunyuan3D shape diffuser (runs on this Apple Silicon M1). Pass the absolute path to a reference photo. WARNING/RAM: the craft is a heavy GPU/Metal compute (several GB) and MUST run with Blender CLOSED — this tool refuses to run while the live Blender bridge is up. After it finishes it returns a GLB you then load into Blender to texture/refine. This is how to get a true 1:1-ish mesh silhouette (not box primitives) from a photo.',
    inputSchema: {
      type: 'object',
      properties: {
        imagePath: { type: 'string', description: 'Absolute path to the reference image (png/jpg).' },
      },
      required: ['imagePath'],
    },
    handler: async (args) => {
      const imagePath = String(args.imagePath ?? '').trim();
      if (!imagePath) return { ok: false, error: 'imagePath is required' };
      try {
        const fs = await import('node:fs');
        if (!fs.existsSync(imagePath)) return { ok: false, error: `image not found: ${imagePath}` };
      } catch {
        return { ok: false, error: 'cannot check image path' };
      }
      // RAM guard: refuse if Blender is live (the craft can't share the machine).
      try {
        const state = await liveBridgeState();
        if (state?.live) {
          return {
            ok: false,
            error: 'Cannot craft while Blender is open (RAM). Close Blender, run this again, then reopen Blender to load the crafted GLB.',
          };
        }
      } catch { /* ignore */ }
      const ready = await craftReady();
      if (!ready) {
        return { ok: false, error: 'hy3d craft engine not installed — needs ~/.jarv-genie/craft/ with the hy3d binary, a colocated mlx.metallib, and weights/shape-small/' };
      }
      const result = await runCraft(imagePath, { quantize: 4, octree: 192, steps: 30 });
      if (!result.ok) return { ok: false, error: result.error ?? 'craft failed', detail: result.detail, durationMs: result.durationMs };
      return {
        ok: true,
        glb: result.glb,
        note: `Craft done in ${result.durationMs ? Math.round(result.durationMs / 1000) : '?'}s → ${result.glb}. This is a real mesh. Now IMPORT it into Blender (bpy.ops.import_scene.gltf(filepath=...) — reopen Blender first, since it was closed for the craft) then texture/refine it.`,
      };
    },
  };
}

/** A bpy_import_craft tool: import the crafted GLB (/tmp/jarv_crafted.glb) into the
 *  LIVE scene, cleanly — removing any default Cube/Plane that would otherwise embed
 *  the figure like a plastic cut-out, and coloring the mesh so it is not gray. */
function bpyImportCraftTool(config: JarvGenieConfig): ToolDefinition {
  return {
    name: 'bpy_import_craft',
    system: 'sense',
    description:
      'Import the crafted mesh GLB (/tmp/jarv_crafted.glb — produced by bpy_craft) into the LIVE scene, cleaning it up: removes the default "Cube"/"Plane" that would otherwise intersect, strips the fused "breakaway-tray" base, and smooth-shades. Does NOT impose a color unless you pass one, so each character keeps its true/reference appearance. Optionally pass material="green"/"brown"/"red"/"gray" to pre-color for a known character. Use AFTER bpy_craft, when Blender is open; then color/texture/refine per the character.',
    inputSchema: {
      type: 'object',
      properties: {
        material: { type: 'string', description: 'Optional single base color to apply: green, brown, red, gray, white. Omit to keep the mesh as-is.' },
        reference: { type: 'string', description: 'Optional absolute path to the reference image. If given, apply up to 3 region colors matched to it (skin/armor/trim via a height ramp) so the model renders true to the photo.' },
      },
    },
    handler: async (args) => {
      const matWord = String(args.material ?? '').trim().toLowerCase();
      const referencePath = String(args.reference ?? '').trim();
      const colorMap: Record<string, [number, number, number]> = {
        green: [0.12, 0.45, 0.18], red: [0.6, 0.1, 0.1], brown: [0.4, 0.28, 0.16],
        gray: [0.55, 0.55, 0.55], white: [0.9, 0.9, 0.9], black: [0.08, 0.08, 0.08],
      };
      const rgb = colorMap[matWord]; // single forced color, or null
      // region colors from the reference (up to 3) — computed headless, quick
      let region: Array<[number, number, number]> = [];
      if (referencePath) {
        try {
          const fs = await import('node:fs');
          if (fs.existsSync(referencePath)) {
            const { regionColorsFromImage } = await import('./craft.js');
            region = await regionColorsFromImage(referencePath);
          }
        } catch { /* [] */ }
      }
      const colorBake = rgb
        ? [
            `        mat=bpy.data.materials.get('MAT_Crafted') or bpy.data.materials.new(name='MAT_Crafted')`,
            `        mat.use_nodes=True`,
            `        b=mat.node_tree.nodes.get('Principled BSDF')`,
            `        b.inputs['Base Color'].default_value=(${rgb[0]},${rgb[1]},${rgb[2]},1.0)`,
            `        b.inputs['Roughness'].default_value=0.7`,
            `        if len(mesh.data.materials)==0:`,
            `            mesh.data.materials.append(mat)`,
            `        else:`,
            `            mesh.data.materials[0]=mat`,
          ].join('\n')
        : region.length
                  ? (() => {
                      const r0 = region[0]!, r1 = region[1], r2 = region[2];
                      return [
                        `        mat=bpy.data.materials.get('MAT_Crafted') or bpy.data.materials.new(name='MAT_Crafted')`,
                        `        mat.use_nodes=True`,
                        `        nt=mat.node_tree; nt.nodes.clear()`,
                        `        o=nt.nodes.new('ShaderNodeOutputMaterial'); pc=nt.nodes.new('ShaderNodeTexCoord'); bs=nt.nodes.new('ShaderNodeBsdfPrincipled')`,
                        `        at=nt.nodes.new('ShaderNodeAttribute'); at.attribute_name='position'; at.attribute_type='GEOMETRY'`,
                        `        sp=nt.nodes.new('ShaderNodeSeparateXYZ'); nt.links.new(at.outputs['Vector'], sp.inputs['Vector'])`,
                        `        m=nt.nodes.new('ShaderNodeMapRange'); m.inputs[1].default_value=0.0; m.inputs[2].default_value=2.0; m.inputs[3].default_value=0.0; m.inputs[4].default_value=1.0`,
                        `        nt.links.new(sp.outputs['Z'], m.inputs[0]); rp=nt.nodes.new('ShaderNodeValToRGB'); rp.color_ramp.elements[0].color=(${r0[0]},${r0[1]},${r0[2]},1.0)`,
                        `        nt.links.new(m.outputs[0], rp.inputs[0])`,
                        ...(r1 ? [`        e=rp.color_ramp.elements.new(0.5); e.color=(${r1[0]},${r1[1]},${r1[2]},1.0)`] : []),
                        ...(r2 ? [`        e=rp.color_ramp.elements.new(0.85); e.color=(${r2[0]},${r2[1]},${r2[2]},1.0)`] : []),
                        `        nt.links.new(rp.outputs['Color'], bs.inputs['Base Color'])`,
                        `        nt.links.new(bs.outputs['BSDF'], o.inputs['Surface']); nt.links.new(pc.outputs['Generated'], at.inputs['Vector'])`,
                        `        if len(mesh.data.materials)==0: mesh.data.materials.append(mat)`,
                        `        else: mesh.data.materials[0]=mat`,
                      ].join('\n');
                    })()
          : `        # (no color imposed — keep the figure as-is; texture/color per character)`;
      const glb = '/tmp/jarv_crafted.glb';
      const code = [
        'import bpy, os',
        `GLB="${glb}"`,
        `if not os.path.exists(GLB):`,
        `    print('NO_GLB')`,
        'else:',
        `    # remove default Cube/Plane that would embed/intersect the figure`,
        `    for n in ('Cube','Plane','Ground'):`,
        `        o=bpy.data.objects.get(n)`,
        `        if o is not None and o.type=='MESH':`,
        `            bpy.data.objects.remove(o, do_unlink=True)`,
        `    # name the imported mesh deterministically`,
        `    bpy.ops.import_scene.gltf(filepath=GLB)`,
        `    imported=[o for o in bpy.data.objects if o.type=='MESH' and o.name not in ('Cube','Plane','Ground')]`,
        `    if not imported:`,
        `        print('NO_MESH')`,
        '    else:',
        `        mesh=imported[-1]`,
        `        mesh.name='Crafted'`,
        `        # CONSERVATIVE: only remove a genuinely-flat, thin co-planar "breakaway`,
        `        # disc" at the very bottom IF one clearly exists (broad Hunyuan3D feet are`,
        `        # NOT a disc, so never slice into them — that amputates the feet).`,
        `        try:`,
        `            import bmesh`,
        `            _verts=[v.co for v in mesh.data.vertices]`,
        `            _lo=min(v.z for v in _verts)`,
        `            _hi=max(v.z for v in _verts)`,
        `            _bound0=[v for v in _verts if v.z-_lo<0.02]`,
        `            _flat=(max(v.z for v in _bound0)-min(v.z for v in _bound0)) if _bound0 else 0.0`,
        `            _np=len([v for v in _verts if v.z-_lo<0.004])`,
        `            if _np>50 and _np>len(_verts)*0.004 and _flat<0.02:`,
        `                bm=bmesh.new(); bm.from_mesh(mesh.data)`,
        `                bmesh.ops.delete(bm, geom=[v for v in bm.verts if v.co.z-_lo<0.004], context='VERTS')`,
        `                bm.to_mesh(mesh.data); bm.free(); mesh.data.update()`,
        `        except Exception:`,
        `            pass`,
        colorBake,
        `        bpy.ops.object.select_all(action='DESELECT'); mesh.select_set(True); bpy.context.view_layer.objects.active=mesh`,
        `        bpy.ops.object.shade_smooth()`,
        `        print('IMPORTED', mesh.name, len(mesh.data.vertices))`,
      ].join('\n');
      const r = await runLiveBpy(code);
      if (!r.ok) return { ok: false, mode: r.mode, result: r.result };
      return {
        ok: true,
        mode: r.mode,
        note: `Imported crafted mesh as "Crafted", removed the default Cube/Plane + handled base + smooth-shaded${rgb ? ` and applied ${matWord} material` : region.length ? ` and applied ${region.length} region colors matched to the reference` : ' (no color imposed — color/texture per the character)'}. Now refine it.`,
      };
    },
  };
}

/** A bpy_paint_remote tool: hand the texture/paint stage to a FREE 0-cost GPU host
 *  (Kaggle dual-T4 / Colab), since the paint model needs ~38GB RAM the M1 lacks.
 *  Uploads the crafted mesh + reference, the remote runs Hunyuan3D-2.1 paint, and
 *  returns a textured GLB you then import into Blender. Set BLENDER_PAINT_URL. */
function bpyPaintRemoteTool(config: JarvGenieConfig): ToolDefinition {
  return {
    name: 'bpy_paint_remote',
    system: 'sense',
    description:
      'Send the crafted mesh + the reference image to a FREE 0-cost GPU host (Kaggle/Colab) which runs the Hunyuan3D paint stage (the M1 cannot — it needs ~38GB RAM). Returns a textured PBR GLB to import into Blender. Configure once with: jarv-genie key set BLENDER_PAINT_URL <url> (+ BLENDER_PAINT_TOKEN). Pass the crafted mesh GLB path and the reference image path.',
    inputSchema: {
      type: 'object',
      properties: {
        mesh: { type: 'string', description: 'Path to the crafted mesh GLB (default /tmp/jarv_crafted.glb).' },
        reference: { type: 'string', description: 'Absolute path to the reference image.' },
      },
      required: ['reference'],
    },
    handler: async (args) => {
      const reference = String(args.reference ?? '').trim();
      if (!reference) return { ok: false, error: 'reference is required' };
      const mesh = String(args.mesh ?? '').trim() || craftGlbPath();
      try {
        const fs = await import('node:fs');
        if (!fs.existsSync(mesh)) return { ok: false, error: `mesh GLB not found: ${mesh}` };
        if (!fs.existsSync(reference)) return { ok: false, error: `reference not found: ${reference}` };
      } catch { /* ignore */ }
      // RAM-light guard: only the M1 networking is used here; the heavy paint is remote.
      const result = await runRemotePaint(mesh, reference);
      if (!result.ok) return { ok: false, error: result.error ?? 'remote paint failed' };
      return {
        ok: true,
        glb: result.glb,
        note: `Painted GLB saved → ${result.glb}. This is now a textured model from the free GPU host. IMPORT it into Blender (File>Import>glTF 2.0, or bpy_import_craft) and refine.`,
      };
    },
  };
}

export interface BlenderRunInput {
  message: string;
  /** Blender path override; defaults to the primary (smart) model. */
  model?: string;
  /** Max agent steps (CPU bound). Default 8. */
  maxSteps?: number;
  /** Route to the small local model instead of the smart primary. */
  local?: boolean;
}

export interface BlenderRunResult {
  text: string;
  steps: number;
  toolCalls: number;
  provider: string;
  model: string;
  /** True when this used the small local model (not the heavy cloud path). */
  local: boolean;
}

/** Verbatim shading/material finalize recipe the model is told to run last, so a
 *  build is never left flat-gray or the wrong color. Plain string (Python
 *  single-quoted) to avoid template-literal/backtick interaction. Includes a
 *  color/material lookup so the model maps description words to real RGB. */
const FINALIZE_SNIPPET = [
  'import bpy',
  "# pick the color from the task's color/material words; default warm gray",
  "named = {'red':(0.7,0.08,0.08),'green':(0.08,0.6,0.1),'blue':(0.1,0.15,0.7),'gold':(0.85,0.65,0.1),'wood':(0.48,0.34,0.21),'pine':(0.48,0.34,0.21),'oak':(0.55,0.4,0.25),'metal':(0.7,0.7,0.72),'silver':(0.75,0.75,0.76),'black':(0.05,0.05,0.05),'white':(0.9,0.9,0.9),'gray':(0.6,0.6,0.6)}",
  "# COMPLETE THIS LINE: base_rgb = named['<the color/material word from the task>']",
  "base_rgb = named.get('gray', (0.6,0.6,0.6))",
  "wood = bpy.data.materials.new('MAT_Build'); wood.use_nodes = True",
  "bsdf = wood.node_tree.nodes.get('Principled BSDF')",
  "bsdf.inputs['Base Color'].default_value = base_rgb + (1.0,); bsdf.inputs['Roughness'].default_value = 0.6",
  'for o in bpy.data.objects:',
  "    if o.type == 'MESH':",
  '        o.data.materials.clear(); o.data.materials.append(wood)',
  "        bpy.context.view_layer.objects.active = o; bpy.ops.object.shade_smooth()",
  "if not any(o.type == 'LIGHT' for o in bpy.data.objects):",
  "    d = bpy.data.lights.new('Sun', type='SUN'); d.energy = 3.0",
  "    o = bpy.data.objects.new('Sun', d); bpy.context.scene.collection.objects.link(o); o.rotation_euler = (0.785, 0, 0.5)",
].join('\n');

const BLENDER_SYSTEM = (today: string): string =>
  `You are Jarv, building 3D models in the user's OPEN Blender scene. Memory/CPU are limited; be terse but build visually coherent, recognizable objects — not symbolic placeholders.

CRITICAL — visual/spatial discipline:
- A "wreath" is a circular arrangement of overlapping branches/leaves, not a plain doughnut + cones. A "running dog" is a quadruped with 4 legs in a RUNNING pose, one body, one head, proportioned — NOT detached separate primitives.
- ADDITIVE, NOT DESTRUCTIVE: DO NOT clear/delete existing objects when refining. If objects already exist, BUILD ON THEM — reuse or modify them by name and ADD new parts. Only remove objects when the user explicitly says "start over", "clear", or "new scene". Iterative prompts refine the current model; they never wipe it.
- On a fresh build (no relevant objects), create the whole silhouette as ONE coherent object (or a few named, PARENTED parts) before adding detail.
- REUSE NAMED objects: to modify/skew/rotate a limb, reference the SAME object by name (bpy.data.objects["Name"]) and apply the transform to THAT object — never spawn a fresh disconnected primitive per step, and never delete the existing one to remake it.
- Do the whole edit in ONE bpy_exec: create, shape, place, parent, apply (do not split one logical step across many calls that each assume a fresh scene).
- VERIFY at the end: call verify/AABB or read the returned object list and CONFIRM counts/positions make sense (e.g. 4 legs, not 8; parts still connected/parented — nothing "dissected" into loose pieces).
- Animation: to animate a running dog across 10 frames, rotate the same shoulder/hip bones or the LEG objects' rotation over time on one armature — do NOT create new armatures or pull existing ones apart. Set keyframes with bpy.context.scene.frame_set(f) + object.keyframe_insert(...).

SHAPING & DETAIL (kill the flat/blocky look):
- SHAPE with modifiers, not just primitives: bevel sharp edges (bevel modifier width ~0.02-0.05) and use SUBSURF/rounded cylinders for organic parts (bpy.ops.mesh.primitive_uv_sphere_add, then scale; add a SUBSURF modifier levels=1-2 for a smooth body/head).
- For smooth organic objects (a dog, a character limb), make the base shape then add a Subdivision Surface modifier (bpy.ops.object.modifier_add(type='SUBSURF'); modifier.levels=2) so it is not a blocky box.
- Faces/heads/limbs taper: use cones, stretched spheres, and beveled boxes, not plain cubes. A "leg"/"arm"/"beak"/"ear" is a shaped 3D body, never a bare box.
- Group detail: once the silhouette is right, add distinguishing detail (eyes, ears, beak, wings, textures via modifier/sculpt) in the SAME or following prompt — not invisible.
- SCULPT-DEEPER for organic subjects (creatures/characters/busts): the add-on already auto-smooths with subsurf+bevel after every build, so DON'T pile on nested subsurfs. Instead invest effort in the BASE SILHOUETTE: use spheres/capsules/cylinders that actually overlap and blend (e.g. a jaw is a flattened sphere tucked under the skull, ears are stretched cones on the head), and shape detail with MANY small well-placed parts, not one giant blob. Add asymmetric, distinctive masses (snout, brow ridge, chest, haunches, horns, tusks) as their own named parts so they read as modeled, not as a cluster of equal primitives. Aim for the PROFILE to be believable from the side, not just the front.
- DEPTH over symmetry: characters/creatures should have real thickness (deep chest, defined limbs, a neck that connects head to torso), NOT flat billboards or disconnected floating shapes. When a part should taper or bulge, scale/rotate that part's ORIGINAL geometry — don't fake it with extra flat copies.

COLOR (apply the described colors — this must not be skipped):
- When the prompt names any color/material (red, blue, green, gold, wood, pine, oak, metal), the FINALIZE material you apply MUST be that color. A "red cube" is RED. Use the named color map in the FINALIZE snippet and set base_rgb = named['<that word>'].
- Do not default to a neutral gray when a color word is present — the gray auto-shade is only a fallback for when NO color was mentioned.
- For REAL materials/lighting that make a render look photographic, call bpy_polyhaven: give it a material keyword (leather, wood, grass, metal, brick, marble...) to fetch a real CC0 PBR texture and build a mat_<name> you assign to objects; or kind="hdris" with a lighting keyword (studio, forest, sunset...) to set realistic world environment lighting. Use this instead of a flat color when the task implies a real surface (e.g. "leather pouch", "wooden table", "photoreal orc") — it dramatically improves fidelity.

CHARACTERS & COMPLEX MODELS (when the task is a named character, creature, or multi-part object):
- BASE-FIRST for humanoid/biped characters (orc, human, goblin, elf, warrior, etc.): call bpy_base_mesh to drop in the single-smooth-mesh "Base_Humanoid" silhouette FIRST, then COLOR it (e.g. MAT green orc skin), SCULPT/tune its named proportions (broaden shoulders, add a snout/tusks/ears/jaw), and POSE it. Do NOT rebuild a biped from many disconnected boxes — the base already has attached, tapered limbs and a smooth body, which reads far closer to the subject. Keep it as one connected body; edit by name (Base_Humanoid).
- If the character is non-humanoid (quadruped, creature), fall back to assembling named, parented parts — but still aim for a coherent silhouette, not scattered primitives.
- Break it into NAMED, PARENTED parts you can refine later: e.g. "Torso", "Head", "L_UpperArm", "L_Forearm", "L_Hand", (mirror for R_...), "Pelvis", "L_Thigh", "L_Calf", "L_Foot". Parent each limb part to the part above it (forearm → upper arm; calf → thigh) and all to one root "Root".
- Thickness + proportion matter more than count: joints should be wider, limbs taper, no part is a bare 2D box. Use cylinders/beveled boxes for limbs, spheres/flattened spheres for joints.
- Keep ALL part names stable across prompts so the user can say "make L_Forearm thicker" and you modify exactly that named object — never recreate it.
- Plant the figure on the ground (Z=0) and give a neutral standing or described pose via bone/part rotation — do not split the figure into disconnected floating pieces.
- REFINE, don't rebuild: on a follow-up prompt ("now make the head bigger"), edit the existing named part(s) by name, never delete the whole character to start over.
- SHAPE KEYS for controllable faces/features: when you build a character's FACE or a deformable part (brow, jaw, mouth, ear, tusk, cheek), add NAMED shape keys so the user can later drive expressions by name (e.g. "make him frown" → set a key's value). Pattern: sk = obj.shape_key_add(name='BrowUp'); sk.value = 0.0   then later set   obj.data.shape_keys.key_blocks['BrowUp'].value = 1.0   (start with shape_key_add(name='Basis') first). Name keys clearly (BrowUp, BrowDown, Smile, Frown, JawOpen, Blink, TuskLift, Snarl). This gives a controllable "handle" for expressions WITHOUT Rigify/drivers — pure bpy, RAM-light.

REFINE-TO-DETAIL (stop producing clustered geometric shapes — close the loop with feedback):
- After building the base, call bpy_render_report to RENDER your current work to a PNG and get a VISION description of what you actually built (e.g. "a green sphere torso, two boxy gray legs, no head"). Use that description to SEE your result instead of assuming.
- When a reference image is present, call bpy_compare to SCAN + COMPARE: it renders your model, re-reads the reference, and returns both descriptions plus the single most-different part. Fix THAT one part by name, then re-render. Run this compare→fix→render loop up to ~3 times for a "make it 1:1"/"refine" request.
- Then compare what you SEE against the task/reference and make ONE targeted correction to the specific named part that is wrong (e.g. the report says "no head" → create/add the Head part; "legs are boxes" → reshape them with bevel/subsurf). Edit that ONE part by name — do not rebuild the whole scene.
- Repeat the render → assess → correct loop up to ~3 times when a prompt asks to 'fine tune' or 'refine', each time fixing the single most-wrong detail.
- If a reference image is available (bpy_reference gave a spec), compare the rendered result's proportions/colors against that spec and adjust named parts to match.

GENERAL:
- REFERENCE IMAGE IS OPTIONAL, NOT REQUIRED. IMAGE INPUT: you CANNOT read image bytes — your raw text model rejects them ("does not support image input"). If a reference image path is present in your prompt, a shape-spec ALREADY appears in the user message (analyzed by a separate vision model) — build from THAT spec text with bpy_exec; do NOT attempt to open/read the image file yourself. The bpy_reference tool is a fallback for when no spec was injected. By default, build from your OWN knowledge + the user's free-text description (e.g. "a sturdy pine workbench, thick top, 4 legs").
- REAL 3D, not flat: a "leg"/"column"/"handle"/"stem" is a 3D body (cylinder/rounded column), NOT a flat plane. A bench leg is a squat cylinder or beveled box — never a 2D rectangle. Give parts thickness and proper X/Y/Z scale.
- You already know what common things look like (wreath, dog, chair, table). Use that + the description; do not stall waiting for an image.
- FINALIZE PASS (ALWAYS, at the end): run ONE bpy_exec that (1) assigns a material to every object, (2) adds a SUN light if none exists, (3) SMOOTH-SHADES the objects. Use THIS VERBATIM bpy (copy exactly):` +
    '\n```\n' + FINALIZE_SNIPPET + '\n```' +
    `\nAdjust the material color/roughness only to match material words in the task (oak, red, metal, glass).
- Prefer low-level bpy (bpy.data.objects, matrix assignment) over bpy.ops when context is flaky.
- Use bpy_exec for scene edits; file/run_shell only if a task truly needs a script file or external asset.
- Stay on the ONE request. Reply concisely with the object names + materials created and the AABB/pose verification.
Today is ${today}.`;

export async function newBlenderRouter(config: JarvGenieConfig, forceLocal = false): Promise<ModelRouter> {
  const { ModelRouter } = await import('../providers/index.js');
  const router = new ModelRouter(config);
  // RAM is consumed by LOADED machinery (memory/RAG/84-tool registry), not by an
  // HTTP API call. So the default (smart cloud primary) is still RAM-light — the
  // isolated tiny toolset + no memory is what prevents the wheel. `forceLocal`
  // lets callers opt into the small local model for fully-offline/quiet work.
  if (forceLocal) {
    try {
      router.setPrimaryModel('qwen3.5:2b');
    } catch {
      /* keep configured primary */
    }
  }
  return router;
}

/** A bpy_reference tool: turn a reference image into a structured 3D shape-spec
 *  via the local vision model, so a text-only Jarv builds from real proportions
 *  (not symbolic guesses). RAM-light (reuses Ollama vision, no extra models). */
function bpyReferenceTool(config: JarvGenieConfig): ToolDefinition {
  return {
    name: 'bpy_reference',
    system: 'sense',
    description:
      'Turn a reference IMAGE FILE into a structured 3D shape-spec (primitives, position, scale, rotation, proportions, parts + parents) via the local vision model. Use ONLY when the user gives an absolute image path or says "make it look like this picture". For a normal text request like "make a wreath" with no image, just build from your own knowledge — do NOT call this. Pass the absolute image path.',
    inputSchema: {
      type: 'object',
      properties: { imagePath: { type: 'string', description: 'Absolute path to the reference image (png/jpg).' } },
      required: ['imagePath'],
    },
    handler: async (args) => {
      const imagePath = String(args.imagePath ?? '').trim();
      if (!imagePath) return { ok: false, error: 'imagePath is required' };
      try {
        const comp = (config as unknown as { computer?: { visionModel?: string } }).computer ?? {};
        const spec = await describeToSpec(imagePath, config, comp.visionModel);
        return { ok: true, ...spec, note: 'Use these proportions/parts to build in bpy_exec; parent the parts so nothing ends up dissected.' };
      } catch (err) {
        return { ok: false, error: `reference vision failed: ${err instanceof Error ? err.message : String(err)} — reply with your best bpy guess and note it is unverified` };
      }
    },
  };
}

/** Render a PNG of the live Blender scene to /tmp via the bridge.
 *  Returns the path, or an error. RAM-light (renders in the already-open Blender).
 *
 *  WHY EEVEE, NOT OPENGL: `bpy.ops.render.opengl` renders the 3D viewport in
 *  whatever shading mode the user happens to be in (often Solid/gray), so builds
 *  looked gray. EEVEE always renders the materials. We also frame the camera on
 *  the scene's bounding box (tight fit + good angle) so the colored model fills
 *  the frame instead of floating tiny in a gray world. */
export async function renderLiveScenePNG(outPath = '/tmp/jarv_blender_report.png', size = 512): Promise<{ ok: boolean; path: string; error?: string }> {
  const code = [
    `import bpy, os, math`,
    `sc = bpy.context.scene`,
    `prev = (sc.render.filepath, sc.render.resolution_x, sc.render.resolution_y, sc.render.engine)`,
    `try:`,
    `    # Use EEVEE so materials/colors are actually rendered.`,
    `    if 'BLENDER_EEVEE_NEXT' in bpy.types.RenderSettings.bl_rna.properties['engine'].enum_items:`,
    `        sc.render.engine = 'BLENDER_EEVEE_NEXT'`,
    `    else:`,
    `        sc.render.engine = 'BLENDER_EEVEE'`,
    `    sc.render.filepath = '${outPath}'`,
    `    sc.render.resolution_x = ${size}; sc.render.resolution_y = ${size}`,
    `    sc.render.image_settings.file_format = 'PNG'`,
    `    # Frame a camera on the scene's bounding box (meshes only).`,
    `    meshes = [o for o in bpy.data.objects if o.type == 'MESH']`,
    `    if not meshes:`,
    `        raise RuntimeError('no mesh objects to render')`,
    `    import mathutils`,
    `    lo = mathutils.Vector((1e9, 1e9, 1e9))`,
    `    hi = mathutils.Vector((-1e9, -1e9, -1e9))`,
    `    for o in meshes:`,
    `        for c in o.bound_box:`,
    `            w = o.matrix_world @ mathutils.Vector(c)`,
    `            for i in range(3):`,
    `                lo[i] = min(lo[i], w[i]); hi[i] = max(hi[i], w[i])`,
    `    center = (lo + hi) * 0.5`,
    `    extents = hi - lo`,
    `    radius = max(extents.length / 2.0, 1.0) * 0.55`,
    `    # A flattering 3/4 angle, slightly above.`,
    `    cam_slot = sc.camera`,
    `    if cam_slot is None and bpy.data.cameras:`,
    `        cam_ob = bpy.data.objects.new('JarvCam', bpy.data.cameras.new('JarvCam'))`,
    `        sc.collection.objects.link(cam_ob); cam_slot = cam_ob; sc.camera = cam_ob`,
    `    if cam_slot is not None:`,
    `        from mathutils import Vector as _V`,
    `        cam_slot.location = _V((radius*0.85, -radius*0.85, center.z + radius*0.55))`,
    `        direction = center - cam_slot.location`,
    `        cam_slot.rotation_euler = direction.to_track_quat('-Z', 'Y').to_euler()`,
    `    bpy.ops.render.render(write_still=True)`,
    `    print('RENDERED', os.path.getsize('${outPath}'))`,
    `except Exception as e:`,
    `    print('RENDER_ERR', repr(e))`,
    `finally:`,
    `    sc.render.filepath, sc.render.resolution_x, sc.render.resolution_y, sc.render.engine = prev`,
  ].join('\n');
  const r = await runLiveBpy(code);
  if (!r.ok) return { ok: false, path: outPath, error: r.mode === 'no-blender' ? 'no live Blender open' : 'render bpy error' };
  try {
    const fs = await import('node:fs');
    if (!fs.existsSync(outPath) || fs.statSync(outPath).size === 0) return { ok: false, path: outPath, error: 'render produced no PNG' };
    return { ok: true, path: outPath };
  } catch (err) {
    return { ok: false, path: outPath, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Assess the current build against the reference (if any): render the live mesh,
 *  describe both the render and the reference with local vision, and return a
 *  comparison note so Jarv can correct the single most-wrong part toward 1:1.
 *  RAM-light (reuses local vision). Renders in the already-open Blender. */
export async function assessAgainstReference(config: JarvGenieConfig, referenceImage?: string): Promise<{
  ok: boolean;
  renderDesc?: string;
  referenceDesc?: string;
  gap?: string;
  error?: string;
}> {
  const shot = await renderLiveScenePNG();
  if (!shot.ok) return { ok: false, error: shot.error ?? 'render failed' };
  try {
    const { describeImage } = await import('../computer/index.js');
    const comp = (config as unknown as { computer?: { visionModel?: string } }).computer ?? {};
    const model = comp.visionModel;
    const renderDesc = await describeImage(shot.path, config, {
      model,
      question: 'Describe this 3D model render: overall shape, parts present (head/body/limbs/ears?), their proportions and colors, and what is MISSING, blocky, or wrong. Be specific and honest.',
    }).then((d) => d.slice(0, 1200));
    let referenceDesc = '';
    let gap = '';
    if (referenceImage) {
      try {
        referenceDesc = await describeImage(referenceImage, config, {
          model,
          question: 'Describe this reference image: overall silhouette, main parts and their proportions, colors, pose. Be specific.',
        }).then((d) => d.slice(0, 1200));
        gap = 'Compare your rendered model to the reference. Identify the SINGLE most-different part (a limb wrong, head too small, wrong color, missing feature) and edit THAT by name. Do not rebuild the whole figure; do not add unrelated detail.';
      } catch {
        gap = 'Reference could not be re-read; correct the single most-wrong part of the render by name.';
      }
    }
    return { ok: true, renderDesc, referenceDesc, gap: gap || 'Correct the single most-wrong part by name, then re-render.' };
  } catch (err) {
    return { ok: false, error: `vision assessment failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** A bpy_compare tool: render the current model and (if a reference path is passed
 *  or present) read the reference, returning BOTH vision descriptions + the single
 *  most-different part to fix toward 1:1. RAM-light (local vision, render in open Blender). */
function bpyCompareTool(config: JarvGenieConfig): ToolDefinition {
  return {
    name: 'bpy_compare',
    system: 'sense',
    description:
      'SCAN + COMPARE toward 1:1. Renders your current model, re-reads the reference image (pass its absolute path in reference, or it is taken from the prompt), and returns a vision description of BOTH plus the single most-different part to fix. Use this to compare what you built against the reference (e.g. "the arms are too long vs the picture") and make ONE targeted edit by name — then re-render to verify. RAM-light: reuses local vision.',
    inputSchema: {
      type: 'object',
      properties: { reference: { type: 'string', description: 'Optional absolute path to the reference image.' } },
    },
    handler: async (args) => {
      const reference = String(args.reference ?? '').trim() || lastReferencePath;
      const ass = await assessAgainstReference(config, reference);
      if (!ass.ok) return { ok: false, error: ass.error ?? 'compare failed' };
      return {
        ok: true,
        render: ass.renderDesc,
        reference: ass.referenceDesc,
        note: ass.gap,
      };
    },
  };
}

/** A bpy_render_report tool: renders the current Blender build to a PNG and gets
 *  a vision description of what Jarv ACTUALLY built, so it can see (not assume)
 *  its work and correct the specific wrong part. RAM-light (reuses local vision). */
function bpyRenderReportTool(config: JarvGenieConfig): ToolDefinition {
  return {
    name: 'bpy_render_report',
    system: 'sense',
    description:
      'Render a viewport still of the current Blender scene and describe it with local vision. Use AFTER building to SEE your actual result (e.g. "a green sphere torso, two boxy gray legs, no head") so you can correct exactly the part that is wrong instead of guessing. Triggers a render + calls the local vision model; returns the vision description of your own work.',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => {
      const ass = await assessAgainstReference(config);
      if (!ass.ok) return { ok: false, error: ass.error ?? 'render report failed' };
      return { ok: true, description: ass.renderDesc, note: ass.gap };
    },
  };
}

/** Build a scoped registry holding only Blender tools. */
export function blenderToolRegistry(config: JarvGenieConfig): ToolRegistry {
  const registry = new ToolRegistry();
  const all: ToolDefinition[] = [
    ...systemTools(),
    ...fileTools(),
    ...webTools(),
    bpyExecTool(config),
    bpyBaseMeshTool(config),
    bpyPolyHavenTool(config),
    bpyCraftTool(config),
    bpyImportCraftTool(config),
    bpyReferenceTool(config),
    bpyRenderReportTool(config),
    bpyCompareTool(config),
    bpyPaintRemoteTool(config),
  ];
  const scoped = all.filter((t) => BLENDER_TOOL_NAMES.has(t.name));
  registry.registerMany(scoped);
  return registry;
}

/** Deterministically read a reference image (if the prompt names one) and return
 *  a terse shape-spec hint to inject into the user message. This runs the vision
 *  model DIRECTLY (not via a model-decided tool call), so a "make it look like
 *  this picture: /path.jpg" task is NEVER lost to a text model that can't see
 *  images. RAM-light: one local llava call, no extra models, best-effort.
 *
 *  Reads the user's absolute image path (png/jpg/jpeg) and feeds it to the
 *  structural vision spec. Returns text the builder should follow, or '' when no
 *  image path is present / nothing usable was extracted. */
async function referenceHintFor(config: JarvGenieConfig, message: string): Promise<string> {
  const path = extractAbsoluteImagePath(message);
  if (!path) return '';
  const comp = (config as unknown as { computer?: { visionModel?: string } }).computer ?? {};
  try {
    const spec = await describeToSpec(path, config, comp.visionModel);
    const parts = Array.isArray(spec.parts) ? spec.parts : [];
    if (parts.length === 0) {
      return `\n[Reference image at "${path}" described as: ${spec.summary.slice(0, 300)}] Build this with bpy_exec primitives following the description. Do NOT read the image bytes yourself (your model cannot see image input); rely on this description only.`;
    }
    // Render the spec as an actionable per-part template. The vision model's
    // absolute coordinates are often unreliable, so give the builder the part
    // NAMES, PARENT chain, PRIMITIVE, and PROPORTION ratios and let it place
    // them sensibly (feet on Z=0, head above torso, limbs attached at joints).
    const lines: string[] = [];
    const seen = new Set<string>();
    for (const p of parts.slice(0, 24)) {
      let name = String((p as Record<string, unknown>).name ?? 'part').trim();
      // Dedupe repeated/mislabeled names so the builder doesn't create two
      // "Forearm and Hand Left" (a common llava slip that confuses articulation).
      if (!name) name = 'part';
      if (seen.has(name)) {
        const i = 2;
        name = `${name}_${i}`;
        while (seen.has(name)) name = `${name}_${i + 1}`;
      }
      seen.add(name);
      const prim = String((p as Record<string, unknown>).primitive ?? 'cube');
      const parent = (p as Record<string, unknown>).parent ? String((p as Record<string, unknown>).parent) : null;
      const scale = Array.isArray((p as Record<string, unknown>).scale) ? (p as Record<string, unknown>).scale as number[] : [];
      const s = scale.slice(0, 3).filter((n) => Number.isFinite(Number(n)) && Number(n) > 0).map((n) => Number(n).toFixed(2)).join('/');
      lines.push(`- "${name}": a ${prim}${parent ? `, child of "${parent}"` : ''}${s ? `, roughly x:y:z = ${s}` : ''}`);
    }
    return (
      `\n[Reference image at "${path}" analyzed by local vision. Build THIS arrangement with bpy_exec primitives — do NOT read the image bytes yourself. Your text model has NO image input. The vision coordinates are approximate; PLACE the parts sensibly yourself: plant feet/legs on the ground (Z≈0), set the torso above, the head on top, and attach paired limbs (L_/R_) at the right joints pointing outward/downward. Overall proportions: ${spec.summary.replace(/\s+$/, '')} (aspect ${typeof spec.proportions?.width_over_height === 'number' ? spec.proportions.width_over_height.toFixed(2) : 'n/a'}).\nNamed parts to create (VERBATIM names, keep them stable so they can be refined later):\n${lines.join('\n')}\nParent the chain so nothing ends up disconnected, and use bevel/subsurf so parts are rounded.]`
    );
  } catch (err) {
    // Vision is optional; fall back to plain text so the build still happens.
    return `\n[Note: reference image "${path}" could not be analyzed by local vision (${err instanceof Error ? err.message : String(err)}). Build from your own knowledge of the subject described. Do NOT attempt to read the image file yourself — your model cannot see image input.]`;
  }
}

/** Run the Blender task through the minimal, RAM-bounded loop. */
export async function runBlenderTask(config: JarvGenieConfig, input: BlenderRunInput): Promise<BlenderRunResult> {
  const forceLocal = input.local === true;
  const router = await newBlenderRouter(config, forceLocal);
  // Track whether we ended up on the small local model (qwen3.5:2b) or the 4B
  // primary. The isolation (tiny toolset + no memory) is what prevents the wheel;
  // the model choice affects capability, not RAM-at-rest.
  let usedLocal = forceLocal || String(input.model ?? '').includes('qwen3.5:2b');
  const registry = blenderToolRegistry(config);
  const tools = registry.list();
  const toolNames = tools.map((t) => t.name);
  // Step budget: give reference-image builds extra room (they burn steps on the
  // vision-informed shape-spec + a larger per-part build + render-refine loop).
  // Steps are SEQUENTIAL model/tool turns, not parallel RAM — raising the budget
  // costs wall-clock time, not memory, so it stays RAM-light on the 8GB M1.
  const hardCap = 28;
  const defaultSteps = extractAbsoluteImagePath(input.message) ? 22 : 16;
  const maxSteps = Math.min(Math.max(input.maxSteps ?? defaultSteps, 4), hardCap);

  const today = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  // Inject the persisted Blender named-parts snapshot so a follow-up prompt
  // "remembers" the current build and refines it by name (isolated to the runner).
  const snapshot = await loadBlenderSnapshot();
  const snapshotHint = renderBlenderSnapshot(snapshot);
  // Inject the Blender "self-learning" log: models already built in past projects,
  // so Jarv builds each NEW character true to its own source (not a past shape).
  const projectNotes = await loadProjectNotes();
  const projectHint = renderProjectContext(projectNotes);
  // Deterministically read any reference image named in the prompt into a
  // shape-spec hint, so the text model is never expected to decode an image it
  // can't see (DeepSeek rejects image input with "does not support image input").
  const referenceHint = await referenceHintFor(config, input.message);
  lastReferencePath = extractAbsoluteImagePath(input.message) || undefined;
  const userMessage = [input.message, referenceHint, snapshotHint, projectHint].filter(Boolean).join('\n');
  const messages: ChatMessage[] = [
    { role: 'system', content: BLENDER_SYSTEM(today) },
    { role: 'user', content: userMessage },
  ];

  let steps = 0;
  let toolCalls = 0;
  let model = '';
  let provider = '';

  // Blender tools (run_shell, file, web) don't touch memory; a minimal no-op
  // stub satisfies the ToolContext type without loading the real memory store
  // (which would add RAM — the whole point of this runner).
  const noopMemory = {
    addFact: async () => ({ id: 'noop' }),
    updateFact: async () => null,
    recall: async () => [],
    listFacts: async () => [],
    deleteFact: async () => false,
    sessionLoad: async () => [],
    sessionAppend: async () => {},
    sessionReset: async () => {},
  };
  const ctx = { memory: noopMemory, config, workdir: config.agent.workdir };

  while (steps < maxSteps) {
    steps++;
    let chat;
    try {
      chat = await router.chat({ messages, tools });
    } catch (err) {
      return { text: `Blender runner model error: ${err instanceof Error ? err.message : String(err)}`, steps, toolCalls, provider, model, local: usedLocal };
    }
    provider = chat.provider;
    model = chat.model;
    if (String(chat.model).includes('qwen3.5:2b') || String(chat.model).includes('llama')) usedLocal = true;
    messages.push({ role: 'assistant', content: chat.content, toolCalls: chat.toolCalls ?? undefined });

    const textCalls = chat.toolCalls ?? extractTextToolCalls(chat.content ?? '', toolNames).map((e, i) => ({ id: `text-${i}`, name: e.name, arguments: e.args }));
    const calls: ToolCall[] = Array.isArray(chat.toolCalls) ? chat.toolCalls : textCalls;
    if (calls.length === 0) {
      // Final answer — record a short "what was built" note in the isolated
      // self-learning log so a FUTURE prompt knows this model exists (and to build
      // new characters fresh, not reuse it). Best-effort.
      const ref = extractAbsoluteImagePath(input.message);
      void recordProjectNote({
        prompt: input.message,
        reference: ref ?? undefined,
        objectName: snapshot?.parts.map((p) => p.name).join(', ').slice(0, 120) || undefined,
        verts: undefined,
        outcome: 'built/refined',
      });
      return { text: chat.content ?? '', steps, toolCalls, provider, model, local: usedLocal };
    }

    toolCalls += calls.length;
    for (const call of calls) {
      try {
        const { ok, result } = await registry.execute(call.name, call.arguments, ctx);
        messages.push({
          role: 'tool',
          toolCallId: call.id,
          name: call.name,
          content: JSON.stringify(ok ? result : { error: result }),
        });
      } catch (err) {
        messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) });
      }
    }
  }

  return { text: `Reached the ${maxSteps}-step budget for this Blender build (${steps} steps used). The in-progress result is exported; refine it in the 3D viewer to keep improving it. For a bigger single build, pass a higher maxSteps.`, steps, toolCalls, provider, model, local: usedLocal };
}

/** Export the LIVE Blender scene to a GLB for the web UI viewer. Sends a bpy
 *  snippet through the bridge and verifies the file was written. RAM-light (the
 *  export runs in the already-open Blender). */
export async function runBlenderExport(): Promise<{ ok: boolean; path: string; error?: string; detail?: string }> {
  const outPath = '/tmp/jarv_blender_preview.glb';
  const code = [
    `import bpy, os, json`,
    `target = '${outPath}'`,
    `if os.path.exists(target): os.remove(target)  # so a stale file can't mask a failed export`,
    `# deselect all, then export the whole scene as GLB`,
    `bpy.ops.object.select_all(action='SELECT')`,
    `# selection-based GLB export needs at least one selected object; ensure one`,
    `if len(bpy.context.selected_objects) == 0 and bpy.data.objects:`,
    `    bpy.data.objects[0].select_set(True)`,
    `# subsurf/bevel/displacement are applied automatically by the GLTF exporter`,
    `bpy.ops.export_scene.gltf(filepath=target, export_format='GLB', use_selection=False)`,
    `print('EXPORTED', target, os.path.getsize(target))`,
  ].join('\n');
  try {
    // GLB export with apply_modifiers=True subdivides/bevels/displaces the whole
    // scene, so it can exceed the normal 15s bpy budget — give it a generous one.
    const r = await runLiveBpy(code, 120_000);
    if (!r.ok) {
      let reason = 'export bpy error';
      if (r.mode === 'no-blender') reason = 'no live Blender open';
      const detail = r.result && typeof r.result === 'object' ? (r.result as { error?: string }).error : undefined;
      return { ok: false, path: outPath, error: reason, detail: detail ? detail.slice(0, 300) : JSON.stringify(r.result).slice(0, 300) };
    }
    const fs = await import('node:fs');
    const exists = fs.existsSync(outPath) && fs.statSync(outPath).size > 0;
    if (!exists) return { ok: false, path: outPath, error: 'GLB file not produced', detail: 'export ran but no file at /tmp/jarv_blender_preview.glb' };
    return { ok: true, path: outPath };
  } catch (err) {
    return { ok: false, path: outPath, error: err instanceof Error ? err.message : String(err) };
  }
}

/** One-shot convenience for tests: run with a stubbed producer already wired. */
export async function runBlenderShell(config: JarvGenieConfig, script: string): Promise<{ ok: boolean; output: string }> {  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const fs = await import('node:fs');
  const execFileAsync = promisify(execFile);
  // Locate the Blender binary: prefer PATH, then the macOS /Applications location.
  let blenderBin = 'blender';
  if (!await commandOnPath('blender')) {
    for (const p of ['/Applications/Blender.app/Contents/MacOS/Blender', '/Applications/Blender.app/Contents/MacOS/blender']) {
      if (fs.existsSync(p)) { blenderBin = p; break; }
    }
  }
  try {
    const res = await execFileAsync(blenderBin, ['--background', '--python-expr', script], { timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
    return { ok: true, output: res.stdout.trim() };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    return { ok: false, output: ((e.stdout ?? '') + (e.stderr ?? '')).slice(0, 2000) };
  }
}

async function commandOnPath(cmd: string): Promise<boolean> {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execFileAsync = promisify(execFile);
  try {
    await execFileAsync('which', [cmd]);
    return true;
  } catch {
    return false;
  }
}
