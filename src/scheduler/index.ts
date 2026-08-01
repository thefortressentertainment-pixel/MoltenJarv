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
