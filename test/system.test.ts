import assert from 'node:assert';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { systemTools } from '../src/tools/system.js';
import type { ToolContext } from '../src/agent/types.js';

function tmp(): { dir: string; ctx: ToolContext } {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'jarv-sys-'));
  return { dir, ctx: { config: {}, memory: {}, workdir: dir } as unknown as ToolContext };
}

test('run_shell executes a command and returns stdout + exit code', async () => {
  const { ctx, dir } = tmp();
  try {
    const tool = systemTools().find((t) => t.name === 'run_shell')!;
    const out = (await tool.handler({ command: 'echo hello; echo err >&2; exit 3' }, ctx)) as {
      ok: boolean;
      exitCode: number;
      stdout: string;
      stderr: string;
    };
    assert.strictEqual(out.exitCode, 3);
    assert.match(out.stdout, /hello/);
    assert.match(out.stderr, /err/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('run_shell honors workdir', async () => {
  const { dir } = tmp();
  try {
    const tool = systemTools().find((t) => t.name === 'run_shell')!;
    const out = (await tool.handler({ command: 'pwd', workdir: dir }, {} as ToolContext)) as { stdout: string };
    assert.match(out.stdout.trim(), new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('file_write_any + file_read_any round-trip outside the workspace sandbox', async () => {
  const { ctx, dir } = tmp();
  const outside = path.join(dir, 'nested', 'deep', 'note.txt');
  try {
    const write = systemTools().find((t) => t.name === 'file_write_any')!;
    const read = systemTools().find((t) => t.name === 'file_read_any')!;
    const list = systemTools().find((t) => t.name === 'file_list_any')!;
    await write.handler({ path: outside, content: 'outside the sandbox' }, ctx);
    assert.strictEqual(readFileSync(outside, 'utf8'), 'outside the sandbox');
    const r = (await read.handler({ path: outside }, ctx)) as { text: string };
    assert.match(r.text, /outside the sandbox/);
    const l = (await list.handler({ path: path.dirname(outside) }, ctx)) as { entries: string[] };
    assert.ok(l.entries.includes('note.txt'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('file_delete_any removes a file anywhere', async () => {
  const { dir } = tmp();
  const f = path.join(dir, 'gone.txt');
  try {
    writeFileSync(f, 'x');
    const tool = systemTools().find((t) => t.name === 'file_delete_any')!;
    await tool.handler({ path: f }, {} as ToolContext);
    await assert.rejects(async () => readFileSync(f));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('mutating system tools are marked consequential for the consent gate', () => {
  const consequential = new Set(systemTools().filter((t) => t.consequential).map((t) => t.name));
  assert.ok(consequential.has('run_shell'));
  assert.ok(consequential.has('file_write_any'));
  assert.ok(consequential.has('file_delete_any'));
  assert.ok(consequential.has('file_move_any'));
  assert.ok(consequential.has('file_copy_any'));
  assert.ok(consequential.has('open_file'));
  assert.ok(consequential.has('reveal_in_finder'));
  assert.ok(!consequential.has('file_read_any'), 'reads stay un-gated');
  assert.ok(!consequential.has('file_list_any'));
  assert.ok(!consequential.has('clipboard_get'), 'clipboard read stays un-gated');
});

test('file_move_any and file_copy_any work', async () => {
  const { dir } = tmp();
  try {
    const src = path.join(dir, 'src.txt');
    writeFileSync(src, 'hello');
    const move = systemTools().find((t) => t.name === 'file_move_any')!;
    const copy = systemTools().find((t) => t.name === 'file_copy_any')!;
    const moved = path.join(dir, 'moved.txt');
    await move.handler({ from: src, to: moved }, {} as ToolContext);
    assert.strictEqual(readFileSync(moved, 'utf8'), 'hello');
    const copied = path.join(dir, 'copied.txt');
    await copy.handler({ from: moved, to: copied }, {} as ToolContext);
    assert.strictEqual(readFileSync(copied, 'utf8'), 'hello');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
