import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ToolContext } from '../agent/types.js';
import type { JarvGenieConfig } from '../config/index.js';
import { resolveApiKey } from '../config/index.js';

const execFileAsync = promisify(execFile);

export interface ComputerConfig {
  /** Allow control actions (AppleScript/System Events) — requires Accessibility permission. */
  allowControl?: boolean;
  /** Vision model used to describe screens. Default: primary endpoint with llama3.2-vision. */
  visionModel?: string;
  /** Vision endpoint (OpenAI-compatible). Default: the primary endpoint. */
  visionEndpoint?: string;
}

export function computerStatus(config?: JarvGenieConfig): { implemented: boolean; note: string } {
  return {
    implemented: process.platform === 'darwin',
    note: process.platform === 'darwin'
      ? 'screenshot awareness on; control requires computer.allowControl'
      : 'computer tools are macOS-only on the hub machine',
  };
}

/** Capture the current screen to a PNG. macOS screen-recording permission needed. */
export async function screenshot(file: string): Promise<void> {
  if (process.platform !== 'darwin') throw new Error('screenshot requires macOS');
  await execFileAsync('screencapture', ['-x', file]);
}

/** Describe what is on the screen using a vision-capable model. */
export async function describeScreen(file: string, config: JarvGenieConfig, question?: string): Promise<string> {
  const comp = (config as unknown as { computer?: ComputerConfig }).computer ?? {};
  const primary = config.providers.primary;
  const baseUrl = comp.visionEndpoint ?? primary.baseUrl ?? 'http://127.0.0.1:11434/v1';
  const model = comp.visionModel ?? 'llama3.2-vision';
  const key = resolveApiKey(primary) ?? 'not-set';
  const b64 = await fs.readFile(file).then((b) => b.toString('base64'));

  const body = {
    model,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: question ?? 'Describe what is visible on this screen, concisely. Mention any windows and their titles.' },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } },
        ],
      },
    ],
  };

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string | null } }>; error?: { message?: string } };
  if (!res.ok) throw new Error(data.error?.message ?? `vision request failed: HTTP ${res.status}`);
  return data.choices?.[0]?.message?.content ?? '';
}

export async function openApp(app: string): Promise<void> {
  await execFileAsync('open', ['-a', app]);
}

/** Run an AppleScript. Requires computer.allowControl and macOS Accessibility permission. */
export async function runAppleScript(script: string): Promise<string> {
  const res = await execFileAsync('osascript', ['-e', script]);
  return res.stdout;
}

export function controlAllowed(config: JarvGenieConfig): boolean {
  return (config as unknown as { computer?: ComputerConfig }).computer?.allowControl === true;
}
