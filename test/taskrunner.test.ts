import assert from 'node:assert';
import { test } from 'node:test';
import { TaskRunner } from '../src/agent/taskrunner.js';
import { setApprovalHandler } from '../src/approvals.js';
import type { ChatMessage } from '../src/agent/types.js';

type StepResult = { content: string | null; provider: string; model: string };

function fakeRouter(sequence: Array<{ content: string | null } | { calls: (msgs: ChatMessage[]) => string | null }>): { router: unknown; calls: ChatMessage[][] } {
  const calls: ChatMessage[][] = [];
  let i = 0;
  const router = {
    chat: async (opts: { messages: ChatMessage[] }) => {
      calls.push(opts.messages);
      const step = sequence[Math.min(i++, sequence.length - 1)]!;
      const content = 'calls' in step ? step.calls(opts.messages) : step.content;
      return { content, toolCalls: null, provider: 'fake', model: 'fake-model' };
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

function build(sequence: Array<{ content: string | null } | { calls: (msgs: ChatMessage[]) => string | null }>) {
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

test('answer path returns the planned text without tools', async () => {
  const { runner, executed } = build([{ content: '{"action":"answer","text":"Sure!"}' }]);
  const res = await runner.run('hi');
  assert.strictEqual(res.text, 'Sure!');
  assert.deepStrictEqual(executed, []);
});

test('tools path plans, executes, and reports', async () => {
  const { runner, executed } = build([
    { content: '{"action":"tools","calls":[{"name":"get_datetime","arguments":{}}]}' },
    { content: 'It is 2026-08-04.' },
  ]);
  const res = await runner.run('what time is it');
  assert.deepStrictEqual(executed, ['get_datetime:{}']);
  assert.match(res.text, /2026-08-04/);
  assert.strictEqual(res.toolCalls, 1);
});

test('denied consequential tool is not executed and the report is honest', async () => {
  setApprovalHandler(async () => false);
  try {
    const { runner, executed } = build([
      { content: '{"action":"tools","calls":[{"name":"set_alarm","arguments":{"cron":"0 8 * * 6","prompt":"alarm"}}]}' },
      {
        calls: (msgs) => {
          const last = msgs[msgs.length - 1]!;
          assert.match(last.content ?? '', /denied|user denied/, 'report step saw the denial');
          return 'I could not set the alarm because you did not approve it.';
        },
      },
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
      { content: '{"action":"tools","calls":[{"name":"set_alarm","arguments":{"cron":"0 8 * * 6","prompt":"alarm"}}]}' },
      { content: 'Alarm set for Saturdays at 08:00.' },
    ]);
    const res = await runner.run('set an alarm');
    assert.strictEqual(executed.length, 1);
    assert.match(res.text, /Alarm set/);
  } finally {
    setApprovalHandler(null);
  }
});

test('invalid JSON plan triggers a retry', async () => {
  const { runner, executed } = build([
    { content: 'here is my plan: use get_datetime, ok?' },
    { content: '{"action":"tools","calls":[{"name":"get_datetime","arguments":{}}]}' },
    { content: 'Done.' },
  ]);
  const res = await runner.run('what time is it');
  assert.deepStrictEqual(executed, ['get_datetime:{}']);
  assert.strictEqual(res.text, 'Done.');
});

test('missing required arguments are rejected before execution', async () => {
  const { runner, executed } = build([
    { content: '{"action":"tools","calls":[{"name":"set_alarm","arguments":{"prompt":"no cron"}}]}' },
    { content: 'The alarm was not set because cron was missing.' },
  ]);
  const res = await runner.run('set an alarm');
  assert.deepStrictEqual(executed, [], 'no execution when required arg missing');
  assert.match(res.text, /not set/);
});
