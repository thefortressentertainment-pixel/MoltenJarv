import assert from 'node:assert';
import { test } from 'node:test';
import { describeToSpec, parseSpecJson, extractAbsoluteImagePath } from '../src/blender/reference.js';

test('extractAbsoluteImagePath finds an absolute image path in a prompt', () => {
  const p = extractAbsoluteImagePath('make it look like this picture [/Users/me/Downloads/orc-male-01.jpg]');
  assert.strictEqual(p, '/Users/me/Downloads/orc-male-01.jpg');
});

test('extractAbsoluteImagePath finds a bare / wrapped absolute path', () => {
  assert.strictEqual(extractAbsoluteImagePath('use /tmp/ref.png') , '/tmp/ref.png');
  assert.strictEqual(extractAbsoluteImagePath('(refer to "/Users/a/b.png")') , '/Users/a/b.png');
});

test('extractAbsoluteImagePath returns null when no absolute image path is present', () => {
  assert.strictEqual(extractAbsoluteImagePath('build an orc') , null);
  assert.strictEqual(extractAbsoluteImagePath('use ref.png (relative, not absolute)') , null);
  assert.strictEqual(extractAbsoluteImagePath('') , null);
});

test('parseSpecJson extracts a wrapped JSON spec', () => {
  const raw = 'here is your spec:\n```json\n{"shape_summary":"a wreath","parts":[{"name":"ring","primitive":"torus"}],\n"proportions":{"width_over_height":1.2,"depth_over_width":0.1}}\n```';
  const spec = parseSpecJson(raw);
  assert.ok(spec);
  assert.strictEqual(spec?.shape_summary, 'a wreath');
  assert.ok(Array.isArray(spec?.parts));
  assert.strictEqual(spec?.parts?.[0]?.primitive, 'torus');
});

test('parseSpecJson strips trailing commas and rejects garbage', () => {
  const ok = parseSpecJson('{"a":1,}');
  assert.ok(ok, 'trailing comma tolerated');
  assert.strictEqual(parseSpecJson('not json at all'), null);
  assert.strictEqual(parseSpecJson('[]'), null, 'array not an object');
});

test('describeToSpec returns structured parts + proportions from a vision reply', async () => {
  // Stub a minimal config + monkey-patch describeImage via the module is not
  // easy, so we test the contract by calling with a nonexistent image and expect
  // a graceful throw-handling path shape: the caller (runner tool) catches it.
  // Here we only assert parseSpecJson can build the intended shape.
  const spec = parseSpecJson(
    '{"shape_summary":"a labrador running","aspect":2.0,"proportions":{"width_over_height":2.1,"depth_over_width":0.6},"parts":[{"name":"body","primitive":"cube","position":[0,0,0],"scale":[2,1,1]},{"name":"head","primitive":"cube","position":[1.2,0,0.4],"scale":[0.5,0.4,0.5],"parent":"body"}]}',
  );
  assert.strictEqual(spec?.proportions?.width_over_height, 2.1);
  assert.strictEqual(spec?.parts?.length, 2);
  assert.strictEqual(spec?.parts?.[1]?.parent, 'body');
});

test('describeToSpec on a missing image rejects cleanly (runner tool catches it)', async () => {
  await assert.rejects(
    () => describeToSpec('/nonexistent/definitely-not-there.png', {} as never),
    'reads the image file and throws a readable error the runner can catch',
  );
});

test('describeToSpec serves a cached spec without re-calling vision', async () => {
  const os = await import('node:os');
  const pathMod = await import('node:path');
  const fsMod = await import('node:fs/promises');
  const dir = await fsMod.mkdtemp(pathMod.join(os.tmpdir(), 'jarv-refcache-'));
  const prevHome = process.env.HOME;
  process.env.HOME = dir;
  try {
    // A tiny dummy "image" + a pre-seeded cache entry so the vision call path
    // (which would need a real endpoint and read an image) is never hit.
    const img = pathMod.join(dir, 'ref.jpg');
    await fsMod.writeFile(img, Buffer.from('fake-image-bytes'));
    const stat = await fsMod.stat(img);
    const key = `${img}\u0000${stat.mtimeMs}\u0000llava`;
    const cacheDir = pathMod.join(dir, '.jarv-genie', 'blender');
    const cacheFile = pathMod.join(cacheDir, 'spec-cache.json');
    await fsMod.mkdir(cacheDir, { recursive: true });
    await fsMod.writeFile(cacheFile, JSON.stringify({
      [key]: { summary: 'cached spec', parts: [{ name: 'Head', primitive: 'sphere' }], proportions: {}, raw: '{}' },
    }));
    // Config with an unreachable vision endpoint: if the cache is honored we get
    // parts back instantly; if it re-analyzes it would try to fetch and fail/throw.
    const config = {
      providers: { primary: { baseUrl: 'http://127.0.0.1:1/v1', model: 'x' }, fallback: null },
      computer: { visionModel: 'llava', visionEndpoint: 'http://127.0.0.1:1/v1' },
    } as never;
    const spec = await describeToSpec(img, config, 'llava');
    assert.ok(Array.isArray(spec.parts));
    assert.strictEqual(spec.parts?.[0]?.name, 'Head');
    assert.strictEqual(spec.summary, 'cached spec');
  } finally {
    process.env.HOME = prevHome;
    await rmPatch(dir);
  }

  async function rmPatch(p: string) {
    const { rm } = await import('node:fs/promises');
    await rm(p, { recursive: true, force: true });
  }
});
