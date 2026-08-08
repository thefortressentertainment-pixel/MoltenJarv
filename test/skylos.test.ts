import assert from 'node:assert';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { sha256Json, attest } from '../src/attest.js';
import { collectExports, parseImports, verifyFile, verifyFileOnDisk, verdict } from '../src/verify.js';

test('sha256Json is canonical and order-independent', () => {
  const a = sha256Json({ b: 1, a: [3, 1, 2], c: 'x' });
  const b = sha256Json({ c: 'x', a: [3, 1, 2], b: 1 });
  assert.strictEqual(a, b, 'same data, different key order → same hash');
  const c = sha256Json({ a: [1, 2, 3] });
  assert.notStrictEqual(a, c, 'different data → different hash');
});

test('attest is reproducible (same inputs ⇒ same digest) and excludes the timestamp', () => {
  const inputs = { schema: 'test/v1', version: '1.0.0', files: { 'a.ts': 'hashA' }, metadata: { gates: ['consent'], tool: 'verify' } };
  const one = attest(inputs);
  const two = attest(inputs);
  assert.strictEqual(one.digest, two.digest, 'identical inputs → identical digest');
  assert.ok(one.generatedAt, 'timestamp surfaced');
  // Changing metadata or files changes the digest.
  const changed = attest({ ...inputs, metadata: { gates: ['consent'], tool: 'edit' } });
  assert.notStrictEqual(changed.digest, one.digest);
});

test('collectExports finds function/const/class/type and named export braces', () => {
  const src = `
    export function hello() {}
    export const WORLD = 1;
    export class A {}
    export interface B {}
    export type C = number;
    export { hello as hi, WORLD };
  `;
  const exports = collectExports(src);
  for (const n of ['hello', 'WORLD', 'A', 'B', 'C', 'hi']) assert.ok(exports.includes(n), `exports ${n}`);
});

test('parseImports extracts named local imports and absolute imports', () => {
  const src = `
    import { a, b as bee } from './util';
    import { c } from './dep.ts';
    import 'reflect-metadata';
    import path from 'node:path';
  `;
  const imports = parseImports(src);
  const local = imports.find((i) => i.specifier === './util');
  assert.ok(local);
  assert.ok(local?.names.includes('a') && local?.names.includes('b'), 'source names preserved');
  assert.ok(local?.localNames.includes('a') && local?.localNames.includes('bee'), 'local bindings (after as)');
  const abs = imports.find((i) => i.specifier === 'node:path');
  assert.ok(abs?.absolute);
  assert.ok(!local?.absolute);
});

test('verifyFile flags phantom local imports and completes coverage', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'jarv-verify-'));
  try {
    const dep = path.join(dir, 'util.ts');
    await writeFile(dep, 'export function real() {}\nexport const thing = 1;\n');
    const file = path.join(dir, 'main.ts');
    const src = `import { real, thing, ghost } from './util';\nexport const x = real();`;

    const { findings, coverage } = await verifyFile(file, src);
    assert.ok(findings.length === 1, 'one phantom reference found');
    assert.strictEqual(findings[0]!.ruleId, 'JV-V001');
    assert.match(findings[0]!.message, /ghost/);
    assert.match(findings[0]!.message, /not exported/);
    const importCheck = coverage.find((c) => c.check === 'import:./util')!;
    assert.strictEqual(importCheck.status, 'complete');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('verifyFile marks absolute/third-party imports incomplete (not a false pass)', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'jarv-verify-'));
  try {
    const file = path.join(dir, 'main.ts');
    const src = `import { Router } from 'express';\nexport const r = Router();`;
    const { findings, coverage } = await verifyFile(file, src);
    assert.strictEqual(findings.length, 0, 'no verified finding for third-party');
    const abs = coverage.find((c) => c.check === "import:express")!;
    assert.strictEqual(abs.status, 'incomplete', 'third-party proof not achievable locally');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('verdict rolls pass/fail/incomplete with coverage', async () => {
  const pass = verdict('a.ts', 'export {}', { findings: [], coverage: [{ check: 'imports', support: 'supported', status: 'complete' }] });
  assert.strictEqual(pass.status, 'pass');

  const fail = verdict('a.ts', 'export {}', {
    findings: [{ ruleId: 'JV-V001', category: 'phantom_reference', file: 'a.ts', line: null, message: 'x', confidence: 'high' as const }],
    coverage: [{ check: 'imports', support: 'supported', status: 'complete' }],
  });
  assert.strictEqual(fail.status, 'fail');

  const incomplete = verdict('a.ts', 'export {}', {
    findings: [],
    coverage: [{ check: 'import:express', support: 'unsupported', status: 'incomplete', reason: 'third-party' }],
  });
  assert.strictEqual(incomplete.status, 'incomplete');
  assert.equal(incomplete.schema_version, 2);
  assert.strictEqual(incomplete.tool, 'verify_change');
  assert.match(incomplete.summary, /INCOMPLETE/);
});

test('verifyFileOnDisk returns incomplete for a missing file', async () => {
  const res = await verifyFileOnDisk('/nonexistent/nope.ts');
  assert.strictEqual(res.status, 'incomplete');
  assert.match(res.summary, /not readable/);
});
