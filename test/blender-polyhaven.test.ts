import assert from 'node:assert';
import { test } from 'node:test';
import { searchPolyHavenAssets, resolvePolyHavenFile, POLYHAVEN_API } from '../src/blender/polyhaven.js';

test('PolyHaven search returns CC0 textures for a material keyword', async () => {
  const r = await searchPolyHavenAssets('leather', 'textures', 5);
  assert.ok(r.ok, 'leather assets found');
  assert.ok(r.assets.length > 0);
  assert.ok(r.assets.every((a) => typeof a.id === 'string' && a.id.length > 0));
});

test('PolyHaven resolve produces a downloadable URL for a texture', async () => {
  const s = await searchPolyHavenAssets('leather', 'textures', 3);
  if (!s.ok || !s.assets[0]) {
    assert.fail('no leather asset to resolve');
  }
  const f = await resolvePolyHavenFile(s.assets[0].id, 'textures', '1k');
  assert.ok(f.ok, f.error ?? 'expected resolve ok');
  assert.ok(String(f.url).startsWith('http'), 'url is absolute');
});

test('PolyHaven API base is the public CC0 endpoint', () => {
  assert.strictEqual(POLYHAVEN_API, 'https://api.polyhaven.com');
});
