import assert from 'node:assert';
import path from 'node:path';
import { test } from 'node:test';
import { craftRoot, craftBinary, craftShapeWeights, craftGlbPath, craftMetallib } from '../src/blender/craft.js';

test('craft paths are isolated under ~/.jarv-genie/craft/', () => {
  const root = craftRoot();
  assert.ok(path.normalize(root).endsWith(path.join('.jarv-genie', 'craft')), 'craft root under ~/.jarv-genie/craft');
  assert.ok(craftBinary().startsWith(root), 'binary inside craft root');
  assert.ok(craftShapeWeights().startsWith(root), 'weights inside craft root');
  assert.ok(craftGlbPath().endsWith('jarv_crafted.glb'), 'craft outputs a predictable GLB path');
});

test('craft is not ready when no binary/weights installed', async () => {
  const prev = process.env.HOME;
  // Point HOME at a temp dir with no craft install → must report not-ready (no throw).
  const { mkdtemp } = await import('node:fs/promises');
  const osMod = await import('node:os');
  const dir = await mkdtemp(path.join(osMod.tmpdir(), 'jarv-craft-'));
  process.env.HOME = dir;
  try {
    const { craftReady } = await import('../src/blender/craft.js');
    const ready = await craftReady();
    assert.strictEqual(ready, false, 'no craft install → not ready');
  } finally {
    process.env.HOME = prev;
    const { rm } = await import('node:fs/promises');
    await rm(dir, { recursive: true, force: true });
  }
});

test('craftGlbPath is a stable absolute path', () => {
  assert.ok(path.isAbsolute(craftGlbPath()), 'GLB path absolute');
});

test('craftMetallib is colocated with the hy3d binary in the craft root', () => {
  assert.ok(craftMetallib().startsWith(craftRoot()), 'metallib in craft root');
  assert.strictEqual(path.basename(craftMetallib()), 'mlx.metallib');
});
