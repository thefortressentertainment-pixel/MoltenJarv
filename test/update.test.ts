import assert from 'node:assert';
import http from 'node:http';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { AgentContext } from '../src/cli/index.js';
import {
  artifactPath,
  cmpVersion,
  fetchManifest,
  manifestPath,
  publishUpdate,
  readManifest,
} from '../src/updates/index.js';
import { dataHome, VERSION } from '../src/config/defaults.js';

function withHome(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'jarv-upd-'));
  const oldHome = process.env.HOME;
  process.env.HOME = dir;
  return fn(dir).finally(() => {
    process.env.HOME = oldHome ?? '';
    rmSync(dir, { recursive: true, force: true });
  });
}

function fakeCtx(): AgentContext {
  return {
    agent: {
      run: async (input: string) => ({ text: `echo: ${input}`, steps: 1, toolCalls: 0, provider: 'fake', model: 'fake-model' }),
      runStream: async () => ({ text: 'x', steps: 1, toolCalls: 0, provider: 'fake', model: 'fake-model' }),
    },
    router: {
      providers: [{ label: 'fake' }],
      get primaryModel() {
        return 'fake-model';
      },
      setPrimaryModel: () => {},
    },
    memory: {
      sessionLoad: async () => [],
      sessionReset: async () => {},
      listFacts: async () => [],
    },
    config: {} as never,
    tools: { list: () => [{ name: 'get_datetime' }] },
    externalErrors: [],
  } as unknown as AgentContext;
}

function startServer(handler: http.RequestListener): Promise<{ server: http.Server; url: string }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve({ server, url: `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}` });
    });
  });
}

test('cmpVersion orders numeric versions', () => {
  assert.ok(cmpVersion('0.1.0', '0.1.1') < 0);
  assert.ok(cmpVersion('0.1.1', '0.1.0') > 0);
  assert.strictEqual(cmpVersion('0.1.0', '0.1.0'), 0);
  assert.ok(cmpVersion('v0.9.0', '0.10.0') < 0);
  assert.ok(cmpVersion('1.0.0', '0.2.0') > 0);
});

test('publishUpdate stages an artifact and writes a manifest', async () => {
  await withHome(async () => {
    const src = path.join(dataHome(), '..', 'fake.dmg');
    writeFileSync(src, Buffer.alloc(1024, 7));
    const m = publishUpdate(src, { version: '0.2.0', notes: 'new build' });

    assert.strictEqual(m.version, '0.2.0');
    assert.strictEqual(m.artifactSize, 1024);
    assert.match(m.artifact, /^jarv-genie-0\.2\.0\.dmg$/);
    assert.strictEqual(m.sha256.length, 64);
    assert.strictEqual(readFileSync(artifactPath(m)).length, 1024);

    const loaded = readManifest();
    assert.ok(loaded);
    assert.strictEqual(loaded.version, '0.2.0');
    assert.strictEqual(loaded.notes, 'new build');
    assert.ok(readFileSync(manifestPath(), 'utf8').includes('0.2.0'));
  });
});

test('fetchManifest reads another hub manifest and 404s when nothing published', async () => {
  await withHome(async () => {
    const src = path.join(dataHome(), '..', 'fake.bin');
    writeFileSync(src, 'x');
    publishUpdate(src, { version: '9.9.9' });

    let status = 200;
    const { server, url } = await startServer((_req, res) => {
      if (status === 404) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(readManifest()));
    });

    const m = await fetchManifest(url);
    assert.ok(m);
    assert.strictEqual(m?.version, '9.9.9');

    status = 404;
    assert.strictEqual(await fetchManifest(url), null);
    await new Promise<void>((r) => server.close(() => r()));
  });
});

test('hub update routes serve manifest, status, and artifact', async () => {
  const { listenUi } = await import('../src/ui/server.js');
  await withHome(async () => {
    const src = path.join(dataHome(), '..', 'fake.dmg');
    writeFileSync(src, Buffer.alloc(64, 3));
    publishUpdate(src, { version: '0.3.0' });

    const { server, url } = await listenUi(fakeCtx(), { port: 0, open: false });
    try {
      const manifestRes = await fetch(url + '/api/update');
      assert.strictEqual(manifestRes.status, 200);
      const m = await manifestRes.json();
      assert.strictEqual(m.version, '0.3.0');

      const statusRes = await fetch(url + '/api/update/status');
      assert.strictEqual(statusRes.status, 200);
      const s = await statusRes.json();
      assert.strictEqual(s.current, VERSION);
      assert.strictEqual(s.latest, '0.3.0');
      assert.strictEqual(s.available, cmpVersion('0.3.0', VERSION) > 0);

      const dl = await fetch(url + '/api/update/download');
      assert.strictEqual(dl.status, 200);
      assert.strictEqual((await dl.arrayBuffer()).byteLength, 64);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
