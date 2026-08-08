import assert from 'node:assert';
import { test } from 'node:test';
import { webTools } from '../src/tools/web.js';
import type { ToolContext } from '../src/agent/types.js';

const ctx = { memory: {}, config: {}, workdir: '/tmp' } as unknown as ToolContext;

function tool(name: string) {
  const t = webTools().find((x) => x.name === name);
  assert.ok(t, `tool ${name} exists`);
  return t!;
}

test('webTools exposes the route-aware channel tools', () => {
  for (const name of ['youtube_transcript', 'read_rss', 'github_search', 'github_read', 'web_read', 'web_search']) {
    assert.ok(webTools().some((t) => t.name === name), `missing ${name}`);
  }
  assert.strictEqual(tool('youtube_transcript').system, 'integration');
  assert.ok(tool('github_read').inputSchema.required?.includes('repo'));
  assert.ok(tool('read_rss').inputSchema.required?.includes('url'));
});

test('channel tools validate their required args', async () => {
  await assert.rejects(tool('youtube_transcript').handler({}, ctx));
  await assert.rejects(tool('read_rss').handler({}, ctx));
  await assert.rejects(tool('github_search').handler({}, ctx));
  await assert.rejects(tool('github_read').handler({ no: true }, ctx));
});

test('route-aware tools return a clean "backend not configured" result rather than crashing', async () => {
  // Each helper first probes its channel; when the backend is unavailable (as it
  // is on a fresh machine) it returns { ok:false, hint } without throwing. We
  // assert the shape is a definition-compatible object, not a thrown error.
  const out = await tool('youtube_transcript').handler({ url: 'https://youtube.com/watch?v=dQw4w9WgXcQ' }, ctx);
  assert.ok(typeof out === 'object' && 'ok' in out, 'returns an object, not a bare throw');
});
