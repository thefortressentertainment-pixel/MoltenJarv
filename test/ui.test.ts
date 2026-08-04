import assert from 'node:assert';
import { test } from 'node:test';
import type { AgentContext } from '../src/cli/index.js';
import { SESSION } from '../src/cli/index.js';
import { listenUi } from '../src/ui/server.js';

function fakeCtx(): AgentContext {
  const calls: string[] = [];
  let model = 'fake-model';
  return {
    agent: {
      run: async (_input: string) => {
        calls.push('run');
        return { text: `echo: ${_input}`, steps: 1, toolCalls: 0, provider: 'fake', model };
      },
      runStream: async (_input: string, _sid: string | undefined, onDelta: (d: string) => void) => {
        calls.push('stream');
        onDelta('hel');
        onDelta('lo');
        return { text: `hello: ${_input}`, steps: 1, toolCalls: 0, provider: 'fake', model };
      },
    },
    router: {
      providers: [{ label: 'Primary (fake-model)' }],
      get primaryModel() {
        return model;
      },
      setPrimaryModel: (m: string) => {
        model = m;
      },
      chat: async (opts: { messages: Array<{ role: string; content: string }> }) => {
        const last = opts.messages[opts.messages.length - 1];
        return { content: `echo: ${last?.content ?? ''}`, toolCalls: null, provider: 'fake', model };
      },
      streamChat: async (opts: { messages: Array<{ role: string; content: string }> }, onDelta: (d: string) => void) => {
        const last = opts.messages[opts.messages.length - 1];
        const content = `hello: ${last?.content ?? ''}`;
        onDelta('hel');
        onDelta('lo');
        return { content, toolCalls: null, provider: 'fake', model };
      },
    },
    memory: {
      sessionLoad: async () => [],
      sessionReset: async (id: string) => {
        calls.push(`reset:${id}`);
      },
      listFacts: async () => [{ id: '1', text: 'fact one', createdAt: '' }],
    },
    config: {} as never,
    tools: {
      list: () => [{ name: 'get_datetime' }],
    },
    externalErrors: [],
  } as unknown as AgentContext;
}

async function withServer(fn: (url: string) => Promise<void>): Promise<void> {
  const { server, url } = await listenUi(fakeCtx(), { port: 0, open: false });
  try {
    await fn(url);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('GET / serves the chat UI', async () => {
  await withServer(async (url) => {
    const res = await fetch(url + '/');
    assert.strictEqual(res.status, 200);
    const html = await res.text();
    assert.match(html, /Jarv Genie/);
    assert.match(html, /app\.js/);
  });
});

test('GET /api/status reports model, tools, and memory', async () => {
  await withServer(async (url) => {
    const s = await (await fetch(url + '/api/status')).json();
    assert.strictEqual(s.model, 'fake-model');
    assert.deepStrictEqual(s.tools, ['get_datetime']);
    assert.strictEqual(s.facts, 1);
  });
});

test('POST /api/chat runs the agent and returns a response', async () => {
  await withServer(async (url) => {
    const res = await fetch(url + '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'hello' }),
    });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.text, 'echo: hello');
    assert.strictEqual(body.provider, 'fake');
  });
});

test('POST /api/chat rejects an empty message', async () => {
  await withServer(async (url) => {
    const res = await fetch(url + '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: '   ' }),
    });
    assert.strictEqual(res.status, 400);
  });
});

test('POST /api/new resets the session', async () => {
  await withServer(async (url) => {
    const res = await fetch(url + '/api/new', { method: 'POST' });
    assert.strictEqual(res.status, 200);
  });
});

test('POST /api/model switches the primary model', async () => {
  await withServer(async (url) => {
    const res = await fetch(url + '/api/model', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'llama3.2:3b' }),
    });
    const body = await res.json();
    assert.strictEqual(body.model, 'llama3.2:3b');
  });
});

test('POST /api/chat with stream:true emits SSE text deltas', async () => {
  await withServer(async (url) => {
    const res = await fetch(url + '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify({ message: 'hi', stream: true }),
    });
    assert.strictEqual(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);
    const body = await res.text();
    assert.match(body, /data: \{"text":"echo: hi"\}/);
    assert.match(body, /data: \{"meta":\{"provider":"fake"/);
  });
});
