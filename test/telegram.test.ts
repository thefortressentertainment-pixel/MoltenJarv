import assert from 'node:assert';
import { test } from 'node:test';
import { TelegramClient } from '../src/telegram/client.js';
import { approvalActive, requireApproval, setApprovalHandler } from '../src/approvals.js';
import { Agent } from '../src/agent/agent.js';
import { chunkText } from '../src/cli/telegram.js';
import type { ChatMessage } from '../src/agent/types.js';

test('long text is split into Telegram-safe chunks', () => {
  const long = 'a'.repeat(9000);
  const parts = chunkText(long);
  assert.ok(parts.length >= 3, `9000 chars should split into ~3 parts, got ${parts.length}`);
  for (const p of parts) assert.ok(p.length <= 4000, `chunk too long: ${p.length}`);
  assert.strictEqual(parts.join('').length, 9000, 'chunks reassemble the full text');
});

test('short text stays one chunk', () => {
  assert.deepStrictEqual(chunkText('hi there'), ['hi there']);
});

function withFetchStub(stub: (url: string, init?: { method?: string; body?: string }) => { ok: boolean; result?: unknown; description?: string }, fn: () => Promise<void>): Promise<void> {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const out = stub(String(input), { method: init?.method, body: typeof init?.body === 'string' ? init.body : undefined });
    return {
      ok: out.ok,
      json: async () => (out.ok ? { ok: true, result: out.result } : { ok: false, description: out.description }),
    } as unknown as Response;
  }) as typeof fetch;
  return fn().finally(() => {
    globalThis.fetch = original;
  });
}

test('TelegramClient getMe/getUpdates/sendMessage hit the right URLs', async () => {
  const calls: string[] = [];
  await withFetchStub(
    (url, init) => {
      calls.push(`${init?.method ?? 'GET'} ${url}`);
      if (url.includes('/getMe')) return { ok: true, result: { id: 1, username: 'jarvbot' } };
      if (url.includes('/getUpdates')) return { ok: true, result: [{ update_id: 5 }] };
      return { ok: true, result: true };
    },
    async () => {
      const c = new TelegramClient('tok123');
      assert.strictEqual((await c.getMe()).username, 'jarvbot');
      await c.getUpdates(5, 30);
      await c.sendMessage(999, 'hi');
      assert.ok(calls.some((x) => x.includes('/bot tok123/getMe'.replace(' ', ''))));
      assert.ok(calls.some((x) => x.includes('offset=5') && x.includes('timeout=30')));
      const post = calls.find((x) => x.startsWith('POST'));
      assert.ok(post, 'sendMessage used POST');
    },
  );
});

test('TelegramClient throws on API errors', async () => {
  await withFetchStub(
    () => ({ ok: false, description: 'Unauthorized' }),
    async () => {
      const c = new TelegramClient('bad');
      await assert.rejects(c.getMe(), /telegram getMe: Unauthorized/);
    },
  );
});

test('approval gate is open when no channel is active', async () => {
  setApprovalHandler(null);
  assert.strictEqual(approvalActive(), false);
  assert.strictEqual(await requireApproval('open_app("Calculator")'), true);
});

test('approval gate waits on the active channel handler', async () => {
  setApprovalHandler(async (q) => {
    assert.match(q, /open_app/);
    return false;
  });
  try {
    assert.strictEqual(approvalActive(), true);
    assert.strictEqual(await requireApproval('open_app({"app":"Calculator"})'), false);
  } finally {
    setApprovalHandler(null);
  }
});

function buildWithConsequentialTool(approval: boolean): { agent: Agent; executed: string[] } {
  const executed: string[] = [];
  const tools = {
    list: () => [{ name: 'do_thing', consequential: true }],
    execute: async (name: string) => {
      executed.push(name);
      return { ok: true, result: 'done' };
    },
  };
  let calls = 0;
  const step = async () => {
    calls++;
    if (calls === 1) {
      return { content: null, toolCalls: [{ id: '1', name: 'do_thing', arguments: {} }], provider: 'fake', model: 'fake' };
    }
    return { content: 'responded', toolCalls: null, provider: 'fake', model: 'fake' };
  };
  const router = { streamChat: step, chat: step };
  const memory = { sessionLoad: async () => [], sessionAppend: async () => {}, sessionReset: async () => {} };
  setApprovalHandler(async () => approval);
  const agent = new Agent({
    router: router as never,
    tools: tools as never,
    memory: memory as never,
    config: { agent: { systemPrompt: 'sys', maxSteps: 3, workdir: '/tmp' } } as never,
  });
  return { agent, executed };
}

test('consequential tool is blocked when the user denies', async () => {
  const { agent, executed } = buildWithConsequentialTool(false);
  try {
    const result = await agent.run('hi');
    assert.deepStrictEqual(executed, [], 'tool must not run when denied');
    assert.strictEqual(result.text, 'responded');
  } finally {
    setApprovalHandler(null);
  }
});

test('consequential tool runs when the user approves', async () => {
  const { agent, executed } = buildWithConsequentialTool(true);
  try {
    await agent.run('hi');
    assert.deepStrictEqual(executed, ['do_thing']);
  } finally {
    setApprovalHandler(null);
  }
});
