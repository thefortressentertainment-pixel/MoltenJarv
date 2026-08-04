import assert from 'node:assert';
import { test } from 'node:test';
import { uiTools } from '../src/tools/ui.js';
import type { ToolContext } from '../src/agent/types.js';

const ctx = { config: { computer: { allowControl: true } }, memory: {}, workdir: '/tmp' } as unknown as ToolContext;
const noControl = { config: {}, memory: {}, workdir: '/tmp' } as unknown as ToolContext;

test('UI tools are all marked consequential for the consent gate', () => {
  const names = uiTools().map((t) => t.name);
  assert.ok(names.includes('ui_activate'));
  assert.ok(names.includes('ui_click'));
  assert.ok(names.includes('ui_type'));
  assert.ok(names.includes('ui_key'));
  assert.ok(names.includes('ui_get_windows'));
  for (const t of uiTools()) assert.strictEqual(t.consequential, true, `${t.name} should be consequential`);
});

test('UI tools are gated behind allowControl', async () => {
  const activate = uiTools().find((t) => t.name === 'ui_activate')!;
  const res = (await activate.handler({ app: 'Clock' }, noControl)) as { ok: boolean; error?: string };
  assert.strictEqual(res.ok, false);
  assert.match(res.error ?? '', /allowControl/);
});

test('ui_activate and ui_click validate required args', async () => {
  const activate = uiTools().find((t) => t.name === 'ui_activate')!;
  const click = uiTools().find((t) => t.name === 'ui_click')!;
  const a = (await activate.handler({}, ctx)) as { ok: boolean; error?: string };
  assert.match(a.error ?? '', /app is required/);
  const c = (await click.handler({ app: 'Clock' }, ctx)) as { ok: boolean; error?: string };
  assert.match(c.error ?? '', /app and button are required/);
});
