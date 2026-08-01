import assert from 'node:assert';
import { rmSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { AgentContext } from '../src/cli/index.js';
import { TokenStore } from '../src/hub/auth.js';
import { DeviceStore, pushNotify } from '../src/sidecar/devices.js';
import { listenUi } from '../src/ui/server.js';

function tmpDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'jarv-dev-'));
}

function fakeCtx(): AgentContext {
  return {
    agent: { run: async () => ({ text: 'x', steps: 0, toolCalls: 0, provider: 'fake', model: 'm' }) },
    router: { providers: [], primaryModel: 'm', setPrimaryModel: () => {} },
    memory: { sessionLoad: async () => [], sessionReset: async () => {}, listFacts: async () => [] },
    config: {} as never,
    tools: { list: () => [] },
    externalErrors: [],
  } as unknown as AgentContext;
}

test('DeviceStore persists devices and survives reload', () => {
  const dir = tmpDir();
  try {
    const store = new DeviceStore(dir);
    const dev = store.register('imac', 'darwin', ['notify']);
    assert.match(dev.id, /^dev-/);
    assert.strictEqual(store.list().length, 1);

    const reloaded = new DeviceStore(dir);
    assert.strictEqual(reloaded.list().length, 1);
    assert.strictEqual(reloaded.list()[0]?.name, 'imac');

    const again = reloaded.register('imac', 'darwin', ['notify', 'speak']);
    assert.strictEqual(again.id, dev.id, 'registering the same name reuses the id');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('pushNotify targets all devices, or one by name, and enqueues events', () => {
  const dir = tmpDir();
  const store = new DeviceStore(dir);
  const phone = store.register('phone', 'ios');
  store.register('imac', 'darwin', ['notify']);
  try {
    const all = pushNotify(store, 'hello everyone');
    assert.strictEqual(all.length, 2);
    assert.ok(store.dequeue(phone.id));

    const one = pushNotify(store, 'just you', { device: 'phone' });
    assert.strictEqual(one.length, 1);
    assert.strictEqual(one[0]?.device, phone.id);
    assert.strictEqual(one[0]?.kind, 'notify');

    const speak = pushNotify(store, 'out loud', { device: 'phone', speak: true });
    assert.strictEqual(speak[0]?.kind, 'say');

    assert.strictEqual(pushNotify(store, 'nobody', { device: 'missing' }).length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('pending events survive hub restart via the events file', () => {
  const dir = tmpDir();
  try {
    const store = new DeviceStore(dir);
    const dev = store.register('imac', 'darwin');
    store.enqueue(dev.id, 'notify', 'while you were offline');

    const reloaded = new DeviceStore(dir);
    const ev = reloaded.dequeue(dev.id);
    assert.ok(ev);
    assert.strictEqual(ev.text, 'while you were offline');
    assert.strictEqual(reloaded.dequeue(dev.id), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('hub device routes: register, list, notify, and long-poll delivery', async () => {
  const dir = tmpDir();
  const tokenStore = new TokenStore(path.join(dir, 'auth.json'));
  const deviceStore = new DeviceStore(dir);
  const { server, url } = await listenUi(fakeCtx(), { port: 0, open: false, auth: true, tokenStore, deviceStore });
  try {
    const token = tokenStore.get();
    const register = await fetch(url + '/api/devices/register', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'phone', platform: 'ios 18' }),
    });
    const { device } = (await register.json()) as { device: { id: string; name: string } };
    assert.strictEqual(device.name, 'phone');

    const listRes = await fetch(url + '/api/devices', { headers: { Authorization: `Bearer ${token}` } });
    const listed = (await listRes.json()) as { devices: Array<{ name: string }> };
    assert.strictEqual(listed.devices.length, 1);

    const notifyRes = await fetch(url + '/api/notify', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'hey phone' }),
    });
    const queued = (await notifyRes.json()) as { enqueued: number };
    assert.strictEqual(queued.enqueued, 1);

    const poll = await fetch(url + `/api/devices/${device.id}/events?timeout=10`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const { event } = (await poll.json()) as { event: { kind: string; text: string } };
    assert.strictEqual(event.text, 'hey phone');
    assert.strictEqual(event.kind, 'notify');

    const empty = await fetch(url + `/api/devices/${device.id}/events?timeout=1`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const { event: none } = (await empty.json()) as { event: unknown };
    assert.strictEqual(none, null);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});
