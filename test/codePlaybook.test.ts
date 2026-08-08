import assert from 'node:assert';
import { test } from 'node:test';
import { CODE_PLAYBOOK } from '../src/config/codePlaybook.js';

test('CODE_PLAYBOOK enforces verification and housekeeping standards', () => {
  assert.match(CODE_PLAYBOOK, /self_review/, 'verifies via self_review');
  assert.match(CODE_PLAYBOOK, /Do not claim success until typecheck and tests are green/);
  assert.match(CODE_PLAYBOOK, /Never leave the build broken/);
  assert.match(CODE_PLAYBOOK, /scratch\/debug files/);
  assert.match(CODE_PLAYBOOK, /NEVER commit or push unless the user explicitly asks/);
  assert.match(CODE_PLAYBOOK, /\.bak/, 'bans leftover backup files');
  assert.match(CODE_PLAYBOOK, /node_modules/, 'marks generated dirs as off-limits');
});

test('CODE_PLAYBOOK is injected into the conversational Agent default prompt', async () => {
  const { defaultConfig } = await import('../src/config/index.js');
  const cfg = defaultConfig();
  assert.match(cfg.agent.systemPrompt, /Coding & housekeeping/);
  assert.match(cfg.agent.systemPrompt, /Do not claim success until typecheck and tests are green/);
});

test('CODE_PLAYBOOK is wired into the TaskRunner system prompt for code tasks only', async () => {
  const { TaskRunner } = await import('../src/agent/taskrunner.js');
  // systemPrompt() is private; exercise it through a minimal instance.
  const runner = new TaskRunner({} as never);
  const sysPrompt = runner as unknown as { systemPrompt(input?: string): string };
  // A code-touching task keeps the playbook, so verification and housekeeping rules apply.
  assert.match(sysPrompt.systemPrompt('refactor the taskrunner typescript'), /Coding & housekeeping/);
  assert.match(sysPrompt.systemPrompt('run npm test'), /Never leave the build broken/);
  // A non-coding task (social sweep, briefing, ops) drops the ~2.4KB playbook from the prompt.
  assert.doesNotMatch(sysPrompt.systemPrompt('check my notifications'), /Coding & housekeeping/);
  assert.doesNotMatch(sysPrompt.systemPrompt(), /Coding & housekeeping/);
});
