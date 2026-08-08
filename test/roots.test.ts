import assert from 'node:assert';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { buildRoots, underAnyRoot, underWritableRoot, renderRootsBoundary, makeRootsHandle } from '../src/roots.js';
import { fileTools } from '../src/tools/filesystem.js';
import type { ToolContext } from '../src/agent/types.js';

async function tmp(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), 'jarv-roots-'));
}

test('buildRoots marks the workspace writable and read roots read-only', async () => {
  const dir = await tmp();
  try {
    const roots = buildRoots({ workdir: path.join(dir, 'work'), readRoots: [path.join(dir, 'refs')] });
    const work = roots.roots.find((r) => r.path === path.resolve(path.join(dir, 'work')))!;
    const refs = roots.roots.find((r) => r.path === path.resolve(path.join(dir, 'refs')))!;
    assert.ok(work?.writable);
    assert.strictEqual(refs?.writable, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('underWritableRoot is true inside the workspace and false elsewhere', async () => {
  const dir = await tmp();
  try {
    const roots = buildRoots({ workdir: path.join(dir, 'work'), readRoots: [path.join(dir, 'refs')] });
    assert.ok(underWritableRoot(roots, path.join(dir, 'work', 'a.txt')));
    assert.strictEqual(underWritableRoot(roots, path.join(dir, 'refs', 'a.txt')), false);
    assert.ok(underAnyRoot(roots, path.join(dir, 'refs', 'a.txt')), 'read roots still readable');
    // Path traversal does not escape.
    assert.strictEqual(underAnyRoot(roots, path.join(dir, 'work', '..', 'outside.txt')), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('renderRootsBoundary names the roots and their writability', async () => {
  const dir = await tmp();
  try {
    const roots = buildRoots({ workdir: path.join(dir, 'work') });
    const text = renderRootsBoundary(roots);
    assert.match(text, /work/);
    assert.match(text, /writable/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('file_write is refused outside a writable root when roots are attached', async () => {
  const dir = await tmp();
  await mkdir(path.join(dir, 'work'));
  try {
    const write = fileTools().find((t) => t.name === 'file_write')!;
    const handle = makeRootsHandle({ workdir: path.join(dir, 'work') });
    const ctx = { workdir: path.join(dir, 'work'), config: { agent: { workdir: path.join(dir, 'work') } }, memory: {}, roots: handle } as unknown as ToolContext;
    // Writing inside the workspace works...
    const okRes = await write.handler({ path: 'ok.txt', content: 'hi' }, ctx);
    assert.strictEqual(okRes.bytes, 2);
    // ...but an escape through a sibling path is refused (safeResolve already rejects ../).
    await assert.rejects(write.handler({ path: '../outside.txt', content: 'x' }, ctx));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
