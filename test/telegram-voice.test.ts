import assert from 'node:assert';
import { test } from 'node:test';
import { audioFileId } from '../src/telegram/voice.js';

test('audioFileId detects a Telegram voice note (OPUS)', () => {
  const r = audioFileId({ voice: { file_id: 'V1', duration: 5, mime_type: 'audio/ogg' } });
  assert.deepStrictEqual(r, { fileId: 'V1', ext: '.ogg' });
});

test('audioFileId detects an audio file', () => {
  const r = audioFileId({ audio: { file_id: 'A1', duration: 10, mime_type: 'audio/mpeg' } });
  assert.deepStrictEqual(r, { fileId: 'A1', ext: '.m4a' });
});

test('audioFileId detects an audio document and infers extension from filename', () => {
  const r = audioFileId({ document: { file_id: 'D1', file_name: 'clip.mp3', mime_type: 'audio/mpeg' } });
  assert.deepStrictEqual(r, { fileId: 'D1', ext: '.mp3' });
});

test('audioFileId returns null for an image or no media', () => {
  assert.strictEqual(audioFileId({ photo: [{ file_id: 'P1' }] }), null);
  assert.strictEqual(audioFileId({}), null);
  assert.strictEqual(audioFileId({ document: { file_id: 'D2', file_name: 'x.png', mime_type: 'image/png' } }), null);
});

test('audioFileId defaults a non-matching extension to .mp3', () => {
  const r = audioFileId({ document: { file_id: 'D3', file_name: 'clip.tmp', mime_type: 'audio/x-weird' } });
  assert.deepStrictEqual(r, { fileId: 'D3', ext: '.mp3' });
});
