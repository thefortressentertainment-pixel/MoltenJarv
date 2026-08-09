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

// ---------------------------------------------------------------------------
// Blender "self-learning" log (isolated, per-project, RAM-light)
//
// A durable note of what 3D objects/characters Jarv has already built and *how*
// (reference + what worked). Kept in ~/.jarv-genie/blender/projects.json — the
// SAME isolation boundary as the snapshot/spec-cache — so it NEVER bleeds into
// Jarv's general memory/reviews/agent. Its only consumer is the Blender runner.
// This lets Jarv recall prior models so it (a) doesn't recreate a past character
// verbatim and (b) carries forward "what worked" for better renders.
// ---------------------------------------------------------------------------

export interface BlenderProjectNote {
  key: string;            // stable id (hash of prompt+reference, or prompt slug)
  prompt: string;         // the original build/craft prompt (truncated)
  reference?: string;     // reference image path if any
  objectName?: string;    // the object/mesh produced
  verts?: number;         // mesh size
  outcome?: string;       // short "what worked / what didn't"
  createdAt: string;
  updatedAt: string;
  crafts: number;         // how many times this project was produced
}

const PROJECTS_FILE = 'projects.json';

function projectsFile(): string {
  return path.join(snapshotDir(), PROJECTS_FILE);
}

function stabilityKey(prompt: string, reference?: string): string {
  const src = `${(prompt || '').trim().toLowerCase().slice(0, 80)}|${reference ?? ''}`;
  let h = 0;
  for (let i = 0; i < src.length; i++) h = (h * 31 + src.charCodeAt(i)) | 0;
  return 'p' + (h >>> 0).toString(16);
}

export async function loadProjectNotes(): Promise<BlenderProjectNote[]> {
  try {
    const raw = await fs.readFile(projectsFile(), 'utf8');
    const arr = JSON.parse(raw) as BlenderProjectNote[];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

/** Record/refresh a project note (upsert by stable key). Best-effort, never throws. */
export async function recordProjectNote(note: {
  prompt: string;
  reference?: string;
  objectName?: string;
  verts?: number;
  outcome?: string;
}): Promise<void> {
  try {
    const key = stabilityKey(note.prompt, note.reference);
    const notes = await loadProjectNotes();
    const now = new Date().toISOString();
    const existing = notes.find((n) => n.key === key);
    if (existing) {
      existing.updatedAt = now;
      existing.crafts += 1;
      if (note.outcome) existing.outcome = note.outcome;
      if (note.objectName) existing.objectName = note.objectName;
      if (note.verts) existing.verts = note.verts;
    } else {
      notes.push({
        key,
        prompt: note.prompt.slice(0, 200),
        reference: note.reference,
        objectName: note.objectName,
        verts: note.verts,
        outcome: note.outcome,
        createdAt: now,
        updatedAt: now,
        crafts: 1,
      });
    }
    // Cap the log so it stays tiny (~50 projects).
    const capped = notes.slice(-50);
    await fs.mkdir(snapshotDir(), { recursive: true });
    await fs.writeFile(projectsFile(), JSON.stringify(capped, null, 2) + '\n', 'utf8');
  } catch {
    /* best-effort */
  }
}

/** A short hint telling Jarv what it has already built (to avoid verbatim reuse and
 *  to carry forward lessons). Empty when no prior projects are recorded. */
export function renderProjectContext(notes: BlenderProjectNote[]): string {
  if (!notes || notes.length === 0) return '';
  const lines = notes
    .slice(-8)
    .map((n) => `- "${n.prompt.slice(0, 60)}"${n.objectName ? ` -> ${n.objectName}` : ''}${n.reference ? ` (ref: ${n.reference})` : ''}${n.outcome ? ` [${n.outcome}]` : ''}`)
    .join('\n');
  return (
    `\n[Blender learning log — models you have ALREADY built across past projects]\n${lines}\n` +
    `If THIS request is a NEW character/model, build it fresh for THIS reference and do NOT reuse/re-arrange a past shape. If it's the SAME project, refine its existing object by name. This keeps each new character true to its own source rather than recreating an earlier one.`
  );
}
