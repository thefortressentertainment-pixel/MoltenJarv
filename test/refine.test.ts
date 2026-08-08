import assert from 'node:assert';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { refineStep, guardFrom, correctiveTail } from '../src/refine.js';
import { refineCode } from '../src/tools/refine.js';

test('refineStep happy path: one attempt, accepted', async () => {
  const calls: string[] = [];
  const result = await refineStep<string>({
    budget: 2,
    produce: async (fb) => { calls.push(fb ?? '<first>'); return 'good output'; },
    guard: guardFrom((out) => out.includes('good')),
  });
  assert.strictEqual(result.accepted, true);
  assert.strictEqual(result.attempts, 1);
  assert.strictEqual(result.value, 'good output');
  assert.deepStrictEqual(calls, ['<first>'], 'only one produce call on pass');
});

test('refineStep retries with corrective feedback on a failed guard', async () => {
  const seen: string[] = [];
  const result = await refineStep<string>({
    budget: 2,
    produce: async (fb) => { seen.push(fb ?? '<first>'); return seen.length === 1 ? 'too long output' : 'short'; },
    guard: guardFrom((out) => out.length <= 10, () => 'output too long, keep it under 10 chars'),
  });
  assert.strictEqual(result.accepted, true);
  assert.strictEqual(result.attempts, 2);
  assert.ok(seen[1]!.includes('output too long'), 'retry received the corrective feedback');
  // The failed output preview is appended by `correctiveTail` (used by refine_code);
  // here the plain guard passes just the failure message.
  assert.strictEqual(seen[0], '<first>');
});

test('refineStep Suggest semantics: returns best-effort when budget exhausted', async () => {
  let n = 0;
  const result = await refineStep<string>({
    budget: 2,
    produce: async () => { n++; return 'never good'; },
    guard: guardFrom(() => false, () => 'always fails'),
  });
  assert.strictEqual(result.accepted, false);
  assert.strictEqual(result.attempts, 3, '1 initial + 2 backtracks');
  assert.strictEqual(n, 3);
  assert.strictEqual(result.value, 'never good');
  assert.match(result.feedback ?? '', /always fails/);
});

test('refineStep Assert semantics: throws when throwOnFail and budget exhausted', async () => {
  await assert.rejects(
    refineStep<string>({
      budget: 1,
      throwOnFail: true,
      produce: async () => 'bad',
      guard: guardFrom(() => false, () => 'nope'),
    }),
    /assertion failed/,
  );
});

test('correctiveTail composes the failed-output + reason block', () => {
  const tail = correctiveTail('foo', 'too short');
  assert.match(tail, /Previous output was rejected because: too short/);
  assert.match(tail, /Previous output started with: foo/);
  assert.match(tail, /Produce a corrected output/);
});

test('refine_code verifies then retries with a custom producer (no router needed)', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'jarv-refine-'));
  try {
    // A dependency module exporting `real`.
    const dep = path.join(dir, 'util.ts');
    await writeFile(dep, 'export function real() { return 1; }\n');

    // Producer returns a phantom-import draft first (verify fails), then a good one.
    let attempt = 0;
    const res = await refineCode({
      file: path.join(dir, 'main.ts'),
      task: 'import real from util and use it',
      budget: 2,
      produce: async () => {
        attempt++;
        return attempt === 1
          ? "import { ghost } from './util';\nexport const x = ghost();\n"
          : "import { real } from './util';\nexport const x = real();\n";
      },
    });
    assert.strictEqual(res.ok, true, 'second draft passes verify');
    assert.strictEqual(attempt, 2);
    assert.strictEqual(res.accepted, true);
    // The accepted source uses the real export.
    assert.match(res.source ?? '', /import \{ real \} from '\.\/util'/);
    assert.equal(res.verify?.status, 'pass');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('refine_code returns not-accepted when the producer never satisfies the guard', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'jarv-refine-'));
  try {
    const res = await refineCode({
      file: path.join(dir, 'main.ts'),
      task: 'something',
      budget: 1,
      produce: async () => "import { bogus } from './does-not-exist-nope';\nexport const x = bogus();\n",
    });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.accepted, false);
    assert.strictEqual(res.attempts, 2, '1 draft + 1 backtrack with budget=1');
    assert.equal(res.verify?.status, 'incomplete', 'unresolvable module → incomplete, non-pass');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('refine_code returns not-ok when neither produce nor router is provided', async () => {
  const res = await refineCode({ file: '/tmp/x.ts', task: 't' });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.accepted, false);
  assert.strictEqual(res.verify, null);
});
