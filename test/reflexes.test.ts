import assert from 'node:assert';
import { test } from 'node:test';
import { reflex } from '../src/reflexes.js';
import type { ToolCall } from '../src/agent/types.js';

const call = (name: string, args?: Record<string, unknown>): ToolCall => ({ id: 't1', name, arguments: args ?? {} });

test('reflex blocks file tools that touch credential files', () => {
  assert.strictEqual(reflex(call('file_read_any', { path: '/Users/tfe/.jarv-genie/secrets.json' })).kind, 'blocked');
  assert.strictEqual(reflex(call('file_write_any', { path: '~/auth.json' })).kind, 'blocked');
  assert.strictEqual(reflex(call('file_delete_any', { path: '/x/link.json' })).kind, 'blocked');
  assert.strictEqual(reflex(call('file_move_any', { from: '/x/secrets.json', to: '/y/backup.json' })).kind, 'blocked');
});

test('reflex blocks shell commands that reference secrets or auth state', () => {
  assert.strictEqual(reflex(call('run_shell', { command: 'cat ~/.jarv-genie/secrets.json' })).kind, 'blocked');
  assert.strictEqual(reflex(call('run_shell', { command: 'echo $DEEPSEEK_API_KEY' })).kind, 'blocked');
  // A safe shell command is NOT a fast-path reflex — it is consequential and
  // must reach the consent gate for the cortex to decide.
  assert.strictEqual(reflex(call('run_shell', { command: 'ls ~/Documents' })).kind, 'pass');
});

test('reflex blocks code_edit on credential files', () => {
  assert.strictEqual(reflex(call('code_edit', { path: '/Users/tfe/.jarv-genie/auth.json' })).kind, 'blocked');
  assert.strictEqual(reflex(call('code_edit', { path: '/Users/tfe/jarv-genie/src/index.ts' })).kind, 'pass', 'code edit on a normal file is left to the cortex');
});

test('reflex marks routine safe organs as fast and lets others pass', () => {
  for (const name of ['get_datetime', 'system_status', 'process_list', 'moltbook_feed', 'recall', 'code_search', 'web_search', 'file_list_any']) {
    assert.strictEqual(reflex(call(name)).kind, 'fast', `${name} is a routine fast-path reflex`);
  }
  assert.strictEqual(reflex(call('app_command', { app: 'spotify', action: 'play' })).kind, 'pass', 'consequential actions still reach the cortex');
  assert.strictEqual(reflex(call('email_send', { to: 'a@b.c', subject: 'hi' })).kind, 'pass');
});
