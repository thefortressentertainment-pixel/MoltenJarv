import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { schedulerTools } from '../src/tools/scheduler.js';
import { reminderTools } from '../src/tools/reminders.js';
import type { ToolContext } from '../src/agent/types.js';

function withHome(fn: () => Promise<void>): Promise<void> {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'jarv-sched-'));
  const oldHome = process.env.HOME;
  process.env.HOME = dir;
  return fn().finally(() => {
    process.env.HOME = oldHome ?? '';
    rmSync(dir, { recursive: true, force: true });
  });
}

const ctxNoControl = { config: {}, memory: {} } as unknown as ToolContext;
const ctxControl = { config: { computer: { allowControl: true } }, memory: {} } as unknown as ToolContext;

test('scheduler tools add, list, and remove schedules', async () => {
  await withHome(async () => {
    const add = schedulerTools().find((t) => t.name === 'schedule_add')!;
    const list = schedulerTools().find((t) => t.name === 'schedule_list')!;
    const remove = schedulerTools().find((t) => t.name === 'schedule_remove')!;

    const added = (await add.handler({ cron: '0 7 * * 6', prompt: 'Saturday alarm', notify: true }, {} as ToolContext)) as {
      ok: boolean;
      id: string;
    };
    assert.ok(added.ok);
    assert.ok(added.id);

    const l = (await list.handler({}, {} as ToolContext)) as { ok: boolean; schedules: Array<{ id: string; cron: string }> };
    assert.strictEqual(l.schedules.length, 1);
    assert.strictEqual(l.schedules[0]?.cron, '0 7 * * 6');

    const r = (await remove.handler({ id: added.id }, {} as ToolContext)) as { ok: boolean };
    assert.ok(r.ok);
    const l2 = (await list.handler({}, {} as ToolContext)) as { ok: boolean; schedules: unknown[] };
    assert.strictEqual(l2.schedules.length, 0);
  });
});

test('schedule_add validates cron and required fields', async () => {
  await withHome(async () => {
    const add = schedulerTools().find((t) => t.name === 'schedule_add')!;
    const bad = (await add.handler({ cron: 'not a cron', prompt: 'x' }, {} as ToolContext)) as { ok: boolean; error?: string };
    assert.strictEqual(bad.ok, false);
    assert.match(bad.error ?? '', /invalid cron/);
    const missing = (await add.handler({ cron: '0 7 * * *' }, {} as ToolContext)) as { ok: boolean; error?: string };
    assert.strictEqual(missing.ok, false);
    assert.match(missing.error ?? '', /requires a prompt/);
  });
});

test('reminder tools are gated behind allowControl', async () => {
  const create = reminderTools().find((t) => t.name === 'reminder_create')!;
  const res = (await create.handler({ name: 'x' }, ctxNoControl)) as { ok: boolean; error?: string };
  assert.strictEqual(res.ok, false);
  assert.match(res.error ?? '', /allowControl/);
});

test('schedule_add accepts a natural-language `when` phrase', async () => {
  await withHome(async () => {
    const add = schedulerTools().find((t) => t.name === 'schedule_add')!;
    const list = schedulerTools().find((t) => t.name === 'schedule_list')!;

    const ok = (await add.handler({ when: 'every monday at 5pm', prompt: 'Monday alarm', notify: true }, {} as ToolContext)) as {
      ok: boolean;
      cron?: string;
    };
    assert.ok(ok.ok);
    assert.strictEqual(ok.cron, '0 17 * * 1');

    const l = (await list.handler({}, {} as ToolContext)) as { ok: boolean; schedules: Array<{ cron: string }> };
    assert.strictEqual(l.schedules[0]?.cron, '0 17 * * 1');

    const bad = (await add.handler({ when: 'nonsense schedule', prompt: 'x' }, {} as ToolContext)) as { ok: boolean; error?: string };
    assert.strictEqual(bad.ok, false);
    assert.match(bad.error ?? '', /invalid schedule phrase/);
  });
});

test('schedule_add still requires cron or when plus prompt', async () => {
  await withHome(async () => {
    const add = schedulerTools().find((t) => t.name === 'schedule_add')!;
    const noWhen = (await add.handler({ prompt: 'x' }, {} as ToolContext)) as { ok: boolean; error?: string };
    assert.strictEqual(noWhen.ok, false);
    assert.match(noWhen.error ?? '', /cron expression or a `when` phrase/);
  });
});

test('reminder_create validates the name field', async () => {
  const create = reminderTools().find((t) => t.name === 'reminder_create')!;
  const res = (await create.handler({}, ctxControl)) as { ok: boolean; error?: string };
  assert.strictEqual(res.ok, false);
  assert.match(res.error ?? '', /name is required/);
});
