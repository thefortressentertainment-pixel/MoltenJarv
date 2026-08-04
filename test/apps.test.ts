import assert from 'node:assert';
import { test } from 'node:test';
import { appsTools } from '../src/tools/apps.js';
import type { ToolContext } from '../src/agent/types.js';

const ctx = { config: {}, memory: {}, workdir: '/' } as unknown as ToolContext;

test('app_command is consequential; app_status and process_list are read-only', () => {
  const names = appsTools().map((t) => t.name);
  assert.ok(names.includes('app_command'));
  assert.ok(names.includes('app_status'));
  assert.ok(names.includes('process_list'));
  const cmd = appsTools().find((t) => t.name === 'app_command')!;
  const status = appsTools().find((t) => t.name === 'app_status')!;
  const plist = appsTools().find((t) => t.name === 'process_list')!;
  assert.strictEqual(cmd.consequential, true);
  assert.ok(!status.consequential, 'status reads must not require consent');
  assert.ok(!plist.consequential, 'process list must not require consent');
});

test('app_command refuses unknown apps and unknown actions', async () => {
  const cmd = appsTools().find((t) => t.name === 'app_command')!;
  const noApp = (await cmd.handler({ app: 'photoshop', action: 'open' }, ctx)) as { ok: boolean; error?: string };
  assert.strictEqual(noApp.ok, false);
  assert.match(noApp.error ?? '', /no recipe for app/);
  const noAction = (await cmd.handler({ app: 'spotify', action: 'explode' }, ctx)) as { ok: boolean; error?: string };
  assert.strictEqual(noAction.ok, false);
  assert.match(noAction.error ?? '', /no action/);
});

test('app_command requires app and action', async () => {
  const cmd = appsTools().find((t) => t.name === 'app_command')!;
  const missing = (await cmd.handler({}, ctx)) as { ok: boolean; error?: string };
  assert.strictEqual(missing.ok, false);
  assert.match(missing.error ?? '', /no recipe for app/);
});

test('app_status refuses unknown apps', async () => {
  const status = appsTools().find((t) => t.name === 'app_status')!;
  const res = (await status.handler({ app: 'photoshop' }, ctx)) as { ok: boolean; error?: string };
  assert.strictEqual(res.ok, false);
  assert.match(res.error ?? '', /no recipe for app/);
});

test('app_status "system" reports wifi/bluetooth/volume read-only', async () => {
  const status = appsTools().find((t) => t.name === 'app_status')!;
  const res = (await status.handler({ app: 'system' }, ctx)) as { ok: boolean; system?: { wifi: string; bluetooth: string; volume: string } };
  assert.strictEqual(res.ok, true);
  assert.ok(res.system);
  assert.ok(['on', 'off'].includes(res.system!.wifi));
  assert.ok(['on', 'off'].includes(res.system!.bluetooth));
  assert.match(res.system!.volume, /%\s*$/);
});

test('app_command system knows wifi/bluetooth/dnd/emptyTrash actions (validates without executing)', async () => {
  const cmd = appsTools().find((t) => t.name === 'app_command')!;
  const old = process.env.JARV_GENIE_NO_OPEN;
  process.env.JARV_GENIE_NO_OPEN = '1';
  try {
    for (const action of ['wifiOn', 'wifiOff', 'bluetoothOn', 'bluetoothOff', 'dndOn', 'emptyTrash', 'restart', 'screenshot']) {
      const res = (await cmd.handler({ app: 'system', action }, ctx)) as { ok: boolean; error?: string };
      assert.strictEqual(res.ok, true, `${action} must be a valid system action`);
    }
  } finally {
    if (old === undefined) delete process.env.JARV_GENIE_NO_OPEN;
    else process.env.JARV_GENIE_NO_OPEN = old;
  }
});

test('new app recipes exist (mail, maps, textedit, etc.)', async () => {
  const cmd = appsTools().find((t) => t.name === 'app_command')!;
  const old = process.env.JARV_GENIE_NO_OPEN;
  process.env.JARV_GENIE_NO_OPEN = '1';
  try {
    for (const app of ['mail', 'maps', 'textedit', 'contacts', 'podcasts', 'facetime']) {
      const res = (await cmd.handler({ app, action: 'open' }, ctx)) as { ok: boolean; error?: string };
      assert.strictEqual(res.ok, true, `${app} open must be valid`);
    }
  } finally {
    if (old === undefined) delete process.env.JARV_GENIE_NO_OPEN;
    else process.env.JARV_GENIE_NO_OPEN = old;
  }
});
