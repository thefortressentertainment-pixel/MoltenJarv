import assert from 'node:assert';
import { statSync, rmSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { SecretStore } from '../src/config/secrets.js';
import { resolveApiKey } from '../src/config/index.js';

function tmpStore(): { dir: string; file: string; store: SecretStore } {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'jarv-secrets-'));
  const file = path.join(dir, 'secrets.json');
  return { dir, file, store: new SecretStore(file) };
}

test('SecretStore persists set/get/remove/list and uses 0600 perms', () => {
  const { dir, file, store } = tmpStore();
  try {
    store.set('OPENAI_API_KEY', 'sk-test1234567890abcdef');
    assert.strictEqual(store.get('OPENAI_API_KEY'), 'sk-test1234567890abcdef');
    assert.deepStrictEqual(store.list(), ['OPENAI_API_KEY']);
    assert.strictEqual(statSync(file).mode & 0o777, 0o600);

    const reloaded = new SecretStore(file);
    assert.strictEqual(reloaded.get('OPENAI_API_KEY'), 'sk-test1234567890abcdef');

    assert.strictEqual(store.remove('OPENAI_API_KEY'), true);
    assert.strictEqual(store.remove('OPENAI_API_KEY'), false);
    assert.strictEqual(store.get('OPENAI_API_KEY'), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveApiKey precedence: config > secret store > env', () => {
  const { dir, store } = tmpStore();
  try {
    store.set('OPENAI_API_KEY', 'from-secret-store');

    const cfg = { apiKey: undefined as string | undefined, apiKeyEnv: 'OPENAI_API_KEY', model: 'gpt-4o-mini' };
    const oldEnv = process.env.OPENAI_API_KEY;

    process.env.OPENAI_API_KEY = 'from-env';
    assert.strictEqual(resolveApiKey(cfg, store), 'from-secret-store');

    store.remove('OPENAI_API_KEY');
    assert.strictEqual(resolveApiKey(cfg, store), 'from-env');

    assert.strictEqual(resolveApiKey({ ...cfg, apiKey: 'from-config' }, store), 'from-config');
    assert.strictEqual(resolveApiKey({ model: 'x', apiKeyEnv: 'MISSING_VAR' }, store), undefined);

    if (oldEnv === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = oldEnv;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
