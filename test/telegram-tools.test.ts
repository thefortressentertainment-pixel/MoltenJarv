import assert from 'node:assert';
import { test } from 'node:test';
import { telegramTools } from '../src/tools/telegram.js';
import type { ToolContext } from '../src/agent/types.js';

const ctx = { config: {}, memory: {}, workdir: '/' } as unknown as ToolContext;

test('telegram_send exists and is consequential', () => {
  const tool = telegramTools().find((t) => t.name === 'telegram_send')!;
  assert.ok(tool);
  assert.strictEqual(tool.consequential, true);
});

test('telegram_send requires text', async () => {
  const tool = telegramTools().find((t) => t.name === 'telegram_send')!;
  const empty = (await tool.handler({}, ctx)) as { ok: boolean; error?: string };
  assert.match(empty.error ?? '', /text is required/);
});
