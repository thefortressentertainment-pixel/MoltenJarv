import assert from 'node:assert';
import { test } from 'node:test';
import { ToolRegistry } from '../src/tools/registry.js';
import type { ToolDefinition } from '../src/agent/types.js';

const t = (name: string, system?: ToolDefinition['system']): ToolDefinition => ({
  name,
  description: `tool ${name}`,
  inputSchema: { type: 'object', properties: {} },
  handler: async () => ({}),
  ...(system ? { system } : {}),
});

test('registry groups organs by body system', () => {
  const reg = new ToolRegistry();
  reg.registerMany([
    t('screen_capture', 'sense'),
    t('system_status', 'sense'),
    t('run_shell', 'effector'),
    t('app_command', 'effector'),
    t('remember', 'memory'),
    t('speak_text', 'voice'),
    t('self_review', 'autonomic'),
    t('deliverylog_verify', 'immune'),
    t('telegram_send', 'integration'),
  ]);
  assert.deepStrictEqual(reg.senses().map((x) => x.name).sort(), ['screen_capture', 'system_status']);
  assert.deepStrictEqual(reg.effectors().map((x) => x.name).sort(), ['app_command', 'run_shell']);
  const organs = reg.organs();
  assert.strictEqual(organs.get('sense')?.length, 2);
  assert.strictEqual(organs.get('memory')?.[0]?.name, 'remember');
  assert.strictEqual(organs.get('immune')?.[0]?.name, 'deliverylog_verify');
  assert.strictEqual(organs.get('integration')?.[0]?.name, 'telegram_send');
  assert.strictEqual(organs.get('voice')?.[0]?.name, 'speak_text');
  assert.strictEqual(organs.get('autonomic')?.[0]?.name, 'self_review');
});

test('registry lists untagged tools separately and bySystem filters', () => {
  const reg = new ToolRegistry();
  reg.register(t('tagged', 'sense'));
  reg.register(t('untagged'));
  assert.strictEqual(reg.list().length, 2);
  assert.strictEqual(reg.bySystem('sense').length, 1);
  assert.strictEqual(reg.list().filter((x) => !x.system).length, 1, 'one tool has no organ tag');
});
