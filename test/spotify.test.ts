import assert from 'node:assert';
import { test } from 'node:test';
import { spotifyTools } from '../src/tools/spotify.js';

test('spotify tools are exposed; spotify_play is consequential, status is read-only', () => {
  const names = spotifyTools().map((t) => t.name);
  assert.ok(names.includes('spotify_play'));
  assert.ok(names.includes('spotify_status'));
  const play = spotifyTools().find((t) => t.name === 'spotify_play')!;
  const status = spotifyTools().find((t) => t.name === 'spotify_status')!;
  assert.strictEqual(play.consequential, true);
  assert.ok(!status.consequential, 'status read should not require consent');
});

test('spotify_play rejects non-Spotify URIs without touching the app', async () => {
  const play = spotifyTools().find((t) => t.name === 'spotify_play')!;
  const ctx = { config: {}, memory: {}, workdir: '/' } as never;
  const bad = (await play.handler({ uri: 'http://example.com' }, ctx)) as { ok: boolean; error?: string };
  assert.strictEqual(bad.ok, false);
  assert.match(bad.error ?? '', /invalid Spotify URI/);
  const empty = (await play.handler({}, ctx)) as { ok: boolean; error?: string };
  assert.strictEqual(empty.ok, false);
  assert.match(empty.error ?? '', /invalid Spotify URI/);
});
