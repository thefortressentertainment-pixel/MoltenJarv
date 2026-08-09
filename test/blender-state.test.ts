import assert from 'node:assert';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { loadBlenderSnapshot, renderBlenderSnapshot, saveBlenderSnapshot, snapshotFile } from '../src/blender/state.js';
import { loadProjectNotes, renderProjectContext, recordProjectNote } from '../src/blender/state.js';

// Point the module at a temp HOME so tests are isolated and don't touch the real
// ~/.jarv-genie/blender/snapshot.json.
function withHome(dir: string, fn: () => Promise<void>): Promise<void> {
  const prev = process.env.HOME;
  process.env.HOME = dir;
  return fn().finally(() => { process.env.HOME = prev; });
}

test('save + load round-trips named parts to the Blender-scoped snapshot file', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'jarv-bstate-'));
  try {
    await withHome(dir, async () => {
      await mkdir(path.join(dir, '.jarv-genie', 'blender'), { recursive: true });
      const objects = [
        { name: 'Root', type: 'EMPTY', location: [0, 0, 0], bounds: null },
        { name: 'Torso', type: 'MESH', location: [0, 0, 1], bounds: [[-1, -1, 0], [1, 1, 2]] },
        { name: 'Head', type: 'MESH', location: [0, 0, 2.4], bounds: [[-0.5, -0.5, 2], [0.5, 0.5, 2.8]] },
      ];
      const n = await saveBlenderSnapshot(objects as never);
      assert.strictEqual(n, 3);
      // The file lives under .jarv-genie/blender/, NOT memory/ (isolation).
      assert.ok(snapshotFile().includes(path.join('.jarv-genie', 'blender')));
      const snap = await loadBlenderSnapshot();
      assert.ok(snap);
      assert.strictEqual(snap!.parts.length, 3);
      assert.strictEqual(snap!.parts[1]!.name, 'Torso');
      assert.deepStrictEqual(snap!.parts[2]!.location, [0, 0, 2.4]);
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('load returns null on a missing snapshot (no file yet)', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'jarv-bstate-'));
  try {
    await withHome(dir, async () => {
      assert.strictEqual(await loadBlenderSnapshot(), null);
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('renderBlenderSnapshot produces a terse refine hint; empty when none', () => {
  const snap = {
    updatedAt: new Date().toISOString(),
    parts: [
      { name: 'Root', type: 'EMPTY', parent: null, location: [], bounds: null },
      { name: 'Torso', type: 'MESH', parent: 'Root', location: [], bounds: null },
    ],
  };
  const text = renderBlenderSnapshot(snap);
  assert.match(text, /Root|Torso/);
  assert.match(text, /child-of/);
  assert.match(text, /REFINE these by name; never delete/);
  assert.strictEqual(renderBlenderSnapshot(null), '');
  assert.strictEqual(renderBlenderSnapshot({ updatedAt: 'x', parts: [] }), '');
});

test('snapshot is isolated from Jarv memory: parents map and note are kept', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'jarv-bstate-'));
  try {
    await withHome(dir, async () => {
      await mkdir(path.join(dir, '.jarv-genie', 'blender'), { recursive: true });
      await saveBlenderSnapshot(
        [{ name: 'L_Forearm', type: 'MESH', location: [1, 0, 1], bounds: null }],
        { L_Forearm: 'L_UpperArm' },
        'Valtherion base model in progress',
      );
      const snap = await loadBlenderSnapshot();
      assert.strictEqual(snap!.parts[0]!.parent, 'L_UpperArm');
      assert.strictEqual(snap!.note, 'Valtherion base model in progress');
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('self-learning log records projects and renders a de-reuse hint (isolated, capped)', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'jarv-bproj-'));
  try {
    await withHome(dir, async () => {
      await recordProjectNote({ prompt: 'build a green orc', reference: '/a/orc.jpg', objectName: 'Crafted', outcome: 'worked well at octree 192' });
      await recordProjectNote({ prompt: 'build a green orc', reference: '/a/orc.jpg', objectName: 'Crafted' }); // same project -> upsert
      await recordProjectNote({ prompt: 'build a wizard', reference: '/a/wizard.jpg', objectName: 'Wizard' });
      const notes = await loadProjectNotes();
      assert.strictEqual(notes.length, 2, 'orc upserted, wizard added');
      const orc = notes.find((n) => n.prompt.includes('orc'))!;
      assert.strictEqual(orc.crafts, 2, 'repeated project increments crafts');
      assert.ok(notes.every((n) => n.key && n.createdAt), 'each note has key + timestamp');
      // render emits the learning hint telling Jarv not to reuse a past shape
      const hint = renderProjectContext(notes);
      assert.match(hint, /green orc/);
      assert.match(hint, /Wizard/);
      assert.match(hint, /build it fresh for THIS reference/);
      assert.strictEqual(renderProjectContext([]), '');
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
