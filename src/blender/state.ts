import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Blender-runner snapshot — named-parts memory for ITERATIVE refinement, fully
 * isolated to the Blender runner (NO bleed into Jarv's general agent/memory).
 *
 * Jarv's live bridge returns per-object spatial metadata (name, type, location,
 * bounds). This store records the NAMED parented parts of the current Blender
 * build to a dedicated file (`~/.jarv-genie/blender/snapshot.json`) so a follow-up
 * prompt can say "make L_Forearm thicker" and Jarv knows precisely which part to
 * edit — without deleting/remaking it.
 *
 * Deliberately SEPARATE from Jarv's shared memory/reviews: it is written under
 * `~/.jarv-genie/blender/`, not `~/.jarv-genie/memory/`, and the only consumer is
 * the Blender runner's task context. Nothing here touches `recall()`, facts, or
 * the general agent loop.
 */

export interface BlenderPart {
  name: string;
  type: string;
  parent: string | null;
  location: number[];
  bounds: number[][] | null;
}

export interface BlenderSnapshot {
  updatedAt: string;
  parts: BlenderPart[];
  /** Small notes the runner can seed back (e.g. what was built last). */
  note?: string;
}

function snapshotDir(): string {
  return path.join(process.env.HOME ?? '/', '.jarv-genie', 'blender');
}

export function snapshotFile(): string {
  return path.join(snapshotDir(), 'snapshot.json');
}

/** Load the persisted named-parts snapshot. Returns null when none yet (or it's
 *  not a Blender session file). */
export async function loadBlenderSnapshot(): Promise<BlenderSnapshot | null> {
  try {
    const raw = await fs.readFile(snapshotFile(), 'utf8');
    const parsed = JSON.parse(raw) as BlenderSnapshot;
    if (parsed && Array.isArray(parsed.parts)) return parsed;
    return null;
  } catch {
    return null;
  }
}

/**
 * Persist named parts extracted from a bpy_exec result. Pass the bridge's
 * `objects` array (each `{name,type,location,bounds}`). Parts are written to the
 * Blender-scoped snapshot file. Best-effort (never throws). Returns size or 0.
 */
export async function saveBlenderSnapshot(
  objects: Array<{ name: string; type?: string; location?: number[]; bounds?: number[][] }>,
  parents?: Record<string, string>,
  note?: string,
): Promise<number> {
  try {
    const parts: BlenderPart[] = (objects ?? [])
      .filter((o) => o && typeof o.name === 'string')
      .map((o) => ({
        name: o.name,
        type: String(o.type ?? 'OBJECT'),
        parent: (parents && parents[o.name!]) ?? null,
        location: Array.isArray(o.location) ? o.location.map(Number) : [],
        bounds: Array.isArray(o.bounds) ? o.bounds : null,
      }));
    const snap: BlenderSnapshot = { updatedAt: new Date().toISOString(), parts, note };
    await fs.mkdir(snapshotDir(), { recursive: true });
    await fs.writeFile(snapshotFile(), JSON.stringify(snap, null, 2) + '\n', 'utf8');
    return parts.length;
  } catch {
    return 0;
  }
}

/** Render the snapshot as a short, terse hint the runner injects into the next
 *  prompt so the model "remembers" its named parts. Empty string when none. */
export function renderBlenderSnapshot(snap: BlenderSnapshot | null): string {
  if (!snap || snap.parts.length === 0) return '';
  const lines = snap.parts
    .slice(0, 60)
    .map((p) => `${p.name} (${p.type}${p.parent ? ` child-of ${p.parent}` : ''})`);
  return `\nYou are CONTINUING work on this existing Blender build. Current named objects in the scene:\n${lines.join('\n')}\nREFINE these by name; never delete/recreate them. Only clear when the user explicitly says start over.`;
}
