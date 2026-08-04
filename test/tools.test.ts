import assert from 'node:assert';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { timeTools } from '../src/tools/time.js';
import { fileTools } from '../src/tools/filesystem.js';
import { memoryTools } from '../src/tools/memory.js';
import { computerTools } from '../src/tools/computer.js';
import { ToolRegistry } from '../src/tools/registry.js';
import type { ToolContext } from '../src/agent/types.js';

function makeContext(workdir: string): ToolContext {
  return { workdir, config: {}, memory: {} } as unknown as ToolContext;
}

test('timeTools get_datetime returns expected shape', async () => {
  const tool = timeTools().find((t) => t.name === 'get_datetime');
  assert.ok(tool);
  const result = await tool.handler({}, makeContext('/tmp'));
  assert.strictEqual(typeof result.iso, 'string');
  assert.strictEqual(typeof result.date, 'string');
  assert.strictEqual(typeof result.unix, 'number');
});

test('fileTools sandbox blocks path escapes', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'jarv-fs-'));
  try {
    const tools = fileTools();
    const read = tools.find((t) => t.name === 'file_read')!;
    await assert.rejects(read.handler({ path: '../outside.txt' }, makeContext(dir)));
    await assert.rejects(read.handler({ path: '/etc/passwd' }, makeContext(dir)));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('fileTools write/read/list/delete round-trip', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'jarv-fs-'));
  try {
    const tools = fileTools();
    const write = tools.find((t) => t.name === 'file_write')!;
    const read = tools.find((t) => t.name === 'file_read')!;
    const list = tools.find((t) => t.name === 'file_list')!;
    const del = tools.find((t) => t.name === 'file_delete')!;
    const ctx = makeContext(dir);

    const w = await write.handler({ path: 'notes/hello.txt', content: 'hi' }, ctx);
    assert.strictEqual(w.bytes, 2);
    assert.strictEqual(await readFile(path.join(dir, 'notes/hello.txt'), 'utf8'), 'hi');

    const r = await read.handler({ path: 'notes/hello.txt' }, ctx);
    assert.strictEqual(r.text, 'hi');

    const l = await list.handler({ path: 'notes' }, ctx);
    assert.strictEqual(l.entries.length, 1);
    assert.strictEqual(l.entries[0]?.name, 'hello.txt');

    const d = await del.handler({ path: 'notes/hello.txt' }, ctx);
    assert.strictEqual(d.deleted, 'notes/hello.txt');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('memoryTools and registry round-trip', async () => {
  const facts: { text: string; id: string }[] = [];
  const fakeMemory = {
    addFact: async (text: string) => {
      const f = { text, id: `id-${facts.length}` };
      facts.push(f);
      return f;
    },
    recall: async () => facts.map((f) => ({ fact: f, score: 1 })),
    listFacts: async () => facts,
    deleteFact: async () => true,
  };

  const registry = new ToolRegistry();
  registry.registerMany(memoryTools());
  assert.ok(registry.has('remember'));
  assert.ok(registry.has('recall'));

  const ctx = { workdir: '/tmp', config: {}, memory: fakeMemory } as unknown as ToolContext;
  const res = await registry.execute('remember', { text: 'prefer tea over coffee' }, ctx);
  assert.ok(res.ok);
  assert.strictEqual(facts.length, 1);

  const recall = await registry.execute('recall', { query: 'tea' }, ctx);
  assert.ok(recall.ok);
  assert.strictEqual(recall.result.length, 1);

  const missing = await registry.execute('nope', {}, ctx);
  assert.strictEqual(missing.ok, false);
});

test('computerTools gate control actions behind allowControl', async () => {
  const tools = computerTools();
  const as = tools.find((t) => t.name === 'run_apple_script')!;
  assert.ok(as);

  const locked = await as.handler({ script: 'say "hi"' }, makeContext('/tmp'));
  assert.strictEqual(locked.ok, false);
  assert.match(locked.error, /approval required/);

  const cfg = { computer: { allowControl: true } };
  const ctx = { workdir: '/tmp', config: cfg } as unknown as ToolContext;
  const result = await as.handler({ script: '1 + 1' }, ctx);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.output.trim(), '2');

  const app = tools.find((t) => t.name === 'open_app')!;
  const oldNoOpen = process.env.JARV_GENIE_NO_OPEN;
  process.env.JARV_GENIE_NO_OPEN = '1';
  const opened = await app.handler({ app: 'Calculator' }, makeContext('/tmp'));
  if (oldNoOpen === undefined) delete process.env.JARV_GENIE_NO_OPEN;
  else process.env.JARV_GENIE_NO_OPEN = oldNoOpen;
  assert.strictEqual(opened.ok, true);
});
