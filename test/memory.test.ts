import assert from 'node:assert';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { FactStore } from '../src/memory/store.js';
import { SessionStore } from '../src/memory/sessions.js';
import { cosineSimilarity, keywordSearch, SemanticSearch, mmrRerank } from '../src/memory/search.js';
import { VectorCache } from '../src/memory/search.js';
import type { MemoryFact } from '../src/memory/types.js';

test('FactStore persists adds and removals', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'jarv-facts-'));
  try {
    const store = new FactStore(path.join(dir, 'facts.json'));
    const a = await store.add('user likes dark mode');
    const b = await store.add('meeting on friday', 'session');
    assert.strictEqual((await store.list()).length, 2);
    assert.strictEqual(a.source, 'user');
    assert.strictEqual(b.source, 'session');

    const reloaded = new FactStore(path.join(dir, 'facts.json'));
    assert.strictEqual((await reloaded.list()).length, 2);
    assert.strictEqual((await reloaded.get(a.id))?.text, 'user likes dark mode');

    assert.strictEqual(await store.remove(a.id), true);
    assert.strictEqual((await store.list()).length, 1);
    assert.strictEqual(await store.remove(a.id), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('cosineSimilarity returns 1 for identical vectors', () => {
  assert.strictEqual(cosineSimilarity([1, 0, 0], [1, 0, 0]), 1);
  assert.ok(cosineSimilarity([1, 0], [0, 1]) < 0.001);
});

test('keywordSearch ranks substring matches', () => {
  const facts = [
    { id: '1', text: 'dark mode enabled on laptop', source: 'user', createdAt: '', updatedAt: '' },
    { id: '2', text: 'bought oat milk', source: 'user', createdAt: '', updatedAt: '' },
  ];
  const hits = keywordSearch('dark mode', facts, 5);
  assert.strictEqual(hits[0]?.fact.id, '1');
});

test('SemanticSearch falls back to keywords without embeddings', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'jarv-search-'));
  try {
    const cache = new VectorCache(path.join(dir, 'vectors.json'));
    const search = new SemanticSearch(null, cache);
    assert.strictEqual(search.embeddingsEnabled, false);
    const facts = [
      { id: '1', text: 'raspberry pi on my desk', source: 'user', createdAt: '', updatedAt: '' },
      { id: '2', text: 'todo: water plants', source: 'user', createdAt: '', updatedAt: '' },
    ];
    const hits = await search.search('raspberry pi', facts, 5);
    assert.strictEqual(hits[0]?.fact.id, '1');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('SessionStore appends, loads, and resets', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'jarv-sess-'));
  try {
    const store = new SessionStore(path.join(dir, 'sessions'));
    await store.append('s1', [{ role: 'user', content: 'hi' }]);
    await store.append('s1', [{ role: 'assistant', content: 'hello' }]);
    assert.strictEqual((await store.load('s1')).length, 2);
    assert.strictEqual((await store.load('missing')).length, 0);
    await store.reset('s1');
    assert.strictEqual((await store.load('s1')).length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('FactStore.recordAccess increments counters and persists', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'jarv-acc-'));
  try {
    const store = new FactStore(path.join(dir, 'facts.json'));
    const f = await store.add('rehearsed fact');
    const read = new FactStore(path.join(dir, 'facts.json')); // fresh read
    assert.strictEqual((await read.get(f.id))?.accessCount, 0);
    const touched = await read.recordAccess([f.id, 'missing-id']);
    assert.strictEqual(touched.length, 1);
    assert.strictEqual(touched[0]!.accessCount, 1);
    const reloaded = new FactStore(path.join(dir, 'facts.json'));
    assert.strictEqual((await reloaded.get(f.id))?.accessCount, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("FactStore.update replaces text in place (update-don't-duplicate)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'jarv-upd-'));
  try {
    const store = new FactStore(path.join(dir, 'facts.json'));
    const a = await store.add('user likes dark mode');
    const before = (await store.list()).length;

    const updated = await store.update(a.id, 'user prefers light mode');
    assert.ok(updated, 'update returns the fact');
    assert.strictEqual(updated!.text, 'user prefers light mode');
    // The fact count is unchanged — we corrected, not duplicated.
    assert.strictEqual((await store.list()).length, before);
    assert.strictEqual((await store.get(a.id))?.text, 'user prefers light mode');

    // Unknown id → undefined.
    assert.strictEqual(await store.update('missing', 'x'), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('temporal decay hits old session facts but exempts evergreen', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'jarv-decay-'));
  try {
    const cache = new VectorCache(path.join(dir, 'vectors.json'));
    const search = new SemanticSearch(null, cache, { halfLifeDays: 1 });
    // Identical bodies except source + age, so only decay/evergreen differs.
    const oldSession = { id: 's', text: 'aquamarine note', source: 'session', createdAt: new Date(Date.now() - 10 * 86400000).toISOString(), updatedAt: '' };
    const evergreen = { id: 'e', text: 'aquamarine note', source: 'user', createdAt: new Date(Date.now() - 10 * 86400000).toISOString(), updatedAt: '' };
    const recentSession = { id: 'r', text: 'aquamarine note', source: 'session', createdAt: new Date().toISOString(), updatedAt: '' };

    const hits = await search.search('aquamarine', [oldSession, evergreen, recentSession], 10);
    const byId = new Map(hits.map((h) => [h.fact.id, h.rawScore]));
    // Evergreen (no decay) should outrank the equally-old but decaying session.
    assert.ok((byId.get('e') ?? 0) > (byId.get('s') ?? 0), 'evergreen outranks equally-old session');
    // A fresh session fact outranks an old decaying one.
    assert.ok((byId.get('r') ?? 0) > (byId.get('s') ?? 0), 'recent session outranks old session');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('access boost raises scores for rehearsed facts', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'jarv-boost-'));
  try {
    const cache = new VectorCache(path.join(dir, 'vectors.json'));
    const search = new SemanticSearch(null, cache);
    const a = { id: 'a', text: 'favorite color is aquamarine', source: 'user', createdAt: new Date().toISOString(), updatedAt: '', accessCount: 0 };
    const b = { id: 'b', text: 'favorite color is aquamarine', source: 'user', createdAt: new Date().toISOString(), updatedAt: '', accessCount: 50 };
    const hits = await search.search('favorite color aquamarine', [a, b], 5);
    const byId = new Map(hits.map((h) => [h.fact.id, h.rawScore]));
    assert.ok((byId.get('b') ?? 0) > (byId.get('a') ?? 0), 'more-accessed fact ranks higher');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('MMR re-rank promotes diversity over near-duplicate recall', async () => {
  const mk = (id: string, text: string): MemoryFact => ({ id, text, source: 'user', createdAt: new Date().toISOString(), updatedAt: '' });
  const dup1 = mk('d1', 'meeting with Alice about the Q3 budget forecast');
  const dup2 = mk('d2', 'Alice Q3 budget meeting, budget forecast details');
  const distinct = mk('x', 'also completed the spring marketing calendar for Q3');
  const hits = [
    { fact: dup1, rawScore: 0.9, score: 0.9 },
    { fact: dup2, rawScore: 0.88, score: 0.88 },
    { fact: distinct, rawScore: 0.8, score: 0.8 },
  ];
  const reranked = mmrRerank('meeting', hits, 0.6);
  // The distinct fact should surface before the second near-duplicate.
  const order = reranked.map((h) => h.fact.id).join(',');
  const distinctIdx = reranked.findIndex((h) => h.fact.id === 'x');
  const dup2Idx = reranked.findIndex((h) => h.fact.id === 'd2');
  assert.ok(distinctIdx !== -1 && dup2Idx !== -1, 'both facts present');
  assert.ok(distinctIdx < dup2Idx, `expected diversity ordering, got ${order}`);
});

