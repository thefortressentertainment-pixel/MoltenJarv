import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ToolContext, ToolDefinition } from '../agent/types.js';
import type { JarvGenieConfig } from '../config/index.js';
import { controlAllowed, describeScreen, extractScreenText, openApp, runAppleScript, screenshot } from '../computer/index.js';

const execFileAsync = promisify(execFile);

export function computerTools(): ToolDefinition[] {
  return [
    {
      name: 'screen_capture',
      system: 'sense',
      description:
        'Capture the current screen on the hub machine and describe what is visible (windows, apps). Requires macOS screen-recording permission. If no vision model is configured, falls back to reading the on-screen TEXT via macOS OCR (instant, on-device). Optionally pass a question about the screen.',
      inputSchema: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'Optional specific question about the screen contents' },
        },
      },
      handler: async (args: Record<string, unknown>, ctx: ToolContext) => {
        if (process.platform !== 'darwin') return { ok: false, error: 'screen_capture requires macOS' };
        const dir = mkdtempSync(path.join(os.tmpdir(), 'jarv-screen-'));
        const file = path.join(dir, 'screen.png');
        try {
          await screenshot(file);
          const question = String(args.question ?? '').trim() || undefined;
          try {
            const description = await describeScreen(file, ctx.config as JarvGenieConfig, question);
            return { ok: true, description };
          } catch (visionErr) {
            // No usable vision model (e.g. small RAM machine) — fall back to
            // on-device OCR so Jarv can still read the screen.
            const ocr = await extractScreenText(file);
            if (ocr.ok) {
              return {
                ok: true,
                mode: 'ocr',
                description:
                  `(No vision model available — reading the on-screen text instead.)\n\n${ocr.text}`,
              };
            }
            return {
              ok: false,
              error: `vision unavailable: ${visionErr instanceof Error ? visionErr.message : String(visionErr)}${
                ocr.error ? ` — OCR also failed: ${ocr.error}` : ''
              }`,
            };
          }
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      },
    },
    {
      name: 'screen_read',
      system: 'sense',
      description:
        'Read the text currently visible on the screen (webpages, terminals, apps, documents) using macOS built-in OCR — instant, on-device, no vision model and no cloud. Screenshots the screen and returns the recognized text. Use to check what a page or app is showing.',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        if (process.platform !== 'darwin') return { ok: false, error: 'screen_read requires macOS' };
        const dir = mkdtempSync(path.join(os.tmpdir(), 'jarv-ocr-'));
        const file = path.join(dir, 'screen.png');
        try {
          await screenshot(file);
          const res = await extractScreenText(file);
          if (!res.ok) return { ok: false, error: res.error ?? 'no text recognized on screen' };
          return { ok: true, text: res.text, note: 'extracted via macOS Vision OCR (on-device, no model)' };
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      },
    },
    {
      name: 'open_app',
      system: 'effector',
      description: 'Open an application on the hub machine by name, e.g. Calendar or Safari.',
      inputSchema: {
        type: 'object',
        properties: {
          app: { type: 'string', description: 'The application name' },
        },
        required: ['app'],
      },
      consequential: true,
      handler: async (args: Record<string, unknown>) => {
        const app = String(args.app ?? '').trim();
        if (!app) return { ok: false, error: 'app is required' };
        try {
          await openApp(app);
          return { ok: true, opened: app };
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      },
    },
    {
      name: 'open_alarms',
      system: 'effector',
      description:
        'Open the macOS Clock app to the Alarms tab on the hub machine. Use when the user asks to see or open their alarms.',
      inputSchema: { type: 'object', properties: {} },
      consequential: true,
      handler: async () => {
        try {
          await execFileAsync('open', ['clock-alarm://']);
          return { ok: true, opened: 'Clock — Alarms' };
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      },
    },
    {
      name: 'run_apple_script',
      system: 'effector',
      description:
        'Run an AppleScript on the hub machine (System Events, apps, shortcuts). Requires computer.allowControl in config and macOS Accessibility permission.',
      inputSchema: {
        type: 'object',
        properties: {
          script: { type: 'string', description: 'The AppleScript source to run' },
        },
        required: ['script'],
      },
      consequential: true,
      handler: async (args: Record<string, unknown>, ctx: ToolContext) => {
        const config = ctx.config as JarvGenieConfig;
        if (!controlAllowed(config)) {
          return {
            ok: false,
            error: 'approval required: set computer.allowControl=true in ~/.jarv-genie/config.json to enable control actions',
          };
        }
        const script = String(args.script ?? '');
        if (!script.trim()) return { ok: false, error: 'script is required' };
        try {
          const output = await runAppleScript(script);
          return { ok: true, output };
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      },
    },
  ];
}
