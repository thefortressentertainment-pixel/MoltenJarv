import { createHash } from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { dataHome } from '../config/defaults.js';
import type { ChatBackend } from './backend.js';
import { speak as ttsSpeak } from '../voice/index.js';
import { notify } from './sidecar.js';

export type MonitorKind = 'dir' | 'web' | 'metric';

export interface Monitor {
  id: string;
  kind: MonitorKind;
  target: string;
  prompt: string;
  /** Seconds between checks. Default 300. */
  every: number;
  notify?: boolean;
  speak?: boolean;
  /** SHA-256 of the last observed state; trigger fires when it changes. */
  lastHash: string;
  lastTriggered: string;
}

export interface MonitorConfig {
  monitors: Monitor[];
}

const MONITORS_FILE = 'monitors.json';

export function monitorsPath(): string {
  return path.join(dataHome(), MONITORS_FILE);
}

export function loadMonitors(): MonitorConfig {
  try {
    const raw = JSON.parse(fs.readFileSync(monitorsPath(), 'utf8')) as Partial<MonitorConfig>;
    return { monitors: Array.isArray(raw.monitors) ? raw.monitors : [] };
  } catch {
    return { monitors: [] };
  }
}

export function saveMonitors(cfg: MonitorConfig): void {
  fs.mkdirSync(dataHome(), { recursive: true });
  fs.writeFileSync(monitorsPath(), JSON.stringify(cfg, null, 2) + '\n');
}

/** Snapshot the current state of a monitor target. Null if it cannot be observed. */
export async function snapshotState(kind: MonitorKind, target: string): Promise<string | null> {
  try {
    if (kind === 'dir') {
      const entries = walkDir(target);
      return hashText(entries.map((e) => `${e.path}:${e.size}:${e.mtimeMs}:${e.contentHash}`).join('\n'));
    }
    if (kind === 'web') {
      return hashText(await fetchText(target));
    }
    if (kind === 'metric') {
      const out = execFileSync('/bin/sh', ['-c', target], { encoding: 'utf8', timeout: 15_000 });
      return hashText(out);
    }
  } catch {
    return null;
  }
  return null;
}

/** Whether the monitor's target has changed since it last fired. */
export async function hasChanged(m: Monitor): Promise<boolean> {
  const current = await snapshotState(m.kind, m.target);
  if (current === null) return false;
  return current !== m.lastHash;
}

export async function describeState(kind: MonitorKind, target: string): Promise<string> {
  if (kind === 'dir') {
    const entries = walkDir(target);
    const total = entries.reduce((n, e) => n + e.size, 0);
    const recent = [...entries].sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, 10);
    const lines = recent.map((e) => `  ${e.mtime.toISOString()} ${e.size}B  ${e.path}`);
    return `directory "${target}" — ${entries.length} files, ${total} bytes\nmost recent:\n${lines.join('\n') || '  (empty)'}`;
  }
  if (kind === 'web') {
    const text = await fetchText(target);
    return `web page ${target} — ${text.length} chars\nhead:\n  ${text.replace(/\s+/g, ' ').slice(0, 400) || '(empty)'}`;
  }
  const out = execFileSync('/bin/sh', ['-c', target], { encoding: 'utf8', timeout: 15_000 });
  return `metric output:\n${out.trim().slice(0, 1000) || '(empty)'}`;
}

export async function addMonitor(
  kind: string,
  target: string,
  prompt: string,
  flags: { every?: number; notify?: boolean; speak?: boolean } = {},
): Promise<void> {
  if (kind !== 'dir' && kind !== 'web' && kind !== 'metric') {
    throw new Error('monitor kind must be one of: dir, web, metric');
  }
  if (!target || !prompt) {
    throw new Error('usage: jarv-genie monitor add <dir|web|metric> <target> "<prompt>"');
  }
  const cfg = loadMonitors();
  const id = `m-${Date.now().toString(36)}`;
  const m: Monitor = {
    id,
    kind,
    target,
    prompt,
    every: Math.max(flags.every ?? 300, 10),
    notify: flags.notify ?? false,
    speak: flags.speak ?? false,
    lastHash: (await snapshotState(kind, target)) ?? '',
    lastTriggered: '',
  };
  cfg.monitors.push(m);
  saveMonitors(cfg);
  process.stdout.write(`Added monitor ${id}: watch ${kind} "${target}" every ${m.every}s\n`);
  if (!m.lastHash) {
    process.stdout.write(`  (could not snapshot the target yet — will fire on first successful observation)\n`);
  }
}

export function printMonitors(): void {
  const cfg = loadMonitors();
  if (cfg.monitors.length === 0) {
    process.stdout.write('no monitors — add one with: jarv-genie monitor add <dir|web|metric> <target> "<prompt>"\n');
    return;
  }
  for (const m of cfg.monitors) {
    process.stdout.write(`  ${m.id.padEnd(10)} ${m.kind.padEnd(6)} every ${String(m.every).padEnd(4)} ${m.target}\n`);
    process.stdout.write(`             last fired: ${m.lastTriggered || 'never'} — ${m.prompt}\n`);
  }
}

export function removeMonitor(id: string): void {
  const cfg = loadMonitors();
  const before = cfg.monitors.length;
  cfg.monitors = cfg.monitors.filter((m) => m.id !== id);
  if (cfg.monitors.length === before) {
    throw new Error(`no monitor matches "${id}"`);
  }
  saveMonitors(cfg);
  process.stdout.write('Removed.\n');
}

async function deliver(text: string, m: Monitor, backend: ChatBackend): Promise<void> {
  process.stdout.write(`\n[monitor ${m.id}] ${text}\n`);
  if (m.notify) notify(text);
  if (m.speak) await ttsSpeak(text);
  if (backend.push && (m.notify || m.speak)) {
    await backend.push(text, { speak: m.speak });
  }
}

export async function runMonitorDaemon(backend: ChatBackend): Promise<void> {
  process.stdout.write(`[jarv-genie] monitor daemon (${backend.kind}) — ctrl-c to stop\n`);
  printMonitors();
  const tick = async (): Promise<void> => {
    const cfg = loadMonitors();
    const now = Date.now();
    for (const m of cfg.monitors) {
      if (m.lastTriggered && now - new Date(m.lastTriggered).getTime() < m.every * 1000) continue;
      const changed = await hasChanged(m);
      m.lastTriggered = new Date().toISOString();
      saveMonitors(cfg);
      if (!changed) continue;
      process.stdout.write(`[jarv-genie] ${m.id} changed: ${m.target}\n`);
      try {
        const state = await describeState(m.kind, m.target);
        const result = await backend.chat(`Monitor ${m.kind} ${m.target} just changed.\n\nCurrent state:\n${state}\n\n${m.prompt}`);
        await deliver(result.text || '(no response)', m, backend);
      } catch (err) {
        process.stdout.write(`[jarv-genie] ${m.id} failed: ${err instanceof Error ? err.message : String(err)}\n`);
      }
    }
  };
  await tick();
  const timer = setInterval(tick, 30_000);
  process.on('SIGINT', () => {
    clearInterval(timer);
    process.exit(0);
  });
  await new Promise(() => {});
}

interface DirEntry {
  path: string;
  size: number;
  mtime: Date;
  mtimeMs: number;
  /** Content hash for small files so same-timestamp edits still fire. */
  contentHash: string;
}

function walkDir(dir: string): DirEntry[] {
  const out: DirEntry[] = [];
  const walk = (d: string): void => {
    for (const name of fs.readdirSync(d)) {
      const full = path.join(d, name);
      const st = fs.statSync(full);
      if (st.isDirectory()) {
        walk(full);
      } else {
        let contentHash = '';
        if (st.size <= 1_048_576) {
          try {
            contentHash = createHash('sha256').update(fs.readFileSync(full)).digest('hex');
          } catch {
            // unreadable file — fall back to metadata only
          }
        }
        out.push({ path: full, size: st.size, mtime: st.mtime, mtimeMs: st.mtimeMs, contentHash });
      }
    }
  };
  walk(dir);
  return out;
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}
