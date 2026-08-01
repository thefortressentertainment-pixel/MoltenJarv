import assert from 'node:assert';
import { test } from 'node:test';
import { readFileSync, unlinkSync } from 'node:fs';
import { speechTools } from '../src/tools/speech.js';
import { splitSentences, hasTts, sayVoices, writeWav } from '../src/voice/index.js';
import { matchWakePhrase, expandWakePhrases, DEFAULT_WAKE_PHRASES } from '../src/voice/wake.js';

test('splitSentences breaks on sentence boundaries and newlines', () => {
  assert.deepStrictEqual(splitSentences('Hi there. How are you? Fine, thanks!'), ['Hi there.', 'How are you?', 'Fine, thanks!']);
  assert.deepStrictEqual(splitSentences('First line\nsecond line'), ['First line', 'second line']);
  assert.deepStrictEqual(splitSentences('   '), []);
  assert.deepStrictEqual(splitSentences('No punctuation here'), ['No punctuation here']);
});

test('speechTools exposes a speak_text tool with TTS capability', () => {
  const tool = speechTools().find((t) => t.name === 'speak_text');
  assert.ok(tool);
  assert.strictEqual(typeof tool.handler, 'function');
  assert.strictEqual(typeof hasTts(), 'boolean');
  if (hasTts()) {
    assert.ok(sayVoices().length > 0, 'macOS should expose say voices');
  }
});

test('matchWakePhrase detects the phrase at the start of an utterance', () => {
  const m = matchWakePhrase('hey jarv, what time is it', DEFAULT_WAKE_PHRASES);
  assert.ok(m);
  assert.strictEqual(m.phrase, 'hey jarv');
  assert.strictEqual(m.command, 'what time is it');
});

test('matchWakePhrase handles whisper renderings without punctuation', () => {
  assert.strictEqual(matchWakePhrase('hey jarv what time is it', DEFAULT_WAKE_PHRASES)?.command, 'what time is it');
  assert.strictEqual(matchWakePhrase('okay jarv tell me a joke', DEFAULT_WAKE_PHRASES)?.command, 'tell me a joke');
  assert.strictEqual(matchWakePhrase('hey jar what time is it', DEFAULT_WAKE_PHRASES)?.command, 'what time is it');
});

test('matchWakePhrase handles the phrase at the end', () => {
  const m = matchWakePhrase('what time is it, hey jarv', DEFAULT_WAKE_PHRASES);
  assert.ok(m);
  assert.strictEqual(m.command, 'what time is it');
});

test('matchWakePhrase returns an empty command for a bare wake word', () => {
  const m = matchWakePhrase('hey jarv', DEFAULT_WAKE_PHRASES);
  assert.ok(m);
  assert.strictEqual(m.command, '');
});

test('matchWakePhrase returns null when no phrase is present', () => {
  assert.strictEqual(matchWakePhrase('tell me a joke', DEFAULT_WAKE_PHRASES), null);
  assert.strictEqual(matchWakePhrase('', DEFAULT_WAKE_PHRASES), null);
});

test('custom wake phrases work and whisper synonyms are added for defaults', () => {
  assert.strictEqual(matchWakePhrase('computer, run diagnostics', ['computer'])?.command, 'run diagnostics');
  assert.ok(expandWakePhrases(['hey jarv']).length >= 3, 'default phrases get synonym expansion');
});

test('writeWav produces a valid 16kHz mono WAV header', () => {
  const file = '/tmp/jarv-test.wav';
  writeWav(file, Buffer.alloc(32000));
  const b = readFileSync(file);
  assert.strictEqual(b.toString('ascii', 0, 4), 'RIFF');
  assert.strictEqual(b.toString('ascii', 8, 12), 'WAVE');
  assert.strictEqual(b.readUInt32LE(24), 16000);
  assert.strictEqual(b.readUInt16LE(22), 1);
  assert.strictEqual(b.readUInt32LE(40), 32000);
  unlinkSync(file);
});
