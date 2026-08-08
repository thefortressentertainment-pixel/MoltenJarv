import assert from 'node:assert';
import { test } from 'node:test';
import { toolRisk, isConsequential } from '../src/risk.js';
import { fileTools } from '../src/tools/filesystem.js';
import { memoryTools } from '../src/tools/memory.js';
import type { ToolDefinition } from '../src/agent/types.js';

const def = (name: string, over: Partial<ToolDefinition> = {}): ToolDefinition => ({
  name, description: name, inputSchema: { type: 'object', properties: {} }, ...over,
});

test('toolRisk classifies read-only tools as read regardless of origin', () => {
  assert.strictEqual(toolRisk(def('file_list')), 'read');
  assert.strictEqual(toolRisk(def('recall')), 'read');
  assert.strictEqual(toolRisk(def('web_search')), 'read');
});

test('toolRisk honors the explicit risk field first', () => {
  assert.strictEqual(toolRisk(def('run_shell', { risk: 'exec' })), 'exec');
  // An explicit read overrides the exec base table.
  assert.strictEqual(toolRisk(def('run_shell', { risk: 'read' })), 'read');
});

test('risk precedence: failClosed > consequential > base', () => {
  assert.strictEqual(toolRisk(def('email_send', { failClosed: true })), 'external');
  assert.strictEqual(toolRisk(def('file_write', { consequential: true })), 'write-local');
  // failClosed also implies consequential semantics.
  assert.strictEqual(isConsequential(def('email_send', { failClosed: true })), true);
});

test('isConsequential is true only for non-read risk', () => {
  assert.strictEqual(isConsequential(def('file_write', { consequential: true })), true);
  assert.strictEqual(isConsequential(def('file_list')), false);
  assert.strictEqual(isConsequential(def('run_shell')), true); // exec risk
});

test('risk model integrates with the real filesystem and memory tools', () => {
  for (const t of fileTools()) {
    assert.ok(toolRisk(t), `${t.name} has a risk class`);
  }
  for (const t of memoryTools()) {
    assert.ok(toolRisk(t), `${t.name} has a risk class`);
  }
  const read = fileTools().find((t) => t.name === 'file_read')!;
  assert.strictEqual(toolRisk(read), 'read');
});
