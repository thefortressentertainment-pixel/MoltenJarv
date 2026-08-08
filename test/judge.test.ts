import assert from 'node:assert';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ReviewStore } from '../src/judge/store.js';
import type { ReviewEntry } from '../src/judge/types.js';

test('ReviewStore persists adds and reloads from disk', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'jarv-judge-'));
  try {
    const store = new ReviewStore(path.join(dir, 'reviews.json'));
    const a = await store.add({
      kind: 'task',
      label: 'scored self-review',
      compliance: 2,
      completeness: 3,
      judgeScore: 1.5,
      total: 6.5,
      fatal: false,
      note: 'clean',
    });
    const b = await store.add({
      kind: 'improvement',
      compliance: 1,
      completeness: 1,
      judgeScore: 0,
      total: 2,
      fatal: true,
      note: 'contract break',
    });
    assert.strictEqual(await store.count(), 2);
    assert.ok(a.id);
    assert.ok(a.ts);

    // A fresh instance reads the same entries.
    const reloaded = new ReviewStore(path.join(dir, 'reviews.json'));
    assert.strictEqual(await reloaded.count(), 2);
    assert.strictEqual((await reloaded.get(a.id))?.total, 6.5);
    assert.strictEqual((await reloaded.get(b.id))?.fatal, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('ReviewStore stamps id and ts when absent', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'jarv-judge-'));
  try {
    const store = new ReviewStore(path.join(dir, 'reviews.json'));
    const e = await store.add({ kind: 'task', compliance: 0, completeness: 0, judgeScore: 0, total: 0, fatal: false });
    assert.ok(e.id, 'id stamped');
    assert.ok(e.ts, 'ts stamped');
    assert.ok(e.id.length > 0 && e.ts.length > 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('ReviewStore.remove deletes by id and reports unknown ids', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'jarv-judge-'));
  try {
    const store = new ReviewStore(path.join(dir, 'reviews.json'));
    const e = await store.add({ kind: 'task', compliance: 1, completeness: 1, judgeScore: 1, total: 3, fatal: false });
    assert.strictEqual(await store.remove(e.id), true);
    assert.strictEqual(await store.count(), 0);
    assert.strictEqual(await store.remove(e.id), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('ReviewStore.summary returns count, latest, and signed delta', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'jarv-judge-'));
  try {
    const store = new ReviewStore(path.join(dir, 'reviews.json'));
    const base = { kind: 'task' as const, compliance: 2, completeness: 2, judgeScore: 1, fatal: false };

    // < 2 entries → no delta.
    await store.add({ ...base, total: 5 });
    let s = await store.summary();
    assert.strictEqual(s.count, 1);
    assert.strictEqual(s.delta, null);
    assert.strictEqual(s.latest?.total, 5);

    // Higher score on the latest entry → positive delta.
    await store.add({ ...base, total: 6.8 });
    s = await store.summary();
    assert.strictEqual(s.count, 2);
    assert.ok(s.delta !== null && s.delta > 0, 'improvement is a positive delta');
    assert.strictEqual(s.latest?.total, 6.8);

    // Still persists across a fresh instance.
    const reloaded = new ReviewStore(path.join(dir, 'reviews.json'));
    const s2 = await reloaded.summary();
    assert.ok(s2.delta !== null && Math.abs(s2.delta - 1.8) < 1e-9);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('ReviewStore handles an empty or missing store', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'jarv-judge-'));
  try {
    const store = new ReviewStore(path.join(dir, 'reviews.json'));
    assert.strictEqual(await store.count(), 0);
    assert.deepStrictEqual(await store.list(), []);
    const s = await store.summary();
    assert.strictEqual(s.count, 0);
    assert.strictEqual(s.latest, undefined);
    assert.strictEqual(s.delta, null);
    assert.strictEqual(await store.remove('missing'), false);
    assert.strictEqual(await store.get('missing'), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('ReviewEntry shape is preserved on round-trip', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'jarv-judge-'));
  try {
    const store = new ReviewStore(path.join(dir, 'reviews.json'));
    const entry: ReviewEntry = {
      id: 'review-1',
      ts: new Date().toISOString(),
      kind: 'improvement',
      label: 'before/after',
      compliance: 3.5,
      completeness: 2,
      judgeScore: 1.25,
      total: 6.75,
      fatal: false,
      inconclusive: true,
      note: 'judge unavailable',
      detail: 'compacted prior context',
    };
    await store.add(entry);
    const reloaded = new ReviewStore(path.join(dir, 'reviews.json'));
    const got = await reloaded.get('review-1');
    assert.ok(got);
    assert.strictEqual(got.id, 'review-1');
    assert.strictEqual(got.kind, 'improvement');
    assert.strictEqual(got.compliance, 3.5);
    assert.strictEqual(got.completeness, 2);
    assert.strictEqual(got.judgeScore, 1.25);
    assert.strictEqual(got.total, 6.75);
    assert.strictEqual(got.fatal, false);
    assert.strictEqual(got.inconclusive, true);
    assert.strictEqual(got.note, 'judge unavailable');
    assert.strictEqual(got.detail, 'compacted prior context');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
