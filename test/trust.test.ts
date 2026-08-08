import assert from 'node:assert';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test, beforeEach, afterEach } from 'node:test';
import {
  createPairingChallenge,
  verifyPairingCode,
  pairTrustedDevice,
  isTrustedDevice,
  trustedDeviceChatId,
  clearPairingChallenge,
  clearTrustedDevice,
} from '../src/telegram/trust.js';

let home: string;

beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), 'jarv-trust-'));
  process.env.HOME = home;
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

test('create + verify a pairing code round-trips (case-insensitive)', () => {
  const { code } = createPairingChallenge();
  assert.ok(code.length >= 4, 'code is screen-length');
  assert.ok(verifyPairingCode(code.toLowerCase()), 'verification is case-insensitive');
});

test('a wrong code fails verification', () => {
  createPairingChallenge();
  const bogus = 'ZZZZ';
  assert.strictEqual(verifyPairingCode(bogus), false);
});

test('a code is single-use', () => {
  const { code } = createPairingChallenge();
  assert.ok(verifyPairingCode(code));
  assert.strictEqual(verifyPairingCode(code), false, 'second use of same code fails');
});

test('a cleared challenge cannot be verified', async () => {
  createPairingChallenge();
  clearPairingChallenge();
  assert.strictEqual(verifyPairingCode('AAAA'), false);
});

test('pairTrustedDevice records the chat id as trusted', () => {
  pairTrustedDevice('123456');
  assert.strictEqual(trustedDeviceChatId(), '123456');
  assert.ok(isTrustedDevice('123456'));
  assert.strictEqual(isTrustedDevice('99999'), false);
  assert.strictEqual(isTrustedDevice(undefined), false);
  // clear for cleanliness in case the shared home is reused.
  clearTrustedDevice();
});
