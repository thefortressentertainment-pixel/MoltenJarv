import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { shutdownTools } from '../src/tools/shutdown.js';
import { recordShutdownRequest, readShutdownLog } from '../src/cli/shutdown.js';
import type { ToolContext } from '../src/agent/types.js';

const ctx = { config: {}, memory: {}, workdir: '/' } as unknown as ToolContext;

test('shutdown tools are exposed; shutdown_mac is consequential', () => {
  const names = shutdownTools().map((t) => t.name);
  assert.ok(names.includes('shutdown_mac'));
  assert.ok(names.includes('shutdown_status'));
  const mac = shutdownTools().find((t) => t.name === 'shutdown_mac')!;
  assert.strictEqual(mac.consequential, true);
});

test('shutdown log records intent and can be read back', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'jarv-sd-'));
  const oldHome = process.env.HOME;
  process.env.HOME = dir;
  try {
    recordShutdownRequest('test');
    const log = readShutdownLog();
    assert.match(log, /shutdown requested \(test\)/);
    assert.match(log, /^\d{4}-\d{2}-\d{2}T/);
  } finally {
    process.env.HOME = oldHome ?? '';
    rmSync(dir, { recursive: true, force: true });
  }
});

test('shutdown_status returns the log via the tool', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'jarv-sd2-'));
  const oldHome = process.env.HOME;
  process.env.HOME = dir;
  try {
    const tool = shutdownTools().find((t) => t.name === 'shutdown_status')!;
    const res = (await tool.handler({}, ctx)) as { log: string };
    assert.match(res.log, /no shutdowns logged/);
  } finally {
    process.env.HOME = oldHome ?? '';
    rmSync(dir, { recursive: true, force: true });
  }
});
