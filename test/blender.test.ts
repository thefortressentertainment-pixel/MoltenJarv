import assert from 'node:assert';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { blenderToolRegistry, runBlenderShell } from '../src/blender/runner.js';
import type { JarvGenieConfig } from '../src/config/index.js';

function makeConfig(dir: string): JarvGenieConfig {
  return {
    providers: {
      primary: { baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen2.5:0.5b' },
      fallback: null,
    },
    embeddings: null,
    agent: { systemPrompt: '', maxSteps: 8, workdir: dir },
    memory: { dir },
    mcp: { servers: [] },
    permissions: [],
  } as unknown as JarvGenieConfig;
}

test('blenderToolRegistry is scoped to only Blender-relevant tools (tiny schema)', () => {
  const config = makeConfig('/tmp/jarv-blender-test');
  const reg = blenderToolRegistry(config);
  const names = reg.list().map((t) => t.name).sort();
  // Must NOT include the heavy/irrelevant tools like email, moltbook-removed,
  // graphiti memory, judge, scheduler, etc.
  for (const heavy of ['email_send', 'schedule_add', 'remember', 'recall', 'judge', 'learn_skill', 'rag_query', 'log_delivery']) {
    assert.ok(!names.includes(heavy), `${heavy} must NOT be in the Blender toolset`);
  }
  // Must include the Blender-driving essentials.
  for (const need of ['run_shell', 'file_read', 'file_write', 'web_search']) {
    assert.ok(names.includes(need), `${need} must be in the Blender toolset`);
  }
  assert.ok(names.length <= 8, `Blender toolset stays tiny (got ${names.length})`);
});

test('runBlenderShell returns JSON from headless Blender when available, or a clear error', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'jarv-blender-'));
  try {
    const config = makeConfig(dir);
    const res = await runBlenderShell(config, 'import bpy,json; print(json.dumps([o.name for o in bpy.data.objects]))');
    if (res.ok) {
      assert.ok(res.output.includes('Camera') || res.output.startsWith('['), 'headless Blender returns scene JSON');
    } else {
      assert.ok(res.output.length > 0, 'error path surfaces a message when Blender is not on PATH');
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
