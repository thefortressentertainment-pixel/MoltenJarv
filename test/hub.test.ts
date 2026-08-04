import assert from 'node:assert';
import { statSync, rmSync, existsSync } from 'node:fs';
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { AgentContext } from '../src/cli/index.js';
import { SESSION } from '../src/cli/index.js';
import { TokenStore } from '../src/hub/auth.js';
import { RemoteClient, LinkStore } from '../src/remote/client.js';
import { listenUi } from '../src/ui/server.js';

function tmpDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'jarv-hub-'));
}

function fakeCtx(): AgentContext {
  return {
    agent: {
      run: async (input: string) => ({ text: `echo: ${input}`, steps: 1, toolCalls: 0, provider: 'fake', model: 'fake-model' }),
      runStream: async (input: string, _sid: string | undefined, onDelta: (d: string) => void) => {
        onDelta('echo-');
        onDelta('stream');
        return { text: `echo-stream: ${input}`, steps: 1, toolCalls: 0, provider: 'fake', model: 'fake-model' };
      },
    },
    router: {
      providers: [{ label: 'Primary (fake-model)' }],
      get primaryModel() {
        return 'fake-model';
      },
      setPrimaryModel: (_m: string) => {},
      chat: async (opts: { messages: Array<{ role: string; content: string }> }) => {
        const last = opts.messages[opts.messages.length - 1];
        return { content: `echo: ${last?.content ?? ''}`, toolCalls: null, provider: 'fake', model: 'fake-model' };
      },
      streamChat: async (opts: { messages: Array<{ role: string; content: string }> }, onDelta: (d: string) => void) => {
        const last = opts.messages[opts.messages.length - 1];
        const content = `echo-stream: ${last?.content ?? ''}`;
        onDelta('echo-');
        onDelta('stream');
        return { content, toolCalls: null, provider: 'fake', model: 'fake-model' };
      },
    },
    memory: {
      sessionLoad: async () => [],
      sessionAppend: async () => {},
      sessionReset: async (id: string) => void id,
      listFacts: async () => [{ id: '1', text: 'fact one', createdAt: '' }],
    },
    config: {} as never,
    tools: {
      list: () => [{ name: 'get_datetime' }],
    },
    externalErrors: [],
  } as unknown as AgentContext;
}

test('TokenStore generates, persists (0600), reloads, rotates, and matches', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'auth.json');
  try {
    const store = new TokenStore(file);
    const first = store.get();
    assert.match(first, /^jarv-[A-Za-z0-9_-]+$/);
    assert.strictEqual(store.matches(first), true);
    assert.strictEqual(store.matches('wrong'), false);
    assert.strictEqual(statSync(file).mode & 0o777, 0o600);

    const reloaded = new TokenStore(file);
    assert.strictEqual(reloaded.get(), first);

    const rotated = store.rotate();
    assert.notStrictEqual(rotated, first);
    assert.strictEqual(store.matches(first), false);
    assert.strictEqual(store.matches(rotated), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('LinkStore set/get/clear persists the hub link with 0600 perms', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'link.json');
  try {
    const store = new LinkStore(file);
    assert.strictEqual(store.get(), null);

    store.set('http://192.168.1.5:3001/', 'jarv-abc');
    const link = store.get();
    assert.ok(link);
    assert.strictEqual(link.url, 'http://192.168.1.5:3001');
    assert.strictEqual(link.token, 'jarv-abc');
    assert.strictEqual(statSync(file).mode & 0o777, 0o600);

    assert.strictEqual(new LinkStore(file).get()?.url, 'http://192.168.1.5:3001');

    store.clear();
    assert.strictEqual(existsSync(file), false);
    assert.strictEqual(store.get(), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

async function withAuthServer(fn: (url: string, token: string) => Promise<void>): Promise<void> {
  const dir = tmpDir();
  const tokenStore = new TokenStore(path.join(dir, 'auth.json'));
  const { server, url } = await listenUi(fakeCtx(), { port: 0, open: false, auth: true, tokenStore });
  try {
    await fn(url, tokenStore.get());
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
}

test('hub requires a bearer token on /api routes', async () => {
  await withAuthServer(async (url) => {
    const anon = await fetch(url + '/api/status');
    assert.strictEqual(anon.status, 401);
    assert.strictEqual((await anon.json()).error, 'unauthorized: provide a hub token (see jarv-genie link)');

    const wrong = await fetch(url + '/api/status', {
      headers: { Authorization: 'Bearer wrong-token' },
    });
    assert.strictEqual(wrong.status, 401);
  });
});

test('hub static assets stay public while API is guarded', async () => {
  await withAuthServer(async (url) => {
    const page = await fetch(url + '/');
    assert.strictEqual(page.status, 200);
    assert.match(await page.text(), /app\.js/);
  });
});

test('RemoteClient talks to the hub with its token', async () => {
  await withAuthServer(async (url, token) => {
    const good = new RemoteClient(url, token);
    const status = await good.status();
    assert.strictEqual(status.model, 'fake-model');
    assert.deepStrictEqual(status.tools, ['get_datetime']);
    assert.strictEqual(status.facts, 1);

    const reply = await good.chat('hi');
    assert.strictEqual(reply.text, 'echo: hi');

    const deltas: string[] = [];
    const streamed = await good.chatStream('hi', (d) => deltas.push(d));
    assert.deepStrictEqual(deltas, ['echo-', 'stream']);
    assert.strictEqual(streamed.text, 'echo-stream');
    assert.strictEqual(streamed.model, 'fake-model');

    const bad = new RemoteClient(url, 'jarv-nope');
    await assert.rejects(() => bad.status(), /unauthorized/);
  });
});

test('ui loopback stays auth-free by default', async () => {
  const { server, url } = await listenUi(fakeCtx(), { port: 0, open: false });
  try {
    const res = await fetch(url + '/api/status');
    assert.strictEqual(res.status, 200);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('voice speak endpoint returns a WAV when TTS is available', async (t) => {
  const { hasPiper, hasTts } = await import('../src/voice/index.js');
  if (!hasPiper() && !hasTts()) {
    t.skip('no TTS on this machine');
    return;
  }
  await withAuthServer(async (url, token) => {
    const res = await fetch(url + '/api/voice/speak', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'hello there' }),
    });
    assert.strictEqual(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /audio\/wav/);
    const bytes = Buffer.from(await res.arrayBuffer());
    assert.strictEqual(bytes.toString('ascii', 0, 4), 'RIFF');
    assert.ok(bytes.length > 44, 'has audio data');
  });
});

test('voice transcribe endpoint turns audio into text', async (t) => {
  const { execFileSync } = await import('node:child_process');
  const { hasWhisperCli, locateWhisperModel, hasTts } = await import('../src/voice/index.js');
  if (!hasWhisperCli() || !locateWhisperModel() || !hasTts()) {
    t.skip('no whisper model or say available');
    return;
  }
  const dir = mkdtempSync(path.join(os.tmpdir(), 'jarv-x-'));
  const aiff = path.join(dir, 'a.aiff');
  const wav = path.join(dir, 'a.wav');
  try {
    execFileSync('say', ['-o', aiff, 'test one two three']);
    execFileSync('sox', [aiff, '-r', '16000', '-c', '1', '-b', '16', wav]);
    const audio = readFileSync(wav);
    await withAuthServer(async (url, token) => {
      const res = await fetch(url + '/api/voice/transcribe', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream' },
        body: audio,
      });
      assert.strictEqual(res.status, 200);
      const { text } = (await res.json()) as { text: string };
      assert.match(text.toLowerCase(), /test/);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
