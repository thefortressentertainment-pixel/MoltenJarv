import assert from 'node:assert';
import { test } from 'node:test';
import type { ToolContext } from '../src/agent/types.js';
import { statusTools } from '../src/tools/status.js';
import { calendarTools } from '../src/tools/calendar.js';
import { briefingTools } from '../src/tools/briefing.js';
import { humanDuration, statusSummary, type SystemStatus } from '../src/computer/status.js';

function makeContext(extra: unknown = {}): ToolContext {
  return { workdir: '/tmp', config: {}, memory: {}, ...extra } as unknown as ToolContext;
}

test('humanDuration formats spans', () => {
  assert.strictEqual(humanDuration(0), 'just now');
  assert.strictEqual(humanDuration(45), '45s');
  assert.strictEqual(humanDuration(3661), '1h 1m');
  assert.strictEqual(humanDuration(90061), '1d 1h 1m');
});

test('statusSummary covers power, cpu, memory, disk, network', () => {
  const s: SystemStatus = {
    platform: 'darwin',
    hostname: 'mac',
    user: 'tfe',
    power: { source: 'Battery Power', batteryPercent: 82, charging: false, timeRemaining: '' },
    cpu: { cores: 8, loadAvg: [1.5, 1.2, 1.0] },
    memory: { totalGb: 16, usedGb: 6, freeGb: 10 },
    disk: { totalGb: 500, usedGb: 300, freeGb: 200 },
    uptime: { seconds: 3600, human: '1h' },
    network: { ipv4: ['192.168.1.5'], wifi: 'HomeNet' },
  };
  const out = statusSummary(s);
  assert.match(out, /82%/);
  assert.match(out, /1\.50\/1\.20\/1\.00 load \(8 cores\)/);
  assert.match(out, /6\/16 GB free 10 GB/);
  assert.match(out, /200 GB of 500 GB/);
  assert.match(out, /192\.168\.1\.5/);
  assert.match(out, /HomeNet/);
});

test('system_status tool reports the real machine on macOS', async () => {
  const tool = statusTools().find((t) => t.name === 'system_status');
  assert.ok(tool);
  const res = await tool.handler({}, makeContext());
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.status.platform, process.platform);
  assert.strictEqual(typeof res.status.power.source, 'string');
  assert.strictEqual(typeof res.status.uptime.seconds, 'number');
});

test('calendar tools are gated behind allowControl', async () => {
  const tools = calendarTools();
  const agenda = tools.find((t) => t.name === 'calendar_agenda')!;
  const add = tools.find((t) => t.name === 'calendar_add')!;
  assert.ok(agenda);
  assert.ok(add);
  assert.strictEqual(add.consequential, true);

  const locked = await agenda.handler({}, makeContext());
  assert.strictEqual(locked.ok, false);
  assert.match(locked.error, /approval required/);

  const lockedAdd = await add.handler({ title: 'x', start: '2026-08-05T14:00:00' }, makeContext());
  assert.strictEqual(lockedAdd.ok, false);
});

test('daily_briefing degrades gracefully with no permissions', async () => {
  const tool = briefingTools().find((t) => t.name === 'daily_briefing');
  assert.ok(tool);
  const res = await tool.handler({}, makeContext());
  assert.strictEqual(res.ok, true);
  assert.match(res.briefing, /## time/);
  assert.ok(Array.isArray(res.unavailable));
});
