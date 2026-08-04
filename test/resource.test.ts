import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tryAcquireBusy, releaseBusy, isBusy, freeMemoryPercent } from '../src/resource.js';

test('busy lock serializes: second acquirer is refused until release', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'jarv-res-'));
  const oldHome = process.env.HOME;
  process.env.HOME = dir;
  try {
    assert.strictEqual(isBusy(), false);
    assert.strictEqual(tryAcquireBusy(), true, 'first acquirer gets the lock');
    assert.strictEqual(isBusy(), true, 'lock is visible after acquisition');
    assert.strictEqual(tryAcquireBusy(), false, 'second acquirer is refused while held');
    releaseBusy();
    assert.strictEqual(isBusy(), false, 'lock is free after release');
  } finally {
    process.env.HOME = oldHome ?? '';
    rmSync(dir, { recursive: true, force: true });
  }
});

test('freeMemoryPercent returns a number', async () => {
  const n = await freeMemoryPercent();
  assert.strictEqual(typeof n, 'number');
  assert.ok(n >= 0 && n <= 100);
});
