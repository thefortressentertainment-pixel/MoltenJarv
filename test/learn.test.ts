import assert from 'node:assert';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { composeSkill, DEFAULT_LEARN_THRESHOLD, renderSkillFrontmatter, saveSkill, shouldLearn, skillExists, skillSlug } from '../src/learn.js';
import { learnTools } from '../src/tools/learn.js';

test('skillSlug produces a dir-safe hyphenated name', () => {
  assert.strictEqual(skillSlug('Generate Investor Digest'), 'generate-investor-digest');
  assert.strictEqual(skillSlug('  Mixed UP case & symbols!! '), 'mixed-up-case-symbols');
  assert.strictEqual(skillSlug('!!!'), 'untitled-skill');
});

test('renderSkillFrontmatter + composeSkill build a valid SKILL.md', () => {
  const fm = { name: 'gen-digest', description: 'Generate an investor digest' };
  const text = composeSkill(fm, '1. Gather.\n2. Format.\n3. Ship.');
  assert.match(text, /^---\nname: gen-digest\n/);
  assert.match(text, /description: Generate an investor digest/);
  assert.match(text, /\n---\n\n# gen-digest/);
  const fmText = renderSkillFrontmatter(fm);
  assert.match(fmText, /name: gen-digest/);
});

test('saveSkill writes <dir>/<slug>/SKILL.md and reports overwrite', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'jarv-learn-'));
  try {
    const first = saveSkill(dir, { name: 'test-skill', description: 'd' }, 'step one');
    const file = path.join(dir, 'test-skill', 'SKILL.md');
    assert.strictEqual(first.slug, 'test-skill');
    assert.strictEqual(first.path, file);
    assert.strictEqual(first.overwrote, false);
    const saved = await readFile(file, 'utf8');
    assert.match(saved, /step one/);
    assert.ok(await skillExists(dir, 'test-skill'));

    const second = saveSkill(dir, { name: 'test-skill', description: 'd' }, 'step two');
    assert.strictEqual(second.overwrote, true);
    const saved2 = await readFile(file, 'utf8');
    assert.match(saved2, /step two/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('skillExists is false for a not-yet-created skill', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'jarv-learn-'));
  try {
    assert.strictEqual(await skillExists(dir, 'nope'), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('shouldLearn gates on the judge score threshold', () => {
  assert.strictEqual(shouldLearn({}).learn, true, 'no score → caller asserts success');
  assert.strictEqual(shouldLearn({ judgeScore: 0.9 }).learn, true);
  assert.strictEqual(shouldLearn({ judgeScore: 0.1 }).learn, false);
  assert.strictEqual(shouldLearn({ judgeScore: DEFAULT_LEARN_THRESHOLD }).learn, true, 'at threshold learns');
});

test('shouldLearn refuses below a custom threshold', () => {
  const low = shouldLearn({ judgeScore: 0.7, threshold: 0.8 });
  assert.strictEqual(low.learn, false);
  assert.match(low.reason ?? '', /threshold/);
});

test('learn_skill tool writes a skill and requires fields', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'jarv-learn-tool-'));
  try {
    const [tool] = learnTools(dir);
    assert.ok(tool, 'learn_skill exported');
    const ctx = { config: {} } as never;

    // Missing fields → error.
    const bad = await tool.handler({ name: 'x', description: 'y' }, ctx);
    assert.strictEqual((bad as { ok: boolean }).ok, false);

    // Valid → writes the skill.
    const out = (await tool.handler(
      { name: 'gen-digest', description: 'Generate a digest', procedure: '1. Call web_search\n2. Summary\n3. Ship' },
      ctx,
    )) as { ok: boolean; skill: string; skillPath: string; overwrote: boolean };
    assert.strictEqual(out.ok, true);
    const file = path.join(dir, 'gen-digest', 'SKILL.md');
    assert.strictEqual(out.skillPath, file);
    assert.strictEqual(out.overwrote, false);
    const written = await readFile(file, 'utf8');
    assert.match(written, /Call web_search/);
    assert.match(written, /# gen-digest/);

    // Low judge score → refuses.
    const refused = await tool.handler(
      { name: 'gen-digest', description: 'd', procedure: 'p', judgeScore: 0.1 },
      ctx,
    );
    assert.strictEqual((refused as { ok: boolean }).ok, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('learn_skill is consequential (consent-gated) but not fail-closed', () => {
  const [tool] = learnTools();
  assert.strictEqual(tool.consequential, true, 'writes to the skills dir');
  assert.notStrictEqual(tool.failClosed, true, 'reversible local write, not fail-closed');
});

test('learn_skill persists into the skills dir listing', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'jarv-learn-ls-'));
  try {
    const [tool] = learnTools(dir);
    await tool.handler({ name: 'round-trip', description: 'd', procedure: 'p' }, { config: {} } as never);
    const entries = await readdir(path.join(dir, 'round-trip'));
    assert.ok(entries.includes('SKILL.md'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
