import assert from 'node:assert';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { parseCron, cronMatches, previousFire } from '../src/scheduler/cron.js';
import { loadAgentConfig, saveAgentConfig, loadAgentState, saveAgentState, newScheduleId } from '../src/scheduler/index.js';

test('cron parser handles *, steps, ranges, and lists', () => {
  const every5 = parseCron('*/5 * * * *');
  assert.ok(every5.minute.includes(0));
  assert.ok(every5.minute.includes(55));
  assert.ok(!every5.minute.includes(3));

  const range = parseCron('0 9-11 * * 1-5');
  assert.deepStrictEqual(range.hour, [9, 10, 11]);
  assert.deepStrictEqual(range.dayOfWeek, [1, 2, 3, 4, 5]);

  const list = parseCron('15,45 0 * * *');
  assert.deepStrictEqual(list.minute, [15, 45]);

  assert.deepStrictEqual(parseCron('@daily').hour, [0]);
  assert.throws(() => parseCron('0 0 * * * *'), /invalid cron/);
  assert.throws(() => parseCron('61 * * * *'), /out of range/);
});

test('cron parser accepts weekday and month names', () => {
  assert.deepStrictEqual(parseCron('0 8 * * Sat').dayOfWeek, [6]);
  assert.deepStrictEqual(parseCron('0 8 * * sa').dayOfWeek, [6]);
  assert.deepStrictEqual(parseCron('0 8 * * Saturday').dayOfWeek, [6]);
  assert.deepStrictEqual(parseCron('0 9 * * MON-FRI').dayOfWeek, [1, 2, 3, 4, 5]);
  assert.deepStrictEqual(parseCron('0 7 * JAN *').month, [1]);
  assert.throws(() => parseCron('0 8 * * Saxy'), /invalid cron/);
});

test('cronMatches checks all fields', () => {
  const expr = parseCron('30 9 * * *');
  assert.ok(cronMatches(expr, new Date(2026, 7, 1, 9, 30)));
  assert.ok(!cronMatches(expr, new Date(2026, 7, 1, 9, 31)));
  assert.ok(!cronMatches(expr, new Date(2026, 7, 1, 10, 30)));
});

test('previousFire finds the last matching moment', () => {
  const expr = parseCron('0 9 * * *');
  const prev = previousFire(expr, new Date(2026, 7, 3, 12, 0));
  assert.strictEqual(prev.getDate(), 3);
  assert.strictEqual(prev.getHours(), 9);
  assert.strictEqual(prev.getMinutes(), 0);
});

test('scheduler config and state round-trip', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'jarv-sched-'));
  const oldHome = process.env.HOME;
  process.env.HOME = dir;
  try {
    const cfg = loadAgentConfig();
    assert.deepStrictEqual(cfg.schedules, []);
    const id = newScheduleId();
    cfg.schedules.push({ id, cron: '0 9 * * *', prompt: 'morning briefing', notify: true });
    cfg.speak = true;
    saveAgentConfig(cfg);

    const reloaded = loadAgentConfig();
    assert.strictEqual(reloaded.schedules.length, 1);
    assert.strictEqual(reloaded.schedules[0]!.prompt, 'morning briefing');
    assert.strictEqual(reloaded.speak, true);
    assert.ok(existsSync(path.join(dir, '.jarv-genie', 'agent.json')));

    const state = loadAgentState();
    state.lastRun[id] = '2026-08-01T09:00:00';
    saveAgentState(state);
    const st = loadAgentState();
    assert.strictEqual(st.lastRun[id], '2026-08-01T09:00:00');
    assert.match(readFileSync(path.join(dir, '.jarv-genie', 'agent.json'), 'utf8'), /morning briefing/);
  } finally {
    process.env.HOME = oldHome ?? '';
    rmSync(dir, { recursive: true, force: true });
  }
});
