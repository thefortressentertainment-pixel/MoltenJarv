import fs from 'node:fs/promises';
import path from 'node:path';
import type { ChatMessage } from './types.js';
import { dataHome } from '../config/defaults.js';

/**
 * Durable task checkpoints. When a TaskRunner run exhausts its step budget, the
 * full working context (system prompt, every assistant turn, every tool result)
 * is saved here so the owner can reply "continue" and the task genuinely
 * resumes from where it stopped — instead of restarting from a summary.
 */

export interface TaskCheckpoint {
  sessionId: string;
  messages: ChatMessage[];
  steps: number;
  toolCalls: number;
  completed: string[];
  updatedAt: string;
}

function dir(): string {
  return path.join(dataHome(), 'checkpoints');
}

function file(sessionId: string): string {
  const safe = sessionId.replace(/[^A-Za-z0-9._-]/g, '_');
  return path.join(dir(), `${safe}.json`);
}

export async function saveCheckpoint(cp: TaskCheckpoint): Promise<void> {
  await fs.mkdir(dir(), { recursive: true });
  await fs.writeFile(file(cp.sessionId), JSON.stringify(cp, null, 2) + '\n', { encoding: 'utf8' });
}

export async function loadCheckpoint(sessionId: string): Promise<TaskCheckpoint | null> {
  try {
    const raw = await fs.readFile(file(sessionId), 'utf8');
    const cp = JSON.parse(raw) as TaskCheckpoint;
    if (cp && Array.isArray(cp.messages) && cp.messages.length > 0) return cp;
    return null;
  } catch {
    return null;
  }
}

export async function clearCheckpoint(sessionId: string): Promise<void> {
  try {
    await fs.rm(file(sessionId), { force: true });
  } catch {
    /* ignore */
  }
}

/** Does this message ask Jarv to resume an interrupted task? */
export function isResumeIntent(input: string): boolean {
  return /^\s*(continue|resume|keep going|keep at it|carry on|pick up where|go on)\b/i.test(input.trim());
}
