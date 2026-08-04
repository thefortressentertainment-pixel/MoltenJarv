import assert from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { codeTools } from '../src/tools/code.js';
import type { ToolContext } from '../src/agent/types.js';

const ctx = { config: {}, memory: {}, workdir: '/' } as unknown as ToolContext;

function tmpDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'jarv-code-'));
}

test('code tools are exposed; code_edit is consequential', () => {
  const names = codeTools().map((t) => t.name);
  assert.ok(names.includes('code_search'));
  assert.ok(names.includes('code_edit'));
  const edit = codeTools().find((t) => t.name === 'code_edit')!;
  assert.strictEqual(edit.consequential, true);
});

test('code_edit performs a single verified edit and reports the line', async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'a.txt');
  try {
    writeFileSync(file, 'hello world\nline two\n');
    const tool = codeTools().find((t) => t.name === 'code_edit')!;
    const res = (await tool.handler({ path: file, find: 'hello world', replace: 'hello jarvis' }, ctx)) as {
      ok: boolean;
      line: number;
      before: string;
      after: string;
    };
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.line, 1);
    assert.strictEqual(res.before, 'hello world');
    assert.strictEqual(res.after, 'hello jarvis');
    assert.match(readFileSync(file, 'utf8'), /hello jarvis/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('code_edit refuses when the find text is missing or ambiguous', async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'a.txt');
  try {
    writeFileSync(file, 'x y\nx y\n');
    const tool = codeTools().find((t) => t.name === 'code_edit')!;
    const missing = (await tool.handler({ path: file, find: 'zzz', replace: 'a' }, ctx)) as { ok: boolean; error?: string };
    assert.strictEqual(missing.ok, false);
    assert.match(missing.error ?? '', /not found/);
    const ambiguous = (await tool.handler({ path: file, find: 'x y', replace: 'a' }, ctx)) as { ok: boolean; error?: string };
    assert.strictEqual(ambiguous.ok, false);
    assert.match(ambiguous.error ?? '', /more than once/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('code_search finds matches and skips nothing important', async () => {
  const dir = tmpDir();
  try {
    writeFileSync(path.join(dir, 'one.ts'), 'const x = 1;\n');
    writeFileSync(path.join(dir, 'two.ts'), 'nothing here\n');
    const tool = codeTools().find((t) => t.name === 'code_search')!;
    const res = (await tool.handler({ pattern: 'const x', dir }, ctx)) as { ok: boolean; matches: Array<{ file: string; line: number }> };
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.matches.length, 1);
    assert.match(res.matches[0]!.file, /one\.ts$/);
    assert.strictEqual(res.matches[0]!.line, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

