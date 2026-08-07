import assert from 'node:assert';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { test } from 'node:test';
import { loadPhone, phonePath } from '../src/cli/phone.js';

test('phone config defaults to empty when absent', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'jarv-phone-nf-'));
  const oldHome = process.env.HOME;
  process.env.HOME = dir;
  try {
    assert.deepStrictEqual(loadPhone(), {});
  } finally {
    process.env.HOME = oldHome ?? '';
    rmSync(dir, { recursive: true, force: true });
  }
});

test('phone config round-trips host + endpoint', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'jarv-phone-rw-'));
  const oldHome = process.env.HOME;
  process.env.HOME = dir;
  try {
    const file = phonePath();
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ host: '100.124.60.73', endpoint: '100.124.60.73:43345' }) + '\n');
    const cfg = loadPhone();
    assert.strictEqual(cfg.host, '100.124.60.73');
    assert.strictEqual(cfg.endpoint, '100.124.60.73:43345');
  } finally {
    process.env.HOME = oldHome ?? '';
    rmSync(dir, { recursive: true, force: true });
  }
});
