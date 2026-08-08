import assert from 'node:assert';
import { test } from 'node:test';
import { validateToolset, ToolRegistry } from '../src/tools/registry.js';
import { fileLock, withLock } from '../src/tools/filelock.js';
import { useToolTools } from '../src/tools/useTool.js';
import { timeTools } from '../src/tools/time.js';
import { memoryTools } from '../src/tools/memory.js';
import { schedulerTools } from '../src/tools/scheduler.js';
import type { ToolContext } from '../src/agent/types.js';

const ctx = { memory: {}, config: {}, workdir: '/tmp' } as unknown as ToolContext;

// ── #2 validateToolset ────────────────────────────────────────────────
test('validateToolset is silent on a coherent, full toolset', () => {
  const tools = [...schedulerTools(), ...memoryTools(), ...timeTools()];
  assert.deepStrictEqual(validateToolset(tools), []);
});

test('validateToolset reports a missing companion tool', () => {
  const scheduled = schedulerTools().find((t) => t.name === 'schedule_add')!;
  const issues = validateToolset([scheduled]);
  assert.ok(issues.some((i) => i.includes('schedule_add') && i.includes('schedule_list')), `issues: ${issues}`);
});

test('validateToolset blocks a missing sibling only when the requiring tool is enabled', () => {
  // No schedule tool at all → no issue.
  assert.deepStrictEqual(validateToolset(memoryTools()), []);
  // remember enabled without recall → one issue.
  const remember = memoryTools().find((t) => t.name === 'remember')!;
  const issues = validateToolset([remember]);
  assert.ok(issues.some((i) => i.includes('remember') && i.includes('recall')));
});

// ── #6 fileLock ───────────────────────────────────────────────────────
test('fileLock serializes exclusive operations on the same path', async () => {
  const order: string[] = [];
  const p = '/tmp/x.txt';
  const run = async (id: string) => {
    await withLock(p, true, async () => {
      order.push(`start-${id}`);
      await new Promise((r) => setTimeout(r, 20));
      order.push(`end-${id}`);
    });
  };
  await Promise.all([run('a'), run('b')]);
  // FIFO: a fully completes before b starts.
  assert.deepStrictEqual(order, ['start-a', 'end-a', 'start-b', 'end-b']);
});

test('fileLock lets different paths run concurrently', async () => {
  let concurrent = 0;
  let peak = 0;
  const run = async (p: string) => {
    await withLock(p, true, async () => {
      concurrent++;
      peak = Math.max(peak, concurrent);
      await new Promise((r) => setTimeout(r, 10));
      concurrent--;
    });
  };
  await Promise.all([run('/tmp/a.txt'), run('/tmp/b.txt')]);
  assert.strictEqual(peak, 2, 'distinct files are not serialized');
});

// ── #7 use_tool ───────────────────────────────────────────────────────
test('use_tool dispatches an external MCP tool by name', async () => {
  const registry = new ToolRegistry();
  registry.registerMany(useToolTools());
  registry.register({
    name: 'weather__get',
    description: 'external',
    mcpServer: 'weather',
    inputSchema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
    handler: async (args) => ({ temp: 72, city: String(args.city) }),
  });

  const res = await registry.execute('use_tool', { tool: 'weather__get', input: { city: 'sf' } }, { ...ctx, tools: registry });
  assert.strictEqual(res.ok, true);
  assert.deepStrictEqual(res.result, { temp: 72, city: 'sf' });
});

test('use_tool gives a corrective error for a native tool', async () => {
  const registry = new ToolRegistry();
  registry.registerMany(useToolTools());
  registry.registerMany(memoryTools());
  const res = await registry.execute('use_tool', { tool: 'recall', input: { query: 'x' } }, { ...ctx, tools: registry });
  assert.strictEqual(res.ok, false);
  assert.match(String(res.result), /native tool/i);
});

test('use_tool reports unknown external name with a hint', async () => {
  const registry = new ToolRegistry();
  registry.registerMany(useToolTools());
  registry.register({ name: 'notes__create', description: 'ext', mcpServer: 'notes', inputSchema: { type: 'object', properties: {} }, handler: async () => ({}) });
  const res = await registry.execute('use_tool', { tool: 'nope__bad', input: {} }, { ...ctx, tools: registry });
  assert.strictEqual(res.ok, false);
  assert.match(String(res.result), /nope__bad/);
  assert.match(String(res.result), /notes__create/);
});
