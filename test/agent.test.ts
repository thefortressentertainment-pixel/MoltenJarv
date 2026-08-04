import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Agent } from '../src/agent/agent.js';
import type { ChatMessage } from '../src/agent/types.js';

function fakeRouter() {
  let calls = 0;
  const step = async (_opts: { messages: ChatMessage[]; tools: unknown[] }, onDelta: (d: string) => void) => {
    calls++;
    if (calls === 1) {
      onDelta('hidden intermediate');
      return {
        content: 'let me check',
        toolCalls: [{ id: '1', name: 'get_datetime', arguments: {} }],
        provider: 'fake',
        model: 'fake-model',
      };
    }
    onDelta('Hel');
    onDelta('lo');
    return { content: 'Hello', toolCalls: null, provider: 'fake', model: 'fake-model' };
  };
  return {
    calls: () => calls,
    streamChat: step,
    chat: async (opts: { messages: ChatMessage[]; tools: unknown[] }) => {
      calls++;
      return calls === 1
        ? { content: 'let me check', toolCalls: [{ id: '1', name: 'get_datetime', arguments: {} }], provider: 'fake', model: 'fake-model' }
        : { content: 'Hello', toolCalls: null, provider: 'fake', model: 'fake-model' };
    },
  };
}

function build(opts: {
  onStream?: (d: string) => void;
  router?: ReturnType<typeof fakeRouter>;
  sessionId?: string;
}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'jarv-agent-'));
  const appended: ChatMessage[][] = [];
  const memory = {
    sessionLoad: async (_id: string) => [],
    sessionAppend: async (_id: string, msgs: ChatMessage[]) => {
      appended.push(msgs);
    },
    sessionReset: async () => {},
  };
  const tools = {
    list: () => [{ name: 'get_datetime' }],
    execute: async (_name: string, _args: Record<string, unknown>) => ({ ok: true, result: { now: '2026-08-01' } }),
  };
  const config = {
    agent: { systemPrompt: 'sys', maxSteps: 5, workdir: path.join(dir, 'ws') },
  };
  const router = opts.router ?? fakeRouter();
  const agent = new Agent({ router, tools, memory, config } as never);
  return {
    agent,
    router,
    appended,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test('runStream buffers intermediate steps and streams only the final answer', async () => {
  const t = build({ onStream: () => {} });
  try {
    const deltas: string[] = [];
    const result = await t.agent.runStream('hi', 's', (d) => deltas.push(d));
    assert.strictEqual(result.text, 'Hello');
    assert.strictEqual(result.toolCalls, 1);
    assert.strictEqual(result.steps, 2);
    assert.deepStrictEqual(deltas, ['Hel', 'lo']);
    assert.ok(t.appended.length === 1, 'session persisted once');
  } finally {
    t.cleanup();
  }
});

test('runStream persists only new messages to the session', async () => {
  const t = build({});
  try {
    await t.agent.runStream('hi', 's', () => {});
    const saved = t.appended[0];
    const roles = saved.map((m) => m.role);
    assert.deepStrictEqual(roles, ['user', 'assistant', 'tool', 'assistant']);
  } finally {
    t.cleanup();
  }
});

test('run (non-streaming) still works after the streaming refactor', async () => {
  const t = build({});
  try {
    const result = await t.agent.run('hi', 's');
    assert.strictEqual(result.text, 'Hello');
    assert.strictEqual(result.steps, 2);
  } finally {
    t.cleanup();
  }
});

test('hallucinated tool names are corrected with the available tool list', async () => {
  let calls = 0;
  const router = {
    streamChat: async (opts: { messages: ChatMessage[] }) => {
      calls++;
      if (calls === 1) {
        return {
          content: null,
          toolCalls: [{ id: '1', name: 'update_knowledge_base', arguments: { scale: 'full' } }],
          provider: 'fake',
          model: 'fake-model',
        };
      }
      return { content: 'recovered', toolCalls: null, provider: 'fake', model: 'fake-model' };
    },
    chat: async (opts: { messages: ChatMessage[] }) => {
      calls++;
      if (calls === 1) {
        return {
          content: null,
          toolCalls: [{ id: '1', name: 'update_knowledge_base', arguments: { scale: 'full' } }],
          provider: 'fake',
          model: 'fake-model',
        };
      }
      return { content: 'recovered', toolCalls: null, provider: 'fake', model: 'fake-model' };
    },
  };
  const t = build({ router: router as never });
  try {
    const result = await t.agent.run('hi', 's');
    assert.strictEqual(result.text, 'recovered');
    assert.strictEqual(calls, 2, 'model recovered on the next step');
    const toolMsg = t.appended[0]?.find((m) => m.role === 'tool');
    assert.ok(toolMsg, 'tool result was persisted');
    assert.match(toolMsg.content ?? '', /Unknown tool .*update_knowledge_base/);
    assert.match(toolMsg.content ?? '', /get_datetime/, 'error lists an available tool');
  } finally {
    t.cleanup();
  }
});

test('text-encoded tool calls are intercepted and executed for real', async () => {
  const executed: string[] = [];
  const tools = {
    list: () => [{ name: 'get_datetime' }],
    execute: async (name: string) => {
      executed.push(name);
      return { ok: true, result: { now: '2026-08-01' } };
    },
  };
  let calls = 0;
  const router = {
    streamChat: async () => {
      calls++;
      if (calls === 1) {
        return { content: 'get_datetime --timezone "US/Eastern"', toolCalls: null, provider: 'fake', model: 'fake' };
      }
      return { content: 'The time tool ran.', toolCalls: null, provider: 'fake', model: 'fake' };
    },
    chat: async () => {
      calls++;
      if (calls === 1) {
        return { content: 'get_datetime --timezone "US/Eastern"', toolCalls: null, provider: 'fake', model: 'fake' };
      }
      return { content: 'The time tool ran.', toolCalls: null, provider: 'fake', model: 'fake' };
    },
  };
  const memory = { sessionLoad: async () => [], sessionAppend: async () => {}, sessionReset: async () => {} };
  const agent = new Agent({
    router: router as never,
    tools: tools as never,
    memory: memory as never,
    config: { agent: { systemPrompt: 'sys', maxSteps: 3, workdir: '/tmp' } } as never,
  });
  const result = await agent.run('what time is it');
  assert.deepStrictEqual(executed, ['get_datetime'], 'text tool call executed for real');
  assert.strictEqual(result.text, 'The time tool ran.');
});
