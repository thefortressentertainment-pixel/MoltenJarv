import fs from 'node:fs';
import path from 'node:path';
import { dataHome } from '../config/defaults.js';

export interface Schedule {
  id: string;
  cron: string;
  prompt: string;
  speak?: boolean;
  notify?: boolean;
}

export interface AgentConfig {
  schedules: Schedule[];
  notifications: boolean;
  speak: boolean;
}

export interface AgentState {
  lastRun: Record<string, string>;
}

const AGENT_FILE = 'agent.json';

export function agentConfigPath(): string {
  return path.join(dataHome(), AGENT_FILE);
}

export function loadAgentConfig(): AgentConfig {
  let user: unknown = {};
  try {
    user = JSON.parse(fs.readFileSync(agentConfigPath(), 'utf8'));
  } catch {
    // defaults
  }
  const base: AgentConfig = { schedules: [], notifications: true, speak: false };
  const u = (user ?? {}) as Partial<AgentConfig>;
  return {
    schedules: Array.isArray(u.schedules) ? u.schedules : [],
    notifications: typeof u.notifications === 'boolean' ? u.notifications : base.notifications,
    speak: typeof u.speak === 'boolean' ? u.speak : base.speak,
  };
}

export function saveAgentConfig(cfg: AgentConfig): void {
  fs.mkdirSync(dataHome(), { recursive: true });
  fs.writeFileSync(agentConfigPath(), JSON.stringify(cfg, null, 2) + '\n');
}

export function loadAgentState(): AgentState {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dataHome(), 'agent-state.json'), 'utf8'));
    return { lastRun: raw?.lastRun ?? {} };
  } catch {
    return { lastRun: {} };
  }
}

export function saveAgentState(state: AgentState): void {
  fs.mkdirSync(dataHome(), { recursive: true });
  fs.writeFileSync(path.join(dataHome(), 'agent-state.json'), JSON.stringify(state, null, 2) + '\n');
}

export function newScheduleId(): string {
  return `s-${Date.now().toString(36)}`;
}

/**
 * Crash-loop breaker for the agent daemon. Because the daemon runs under a
 * launchd service with KeepAlive=true, an unexpected process-level crash would
 * be respawned instantly forever — a hot loop that pins CPU and spams the log.
 * These helpers persist consecutive-crash counts so a genuinely stuck daemon
 * backs off (exponential) instead of spinning, and a healthy run resets them.
 */
const CRASH_FILE = path.join(dataHome(), 'agent-crashes.json');

interface CrashState {
  consecutive: number;
  lastCrash: number;
}

function loadCrashState(): CrashState {
  try {
    const raw = JSON.parse(fs.readFileSync(CRASH_FILE, 'utf8'));
    return {
      consecutive: typeof raw?.consecutive === 'number' ? raw.consecutive : 0,
      lastCrash: typeof raw?.lastCrash === 'number' ? raw.lastCrash : 0,
    };
  } catch {
    return { consecutive: 0, lastCrash: 0 };
  }
}

function saveCrashState(s: CrashState): void {
  fs.mkdirSync(dataHome(), { recursive: true });
  fs.writeFileSync(CRASH_FILE, JSON.stringify(s));
}

/** Record that the daemon hit a fatal tick error. Returns the backoff delay (ms). */
export function recordDaemonCrash(): number {
  const s = loadCrashState();
  s.consecutive = s.consecutive >= 60 ? 60 : s.consecutive + 1;
  s.lastCrash = Date.now();
  saveCrashState(s);
  // Exponential backoff: 30s, 1m, 2m, 4m, ... capped at 10 minutes.
  return Math.min(30_000 * 2 ** (s.consecutive - 1), 10 * 60 * 1000);
}

/** Reset the crash counter after a clean, healthy run. */
export function resetDaemonCrashCount(): void {
  const s = loadCrashState();
  if (s.consecutive !== 0) {
    saveCrashState({ consecutive: 0, lastCrash: 0 });
  }
}

