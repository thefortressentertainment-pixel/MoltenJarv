import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createInitiativeStore } from '../src/initiatives.js';
import { initiativeTools } from '../src/tools/initiative.js';
import { resetSecretStore } from '../src/config/secrets.js';
import type { ToolContext } from '../src/agent/types.js';

async function withHome(fn: () => Promise<void>): Promise<void> {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'jarv-init-'));
  const oldHome = process.env.HOME;
  process.env.HOME = dir;
  resetSecretStore();
  try {
    await fn();
  } finally {
    process.env.HOME = oldHome ?? '';
    resetSecretStore();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('initiative store adds, lists, and updates status', async () => {
  await withHome(async () => {
    const store = createInitiativeStore();
    const i = store.add({ idea: 'Automate my morning briefing', rationale: 'Saves time daily', value: 'high', effort: 'low' });
    assert.strictEqual(i.status, 'proposed');
    assert.strictEqual(store.openCount(), 1);
    const set = store.setStatus(i.id, 'approved');
    assert.ok(set);
    assert.strictEqual(store.get(i.id)!.status, 'approved');
    assert.strictEqual(store.openCount(), 1);
    store.setStatus(i.id, 'done');
    assert.strictEqual(store.openCount(), 0);
  });
});

test('initiative tools are exposed; list is read-only, propose/status are consequential', () => {
  const names = initiativeTools().map((t) => t.name);
  assert.ok(names.includes('initiative_propose'));
  assert.ok(names.includes('initiative_list'));
  assert.ok(names.includes('initiative_status'));
  const list = initiativeTools().find((t) => t.name === 'initiative_list')!;
  const propose = initiativeTools().find((t) => t.name === 'initiative_propose')!;
  const status = initiativeTools().find((t) => t.name === 'initiative_status')!;
  assert.ok(!list.consequential);
  assert.strictEqual(propose.consequential, true);
  assert.strictEqual(status.consequential, true);
});

test('initiative_propose stores an initiative without sending real Telegram (isolated)', async () => {
  await withHome(async () => {
    const ctx = { config: {}, memory: {}, workdir: '/' } as unknown as ToolContext;
    const propose = initiativeTools().find((t) => t.name === 'initiative_propose')!;
    const list = initiativeTools().find((t) => t.name === 'initiative_list')!;
    const res = (await propose.handler({ idea: 'Test idea', rationale: 'To verify' }, ctx)) as { ok: boolean; error?: string };
    assert.strictEqual(res.ok, true, res.error);
    const l = (await list.handler({}, ctx)) as { ok: boolean; count: number };
    assert.strictEqual(l.count, 1);
  });
});

test('initiative_status validates the status value', async () => {
  await withHome(async () => {
    const ctx = { config: {}, memory: {}, workdir: '/' } as unknown as ToolContext;
    const status = initiativeTools().find((t) => t.name === 'initiative_status')!;
    const bad = (await status.handler({ id: 'x', status: 'maybe' }, ctx)) as { ok: boolean; error?: string };
    assert.strictEqual(bad.ok, false);
    assert.match(bad.error ?? '', /valid status/);
  });
});
