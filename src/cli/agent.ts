import { execFile } from 'node:child_process';
import { isBusy } from '../resource.js';
import { cronMatches, parseCron, previousFire } from '../scheduler/cron.js';
import {
  loadAgentConfig,
  saveAgentConfig,
  loadAgentState,
  saveAgentState,
  newScheduleId,
  type AgentConfig,
} from '../scheduler/index.js';
import type { ChatBackend } from './backend.js';
import { speak as ttsSpeak } from '../voice/index.js';

function notify(text: string): void {
  if (process.platform !== 'darwin') return;
  const safe = text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').slice(0, 400);
  execFile('osascript', ['-e', `display notification "${safe}" with title "Jarv Genie"`], () => {
    // best effort
  });
}

export async function runAgentSchedule(cfg: AgentConfig, backend: ChatBackend): Promise<void> {
  if (isBusy()) {
    process.stdout.write('[jarv-genie] busy — skipping schedules this tick\n');
    return;
  }
  const state = loadAgentState();
  const now = new Date();
  // Zero-pad month/day so the key round-trips through `new Date()` correctly.
  // (getMonth() is 0-indexed — writing it bare produced "2026-7-5" which
  // `new Date()` read back as *July* 5, making every schedule look "missed".)
  const pad = (n: number): string => String(n).padStart(2, '0');
  const minuteKey = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`;
    const done: string[] = [];

  for (const s of cfg.schedules) {
    let expr;
    try {
      expr = parseCron(s.cron);
    } catch (err) {
      process.stdout.write(`[jarv-genie] skip ${s.id}: ${err instanceof Error ? err.message : String(err)}\n`);
      continue;
    }
    const missed =
      state.lastRun[s.id] !== undefined &&
      new Date(state.lastRun[s.id] as string).getTime() < previousFire(expr, now).getTime();
    if (!cronMatches(expr, now) && !missed) continue;
    if (state.lastRun[s.id] === minuteKey) continue;

    state.lastRun[s.id] = minuteKey;
    saveAgentState(state);
    done.push(s.id);
    process.stdout.write(`[jarv-genie] running ${s.id}${missed ? ' (missed)' : ''}: ${s.prompt}\n`);
    try {
      const result = await backend.chat(s.prompt);
      await deliver(result.text || '(no response)', s, cfg, backend);
    } catch (err) {
      process.stdout.write(`[jarv-genie] ${s.id} failed: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }
  if (done.length > 0) saveAgentState(state);
}

async function deliver(text: string, s: { notify?: boolean; speak?: boolean }, cfg: AgentConfig, backend: ChatBackend): Promise<void> {
  process.stdout.write(`\n[jarv] ${text}\n`);
  if (s.notify ?? cfg.notifications) notify(text);
  if (s.speak ?? cfg.speak) await ttsSpeak(text);
  if (backend.push && ((s.notify ?? cfg.notifications) || (s.speak ?? cfg.speak))) {
    await backend.push(text, { speak: !!(s.speak ?? cfg.speak) });
  }
}

export function printSchedules(cfg: AgentConfig): void {
  const state = loadAgentState();
  if (cfg.schedules.length === 0) {
    process.stdout.write('no schedules — add one with: jarv-genie agent schedule "@daily" "<prompt>"\n');
    return;
  }
  for (const s of cfg.schedules) {
    process.stdout.write(`  ${s.cron.padEnd(12)} ${s.id.padEnd(10)} ${s.prompt}\n`);
    process.stdout.write(`             last run: ${state.lastRun[s.id] ?? 'never'}\n`);
  }
}

export function addSchedule(cron: string, prompt: string, flags: { notify?: boolean; speak?: boolean }): void {
  parseCron(cron); // validate early
  const cfg = loadAgentConfig();
  const id = newScheduleId();
  cfg.schedules.push({ id, cron, prompt, ...flags });
  saveAgentConfig(cfg);
  process.stdout.write(`Added schedule ${id}: ${cron} — ${prompt}\n`);
}

export function removeSchedule(id: string): void {
  const cfg = loadAgentConfig();
  const before = cfg.schedules.length;
  cfg.schedules = cfg.schedules.filter((s) => s.id !== id && s.prompt !== id);
  if (cfg.schedules.length === before) {
    process.stderr.write(`no schedule matches "${id}"\n`);
    return;
  }
  saveAgentConfig(cfg);
  process.stdout.write('Removed.\n');
}

export async function runScheduleNow(id: string, backend: ChatBackend): Promise<void> {
  const cfg = loadAgentConfig();
  const s = cfg.schedules.find((x) => x.id === id);
  if (!s) {
    process.stderr.write(`no schedule with id "${id}"\n`);
    return;
  }
  const result = await backend.chat(s.prompt);
  await deliver(result.text || '(no response)', s, cfg, backend);
}

export async function runAdHoc(
  prompt: string,
  backend: ChatBackend,
  flags: { notify?: boolean; speak?: boolean },
): Promise<void> {
  const cfg = loadAgentConfig();
  const result = await backend.chat(prompt);
  process.stdout.write(`\n[jarv] ${result.text || '(no response)'}\n`);
  if (flags.notify) notify(result.text ?? '');
  if (flags.speak) await ttsSpeak(result.text ?? '');
}
