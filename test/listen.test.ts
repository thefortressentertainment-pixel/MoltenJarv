import assert from 'node:assert';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { buildMemory } from '../src/memory/index.js';
import { persistInstruction } from '../src/cli/listen.js';
import type { AgentContext } from '../src/cli/index.js';
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

async function makeCtx(dir: string): Promise<AgentContext> {
  const memory = buildMemory(makeConfig(dir));
  return { memory } as unknown as AgentContext;
}

test('persistInstruction writes a spoken instruction as a durable voice fact', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'jarv-listen-'));
  try {
    const ctx = await makeCtx(dir);
    await persistInstruction(ctx, 'Remind me to file taxes by Friday', true);
    const facts = await ctx.memory.listFacts();
    assert.strictEqual(facts.length, 1);
    assert.strictEqual(facts[0]?.text, 'Remind me to file taxes by Friday');
    // source 'voice' → evergreen durable fact (recallable, not decaying).
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('persistInstruction skips exit phrases (stop/goodbye)', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'jarv-listen-'));
  try {
    const ctx = await makeCtx(dir);
    await persistInstruction(ctx, 'stop', true);
    await persistInstruction(ctx, 'goodbye now', true);
    assert.strictEqual((await ctx.memory.listFacts()).length, 0, 'exit phrases not memorized');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('persistInstruction is a no-op when storing is disabled', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'jarv-listen-'));
  try {
    const ctx = await makeCtx(dir);
    await persistInstruction(ctx, 'important instruction', false);
    assert.strictEqual((await ctx.memory.listFacts()).length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
