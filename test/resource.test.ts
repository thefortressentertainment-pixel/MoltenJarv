import assert from 'node:assert';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { tryAcquireBusy, releaseBusy, isBusy, freeMemoryPercent, sense, regulate, busyByOthers } from '../src/resource.js';

test('busy lock serializes: second acquirer is refused until release', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'jarv-res-'));
  const lock = path.join(dir, 'busy.lock');
  try {
    assert.strictEqual(isBusy(lock), false);
    assert.strictEqual(tryAcquireBusy(lock), true, 'first acquirer gets the lock');
    assert.strictEqual(isBusy(lock), true, 'lock is visible after acquisition');
    assert.strictEqual(tryAcquireBusy(lock), false, 'second acquirer is refused while held');
    assert.strictEqual(busyByOthers(lock), false, 'our own lock is not reported as others busy');
    releaseBusy(lock);
    assert.strictEqual(isBusy(lock), false, 'lock is free after release');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('busyByOthers is false for our own lock and true for a foreign live lock', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'jarv-busy-'));
  const lock = path.join(dir, 'busy.lock');
  // A real, live foreign process (a long-lived sleep child) to represent "busy".
  const { spawn } = await import('node:child_process');
  const foreign = spawn('sleep', ['30'], { stdio: 'ignore' });
  try {
    // Our own lock (current PID) — not "others busy".
    writeFileSync(lock, `${process.pid}:${Date.now()}`);
    assert.strictEqual(busyByOthers(lock), false, 'own PID lock is not others-busy');

    // A foreign live PID — reported busy.
    writeFileSync(lock, `${foreign.pid}:${Date.now()}`);
    assert.strictEqual(busyByOthers(lock), true, 'foreign live PID lock is others-busy');

    // A dead PID — lock is dead, not busy.
    writeFileSync(lock, `999999:${Date.now()}`);
    assert.strictEqual(busyByOthers(lock), false, 'dead-owner lock is not busy');
  } finally {
    foreign.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('freeMemoryPercent returns a number', async () => {
  const n = await freeMemoryPercent();
  assert.strictEqual(typeof n, 'number');
  assert.ok(n >= 0 && n <= 100);
});

test('autonomic sense() reports vitals as numbers', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'jarv-auto-'));
  const oldHome = process.env.HOME;
  process.env.HOME = dir;
  try {
    mkdirSync(path.join(dir, '.jarv-genie', 'memory', 'sessions'), { recursive: true });
    const vitals = await sense();
    assert.strictEqual(typeof vitals.freeMemoryPercent, 'number');
    assert.strictEqual(typeof vitals.freeDiskPercent, 'number');
    assert.ok(vitals.freeMemoryPercent >= 0 && vitals.freeMemoryPercent <= 100);
    assert.ok(vitals.freeDiskPercent >= 0 && vitals.freeDiskPercent <= 100);
    assert.strictEqual(typeof vitals.contextUsage, 'number');
    assert.strictEqual(typeof vitals.sampledAt, 'number');
    assert.strictEqual(vitals.busy, false, 'no busy lock in a clean temp HOME');
  } finally {
    process.env.HOME = oldHome ?? '';
    rmSync(dir, { recursive: true, force: true });
  }
});

test('autonomic regulate() compacts an overgrown session file', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'jarv-compact-'));
  const oldHome = process.env.HOME;
  process.env.HOME = dir;
  try {
    const sessions = path.join(dir, '.jarv-genie', 'memory', 'sessions');
    mkdirSync(sessions, { recursive: true });
    const big = path.join(sessions, 'chat.jsonl');
    const line = '{"role":"user","content":"' + 'x'.repeat(200) + '"}\n';
    // ~2MB of turns — enough to exceed the autonomic session cap.
    writeFileSync(big, line.repeat(10000));
    const before = statSync(big).size;
    const vitals = { freeMemoryPercent: 60, contextUsage: 1, busy: false, freeDiskPercent: 60, sampledAt: Date.now() };
    const result = await regulate(vitals);
    assert.strictEqual(result, 'compacted', 'overgrown session triggers autonomic compaction');
    const after = statSync(big).size;
    assert.ok(after < before, 'session file shrank');
    assert.ok(after < 100_000, 'session is now a small recent tail');
  } finally {
    process.env.HOME = oldHome ?? '';
    rmSync(dir, { recursive: true, force: true });
  }
});

test('autonomic regulate() is a no-op when vitals are healthy', async () => {
  const vitals = { freeMemoryPercent: 80, contextUsage: 0.1, busy: false, freeDiskPercent: 80, sampledAt: Date.now() };
  const result = await regulate(vitals);
  assert.strictEqual(result, 'ok');
});

test('autonomic regulate() blocks when memory is critically low', async () => {
  const vitals = { freeMemoryPercent: 4, contextUsage: 0.1, busy: false, freeDiskPercent: 80, sampledAt: Date.now() };
  const result = await regulate(vitals);
  assert.strictEqual(result, 'blocked');
});
