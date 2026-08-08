import assert from 'node:assert';
import { test } from 'node:test';
import {
  activeBackend,
  internetChannelsDoctor,
  renderInternetDoctor,
  type Channel,
} from '../src/web/channels.js';

const channels: Channel[] = [
  {
    id: 'web',
    label: 'Read web pages',
    backends: [
      { id: 'jina', label: 'Jina Reader', probe: async () => true, setupHint: '' },
    ],
    brokenHint: 'jina down',
  },
  {
    id: 'github',
    label: 'GitHub',
    backends: [
      { id: 'gh-works', label: 'gh CLI', probe: async () => true, setupHint: '' },
      { id: 'gh-alt', label: 'gh alt', probe: async () => true, setupHint: '' },
    ],
    brokenHint: 'gh down',
  },
  {
    id: 'youtube',
    label: 'YouTube',
    backends: [
      { id: 'broken', label: 'yt-dlp', probe: async () => false, setupHint: 'brew install yt-dlp' },
      { id: 'fallback', label: 'OpenCLI', probe: async () => true, setupHint: '' },
    ],
    brokenHint: 'yt down',
  },
  {
    id: 'all_down',
    label: 'All down',
    backends: [
      { id: 'a', label: 'A', probe: async () => false, setupHint: '' },
      { id: 'b', label: 'B', probe: async () => false, setupHint: '' },
    ],
    brokenHint: 'everything broken',
  },
];

test('activeBackend picks the first working backend in order', async () => {
  const git = await activeBackend(channels[1]!);
  assert.deepStrictEqual(git, { id: 'gh-works', label: 'gh CLI' }, 'first working wins');
  const yt = await activeBackend(channels[2]!);
  assert.strictEqual(yt?.id, 'fallback', 'breaks past a dead backend to the next');
});

test('activeBackend returns null when all backends fail', async () => {
  assert.strictEqual(await activeBackend(channels[3]!), null);
});

test('internetChannelsDoctor reports ok + active backend, or fail + hint', async () => {
  const statuses = await internetChannelsDoctor(channels);
  assert.strictEqual(statuses.length, 4);
  const web = statuses[0]!;
  assert.strictEqual(web.ok, true);
  assert.match(web.activeBackend ?? '', /Jina/);
  const down = statuses[3]!;
  assert.strictEqual(down.ok, false);
  assert.match(down.hint ?? '', /broken/);
});

test('a probe exception is treated as down (not a crash)', async () => {
  const c: Channel = { id: 'x', label: 'X', backends: [{ id: 'boom', label: 'Boom', probe: async () => { throw new Error('boom'); }, setupHint: '' }], brokenHint: 'x' };
  const statuses = await internetChannelsDoctor([c]);
  assert.strictEqual(statuses[0]?.ok, false);
});

test('renderInternetDoctor formats each row', () => {
  const out = renderInternetDoctor([
    { id: 'web', label: 'Read web pages', ok: true, activeBackend: 'Jina Reader' },
    { id: 'youtube', label: 'YouTube', ok: false, hint: 'yt-dlp not installed.' },
  ]);
  assert.match(out, /\[OK\] Read web pages — via Jina Reader/);
  assert.match(out, /\[FAIL\] YouTube — yt-dlp not installed\./);
});
