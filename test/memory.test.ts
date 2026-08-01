import assert from 'node:assert';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { FactStore } from '../src/memory/store.js';
import { SessionStore } from '../src/memory/sessions.js';
import { cosineSimilarity, keywordSearch, SemanticSearch } from '../src/memory/search.js';
import { VectorCache } from '../src/memory/search.js';

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
