import assert from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { loadMonitors, addMonitor, snapshotState, hasChanged, removeMonitor } from '../src/cli/monitor.js';
import { dataHome } from '../src/config/defaults.js';

function withHome(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'jarv-mon-'));
  const oldHome = process.env.HOME;
  process.env.HOME = dir;
  return fn(dir).finally(() => {
    process.env.HOME = oldHome ?? '';
    rmSync(dir, { recursive: true, force: true });
  });
}

test('dir snapshot changes when files appear or change', async () => {
  await withHome(async (dir) => {
    const watch = path.join(dir, 'watch');
    mkdirSync(watch);
    writeFileSync(path.join(watch, 'a.txt'), 'one');
    const s1 = await snapshotState('dir', watch);
    assert.ok(s1);

    const s2 = await snapshotState('dir', watch);
    assert.strictEqual(s1, s2, 'unchanged dir hashes identically');

    writeFileSync(path.join(watch, 'b.txt'), 'two');
    const s3 = await snapshotState('dir', watch);
    assert.notStrictEqual(s1, s3, 'new file changes the hash');
  });
});

test('metric snapshot hashes command output', async () => {
  await withHome(async () => {
    const a = await snapshotState('metric', 'echo hello');
    const b = await snapshotState('metric', 'echo hello');
    assert.strictEqual(a, b);
    const c = await snapshotState('metric', 'echo changed');
    assert.notStrictEqual(a, c);
    assert.strictEqual(await snapshotState('metric', 'exit 1'), null, 'failing command yields null');
  });
});

test('web snapshot hashes page content', async () => {
  const server = http.createServer((_req, res) => {
    res.end('page-v1');
  });
  await new Promise<void>((r) => server.listen(0, r));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  try {
    assert.ok(await snapshotState('web', url));
    assert.strictEqual(await snapshotState('web', url), await snapshotState('web', url));
    assert.strictEqual(await snapshotState('web', 'http://127.0.0.1:1/nope'), null);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test('monitors persist, list, and fire on change via hasChanged', async () => {
  await withHome(async (dir) => {
    const watch = path.join(dir, 'watch');
    mkdirSync(watch);
    writeFileSync(path.join(watch, 'a.txt'), 'one');
    await addMonitor('dir', watch, 'summarize changes', { every: 10, notify: true });

    const cfg = loadMonitors();
    assert.strictEqual(cfg.monitors.length, 1);
    const m = cfg.monitors[0]!;
    assert.strictEqual(m.kind, 'dir');
    assert.strictEqual(m.every, 10);

    assert.strictEqual(await hasChanged(m), false, 'no change since snapshot');

    writeFileSync(path.join(watch, 'a.txt'), 'two');
    assert.strictEqual(await hasChanged(m), true, 'content change fires the monitor');

    removeMonitor(m.id);
    assert.strictEqual(loadMonitors().monitors.length, 0);
  });
});

test('monitors.json lives under the overridden data home', async () => {
  await withHome(async (dir) => {
    const p = path.join(dataHome(), 'monitors.json');
    assert.ok(p.startsWith(dir), `expected data home under ${dir}, got ${p}`);
    assert.ok(p.endsWith(path.join('.jarv-genie', 'monitors.json')));
  });
});
