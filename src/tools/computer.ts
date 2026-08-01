import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ToolContext, ToolDefinition } from '../agent/types.js';
import type { JarvGenieConfig } from '../config/index.js';
import { controlAllowed, describeScreen, openApp, runAppleScript, screenshot } from '../computer/index.js';

export function computerTools(): ToolDefinition[] {
  return [
    {
      name: 'screen_capture',
      description:
        'Capture the current screen on the hub machine and describe what is visible (windows, apps). Requires macOS screen-recording permission. Optionally pass a question about the screen.',
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
          const description = await describeScreen(file, ctx.config as JarvGenieConfig, question);
          return { ok: true, description };
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      },
    },
    {
      name: 'open_app',
      description: 'Open an application on the hub machine by name, e.g. Calendar or Safari.',
      inputSchema: {
        type: 'object',
        properties: {
          app: { type: 'string', description: 'The application name' },
        },
        required: ['app'],
      },
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
      name: 'run_apple_script',
      description:
        'Run an AppleScript on the hub machine (System Events, apps, shortcuts). Requires computer.allowControl in config and macOS Accessibility permission.',
      inputSchema: {
        type: 'object',
        properties: {
          script: { type: 'string', description: 'The AppleScript source to run' },
        },
        required: ['script'],
      },
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
