import assert from 'node:assert';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { selfReviewTools, readPlan, readQuality } from '../src/tools/selfreview.js';
import { ReviewStore } from '../src/judge/store.js';

test('self_review tool is exposed', () => {
  const tool = selfReviewTools().find((t) => t.name === 'self_review')!;
  assert.ok(tool);
  assert.strictEqual(typeof tool.handler, 'function');
});

test('readPlan reads the optimization plan', () => {
  const plan = readPlan();
  assert.strictEqual(plan.exists, true);
  assert.ok(Array.isArray(plan.openItems));
});

test('readQuality returns null when no reviews file is configured', async () => {
  assert.strictEqual(await readQuality(), null);
});

test('readQuality reports count, latest total, and signed delta from the review log', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'jarv-sq-'));
  try {
    const file = path.join(dir, 'reviews.json');
    // A path with no file yet → empty summary (count 0, no latest, no delta).
    const empty = await readQuality(file);
    assert.ok(empty !== null, 'configured path is not null even when empty');
    assert.strictEqual(empty.reviewCount, 0);
    assert.strictEqual(empty.latest, undefined);
    assert.strictEqual(empty.delta, null);

    const store = new ReviewStore(file);
    await store.add({ kind: 'task', compliance: 0.5, completeness: 0.5, judgeScore: 0, total: 0.4, fatal: false });
    let q = await readQuality(file);
    assert.strictEqual(q?.reviewCount, 1);
    assert.strictEqual(q?.latest?.total, 0.4);
    assert.strictEqual(q?.delta, null, 'single review → no delta');

    await store.add({ kind: 'task', compliance: 0.8, completeness: 0.8, judgeScore: 0, total: 0.9, fatal: false });
    q = await readQuality(file);
    assert.strictEqual(q?.reviewCount, 2);
    assert.ok(q !== null && q.delta !== null && q.delta > 0, 'improving quality is a positive delta');
    assert.strictEqual(q?.latest?.total, 0.9);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
