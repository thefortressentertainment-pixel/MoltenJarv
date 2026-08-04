import type { ToolDefinition, ToolContext } from '../agent/types.js';
import type { JarvGenieConfig } from '../config/index.js';
import { controlAllowed, runAppleScript } from '../computer/index.js';

/**
 * macOS UI automation. Purpose-built tools that build correct System Events
 * AppleScript from structured arguments — so Jarv can physically operate the
 * Mac (activate apps, click buttons, type, send keys) without the user touching
 * it. Requires computer.allowControl=true and macOS Accessibility permission
 * for the hub's process (check with: jarv-genie setup-mac).
 *
 * All tools are consequential: when a consent channel (Telegram) is active,
 * each action waits for explicit user approval before running.
 */

function escapeLiteral(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function requireControl(ctx: ToolContext): { ok: boolean; error?: string } {
  const config = ctx.config as JarvGenieConfig;
  if (!controlAllowed(config)) {
    return {
      ok: false,
      error:
        'approval required: set computer.allowControl=true in ~/.jarv-genie/config.json (restart the hub afterwards) to enable UI control',
    };
  }
  return { ok: true };
}

const KEY_CODES: Record<string, string> = {
  enter: '36',
  return: '36',
  tab: '48',
  escape: '53',
  esc: '53',
  space: '49',
  delete: '51',
  backspace: '51',
  up: '126',
  down: '125',
  left: '123',
  right: '124',
  home: '115',
  end: '119',
  pageup: '116',
  pagedown: '121',
};

function buildKeyScript(combo: string): string {
  const parts = combo.split('+').map((p) => p.trim().toLowerCase());
  const modifiers: string[] = [];
  const keys: string[] = [];
  for (const p of parts) {
    if (p === 'cmd' || p === 'command') modifiers.push('command down');
    else if (p === 'ctrl' || p === 'control') modifiers.push('control down');
    else if (p === 'alt' || p === 'option') modifiers.push('option down');
    else if (p === 'shift') modifiers.push('shift down');
    else keys.push(p);
  }
  const key = keys[0] ?? '';
  if (!key) return '';
  const mods = modifiers.length > 0 ? ` using ${modifiers.join(' and ')}` : '';
  const code = KEY_CODES[key];
  if (code) {
    return `tell application "System Events" to key code ${code}${mods}`;
  }
  const char = key.length === 1 ? key : key.slice(0, 1);
  return `tell application "System Events" to keystroke "${escapeLiteral(char)}"${mods}`;
}

export function uiTools(): ToolDefinition[] {
  return [
    {
      name: 'ui_activate',
      description:
        'Bring an app to the front (activate it) on the Mac. Use before clicking or typing in it. Example: "Clock".',
      inputSchema: {
        type: 'object',
        properties: { app: { type: 'string', description: 'Application name (e.g. Clock, Safari, Notes).' } },
        required: ['app'],
      },
      consequential: true,
      handler: async (args: Record<string, unknown>, ctx: ToolContext) => {
        const gate = requireControl(ctx);
        if (!gate.ok) return gate;
        const app = String(args.app ?? '').trim();
        if (!app) return { ok: false, error: 'app is required' };
        try {
          await runAppleScript(`tell application "${escapeLiteral(app)}" to activate`);
          return { ok: true, activated: app };
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      },
    },
    {
      name: 'ui_quit',
      description:
        'Quit (close) an app on the Mac by name, e.g. ui_quit(app: "Spotify"). Reliable way to close apps; use this instead of clicking close buttons.',
      inputSchema: {
        type: 'object',
        properties: { app: { type: 'string', description: 'Application name to quit.' } },
        required: ['app'],
      },
      consequential: true,
      handler: async (args: Record<string, unknown>, ctx: ToolContext) => {
        const gate = requireControl(ctx);
        if (!gate.ok) return gate;
        const app = String(args.app ?? '').trim();
        if (!app) return { ok: false, error: 'app is required' };
        try {
          await runAppleScript(`tell application "${escapeLiteral(app)}" to quit`);
          return { ok: true, quit: app };
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      },
    },
    {
      name: 'ui_click',
      description:
        'Click a button in the front window of an app on the Mac. The app must be activated first. Example: button "Alarms" in Clock. Returns an error if the button does not exist.',
      inputSchema: {
        type: 'object',
        properties: {
          app: { type: 'string', description: 'Application name (process name).' },
          button: { type: 'string', description: 'Button title to click.' },
        },
        required: ['app', 'button'],
      },
      consequential: true,
      handler: async (args: Record<string, unknown>, ctx: ToolContext) => {
        const gate = requireControl(ctx);
        if (!gate.ok) return gate;
        const app = String(args.app ?? '').trim();
        const button = String(args.button ?? '').trim();
        if (!app || !button) return { ok: false, error: 'app and button are required' };
        try {
          await runAppleScript(
            `tell application "${escapeLiteral(app)}" to activate\n` +
              `tell application "System Events" to tell process "${escapeLiteral(app)}"\n` +
              `  click button "${escapeLiteral(button)}" of window 1\n` +
              `end tell`,
          );
          return { ok: true, app, clicked: button };
        } catch (err) {
          return { ok: false, error: `could not click button "${button}" in ${app}: ${err instanceof Error ? err.message : String(err)}` };
        }
      },
    },
    {
      name: 'ui_type',
      description:
        'Type text into the currently frontmost app on the Mac (as if typing on the keyboard). Use after ui_activate.',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string', description: 'Text to type.' } },
        required: ['text'],
      },
      consequential: true,
      handler: async (args: Record<string, unknown>, ctx: ToolContext) => {
        const gate = requireControl(ctx);
        if (!gate.ok) return gate;
        const text = String(args.text ?? '');
        if (!text) return { ok: false, error: 'text is required' };
        try {
          await runAppleScript(`tell application "System Events" to keystroke "${escapeLiteral(text)}"`);
          return { ok: true, typed: text.slice(0, 200) };
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      },
    },
    {
      name: 'ui_key',
      description:
        'Send a keyboard shortcut to the frontmost app. Examples: "cmd+s", "enter", "escape", "tab", "cmd+shift+p".',
      inputSchema: {
        type: 'object',
        properties: { keys: { type: 'string', description: 'Shortcut, e.g. cmd+s or enter.' } },
        required: ['keys'],
      },
      consequential: true,
      handler: async (args: Record<string, unknown>, ctx: ToolContext) => {
        const gate = requireControl(ctx);
        if (!gate.ok) return gate;
        const keys = String(args.keys ?? '').trim();
        if (!keys) return { ok: false, error: 'keys is required' };
        const script = buildKeyScript(keys);
        if (!script) return { ok: false, error: `unsupported key combo: ${keys}` };
        try {
          await runAppleScript(script);
          return { ok: true, sent: keys };
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      },
    },
    {
      name: 'ui_get_windows',
      description: 'List the open windows of an app on the Mac, so Jarv can see what is on screen before clicking.',
      inputSchema: {
        type: 'object',
        properties: { app: { type: 'string', description: 'Application name (process name).' } },
        required: ['app'],
      },
      handler: async (args: Record<string, unknown>, ctx: ToolContext) => {
        const gate = requireControl(ctx);
        if (!gate.ok) return gate;
        const app = String(args.app ?? '').trim();
        if (!app) return { ok: false, error: 'app is required' };
        try {
          const out = await runAppleScript(
            `tell application "System Events" to tell process "${escapeLiteral(app)}"\n  try\n    get name of every window\n  end try\nend tell`,
          );
          const windows = out
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);
          return { ok: true, app, windows };
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      },
    },
  ];
}
