import assert from 'node:assert';
import { test } from 'node:test';
import { TaskRunner } from '../src/agent/taskrunner.js';
import { setApprovalHandler } from '../src/approvals.js';
import type { ChatMessage, ToolCall } from '../src/agent/types.js';

type Step = { content?: string | null; calls?: ToolCall[] | null };

function fakeRouter(sequence: Step[]): { router: unknown; calls: ChatMessage[][] } {
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
  return { router, calls };
}

function fakeTools(): { tools: unknown; executed: string[] } {
  const executed: string[] = [];
  const defs = [
    { name: 'set_alarm', description: 'set a recurring alarm', consequential: true, inputSchema: { type: 'object', properties: { cron: { type: 'string' }, prompt: { type: 'string' } }, required: ['cron', 'prompt'] } },
    { name: 'get_datetime', description: 'current time', consequential: false, inputSchema: { type: 'object', properties: {} } },
  ];
  const tools = {
    list: () => defs,
    has: (n: string) => defs.some((d) => d.name === n),
    execute: async (name: string, args: Record<string, unknown>) => {
      executed.push(`${name}:${JSON.stringify(args)}`);
      if (name === 'set_alarm') return { ok: true, result: { id: 's-abc' } };
      return { ok: true, result: { now: '2026-08-04' } };
    },
  };
  return { tools, executed };
}

function build(sequence: Step[]) {
  const { router, calls } = fakeRouter(sequence);
  const { tools, executed } = fakeTools();
  const memory = { sessionLoad: async () => [], sessionAppend: async () => {}, sessionReset: async () => {} };
  const runner = new TaskRunner({
    router: router as never,
    tools: tools as never,
    memory: memory as never,
    config: { agent: { systemPrompt: 'sys', maxSteps: 5, workdir: '/tmp' } } as never,
  });
  return { runner, calls, executed };
}

test('plain answer is returned without tools', async () => {
  const { runner, executed } = build([{ content: 'Hello!' }]);
  const res = await runner.run('hi');
  assert.strictEqual(res.text, 'Hello!');
  assert.deepStrictEqual(executed, []);
  assert.strictEqual(res.toolCalls, 0);
});

test('native tool call is executed and reported', async () => {
  const { runner, executed } = build([
    { calls: [{ id: '1', name: 'get_datetime', arguments: {} }] },
    { content: 'It is 2026-08-04.' },
  ]);
  const res = await runner.run('what time is it');
  assert.deepStrictEqual(executed, ['get_datetime:{}']);
  assert.match(res.text, /2026-08-04/);
  assert.strictEqual(res.toolCalls, 1);
});

test('text-encoded tool call is intercepted and executed', async () => {
  const { runner, executed } = build([
    { content: 'get_datetime --tz "US/Eastern"' },
    { content: 'Done.' },
  ]);
  const res = await runner.run('what time is it');
  assert.deepStrictEqual(executed, ['get_datetime:{"tz":"US/Eastern"}']);
  assert.strictEqual(res.text, 'Done.');
});

test('denied consequential tool is not executed and the report is honest', async () => {
  setApprovalHandler(async () => false);
  try {
    const { runner, executed } = build([
      { calls: [{ id: '1', name: 'set_alarm', arguments: { cron: '0 8 * * 6', prompt: 'alarm' } }] },
      { content: 'I could not set the alarm because you did not approve it.' },
    ]);
    const res = await runner.run('set an alarm');
    assert.deepStrictEqual(executed, [], 'tool must not run when denied');
    assert.match(res.text, /did not approve/);
  } finally {
    setApprovalHandler(null);
  }
});

test('approved consequential tool runs', async () => {
  setApprovalHandler(async () => true);
  try {
    const { runner, executed } = build([
      { calls: [{ id: '1', name: 'set_alarm', arguments: { cron: '0 8 * * 6', prompt: 'alarm' } }] },
      { content: 'Alarm set for Saturdays at 08:00.' },
    ]);
    const res = await runner.run('set an alarm');
    assert.strictEqual(executed.length, 1);
    assert.match(res.text, /Alarm set/);
  } finally {
    setApprovalHandler(null);
  }
});

test('missing required arguments are rejected before execution', async () => {
  const { runner, executed } = build([
    { calls: [{ id: '1', name: 'set_alarm', arguments: { prompt: 'no cron' } }] },
    { content: 'The alarm was not set because cron was missing.' },
  ]);
  const res = await runner.run('set an alarm');
  assert.deepStrictEqual(executed, [], 'no execution when required arg missing');
  assert.match(res.text, /not set/);
});

test('empty model output is nudged to respond', async () => {
  const { runner } = build([{ content: '' }, { content: 'There now.' }]);
  const res = await runner.run('hello');
  assert.strictEqual(res.text, 'There now.');
});

test('a round of multiple consequential tools gets ONE batched approval', async () => {
  let approvals = 0;
  setApprovalHandler(async () => {
    approvals++;
    return true;
  });
  try {
    const { runner, executed } = build([
      {
        calls: [
          { id: '1', name: 'set_alarm', arguments: { cron: '0 8 * * 6', prompt: 'a' } },
          { id: '2', name: 'set_alarm', arguments: { cron: '0 9 * * 6', prompt: 'b' } },
        ],
      },
      { content: 'done.' },
    ]);
    const res = await runner.run('set two alarms');
    assert.strictEqual(approvals, 1, 'one approval for the whole round, not two');
    assert.strictEqual(executed.length, 2, 'both ran after the single approval');
    assert.strictEqual(res.text, 'done.');
  } finally {
    setApprovalHandler(null);
  }
});

test('with a sessionId, the exchange is persisted and recent history is loaded', async () => {
  let loaded = 0;
  let appended: ChatMessage[][] = [];
  const memory = {
    sessionLoad: async () => {
      loaded++;
      return [];
    },
    sessionAppend: async (_id: string, msgs: ChatMessage[]) => appended.push(msgs),
    sessionReset: async () => {},
  };
  const { router } = fakeRouter([{ content: 'Hello!' }]);
  const { tools } = fakeTools();
  const runner = new TaskRunner({
    router: router as never,
    tools: tools as never,
    memory: memory as never,
    config: { agent: { systemPrompt: 'sys', maxSteps: 3, workdir: '/tmp' } } as never,
    sessionId: 'chat',
  });
  const res = await runner.run('hi');
  assert.strictEqual(res.text, 'Hello!');
  assert.strictEqual(loaded, 1, 'history loaded for recent context');
  assert.strictEqual(appended.length, 1, 'exchange persisted');
  const saved = appended[0]!;
  assert.strictEqual(saved[0]?.role, 'user');
  assert.strictEqual(saved[0]?.content, 'hi');
  assert.strictEqual(saved[1]?.role, 'assistant');
  assert.strictEqual(saved[1]?.content, 'Hello!');
});
