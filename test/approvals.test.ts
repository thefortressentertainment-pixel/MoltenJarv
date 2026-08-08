import assert from 'node:assert';
import { test } from 'node:test';
import { requireApproval, requireFailClosedApproval, setApprovalHandler } from '../src/approvals.js';

test('approval handler receives fail-closed=false for normal approvals and true for fail-closed', async () => {
  const seen: Array<{ failClosed?: boolean; risk?: string }> = [];
  setApprovalHandler(async (_q, kind) => {
    seen.push(kind ?? {});
    return true;
  });
  try {
    await requireApproval('run_shell?');
    await requireFailClosedApproval('email_send?');
  } finally {
    setApprovalHandler(null);
  }
  assert.strictEqual(seen.length, 2);
  assert.strictEqual(seen[0]?.failClosed, false);
  assert.strictEqual(seen[1]?.failClosed, true);
  assert.strictEqual(seen[1]?.risk, 'external');
});
