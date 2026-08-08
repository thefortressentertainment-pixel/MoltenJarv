import assert from 'node:assert';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test, beforeEach, afterEach } from 'node:test';
import { resolveSecret, envForSecret, redactSecrets } from '../src/credentials.js';
import { getSecretStore, resetSecretStore } from '../src/config/secrets.js';

let home: string;

beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), 'jarv-cred-'));
  process.env.HOME = home;
  resetSecretStore();
});

afterEach(async () => {
  resetSecretStore();
  await rm(home, { recursive: true, force: true });
});

test('resolveSecret reads the secret store and falls back by name', () => {
  getSecretStore().set('GH_TOKEN', 'ghs_abc123');
  assert.strictEqual(resolveSecret('GH_TOKEN'), 'ghs_abc123');
  // Fallback order: GITHUB_TOKEN used when GH_TOKEN missing.
  const store = getSecretStore();
  store.set('GITHUB_TOKEN', 'ghp_def456');
  store.remove('GH_TOKEN');
  assert.strictEqual(resolveSecret('GH_TOKEN', ['GITHUB_TOKEN']), 'ghp_def456');
});

test('resolveSecret returns undefined when absent', () => {
  assert.strictEqual(resolveSecret('NOPE', ['ALSO_MISSING']), undefined);
});

test('envForSecret maps a single env var', () => {
  assert.deepStrictEqual(envForSecret('GH_TOKEN', 'x'), { GH_TOKEN: 'x' });
});

test('redactSecrets masks known secrets from a string', () => {
  const s = 'token=ghs_leaked123 in this error path ghs_leaked123 again';
  const out = redactSecrets(s, 'ghs_leaked123');
  assert.ok(!out.includes('ghs_leaked123'), 'secret removed');
  assert.ok(out.includes('****'), 'mask present');
  assert.ok(out.includes('token='), 'non-secret prose intact');
});

test('redactSecrets handles short or missing secrets gracefully', () => {
  assert.strictEqual(redactSecrets('keep', 'ab', undefined), 'keep');
});
