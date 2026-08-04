import assert from 'node:assert';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Agent } from '../src/agent/agent.js';
import { composeSystemPrompt, loadSoul } from '../src/config/soul.js';
import type { ChatMessage } from '../src/agent/types.js';

function tmpSoulDir(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'jarv-soul-'));
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(dir, rel);
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, content);
  }
  return dir;
}

const MANIFEST = {
  specVersion: '0.5',
  name: 'jarv-genie',
  displayName: 'Jarv Genie',
  files: { soul: 'SOUL.md' },
};

test('loadSoul reads metadata and SOUL.md content', () => {
  const dir = tmpSoulDir({
    'soul.json': JSON.stringify(MANIFEST),
    'SOUL.md': '# Jarv Genie\n\nI stay true to my soul.',
  });
  try {
    const soul = loadSoul(dir);
    assert.ok(soul);
    assert.strictEqual(soul.name, 'jarv-genie');
    assert.strictEqual(soul.displayName, 'Jarv Genie');
    assert.strictEqual(soul.specVersion, '0.5');
    assert.match(soul.content, /I stay true to my soul/);
    assert.strictEqual(soul.path, path.join(dir, 'SOUL.md'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadSoul honors a custom files.soul path', () => {
  const dir = tmpSoulDir({
    'soul.json': JSON.stringify({ ...MANIFEST, files: { soul: 'persona.md' } }),
    'persona.md': 'custom path soul',
  });
  try {
    const soul = loadSoul(dir);
    assert.ok(soul);
    assert.match(soul.content, /custom path soul/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadSoul returns null for missing dir, manifest, unsupported version, or missing soul file', () => {
  const unsupported = tmpSoulDir({
    'soul.json': JSON.stringify({ ...MANIFEST, specVersion: '9.9' }),
    'SOUL.md': 'x',
  });
  const noFile = tmpSoulDir({ 'soul.json': JSON.stringify(MANIFEST) });
  const noManifest = tmpSoulDir({ 'SOUL.md': 'x' });
  try {
    assert.strictEqual(loadSoul(undefined), null);
    assert.strictEqual(loadSoul(path.join(unsupported, 'nope')), null);
    assert.strictEqual(loadSoul(noManifest), null);
    assert.strictEqual(loadSoul(unsupported), null);
    assert.strictEqual(loadSoul(noFile), null);
  } finally {
    rmSync(unsupported, { recursive: true, force: true });
    rmSync(noFile, { recursive: true, force: true });
    rmSync(noManifest, { recursive: true, force: true });
  }
});

test('loadSoul returns null for a corrupt manifest', () => {
  const dir = tmpSoulDir({ 'soul.json': 'not json', 'SOUL.md': 'x' });
  try {
    assert.strictEqual(loadSoul(dir), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('composeSystemPrompt appends the soul and leaves the prompt alone when absent', () => {
  const soul = loadSoul(
    tmpSoulDir({ 'soul.json': JSON.stringify(MANIFEST), 'SOUL.md': '# Soul\n\nI value truth.' }),
  );
  try {
    assert.ok(soul);
    const composed = composeSystemPrompt('You are Jarv.', soul);
    assert.match(composed, /^You are Jarv\./);
    assert.match(composed, /# Soul: Jarv Genie/);
    assert.match(composed, /I value truth\./);

    assert.strictEqual(composeSystemPrompt('You are Jarv.', null), 'You are Jarv.');
  } finally {
    rmSync(soul!.path, { recursive: true, force: true });
  }
});

test('Agent injects the soul into the system message', async () => {
  const dir = tmpSoulDir({
    'soul.json': JSON.stringify(MANIFEST),
    'SOUL.md': '# Soul\n\nI am anchored.',
  });
  let captured: ChatMessage[] = [];
  const router = {
    streamChat: async (opts: { messages: ChatMessage[] }) => {
      captured = opts.messages;
      return { content: 'Hello', toolCalls: null, provider: 'fake', model: 'fake' };
    },
    chat: async (opts: { messages: ChatMessage[] }) => {
      captured = opts.messages;
      return { content: 'Hello', toolCalls: null, provider: 'fake', model: 'fake' };
    },
  };
  try {
    const agent = new Agent({
      router: router as never,
      tools: { list: () => [], execute: async () => ({ ok: true, result: {} }) } as never,
      memory: {
        sessionLoad: async () => [],
        sessionAppend: async () => {},
        sessionReset: async () => {},
      } as never,
      config: {
        agent: { systemPrompt: 'sys', maxSteps: 3, workdir: path.join(dir, 'ws'), soulPath: dir },
      } as never,
    });
    await agent.run('hi');
    assert.strictEqual(captured[0].role, 'system');
    assert.match(captured[0].content, /# Soul: Jarv Genie/);
    assert.match(captured[0].content, /I am anchored\./);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
