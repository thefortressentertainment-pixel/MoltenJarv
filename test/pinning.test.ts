import assert from 'node:assert';
import { test } from 'node:test';
import { bm25ScoreTools, pinTools, tokenize } from '../src/tools/pinning.js';
import { policyFor, isMutating, toolRisk } from '../src/risk.js';
import type { ToolDefinition } from '../src/agent/types.js';

const tools = [
  { name: 'web_search', description: 'Search the web for information, pages, results.' },
  { name: 'email_send', description: 'Send an email via SMTP to a recipient.' },
  { name: 'schedule_add', description: 'Add a recurring scheduled task or cron job.' },
  { name: 'screen_capture', description: 'Capture and describe the current screen.' },
  { name: 'run_shell', description: 'Run a shell command on the Mac.' },
  { name: 'self_review', description: 'Run tests and typecheck of the Jarv codebase.' },
  { name: 'judge', description: 'Score a piece of work on a -1..1 scale.' },
  { name: 'system_status', description: 'Battery, CPU, memory, disk status.' },
];

test('tokenize lowercases and splits into terms', () => {
  assert.deepStrictEqual(tokenize('Web Search the WEB'), ['web', 'search', 'the', 'web']);
  assert.deepStrictEqual(tokenize('a'), []);
  assert.deepStrictEqual(tokenize('hello-world 123'), ['hello', 'world', '123']);
});

test('bm25ScoreTools ranks tools relevant to the query highest', () => {
  const ranked = bm25ScoreTools('search the web for news', tools);
  assert.strictEqual(ranked[0]?.name, 'web_search');
  assert.ok(ranked[0]!.score > 0);
});

test('bm25 prioritizes a distinct keyword over generic', () => {
  const ranked = bm25ScoreTools('send an email to alice', tools);
  // Distinctive tokens (email) outrank the very generic ones.
  assert.strictEqual(ranked[0]?.name, 'email_send');
});

test('pinTools keeps the whole set when it is under the cap', () => {
  const pinned = pinTools('anything', tools, { maxTools: 24 });
  assert.strictEqual(pinned.length, tools.length);
});

test('pinTools caps to maxTools and always keeps core tools', () => {
  // Small cap so pinning must drop most tools.
  const pinned = pinTools('search the web for news about the weather today', tools, { maxTools: 4 });
  assert.ok(pinned.length <= 4);
  const names = pinned.map((t) => t.name);
  // Core safety tools (self_review, judge, system_status) are never crowded out.
  assert.ok(names.includes('self_review'), 'self_review always kept');
  assert.ok(names.includes('judge'), 'judge always kept');
  assert.ok(names.includes('system_status'), 'system_status always kept');
  // And the task-relevant tool is present.
  assert.ok(names.includes('web_search'), 'task-relevant tool kept');
});

test('pinTools preserves original ordering', () => {
  const pinned = pinTools('running tests to verify the build and typecheck', tools, { maxTools: 3 });
  const order = pinned.map((t) => t.name);
  const baseOrder = tools.map((t) => t.name).filter((n) => order.includes(n));
  assert.deepStrictEqual(order, baseOrder, 'pinned order matches the original relative order');
});

function def(name: string, meta: Partial<ToolDefinition> = {}): ToolDefinition {
  return { name, description: name, inputSchema: { type: 'object', properties: {} }, handler: async () => ({}), ...meta } as unknown as ToolDefinition;
}

test('policyFor splits read vs mutating by risk', () => {
  assert.strictEqual(policyFor(def('web_search')), 'read');
  assert.strictEqual(isMutating(def('web_search')), false);
  assert.strictEqual(policyFor(def('run_shell', { consequential: true })), 'mutating');
  assert.strictEqual(policyFor(def('email_send', { failClosed: true })), 'mutating');
  assert.strictEqual(policyFor(def('code_edit', { risk: 'exec' })), 'mutating');
});

test('a read-only tool misflagged consequential is read under policy but raw risk reflects the flag', () => {
  // Mixed signal: explicit risk 'read' name-table membership but a consequential
  // flag set. `toolRisk` (raw) respects the flag → 'write-local'; `policyFor`
  // (the read/write split) refuses to class a genuinely read-only tool as
  // mutating — defense-in-depth.
  const weird = def('web_search', { consequential: true });
  assert.strictEqual(toolRisk(weird), 'write-local');
  assert.strictEqual(policyFor(weird), 'read');
  assert.strictEqual(isMutating(weird), false);
});
