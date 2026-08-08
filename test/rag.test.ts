import assert from 'node:assert';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { chunkText, stableHash, buildIndex, queryIndex, loadIndex, cosine, jaccard, discoverFiles } from '../src/rag.js';

test('chunkText splits on word boundaries up to chunkChars with overlap', () => {
  const text = Array.from({ length: 200 }, (_, i) => `word${i}`).join(' ');
  const chunks = chunkText(text, 500, 100);
  assert.ok(chunks.length > 1);
  // "wordN" is 6 chars incl. space → ~500/6 ≈ 83 words per 500-char chunk.
  assert.ok(chunks.every((c) => c.split(' ').length <= 90), 'each chunk bounded');
  // Overlap carries tail tokens into the next chunk.
  const overlap = chunkText(text, 100, 30);
  assert.ok(overlap.length > 3);
});

test('chunkText returns empty for blank input', () => {
  assert.deepStrictEqual(chunkText('   '), []);
});

test('stableHash is deterministic and differs across strings', () => {
  assert.strictEqual(stableHash('abc'), stableHash('abc'));
  assert.notStrictEqual(stableHash('abc'), stableHash('abd'));
});

test('discoverFiles finds indexable text files and skips node_modules/.git', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'jarv-rag-'));
  try {
    const docs = path.join(dir, 'docs');
    const fsp = await import('node:fs/promises');
    await fsp.mkdir(docs, { recursive: true });
    await fsp.writeFile(path.join(docs, 'notes.md'), '# Notes\nhello there');
    await fsp.writeFile(path.join(docs, 'data.json'), '{"a":1}');
    await fsp.writeFile(path.join(docs, 'image.png'), 'nottext');
    await fsp.writeFile(path.join(dir, 'node_modules'), 'x');
    await fsp.writeFile(path.join(dir, '.git'), 'x');
    const files = await discoverFiles(dir, { maxFiles: 100 });
    const names = files.map((f) => path.basename(f.file));
    assert.ok(names.includes('notes.md'));
    assert.ok(names.includes('data.json'));
    assert.ok(!names.includes('image.png'), 'png not indexed');
    assert.ok(!names.some((n) => n === 'node_modules' || n === '.git'), 'skip dirs');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('buildIndex embeds, persists, and reuses unchanged chunk ids on a second run', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'jarv-rag-'));
  try {
    const fsp = await import('node:fs/promises');
    const src = path.join(dir, 'src');
    await fsp.mkdir(src, { recursive: true });
    const md = path.join(src, 'about.md');
    await fsp.writeFile(md, 'Jarv is a local-first assistant. It respects privacy by default.');

    const indexFile = path.join(dir, 'index.json');
    const stubEmbed = async (texts: string[]): Promise<number[][]> => texts.map(() => [1, 2, 3]);

    const first = await buildIndex(src, indexFile, stubEmbed);
    assert.ok(first.indexedFiles >= 1);
    assert.ok(first.chunks >= 1);
    const idx = await loadIndex(indexFile);
    assert.ok(idx.chunks.length > 0);
    assert.ok(idx.chunks.every((c) => c.vector && c.vector.length === 3));

    // Second run: reuses unchanged (same mtime) chunk ids — no new chunks.
    const second = await buildIndex(src, indexFile, stubEmbed);
    assert.strictEqual(second.newChunks, 0, 'unchanged file reuses chunk ids');
    assert.ok(second.chunks >= first.chunks);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('queryIndex ranks by cosine when vectors exist', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'jarv-rag-'));
  try {
    const fsp = await import('node:fs/promises');
    const src = path.join(dir, 'src');
    await fsp.mkdir(src, { recursive: true });
    await fsp.writeFile(path.join(src, 'a.md'), 'Jarv is a local-first AI assistant respecting privacy on the Mac.');
    await fsp.writeFile(path.join(src, 'b.md'), 'The weather is sunny and warm in the afternoon.');
    const indexFile = path.join(dir, 'index.json');

    // Embedding: cosine reflects token overlap between query and chunk.
    const vocab = ['jarv', 'local', 'first', 'ai', 'assistant', 'respects', 'privacy', 'mac', 'weather', 'sunny', 'warm', 'afternoon'];
    const toVec = (s: string): number[] => {
      const toks = s.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 1);
      return vocab.map((v) => (toks.includes(v) ? 1 : 0));
    };
    await buildIndex(src, indexFile, async (texts) => texts.map(toVec));

    const index = await loadIndex(indexFile);
    const hits = await queryIndex(index, 'jarv local assistant privacy mac', async (texts) => texts.map(toVec), 2);
    assert.ok(hits.length >= 1);
    const top = hits[0]!;
    assert.strictEqual(top.file, 'a.md', 'privacy/mac chunk ranks top');
    assert.ok(top.score > 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('cosine and jaccard math are sane', () => {
  assert.strictEqual(cosine([], []), 0);
  assert.strictEqual(cosine([1, 0], [0, 1]), 0);
  assert.ok(cosine([1, 1], [1, 1]) > 0.99);
  assert.strictEqual(jaccard('alpha beta gamma', 'delta epsilon zeta'), 0);
  assert.strictEqual(jaccard('alpha beta', 'alpha beta'), 1);
});
