import assert from 'node:assert';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { buildMemory } from '../src/memory/index.js';
import { FactStore } from '../src/memory/store.js';
import { extractTriplet, parseTriplet } from '../src/memory/triplet.js';
import { extractFacts } from '../src/memory/extract.js';
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

test('addFactMeta stamps triplet, provenance, and validFrom', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'jarv-tmp-'));
  try {
    const mem = buildMemory(makeConfig(dir));
    await mem.addFactMeta('user prefers dark mode', { source: 'extraction', provenance: 'utterance#7', subject: 'user', relationship: 'prefers', object: 'dark mode' });
    const facts = await mem.factStore.list();
    assert.strictEqual(facts.length, 1);
    const f = facts[0]!;
    assert.strictEqual(f.subject, 'user');
    assert.strictEqual(f.relationship, 'prefers');
    assert.strictEqual(f.object, 'dark mode');
    assert.strictEqual(f.provenance, 'utterance#7');
    assert.ok(f.validFrom, 'validFrom defaults to createdAt');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('update supersedes: old fact retained as historical, new fact created', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'jarv-tmp-'));
  try {
    const mem = buildMemory(makeConfig(dir));
    const a = await mem.addFact('user prefers dark mode');
    await new Promise((r) => setTimeout(r, 10)); // ensure timestamps differ on concurrency-safe sleeps
    const updated = await mem.updateFact(a.id, 'user prefers light mode');

    assert.ok(updated, 'new fact id returned');
    assert.notStrictEqual(updated.id, a.id, 'new fact, not text-overwrite');

    const all = await mem.factStore.list();
    assert.strictEqual(all.length, 2, 'old fact retained, not deleted');

    // Old fact is now historical (validTo set, past).
    const old = all.find((f) => f.id === a.id)!;
    assert.ok(old.validTo, 'superseded fact has validTo');
    assert.strictEqual(old.text, 'user prefers dark mode', 'old text preserved, not overwritten');
    assert.strictEqual(Date.parse(old.validTo!) <= Date.now(), true);

    // New fact is currently valid (no validTo).
    const neu = all.find((f) => f.id === updated.id)!;
    assert.strictEqual(neu.text, 'user prefers light mode');
    assert.strictEqual(neu.validTo, undefined, 'new fact currently valid');

    // validFacts → only the new; historicalFacts → only the old.
    const valid = await mem.factStore.validFacts();
    assert.ok(valid.some((f) => f.id === updated.id));
    assert.ok(!valid.some((f) => f.id === a.id), 'old no longer in currently-valid');
    const hist = await mem.factStore.historicalFacts();
    assert.ok(hist.some((f) => f.id === a.id));
    assert.ok(!hist.some((f) => f.id === updated.id));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('factsForSubject returns subject and object scoped facts', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'jarv-tmp-'));
  try {
    const mem = buildMemory(makeConfig(dir));
    await mem.addFactMeta('user prefers dark mode', { source: 'extraction', subject: 'user', relationship: 'prefers', object: 'dark mode' });
    await mem.addFactMeta('user likes coffee', { source: 'extraction', subject: 'user', relationship: 'likes', object: 'coffee' });
    await mem.addFactMeta('Fortress is home', { source: 'extraction', subject: 'user', relationship: 'calls home', object: 'Fortress' });
    const userFacts = await mem.factStore.factsForSubject('user');
    assert.strictEqual(userFacts.length, 3, 'all facts where user is subject or object');
    const coffeeAsObject = await mem.factStore.factsForSubject('coffee');
    assert.strictEqual(coffeeAsObject.length, 1);
    assert.strictEqual(coffeeAsObject[0]!.relationship, 'likes');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('parseTriplet handles object JSON and rejects incomplete triples', () => {
  assert.deepStrictEqual(parseTriplet('{"subject":"user","relationship":"prefers","object":"dark mode"}'), { subject: 'user', relationship: 'prefers', object: 'dark mode' });
  assert.deepStrictEqual(parseTriplet('```json\n{"subject":"a","relationship":"b","object":"c"}\n```'), { subject: 'a', relationship: 'b', object: 'c' });
  assert.strictEqual(parseTriplet('{"subject":"a","relationship":"b"}'), null, 'missing object → null');
  assert.strictEqual(parseTriplet('not json'), null);
});

test('extractTriplet is fail-open and parses the model output', async () => {
  const good = await extractTriplet('user prefers dark mode', async () => '{"subject":"user","relationship":"prefers","object":"dark mode"}');
  assert.deepStrictEqual(good.triplet, { subject: 'user', relationship: 'prefers', object: 'dark mode' });
  const bad = await extractTriplet('anything', async () => { throw new Error('down'); });
  assert.strictEqual(bad.triplet, undefined, 'fail-open on model error');
  const empty = await extractTriplet('note', async () => '{"subject":"","relationship":"","object":""}');
  assert.strictEqual(empty.triplet, undefined);
});

test('extractFacts stamps triplets + provenance on the durable facts it writes', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'jarv-tmp-'));
  try {
    const mem = buildMemory(makeConfig(dir));
    const router = stubRouter('["user prefers dark mode"]');
    const result = await extractFacts(mem, router, 'I prefer dark mode a lot.');
    assert.strictEqual(result.added.length, 1);
    const facts = await mem.factStore.list();
    assert.strictEqual(facts.length, 1);
    assert.strictEqual(facts[0]!.source, 'extraction');
    assert.strictEqual(facts[0]!.validFrom, facts[0]!.createdAt);
    // provenance defaults to the (truncated) input when triplet provider is mocked
    assert.ok(facts[0]!.provenance, 'has provenance');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('FactStore persists temporal fields across reload', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'jarv-tmp-'));
  try {
    const file = path.join(dir, 'facts.json');
    const s1 = new FactStore(file);
    const f = await s1.add('x prefers y', { subject: 'x', relationship: 'prefers', object: 'y', provenance: 'ep1', validFrom: '2026-01-01T00:00:00Z' });
    const s2 = new FactStore(file);
    const got = await s2.get(f.id);
    assert.strictEqual(got?.subject, 'x');
    assert.strictEqual(got?.object, 'y');
    assert.strictEqual(got?.provenance, 'ep1');
    assert.strictEqual(got?.validFrom, '2026-01-01T00:00:00Z');
    assert.strictEqual(got?.validTo, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
