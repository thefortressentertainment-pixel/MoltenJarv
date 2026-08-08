import assert from 'node:assert';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test, beforeEach, afterEach } from 'node:test';
import {
  executorDecision,
  configurePolicy,
  fullAutoSet,
  executeMode,
  trustedPolicy,
  pairTrustedDevice,
  clearTrustedDevice,
  DEFAULT_NEVER_AUTO,
} from '../src/telegram/trust.js';

let home: string;

beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), 'jarv-exec-'));
  process.env.HOME = home;
  pairTrustedDevice('12345'); // a verified device for the tests
});

afterEach(async () => {
  clearTrustedDevice();
  await rm(home, { recursive: true, force: true });
});

test('default policy is confirm mode with nothing auto-ran', () => {
  assert.strictEqual(trustedPolicy().mode, 'confirm');
  assert.strictEqual(executeMode(), false);
  assert.strictEqual(fullAutoSet().size, 0);
  assert.ok(DEFAULT_NEVER_AUTO.length > 0, 'there is a safe never-auto set');
});

test('not-trusted device never executes (hard gate)', () => {
  assert.strictEqual(executorDecision('run_shell', '99999'), 'not-trusted');
  assert.strictEqual(executorDecision('run_shell', undefined), 'not-trusted');
});

test('in confirm mode even a trusted device asks', () => {
  configurePolicy({ mode: 'confirm', addAuto: ['run_shell'] });
  assert.strictEqual(executorDecision('run_shell', '12345'), 'ask');
});

test('in execute mode a trusted device runs only allow-listed tools', () => {
  configurePolicy({ mode: 'execute', addAuto: ['run_shell'] });
  assert.strictEqual(executeMode(), true);
  assert.strictEqual(executorDecision('run_shell', '12345'), 'run');
  assert.strictEqual(executorDecision('file_write', '12345'), 'ask', 'unlisted tool still asks');
});

test('never-autos still ask in execute mode until explicitly allow-listed', () => {
  configurePolicy({ mode: 'execute' });
  // email_send is in DEFAULT_NEVER_AUTO and not allow-listed → asks.
  assert.strictEqual(executorDecision('email_send', '12345'), 'ask');
  // Once explicitly allow-listed, it may run (operator's explicit choice).
  configurePolicy({ addAuto: ['email_send'] });
  assert.strictEqual(executorDecision('email_send', '12345'), 'run');
});

test('deny removes a tool from the allowlist', () => {
  configurePolicy({ mode: 'execute', addAuto: ['run_shell', 'file_write'] });
  configurePolicy({ removeAuto: ['run_shell'] });
  assert.strictEqual(executorDecision('run_shell', '12345'), 'ask');
  assert.strictEqual(executorDecision('file_write', '12345'), 'run');
});

test('fullAutoSet persists additions', () => {
  configurePolicy({ mode: 'execute', addAuto: ['run_shell'] });
  assert.ok(fullAutoSet().has('run_shell'));
});
