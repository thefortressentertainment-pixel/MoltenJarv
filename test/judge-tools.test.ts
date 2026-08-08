import assert from 'node:assert';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { parseJudgeScore, judgeOutput } from '../src/judge/judge.js';
import { judgeTools } from '../src/tools/judge.js';

test('parseJudgeScore extracts a strict <score> tag and strips it from the note', () => {
  const { score, note } = parseJudgeScore('Solid structure. <score>0.85</score>');
  assert.ok(Math.abs(score - 0.85) < 1e-9);
  assert.ok(!note.includes('<score>'));
  assert.match(note, /Solid structure/);
});

test('parseJudgeScore clamps out-of-band values', () => {
  assert.strictEqual(parseJudgeScore('<score>5</score>').score, 1);
  assert.strictEqual(parseJudgeScore('<score>-5</score>').score, -1);
});

test('parseJudgeScore falls back to bare numeric and returns neutral otherwise', () => {
  assert.strictEqual(parseJudgeScore('0.4').score, 0.4);
  assert.strictEqual(parseJudgeScore('no score here').score, 0);
});

test('judgeOutput decomposes and applies weights with a judge', async () => {
  const result = await judgeOutput(
    { compliance: 1, completeness: 1, fatal: false },
    'write a digest',
    'finished digest',
    { judge: async () => ({ score: 0.5, note: 'good' }) },
  );
  assert.strictEqual(result.fatal, false);
  assert.strictEqual(result.judgeSkipped, false);
  assert.strictEqual(result.inconclusive, false);
  // 1*0.4 + 1*0.4 + 0.5*0.2 = 0.9
  assert.ok(Math.abs(result.total - 0.9) < 1e-9);
  assert.strictEqual(result.note, 'good');
});

test('judgeOutput fatal break skips the LLM judge entirely', async () => {
  let called = false;
  const result = await judgeOutput(
    { compliance: 0, completeness: 0, fatal: true, fatalReason: 'work is empty' },
    'task',
    '',
    { judge: async () => { called = true; return { score: 1 }; } },
  );
  assert.strictEqual(result.fatal, true);
  assert.strictEqual(result.fatalReason, 'work is empty');
  assert.strictEqual(result.judgeSkipped, true);
  assert.strictEqual(called, false);
  assert.strictEqual(result.judgeScore, 0);
});

test('judgeOutput without a configured judge scores deterministically only', async () => {
  const result = await judgeOutput({ compliance: 1, completeness: 0.8, fatal: false }, 't', 'w');
  assert.strictEqual(result.judgeSkipped, true);
  assert.strictEqual(result.inconclusive, false);
  // 1*0.4 + 0.8*0.4 = 0.72
  assert.ok(Math.abs(result.total - 0.72) < 1e-9);
});

test('judgeOutput degrades gracefully when the judge throws (P4)', async () => {
  const result = await judgeOutput(
    { compliance: 1, completeness: 1, fatal: false },
    't',
    'w',
    { judge: async () => { throw new Error('judge down'); } },
  );
  assert.strictEqual(result.inconclusive, true);
  assert.strictEqual(result.judgeSkipped, true);
  assert.strictEqual(result.judgeScore, 0);
  // Deterministic component still counts: 0.4 + 0.4 = 0.8
  assert.ok(Math.abs(result.total - 0.8) < 1e-9);
});

test('judge tool rejects empty work as fatal without calling the provider', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'jarv-judge-tool-'));
  try {
    const [tool] = judgeTools(path.join(dir, 'reviews.json'));
    assert.ok(tool, 'judge tool is exported');
    const ctx = { config: { providers: { primary: { baseUrl: 'http://127.0.0.1:1/v1', model: 'x' } } } } as never;
    const out = (await tool.handler({ task: 'do a thing', work: '' }, ctx)) as {
      fatal: boolean;
      fatalReason?: string;
      persisted: boolean;
      reviewId: string;
    };
    assert.strictEqual(out.fatal, true);
    assert.strictEqual(out.fatalReason, 'work is empty');
    assert.strictEqual(out.persisted, true);
    assert.ok(out.reviewId, 'fatal verdict still persisted');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('judge tool grades work via a provider call and persists', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'jarv-judge-tool-'));
  try {
    const [tool] = judgeTools(path.join(dir, 'reviews.json'));
    // Deterministic (non-fatal) path: compliance and completeness are derived in
    // code; the LLM judge is a real network call to an unreachable port, which
    // must degrade to inconclusive rather than crash (P4). The store still holds
    // the deterministic grade.
    const ctx = { config: { providers: { primary: { baseUrl: 'http://127.0.0.1:1/v1', model: 'x' } } } } as never;
    const out = (await tool.handler({ task: 'summarize', work: 'here is my summary', claimComplete: true }, ctx)) as {
      fatal: boolean;
      inconclusive: boolean;
      persisted: boolean;
      reviewId?: string;
      compliance: number;
      completeness: number;
      total: number;
    };
    assert.strictEqual(out.fatal, false);
    assert.strictEqual(out.compliance, 1);
    assert.strictEqual(out.completeness, 1);
    assert.strictEqual(out.inconclusive, true);
    assert.strictEqual(out.persisted, true);
    assert.strictEqual(out.total, 0.8); // 1*0.4 + 1*0.4, judge neutral

    const { ReviewStore } = await import('../src/judge/store.js');
    const store = new ReviewStore(path.join(dir, 'reviews.json'));
    const saved = await store.get(out.reviewId!);
    assert.ok(saved, 'verdict persisted to the review log');
    assert.strictEqual(saved.inconclusive, true);
    assert.strictEqual(saved.total, 0.8);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('judge tool does not persist when no file path is configured', async () => {
  const [tool] = judgeTools();
  const ctx = { config: { providers: { primary: { baseUrl: 'http://127.0.0.1:1/v1', model: 'x' } } } } as never;
  const out = (await tool.handler({ task: 'x', work: '' }, ctx)) as { persisted: boolean; reviewId?: string };
  assert.strictEqual(out.persisted, false);
  assert.strictEqual(out.reviewId, undefined);
});
