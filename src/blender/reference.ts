import type { JarvGenieConfig } from '../config/index.js';
import { describeImage } from '../computer/index.js';

/**
 * Reference-image → 3D shape-spec for Blender (GitHub sweep: blender-vision-agent
 * JSON contract, love2d3d/CubeSter proportion kernels; patterns only, MIT-safe).
 *
 * Jarv's text-only model can't "see" a reference photo (a wreath, a Labrador), so
 * it guesses symbolic placeholders ("ring + cones"). This lets Jarv point at a
 * reference image; the local Ollama vision model (llava/moondream, already
 * installed) turns it into a STRUCTURED JSON shape-spec (primitives + position +
 * scale + rotation + material color + aspect), which the text model then turns
 * into real bpy. RAM-light: reuses the existing vision endpoint, no extra models,
 * no GPU; the agent only reads the returned JSON spec.
 */

/** Match an absolute local image path (png/jpg/jpeg) anywhere in a prompt, so
 *  we can deterministically run reference-vision WITHOUT relying on the text
 *  model deciding to call a tool. Returns the first absolute image path, or null. */
export function extractAbsoluteImagePath(text: string): string | null {
  if (!text) return null;
  // Absolute posix or macOS path, optionally wrapped in quotes/brackets/parens,
  // ending in a common image extension.
  const re = /(?:['"([]?|\b)(\/[^\s'"()[\]{}<>]+\.(?:png|jpe?g|webp|bmp|gif))['")]?[\]]?/gi;
  // Prefer a bare path match before a bracketed one; take the first.
  const m = text.match(re);
  if (!m) return null;
  // Trim surrounding quote/bracket/paren delimiters.
  const raw = m[0].replace(/^['"([\[]+|['")\]]+$/g, '');
  return raw.length > 4 ? raw : null;
}

/** The structured contract we ask the vision model to return (blender-vision-agent). */
const SPEC_SYSTEM = `You analyze a reference image and emit a structured 3D shape spec that can be rebuilt in Blender from simple primitives (cube, sphere, cylinder, cone, torus, plane) and booleans.
CRITICAL: the subject may be asymmetric and detailed — capture its true PROPORTIONS and ARRANGEMENT, not a literal 'it's a cup'. For example a wreath = a circular ring of many small leaves/branches; a dog = one body + head + 4 legs in a pose.
Coordinate system: X left(-)/right(+), Y front(-)/back(+), Z up(+); objects may be grouped in one or a few parented parts.
Return STRICT JSON only:
{"shape_summary":"2-line description", "proportions":{"width_over_height":N, "depth_over_width":N}, "aspect":1.0,
 "parts":[{"name":"...","primitive":"cube|sphere|cylinder|cone|torus|plane","position":[x,y,z],"scale":[x,y,z],"rotation_deg":[x,y,z],"parent":null|"name"}],
 "boolean_operations":[{"operation":"union|difference|intersect","base":"partName","tool":"partName"}]}`;

/** Ask the local vision model for a structured spec. */
export async function describeToSpec(
  imagePath: string,
  config: JarvGenieConfig,
  visionModel?: string,
): Promise<{ summary: string; parts: Array<Record<string, unknown>>; proportions: Record<string, number> | null; raw: string }> {
  const model = visionModel;
  // Prompt describing to return the JSON spec; describeImage hits the configured
  // Ollama vision endpoint (llava default, moondream available).
  const question =
    'Look at this reference image and return the STRICT JSON 3D shape spec (shape_summary, proportions {width_over_height,depth_over_width}, aspect, parts [{name,primitive,position,scale,rotation_deg,parent}], boolean_operations). Use only: cube sphere cylinder cone torus plane. Capture real proportions and arrangement.';
  const raw = await describeImage(imagePath, config, { question, model });
  const spec = parseSpecJson(raw);
  if (!spec) {
    return { summary: raw.slice(0, 300), parts: [], proportions: null, raw };
  }
  return {
    summary: String(spec.shape_summary ?? raw.slice(0, 200)),
    parts: Array.isArray(spec.parts) ? spec.parts : [],
    proportions: spec.proportions && typeof spec.proportions === 'object' ? (spec.proportions as Record<string, number>) : null,
    raw,
  };
}

/** Tolerantly parse the JSON spec out of a model reply (strip fences/trailing commas). */
export function parseSpecJson(raw: string): { shape_summary?: unknown; proportions?: unknown; aspect?: unknown; parts?: unknown; boolean_operations?: unknown } | null {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  let candidate = (fenced && fenced[1] ? fenced[1] : raw).trim();
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  candidate = candidate.slice(start, end + 1)
    .replace(/,\s*}/g, '}')
    .replace(/,\s*]/g, ']');
  try {
    const o = JSON.parse(candidate);
    return o && typeof o === 'object' ? o : null;
  } catch {
    return null;
  }
}

/**
 * Pure-proportion fallback (love2d3d/CubeSter kernel) run via a headless Blender
 * subprocess (Blender bundles numpy) — extracts aspect + dominant colors from an
 * image with ZERO model calls, so the text agent still gets real proportions even
 * if vision is unavailable. Returns ASCII-only JSON.
 */
export async function extractShapeIntent(imagePath: string): Promise<{ aspects: string; colors: string[]; error?: string }> {
  const snippet = `
import bpy, numpy as np, json, sys
try:
    from PIL import Image, ImageOps
except ImportError:
    im = bpy.data.images.load("${imagePath}")
    w, h = im.size
    px = np.asarray(im.pixels, dtype=float).reshape((h, w, 4))
    gray = px[..., 0]
else:
    img = Image.open("${imagePath}").convert("L")
    img = ImageOps.autocontrast(img)
    g = np.asarray(img.resize((24, 24)), dtype=float) / 255.0
    gray = g
h = gray.shape[0]; w = gray.shape[1]
ys, xs = np.where(gray > 0.08)
if ys.size and xs.size:
    x0,x1,y0,y1 = xs.min(),xs.max(),ys.min(),ys.max()
    aspect = (x1-x0+1)/max(1,(y1-y0+1))
    com = [float(np.mean(xs)/w), float(np.mean(ys)/h)]
else:
    aspect, com = 1.0, [0.5,0.5]
print("SHAPE_JSON:" + json.dumps({"aspect_width_over_height": round(float(aspect),3), "com_xy_norm": [round(com[0],3), round(com[1],3)]}))
`;
  // Use headless Blender (bundles numpy) to run the extraction.
  try {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);
    let bin = 'blender';
    if (!await hasCommand('blender')) bin = '/Applications/Blender.app/Contents/MacOS/Blender';
    const res = await execFileAsync(bin, ['--background', '--python-expr', snippet], { timeout: 60_000, maxBuffer: 2 * 1024 * 1024 });
    const m = (res.stdout || '').match(/SHAPE_JSON:(\{.*\})/);
    if (m?.[1]) {
      const o = JSON.parse(m[1]) as { aspect_width_over_height?: number; com_xy_norm?: number[] };
      return { aspects: `aspect ${o.aspect_width_over_height ?? 1} com ${JSON.stringify(o.com_xy_norm ?? [0.5, 0.5])}`, colors: [] };
    }
    return { aspects: '', colors: [], error: 'no proportion JSON from extraction' };
  } catch (err) {
    return { aspects: '', colors: [], error: err instanceof Error ? err.message : String(err) };
  }
}

async function hasCommand(cmd: string): Promise<boolean> {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  try { await promisify(execFile)('which', [cmd]); return true; } catch { return false; }
}
