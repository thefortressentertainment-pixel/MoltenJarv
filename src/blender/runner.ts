import type { ToolDefinition, ToolCall, ChatMessage } from '../agent/types.js';
import type { ModelRouter } from '../providers/index.js';
import { ToolRegistry } from '../tools/registry.js';
import { systemTools } from '../tools/system.js';
import { fileTools } from '../tools/filesystem.js';
import { webTools } from '../tools/web.js';
import { extractTextToolCalls } from '../agent/agent.js';
import type { JarvGenieConfig } from '../config/index.js';
import { describeToSpec } from './reference.js';
import { loadBlenderSnapshot, renderBlenderSnapshot, saveBlenderSnapshot } from './state.js';

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
 *  - A fresh, isolated ModelRouter pointed at the SMALL local model (qwen2.5:0.5b)
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
  'bpy_reference',
  'file_read', 'file_write', 'file_list', 'file_delete',
  'web_search', 'web_read',
  'screen_capture',
]);

/** Read the live Blender bridge state written by the add-on, if Blender is open. */
export async function liveBridgeState(): Promise<{ live: boolean; port: number } | null> {
  try {
    const fs = await import('node:fs/promises');
    const home = process.env.HOME ?? '/';
    const raw = await fs.readFile(home + '/.jarv-genie/blender-state.json', 'utf8');
    const s = JSON.parse(raw) as { live?: boolean; port?: number | null };
    return { live: s.live === true, port: Number(s.port ?? 3937) };
  } catch {
    return null;
  }
}

/** Execute bpy code against the LIVE open Blender scene (via the add-on bridge),
 *  or fall back to headless if no Blender is live. Returns a Jarv-friendly result. */
export async function runLiveBpy(code: string): Promise<{ ok: boolean; result: unknown; mode: 'live' | 'headless' | 'no-blender' }> {
  const state = await liveBridgeState();
  if (state?.live) {
    try {
      const res = await fetch(`http://127.0.0.1:${state.port}/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
        // Short timeout so a bridge whose main-thread timer isn't firing (e.g.
        // Blender in --background, or a wedged session) can't hang the runner for
        // the full 60s the add-on handler would otherwise block.
        signal: AbortSignal.timeout(15_000),
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
        const res = r.result as { objects?: Array<{ name: string; type?: string; location?: number[]; bounds?: number[][] }> };
        if (res.objects) {
          try { void saveBlenderSnapshot(res.objects); } catch { /* best-effort */ }
        }
      }
      return { ok: r.ok, mode: r.mode, result: r.result };
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

COLOR (apply the described colors — this must not be skipped):
- When the prompt names any color/material (red, blue, green, gold, wood, pine, oak, metal), the FINALIZE material you apply MUST be that color. A "red cube" is RED. Use the named color map in the FINALIZE snippet and set base_rgb = named['<that word>'].
- Do not default to a neutral gray when a color word is present — the gray auto-shade is only a fallback for when NO color was mentioned.

CHARACTERS & COMPLEX MODELS (when the task is a named character, creature, or multi-part object):
- Break it into NAMED, PARENTED parts you can refine later: e.g. "Torso", "Head", "L_UpperArm", "L_Forearm", "L_Hand", (mirror for R_...), "Pelvis", "L_Thigh", "L_Calf", "L_Foot". Parent each limb part to the part above it (forearm → upper arm; calf → thigh) and all to one root "Root".
- Thickness + proportion matter more than count: joints should be wider, limbs taper, no part is a bare 2D box. Use cylinders/beveled boxes for limbs, spheres/flattened spheres for joints.
- Keep ALL part names stable across prompts so the user can say "make L_Forearm thicker" and you modify exactly that named object — never recreate it.
- Plant the figure on the ground (Z=0) and give a neutral standing or described pose via bone/part rotation — do not split the figure into disconnected floating pieces.
- REFINE, don't rebuild: on a follow-up prompt ("now make the head bigger"), edit the existing named part(s) by name, never delete the whole character to start over.

GENERAL:
- REFERENCE IMAGE IS OPTIONAL, NOT REQUIRED. You do NOT need an image to build. By default, build from your OWN knowledge + the user's free-text description (e.g. "a sturdy pine workbench, thick top, 4 legs"). Use bpy_reference ONLY when the user explicitly gives an absolute image path (e.g. "/Users/.../wreath.jpg") or says "make it look like this picture" — then call it FIRST to extract proportions, then build with bpy_exec.
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
      router.setPrimaryModel('qwen2.5:0.5b');
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

/** Build a scoped registry holding only Blender tools. */
export function blenderToolRegistry(config: JarvGenieConfig): ToolRegistry {
  const registry = new ToolRegistry();
  const all: ToolDefinition[] = [
    ...systemTools(),
    ...fileTools(),
    ...webTools(),
    bpyExecTool(config),
    bpyReferenceTool(config),
  ];
  const scoped = all.filter((t) => BLENDER_TOOL_NAMES.has(t.name));
  registry.registerMany(scoped);
  return registry;
}

/** Run the Blender task through the minimal, RAM-bounded loop. */
export async function runBlenderTask(config: JarvGenieConfig, input: BlenderRunInput): Promise<BlenderRunResult> {
  const forceLocal = input.local === true;
  const router = await newBlenderRouter(config, forceLocal);
  // Track whether we ended up on the small local model (qwen2.5:0.5b) or a cloud
  // primary. The isolation (tiny toolset + no memory) is what prevents the wheel;
  // the model choice affects capability, not RAM-at-rest.
  let usedLocal = forceLocal || String(input.model ?? '').includes('0.5b');
  const registry = blenderToolRegistry(config);
  const tools = registry.list();
  const toolNames = tools.map((t) => t.name);
  const maxSteps = Math.min(input.maxSteps ?? 14, 16);

  const today = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  // Inject the persisted Blender named-parts snapshot so a follow-up prompt
  // "remembers" the current build and refines it by name (isolated to the runner).
  const snapshot = await loadBlenderSnapshot();
  const snapshotHint = renderBlenderSnapshot(snapshot);
  const userMessage = snapshotHint ? `${input.message}\n\n${snapshotHint}` : input.message;
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
    if (String(chat.model).includes('0.5b') || String(chat.model).includes('llama')) usedLocal = true;
    messages.push({ role: 'assistant', content: chat.content, toolCalls: chat.toolCalls ?? undefined });

    const textCalls = chat.toolCalls ?? extractTextToolCalls(chat.content ?? '', toolNames).map((e, i) => ({ id: `text-${i}`, name: e.name, arguments: e.args }));
    const calls: ToolCall[] = Array.isArray(chat.toolCalls) ? chat.toolCalls : textCalls;
    if (calls.length === 0) {
      // Final answer.
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

  return { text: `Reached the ${maxSteps}-step budget for this Blender task; background work may continue. For more, split the request.`, steps, toolCalls, provider, model, local: usedLocal };
}

/** One-shot convenience for tests: run with a stubbed producer already wired. */
export async function runBlenderShell(config: JarvGenieConfig, script: string): Promise<{ ok: boolean; output: string }> {
  const { execFile } = await import('node:child_process');
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
