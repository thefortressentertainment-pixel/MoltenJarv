import assert from 'node:assert';
import { test } from 'node:test';
import { speechTools } from '../src/tools/speech.js';
import { splitSentences, hasTts, sayVoices } from '../src/voice/index.js';

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
