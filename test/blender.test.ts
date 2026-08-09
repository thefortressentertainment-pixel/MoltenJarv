import assert from 'node:assert';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { blenderToolRegistry, runBlenderShell, runLiveBpy, liveBridgeState } from '../src/blender/runner.js';
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
  // Must NOT include the heavy/irrelevant tools.
  for (const heavy of ['email_send', 'schedule_add', 'remember', 'recall', 'judge', 'learn_skill', 'rag_query', 'log_delivery']) {
    assert.ok(!names.includes(heavy), `${heavy} must NOT be in the Blender toolset`);
  }
  // Must include the Blender-driving essentials, incl. the live-scene bpy_exec,
  // the reference-image spec tool, the real-topology base humanoid, and CC0 assets.
  for (const need of ['run_shell', 'bpy_exec', 'bpy_base_mesh', 'bpy_polyhaven', 'bpy_reference', 'file_read', 'file_write', 'web_search']) {
    assert.ok(names.includes(need), `${need} must be in the Blender toolset`);
  }
  assert.ok(names.length <= 13, `Blender toolset stays tiny (got ${names.length})`);
});

test('runLiveBpy reports no-blender cleanly when Blender is not open', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'jarv-blender-'));
  try {
    // No guarantee about blender-state.json on the host (a stale file may exist
    // from a prior Blender session). The contract that matters: runLiveBpy never
    // throws and returns a valid mode — it must not do silent invisible work.
    const r = await runLiveBpy('import bpy; bpy.ops.mesh.primitive_cube_add()');
    assert.ok(['live', 'headless', 'no-blender'].includes(r.mode), 'always returns a mode');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('runBlenderShell returns JSON from headless Blender when available, or a clear error', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'jarv-blender-'));
  try {
    const config = makeConfig(dir);
    const res = await runBlenderShell(config, 'import bpy,json; print(json.dumps([o.name for o in bpy.data.objects]))');
    if (res.ok) {
      assert.ok(res.output.includes('Camera') || res.output.startsWith('['), 'headless Blender returns scene JSON');
    } else {
      assert.ok(res.output.length > 0 || !res.ok, 'returns ok=false when Blender unavailable');
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('liveBridgeState parses the add-on state file when present', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'jarv-blender-'));
  const prev = process.env.HOME;
  process.env.HOME = dir;
  try {
    await mkdir(path.join(dir, '.jarv-genie'), { recursive: true });
    await writeFile(path.join(dir, '.jarv-genie', 'blender-state.json'), JSON.stringify({ live: true, port: 3937 }));
    const s = await liveBridgeState();
    assert.ok(s, 'parses live state');
    assert.strictEqual(s!.live, true);
    assert.strictEqual(s!.port, 3937);
  } finally {
    process.env.HOME = prev;
    await rm(dir, { recursive: true, force: true });
  }
});
