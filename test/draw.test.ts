import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { drawTools } from '../src/tools/draw.js';
import type { ToolContext } from '../src/agent/types.js';

function withHome(fn: () => Promise<void>): Promise<void> {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'jarv-draw-'));
  const oldHome = process.env.HOME;
  process.env.HOME = dir;
  return fn().finally(() => {
    process.env.HOME = oldHome ?? '';
    rmSync(dir, { recursive: true, force: true });
  });
}

const ctx = { config: {}, memory: {}, workdir: '/' } as unknown as ToolContext;

test('draw_shape validates the shape and is consequential', () => {
  const tool = drawTools().find((t) => t.name === 'draw_shape')!;
  assert.ok(tool);
  assert.strictEqual(tool.consequential, true);
});

test('draw_shape rejects unsupported shapes', async () => {
  const tool = drawTools().find((t) => t.name === 'draw_shape')!;
  const res = (await tool.handler({ shape: 'dodecahedron' }, ctx)) as { ok: boolean; error?: string };
  assert.strictEqual(res.ok, false);
  assert.match(res.error ?? '', /unsupported shape/);
});

test('draw_shape generates a square PNG with ImageMagick', async () => {
  await withHome(async () => {
    const tool = drawTools().find((t) => t.name === 'draw_shape')!;
    const res = (await tool.handler({ shape: 'square', size: 128, color: '#00ff00' }, ctx)) as {
      ok: boolean;
      savedTo?: string;
      error?: string;
    };
    assert.strictEqual(res.ok, true, res.error);
    assert.ok(res.savedTo);
    const fs = await import('node:fs');
    assert.ok(fs.existsSync(res.savedTo!), 'png file was created');
  });
});
