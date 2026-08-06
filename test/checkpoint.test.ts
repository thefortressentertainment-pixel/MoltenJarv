import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { TaskRunner } from '../src/agent/taskrunner.js';
import { setApprovalHandler } from '../src/approvals.js';
import { saveCheckpoint, loadCheckpoint, clearCheckpoint, isResumeIntent } from '../src/agent/checkpoint.js';
import type { ChatMessage, ToolCall } from '../src/agent/types.js';

async function withHome(fn: () => Promise<void>): Promise<void> {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'jarv-cp-'));
  const oldHome = process.env.HOME;
  process.env.HOME = dir;
  try {
    await fn();
  } finally {
    process.env.HOME = oldHome ?? '';
    rmSync(dir, { recursive: true, force: true });
  }
}

function fakeTools() {
  const defs = [
    { name: 'get_datetime', description: 'time', consequential: false, inputSchema: { type: 'object', properties: {} } },
    { name: 'read_file', description: 'read a file', consequential: false, inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  ];
  return {
    list: () => defs,
    has: (n: string) => defs.some((d) => d.name === n),
    execute: async (name: string, _args: Record<string, unknown>) => {
      if (name === 'get_datetime') return { ok: true, result: { now: '2026-08-04T10:00:00' } };
      return { ok: true, result: { content: 'file-contents-123' } };
    },
  };
}

type Step = { content?: string | null; calls?: ToolCall[] | null };

function runnerWith(sequence: Step[], sessionId: string) {
  const calls: ChatMessage[][] = [];
  let i = 0;
  const router = {
    chat: async (opts: { messages: ChatMessage[] }) => {
      calls.push(opts.messages);
      const step = sequence[Math.min(i++, sequence.length - 1)]!;
      return { content: step.content ?? null, toolCalls: step.calls ?? null, provider: 'fake', model: 'fake-model' };
    },
    streamChat: async () => ({ content: null, toolCalls: null, provider: 'fake', model: 'fake-model' }),
  };
  const tools = fakeTools();
  const memory = { sessionLoad: async () => [], sessionAppend: async () => {}, sessionReset: async () => {} };
  const runner = new TaskRunner({
    router: router as never,
    tools: tools as never,
    memory: memory as never,
    config: { agent: { systemPrompt: 'sys', maxSteps: 2, workdir: '/tmp' } } as never,
    sessionId,
  });
  return { runner, calls };
}

test('checkpoint store saves, loads, and clears', async () => {
  await withHome(async () => {
    const messages: ChatMessage[] = [{ role: 'user', content: 'do it' }];
    await saveCheckpoint({ sessionId: 'chat', messages, steps: 7, toolCalls: 5, completed: ['read_file'], updatedAt: new Date().toISOString() });
    const cp = await loadCheckpoint('chat');
    assert.ok(cp);
    assert.strictEqual(cp!.steps, 7);
    assert.strictEqual(cp!.messages.length, 1);
    assert.deepStrictEqual(cp!.completed, ['read_file']);

    await clearCheckpoint('chat');
    assert.strictEqual(await loadCheckpoint('chat'), null);
  });
});

test('isResumeIntent matches continue/release phrases only at the start', () => {
  assert.strictEqual(isResumeIntent('continue'), true);
  assert.strictEqual(isResumeIntent('Continue please'), true);
  assert.strictEqual(isResumeIntent('keep going'), true);
  assert.strictEqual(isResumeIntent('pick up where you left off'), true);
  assert.strictEqual(isResumeIntent('please continue the task now'), false, 'must lead with the verb');
  assert.strictEqual(isResumeIntent('what time is it'), false);
  assert.strictEqual(isResumeIntent(''), false);
});

test('an exhausted run saves a checkpoint; "continue" resumes with the full working context', async () => {
  await withHome(async () => {
    setApprovalHandler(null);
    try {
      // Run 1: budget 2, both rounds call a tool -> exhausts and checkpoints.
      const r1 = runnerWith([{ calls: [{ id: '1', name: 'get_datetime', arguments: {} }] }, { calls: [{ id: '2', name: 'read_file', arguments: { path: 'a.txt' } }] }], 'chat');
      const res1 = await r1.runner.run('do the long task');
      assert.match(res1.text, /ran out of steps/i);
      assert.ok(res1.steps >= 2);

      const cp = await loadCheckpoint('chat');
      assert.ok(cp, 'checkpoint saved after exhaustion');
      assert.ok(cp!.completed.includes('get_datetime') && cp!.completed.includes('read_file'));

      // Run 2: "continue" resumes, so the model should see the checkpointed
      // tool result from run 1 in its first request.
      const r2 = runnerWith([{ content: 'All done now.' }], 'chat');
      const res2 = await r2.runner.run('continue');
      assert.strictEqual(res2.text, 'All done now.');
      const firstRequest = r2.calls[0];
      assert.ok(firstRequest, 'resume made at least one model call');
      const hasToolResult = firstRequest!.some((m) => m.role === 'tool' && m.content.includes('file-contents-123'));
      assert.ok(hasToolResult, 'resumed context carries the prior tool result, not a fresh start');
      assert.strictEqual(await loadCheckpoint('chat'), null, 'checkpoint cleared after successful completion');
    } finally {
      setApprovalHandler(null);
    }
  });
});

test('a brand-new (non-continue) task clears a stale checkpoint', async () => {
  await withHome(async () => {
    setApprovalHandler(null);
    try {
      const r1 = runnerWith([{ calls: [{ id: '1', name: 'get_datetime', arguments: {} }] }, { calls: [{ id: '2', name: 'read_file', arguments: { path: 'a.txt' } }] }], 'chat');
      await r1.runner.run('do the long task');
      assert.ok(await loadCheckpoint('chat'), 'checkpoint exists');

      const r2 = runnerWith([{ content: 'Fresh task done.' }], 'chat');
      await r2.runner.run('a completely different request');
      assert.strictEqual(await loadCheckpoint('chat'), null, 'stale checkpoint cleared by new task');
    } finally {
      setApprovalHandler(null);
    }
  });
});
