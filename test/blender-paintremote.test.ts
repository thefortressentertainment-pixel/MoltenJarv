import assert from 'node:assert';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { paintRemoteConfig } from '../src/blender/paintRemote.js';

test('paintRemoteConfig reads endpoint + token from a temp secret store (isolated)', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'jarv-paintcfg-'));
  const prev = process.env.HOME;
  process.env.HOME = dir;
  try {
    // NOTE: getSecretStore caches a singleton; run THIS first (before the "null"
    // test) so the singleton initializes against the temp HOME.
    const secretsDir = path.join(dir, '.jarv-genie');
    await mkdir(secretsDir, { recursive: true });
    const secretsFile = path.join(secretsDir, 'secrets.json');
    await writeFile(secretsFile, JSON.stringify({
      BLENDER_PAINT_URL: 'https://abc.ngrok-free.app',
      BLENDER_PAINT_TOKEN: 'tok123',
    }));
    const cfg = paintRemoteConfig();
    assert.ok(cfg, 'config present when BLENDER_PAINT_URL is set');
    assert.strictEqual(cfg!.endpoint, 'https://abc.ngrok-free.app');
    assert.strictEqual(cfg!.token, 'tok123');
  } finally {
    process.env.HOME = prev;
    await rm(dir, { recursive: true, force: true });
  }
});
