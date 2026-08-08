import assert from 'node:assert';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { capabilityCovers, toolCapability, filterByCapability } from '../src/capability.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { loadSkills, renderSkills } from '../src/skills.js';
import { timeTools } from '../src/tools/time.js';
import type { ToolDefinition, ToolContext } from '../src/agent/types.js';

const ctx = { memory: {}, config: {}, workdir: '/tmp' } as unknown as ToolContext;

function def(name: string, over: Partial<ToolDefinition> = {}): ToolDefinition {
  return { name, description: name, inputSchema: { type: 'object', properties: {} }, handler: async () => ({}), ...over };
}

// ── #8 capability ─────────────────────────────────────────────────────
test('capabilityCovers orders read-only below read-write/execute below all', () => {
  assert.ok(capabilityCovers('all', 'read-only'));
  assert.ok(capabilityCovers('all', 'execute'));
  assert.ok(capabilityCovers('read-write', 'read-only'));
  assert.ok(capabilityCovers('execute', 'read-only'));
  assert.ok(!capabilityCovers('read-only', 'read-write'));
  assert.ok(!capabilityCovers('read-write', 'execute')); // incomparable
  assert.ok(!capabilityCovers('execute', 'read-write')); // incomparable
  assert.ok(capabilityCovers('read-only', 'read-only'));
});

test('toolCapability classifies read vs execute vs write tools', () => {
  assert.strictEqual(toolCapability(def('file_read')), 'read-only');
  assert.strictEqual(toolCapability(def('recall')), 'read-only');
  assert.strictEqual(toolCapability(def('run_shell')), 'execute');
  assert.strictEqual(toolCapability(def('file_write')), 'read-write');
});

test('filterByCapability exposes the right tools per mode', () => {
  const tools = [def('file_read'), def('file_write'), def('run_shell')];
  assert.deepStrictEqual(filterByCapability(tools, 'read-only').map((t) => t.name), ['file_read']);
  assert.deepStrictEqual(filterByCapability(tools, 'read-write').map((t) => t.name).sort(), ['file_read', 'file_write']);
  assert.deepStrictEqual(filterByCapability(tools, 'execute').map((t) => t.name).sort(), ['file_read', 'run_shell']);
  assert.strictEqual(filterByCapability(tools, 'all').length, 3);
});

test('registry enforces capability mode at execute time', async () => {
  const reg = new ToolRegistry();
  reg.registerMany([...timeTools(), def('file_write', { handler: async () => ({ wrote: true }) })]);
  reg.setCapability('read-only');
  assert.deepStrictEqual(
    (await reg.execute('file_write', {}, ctx)).ok,
    false,
    'write blocked in read-only mode',
  );
  // read-only tools still run.
  assert.strictEqual((await reg.execute('get_datetime', {}, ctx)).ok, true);
});

// ── #9 skills ─────────────────────────────────────────────────────────
test('loadSkills reads SKILL.md folders under a skills dir', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'jarv-skills-'));
  try {
    await mkdir(path.join(dir, 'bilingual'));
    await writeFile(path.join(dir, 'bilingual', 'SKILL.md'), 'Always translate replies to Spanish.');
    await mkdir(path.join(dir, 'empty'));
    await writeFile(path.join(dir, 'empty', 'SKILL.md'), '   \n');
    const skills = await loadSkills(dir);
    assert.strictEqual(skills.length, 1);
    assert.strictEqual(skills[0]!.name, 'bilingual');
    assert.match(skills[0]!.body, /Spanish/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('loadSkills is empty and silent when the dir is missing', () => {
  assert.deepStrictEqual(loadSkills(path.join(os.tmpdir(), 'nope-missing-' + Date.now())), []);
});

test('renderSkills returns empty for none and a block for some', () => {
  assert.strictEqual(renderSkills([]), '');
  const out = renderSkills([{ name: 's', body: 'do x' }]);
  assert.match(out, /Skill: s/);
  assert.match(out, /do x/);
});
