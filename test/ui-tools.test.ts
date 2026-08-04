import assert from 'node:assert';
import { test } from 'node:test';
import { uiTools } from '../src/tools/ui.js';
import type { ToolContext } from '../src/agent/types.js';

const ctx = { config: { computer: { allowControl: true } }, memory: {}, workdir: '/tmp' } as unknown as ToolContext;
const noControl = { config: {}, memory: {}, workdir: '/tmp' } as unknown as ToolContext;

test('mutating UI tools are consequential; the read-only one is not', () => {
  const consequential = new Set(uiTools().filter((t) => t.consequential).map((t) => t.name));
  assert.ok(consequential.has('ui_activate'));
  assert.ok(consequential.has('ui_click'));
  assert.ok(consequential.has('ui_type'));
  assert.ok(consequential.has('ui_key'));
  assert.ok(consequential.has('ui_quit'));
  assert.ok(!consequential.has('ui_get_windows'), 'listing windows is read-only');
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
