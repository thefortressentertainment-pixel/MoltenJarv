import assert from 'node:assert';
import { statSync, rmSync, existsSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
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
    },
    router: {
      providers: [{ label: 'Primary (fake-model)' }],
      get primaryModel() {
        return 'fake-model';
      },
      setPrimaryModel: (_m: string) => {},
    },
    memory: {
      sessionLoad: async () => [],
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
