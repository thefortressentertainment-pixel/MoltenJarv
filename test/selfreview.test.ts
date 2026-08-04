import assert from 'node:assert';
import { test } from 'node:test';
import { selfReviewTools, readPlan } from '../src/tools/selfreview.js';

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
