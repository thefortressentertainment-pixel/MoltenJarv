import assert from 'node:assert';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { buildMemory } from '../src/memory/index.js';
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

function createdDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), 'jarv-extract-'));
}

test('extractFacts writes durable facts with provenance and returns candidates', async () => {
  const dir = await createdDir();
  try {
    const mem = buildMemory(makeConfig(dir));
    const router = stubRouter('["user prefers dark mode", "meeting with Alice on friday"]');
    const result = await extractFacts(mem, router, 'I really prefer dark mode. Also I have a meeting with Alice on friday.');

    assert.strictEqual(result.ran, true);
    assert.strictEqual(result.candidates.length, 2);
    assert.strictEqual(result.added.length, 2);
    assert.strictEqual(result.skipped.length, 0);

    const facts = await mem.factStore.list();
    assert.strictEqual(facts.length, 2);
    assert.ok(facts.every((f) => f.source === 'extraction'), 'provenance is extraction');
    assert.ok(facts.some((f) => f.text === 'user prefers dark mode'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('extractFacts skips exact and substring duplicates (update-don-t-duplicate)', async () => {
  const dir = await createdDir();
  try {
    const mem = buildMemory(makeConfig(dir));
    await mem.addFact('user prefers dark mode');
    const result = await extractFacts(mem, stubRouter('["user prefers dark mode", "user likes strong coffee"]'), 'I prefer dark mode and like strong coffee.');

    assert.strictEqual(result.added.length, 1);
    assert.strictEqual(result.added[0], 'user likes strong coffee');
    assert.strictEqual(result.skipped.length, 1);
    assert.strictEqual(result.skipped[0], 'user prefers dark mode');

    const facts = await mem.factStore.list();
    assert.strictEqual(facts.length, 2, 'no duplicate piled up');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('extractFacts is fail-open on empty input and on model failure', async () => {
  const dir = await createdDir();
  try {
    const mem = buildMemory(makeConfig(dir));

    let called = false;
    const spy: ModelRouter = { chat: async () => { called = true; return { content: '[]', toolCalls: null, provider: 'test', model: 'test' }; } } as unknown as ModelRouter;
    const empty = await extractFacts(mem, spy, '   ');
    assert.strictEqual(empty.ran, false);
    assert.strictEqual(called, false, 'model not called on empty input');

    const bad = stubRouter('down');
    bad.chat = () => { throw new Error('down'); };
    const failed = await extractFacts(mem, bad as unknown as ModelRouter, 'some text');
    assert.strictEqual(failed.ran, false);
    assert.strictEqual(failed.reason?.includes('model unavailable'), true);
    assert.strictEqual((await mem.factStore.list()).length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('extractFacts handles invalid JSON and empty array without writing', async () => {
  const dir = await createdDir();
  try {
    const mem = buildMemory(makeConfig(dir));

    const bad = await extractFacts(mem, stubRouter('not json at all'), 'some text');
    assert.strictEqual(bad.ran, false);
    assert.strictEqual(bad.added.length, 0);
    assert.strictEqual((await mem.factStore.list()).length, 0);

    const none = await extractFacts(mem, stubRouter('[]'), 'some text');
    assert.strictEqual(none.ran, true, 'empty array is a valid result');
    assert.strictEqual(none.added.length, 0);
    assert.strictEqual((await mem.factStore.list()).length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
