import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { shutdownTools } from '../src/tools/shutdown.js';
import { recordShutdownRequest, readShutdownLog, lastShutdownRequest, verifyLastShutdown } from '../src/cli/shutdown.js';
import type { ToolContext } from '../src/agent/types.js';

const ctx = { config: {}, memory: {}, workdir: '/' } as unknown as ToolContext;

function withHome(fn: () => Promise<void>): Promise<void> {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'jarv-sd-'));
  const oldHome = process.env.HOME;
  process.env.HOME = dir;
  return fn().finally(() => {
    process.env.HOME = oldHome ?? '';
    rmSync(dir, { recursive: true, force: true });
  });
}

test('shutdown tools are exposed; shutdown_mac is consequential', () => {
  const names = shutdownTools().map((t) => t.name);
  assert.ok(names.includes('shutdown_mac'));
  assert.ok(names.includes('shutdown_status'));
  const mac = shutdownTools().find((t) => t.name === 'shutdown_mac')!;
  assert.strictEqual(mac.consequential, true);
});

test('shutdown log records intent and can be read back', async () => {
  await withHome(async () => {
    recordShutdownRequest('test');
    const log = readShutdownLog();
    assert.match(log, /shutdown requested \(test\)/);
    assert.match(log, /^\d{4}-\d{2}-\d{2}T/);
  });
});

test('lastShutdownRequest parses the most recent request; none when empty', async () => {
  await withHome(async () => {
    assert.strictEqual(lastShutdownRequest(), null);
    recordShutdownRequest('a');
    const d = lastShutdownRequest();
    assert.ok(d instanceof Date && !Number.isNaN(d.getTime()));
  });
});

test('verifyLastShutdown reports NOT verified for a future request, verified for a past one', async () => {
  await withHome(async () => {
    const home = process.env.HOME!;
    const logPath = path.join(home, '.jarv-genie', 'shutdown.log');
    fs.mkdirSync(path.dirname(logPath), { recursive: true });

    const future = new Date(Date.now() + 3600_000).toISOString();
    fs.writeFileSync(logPath, `${future} shutdown requested (test)\n`);
    const notVerified = await verifyLastShutdown();
    assert.match(notVerified, /NOT verified/);

    const past = new Date(Date.now() - 86400_000).toISOString();
    fs.writeFileSync(logPath, `${past} shutdown requested (test)\n`);
    const verified = await verifyLastShutdown();
    assert.match(verified, /verified: shutdown was requested/);
  });
});

test('shutdown_status returns the log and verification via the tool', async () => {
  await withHome(async () => {
    const tool = shutdownTools().find((t) => t.name === 'shutdown_status')!;
    const res = (await tool.handler({}, ctx)) as { log: string; verification: string };
    assert.match(res.log, /no shutdowns logged/);
    assert.match(res.verification, /no shutdown has been recorded/);
  });
});
