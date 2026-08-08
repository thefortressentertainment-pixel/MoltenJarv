import assert from 'node:assert';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { buildMemory } from '../src/memory/index.js';
import { DreamLockFile, mergeConsolidated, parseJsonArray, runDream, shouldDream } from '../src/memory/dream.js';
import type { ModelRouter } from '../src/providers/index.js';
import type { JarvGenieConfig } from '../src/config/index.js';

function makeConfig(dir: string): JarvGenieConfig {
  return {
    memory: { dir },
    providers: { primary: { model: 'test', baseUrl: 'http://127.0.0.1:11434/v1' }, fallback: null },
    embeddings: null,
    agent: { systemPrompt: '', maxSteps: 8, workdir: dir },
    mcp: { servers: [] },
    permissions: [],
  } as unknown as JarvGenieConfig;
}

function stubRouter(content: string): ModelRouter {
  return { chat: async () => ({ content, toolCalls: null, provider: 'test', model: 'test' }) } as unknown as ModelRouter;
}

function createdDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), 'jarv-dream-'));
}

test('parseJsonArray handles fenced, bare, and invalid JSON', () => {
  assert.deepStrictEqual(parseJsonArray('["a","b"]'), ['a', 'b']);
  assert.deepStrictEqual(parseJsonArray('```json\n["x","y"]\n```'), ['x', 'y']);
  assert.strictEqual(parseJsonArray('prose [1] ok'), null); // numbers not strings
  assert.strictEqual(parseJsonArray('not json'), null);
  assert.deepStrictEqual(parseJsonArray('[]'), []);
});

test('mergeConsolidated keeps ids for unchanged fact text and mints ids for new', () => {
  const facts = [
    { id: 'a', text: 'user prefers dark mode', source: 'user', createdAt: '', updatedAt: '', accessCount: 3 },
    { id: 'b', text: 'meeting on friday', source: 'user', createdAt: '', updatedAt: '' },
  ];
  const out = mergeConsolidated(facts, ['user prefers dark mode', 'user likes oat milk weekly']);
  const kept = out.find((f) => f.text === 'user prefers dark mode');
  assert.strictEqual(kept?.id, 'a', 'unchanged text preserves id');
  assert.strictEqual(kept?.accessCount, 3, 'kept fact preserves its rehearsal counters');
  const minted = out.find((f) => f.text === 'user likes oat milk weekly');
  assert.ok(minted && minted.id !== 'a' && minted.id !== 'b', 'new fact gets a fresh id');
});

test('shouldDream gates on disabled, time, and fact count', async () => {
  const dir = await createdDir();
  const lock = new DreamLockFile(path.join(dir, '.dream-lock'));
  const facts = [
    { id: '1', text: 'x', source: 'user', createdAt: new Date(Date.now() - 86400000).toISOString(), updatedAt: '' },
  ];
  const disabled = await shouldDream(lock, facts, { enabled: false, minCount: 1, minAgeMs: 0 });
  assert.strictEqual(disabled.go, false);

  const tooFew = await shouldDream(lock, facts, { enabled: true, minCount: 5, minAgeMs: 0 });
  assert.strictEqual(tooFew.go, false);

  // Stamp a fresh lock so the time gate trips.
  assert.ok(await lock.acquire(600000));
  await lock.stamp();
  const tooSoon = await shouldDream(lock, facts, { enabled: true, minCount: 1, minHours: 6, minAgeMs: 0 });
  assert.strictEqual(tooSoon.go, false);
  await lock.release();
});

test('runDream rewrites the store from the model JSON output', async () => {
  const dir = await createdDir();
  const mem = buildMemory(makeConfig(dir));
  await mem.addFact('user prefers dark mode');
  await mem.addFact('meeting on friday');
  await mem.addFact('buy oat milk');

  const modelOut = JSON.stringify([
    'user prefers dark mode',
    'meeting on friday',
    'grocery: user likes oat milk weekly',
  ]);
  const result = await runDream(mem, stubRouter(modelOut), makeConfig(dir), {
    enabled: true, minCount: 1, minHours: 0, minAgeMs: 0,
  });
  assert.strictEqual(result.ran, true);
  assert.strictEqual(result.before, 3);
  assert.strictEqual(result.after, 3);
  const after = await mem.listFacts();
  assert.ok(after.some((f) => f.text.includes('oat milk weekly')), 'consolidated fact present');
});

test('runDream fails open when the model returns invalid JSON', async () => {
  const dir = await createdDir();
  const mem = buildMemory(makeConfig(dir));
  await mem.addFact('fact one');
  await mem.addFact('fact two');
  const bad = await runDream(mem, stubRouter('no json here'), makeConfig(dir), {
    enabled: true, minCount: 1, minHours: 0, minAgeMs: 0,
  });
  assert.strictEqual(bad.ran, false);
  assert.match(bad.reason ?? '', /invalid JSON/);
  assert.strictEqual((await mem.listFacts()).length, 2, 'store untouched on failure');
});

test('DreamLockFile single-flights, releases, and reclaims a dead-pid lock', async () => {
  const dir = await createdDir();
  const file = path.join(dir, '.dream-lock');
  const a = new DreamLockFile(file);
  const b = new DreamLockFile(file);
  assert.ok(await a.acquire(60_000));
  assert.strictEqual(await b.acquire(60_000), false, 'second acquirer blocked');
  await a.release();
  assert.ok(await b.acquire(60_000), 'released lock can be re-acquired');
  await b.release();

  await writeFile(file, JSON.stringify({ pid: 999999999, ts: Date.now() }));
  const c = new DreamLockFile(file);
  assert.ok(await c.acquire(60_000), 'dead-pid lock reclaimed');
  await c.release();
  await rm(dir, { recursive: true, force: true });
});
