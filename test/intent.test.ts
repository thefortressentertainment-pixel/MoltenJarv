import assert from 'node:assert';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Inbox } from '../src/inbox.js';
import { WakeStore } from '../src/selfwake.js';
import { routeBlocker } from '../src/unattended.js';
import { toolRisk } from '../src/risk.js';
import type { ToolDefinition } from '../src/agent/types.js';

function tmpdir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), 'jarv-inbox-'));
}

// ── Inbox (P6) ────────────────────────────────────────────────────────
test('Inbox parks, lists, and resolves pending asks idempotently', async () => {
  const dir = await tmpdir();
  try {
    const inbox = new Inbox(path.join(dir, 'inbox.json'));
    const a = await inbox.park('s1', 'tc1', 'approve send_message?', {});
    assert.strictEqual(a.status, 'pending');

    // Idempotent: parking the same (session, toolCallId) returns the same pending item.
    const again = await inbox.park('s1', 'tc1', 'approve send_message?', {});
    assert.strictEqual(again.id, a.id);
    assert.strictEqual((await inbox.pending()).length, 1);

    // Resolve by id (first-responder-wins).
    assert.strictEqual(await inbox.resolveById(a.id, true, 'yes'), true);
    assert.strictEqual(await inbox.resolveById(a.id, true), false, 'already resolved');
    assert.strictEqual((await inbox.pending()).length, 0);
    assert.strictEqual((await inbox.get(a.id))?.resolution, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Inbox distinguishes inline vs inbox visibility', async () => {
  const dir = await tmpdir();
  try {
    const inbox = new Inbox(path.join(dir, 'inbox.json'));
    const inline = await inbox.park('s1', 'tc1', 'q', { inline: true });
    const queued = await inbox.park('s2', 'tc2', 'q2', { inline: false });
    assert.strictEqual(inline.visibility, 'inline');
    assert.strictEqual(queued.visibility, 'inbox');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── Self-wake (P7) ────────────────────────────────────────────────────
test('WakeStore schedules, polls due, and fires', async () => {
  const dir = await tmpdir();
  try {
    const wake = new WakeStore(dir);
    await wake.schedule('do report', Date.now() - 1000);
    await wake.schedule('do later', Date.now() + 60_000);
    assert.strictEqual((await wake.due()).length, 1);

    const fired = await wake.pollDue();
    assert.strictEqual(fired.length, 1);
    assert.strictEqual(fired[0]!.prompt, 'do report');
    assert.strictEqual((await wake.due()).length, 0, 'fired wakes are no longer due');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('WakeStore dedupes a pending job wake and cancel removes it', async () => {
  const dir = await tmpdir();
  try {
    const wake = new WakeStore(dir);
    const id = await wake.schedule('by job', Date.now() - 1, 'job-x');
    const again = await wake.schedule('by job', Date.now() - 1, 'job-x');
    assert.strictEqual(again, id, 'same job deduped');
    assert.strictEqual(await wake.cancel(id), true);
    assert.strictEqual((await wake.due()).length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── Unattended routing (P8) ───────────────────────────────────────────
const def = (name: string, over: Partial<ToolDefinition> = {}): ToolDefinition => ({
  name, description: name, inputSchema: { type: 'object', properties: {} }, handler: async () => ({}), ...over,
});

test('attended blockers run inline (no parking)', async () => {
  const dir = await tmpdir();
  try {
    const inbox = new Inbox(path.join(dir, 'inbox.json'));
    const r = await routeBlocker({
      tool: def('file_write', { consequential: true }), unattended: false, inbox, sessionId: 's', toolCallId: 't', prompt: 'q',
    });
    assert.strictEqual(r.outcome, 'run');
    assert.strictEqual((await inbox.pending()).length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('unattended non-external blockers are parked; external/fail-closed refuse', async () => {
  const dir = await tmpdir();
  try {
    // A fail-closed external tool refuses even unattended (must not auto-run/park-wait).
    const ext = def('email_send', { failClosed: true, risk: 'external' as const });
    const inbox = new Inbox(path.join(dir, 'inbox.json'));
    assert.strictEqual(toolRisk(ext), 'external');
    const refuse = await routeBlocker({
      tool: ext, unattended: true, inbox, sessionId: 's', toolCallId: 't', prompt: 'send?', failClosed: true,
    });
    assert.strictEqual(refuse.outcome, 'refuse');

    // A plain consequential write parks to the inbox.
    const wr = def('file_write', { consequential: true });
    const park = await routeBlocker({
      tool: wr, unattended: true, inbox, sessionId: 's', toolCallId: 't2', prompt: 'write?',
    });
    assert.strictEqual(park.outcome, 'park');
    assert.ok((park as { itemId?: string }).itemId);
    assert.strictEqual((await inbox.pending()).length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
