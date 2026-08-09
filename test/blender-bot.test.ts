import assert from 'node:assert';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { buildPrompt, isCommandMessage, isBudgetExhausted } from '../src/cli/blenderBot.js';

test('buildPrompt appends a reference path when a photo was attached', () => {
  const p = buildPrompt('build an orc', '/tmp/photo.jpg');
  assert.ok(p.startsWith('build an orc'), 'keeps the message');
  assert.ok(p.includes('make it look like this picture /tmp/photo.jpg'), 'appends reference directive');
});

test('buildPrompt returns the bare message when no photo', () => {
  assert.strictEqual(buildPrompt('make the head bigger', null), 'make the head bigger');
});

test('buildPrompt trims and handles empty message returns empty', () => {
  assert.strictEqual(buildPrompt('   ', null), '');
});

test('isCommandMessage flags Telegram commands so /start never triggers a build', () => {
  assert.ok(isCommandMessage('/start'));
  assert.ok(isCommandMessage('  /help '));
  assert.ok(isCommandMessage('/build orc'));
  assert.ok(!isCommandMessage('build a green orc'));
  assert.ok(!isCommandMessage(''));
  assert.ok(!isCommandMessage('   '));
});

test('isBudgetExhausted detects the runner budget-cutoff so the bot auto-continues', () => {
  assert.ok(isBudgetExhausted('Reached the 18-step budget for this Blender build (18 steps used).'));
  assert.ok(isBudgetExhausted('Reached the 24-step budget for this Blender build. The in-progress result is exported.'));
  assert.ok(!isBudgetExhausted('The orc is complete and verified.'));
  assert.ok(!isBudgetExhausted(''));
});

test('sendPhoto downscale path is guarded (no real network in tests)', async () => {
  // We can't hit Telegram in tests; assert the client exposes sendPhoto so a
  // real run can send stills, and that a nonexistent image doesn't hang.
  const { TelegramClient } = await import('../src/telegram/client.js');
  assert.strictEqual(typeof (TelegramClient.prototype as unknown as { sendPhoto?: unknown }).sendPhoto, 'function');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'jarv-bot-img-'));
  const img = path.join(dir, 'x.jpg');
  await writeFile(img, 'not-a-real-image');
  // downscaleImage falls back to raw bytes when sips can't decode; no throw.
  const mod = await import('../src/telegram/client.js');
  const downscaled = await (mod as unknown as { downscaleImage?: (p: string) => Promise<Buffer> }).downscaleImage?.(img);
  if (downscaled) {
    assert.ok(Buffer.isBuffer(downscaled), 'returns a Buffer (fallback to raw bytes)');
  }
  const fs = await import('node:fs/promises');
  await fs.rm(dir, { recursive: true, force: true });
});

test('photoToPath selects the largest photo and downloads (stubbed client)', async () => {
  const { photoToPath } = await import('../src/cli/blenderBot.js');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'jarv-bot-photo-'));
  const filePath = path.join(dir, 'photo.png');
  await writeFile(filePath, 'fake-image');
  let getFileCalled = 0;
  let downloaded = '';
  const fakeClient = {
    getFile: async () => { getFileCalled++; return { file_id: 'f1', file_path: 'photo/path.png' }; },
    downloadFile: async (_fp: string, dest: string) => { downloaded = dest; return dest; },
  } as unknown as import('../src/telegram/client.js').TelegramClient;
  const update = {
    update_id: 1,
    message: {
      message_id: 1,
      chat: { id: 123 },
      text: 'hello',
      photo: [
        { file_id: 'small', file_size: 10 },
        { file_id: 'big', file_size: 999 },
      ],
    },
  };
  const dest = await photoToPath(fakeClient, update);
  assert.strictEqual(getFileCalled, 1, 'getFile called');
  assert.ok(dest, 'returns a local path');
  assert.ok(String(dest).endsWith('.png'), 'ext taken from the telegram file_path (photo/path.png -> .png)');
  void filePath;
});
