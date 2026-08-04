import type { ToolDefinition } from '../agent/types.js';
import { runAppleScript } from '../computer/index.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

/**
 * The "real-life Jarvis" app-control layer: every manual Mac ability, expressed
 * as curated, one-call AppleScript recipes. Everything here is a fixed, vetted
 * command — no free-form AppleScript, no shell, no file writes, no System Events
 * UI scripting (so no extra Automation/Accessibility popups). Unknown apps or
 * actions are refused. Mutating actions are consent-gated; reads are free.
 */

const execFileAsync = promisify(execFile);

function esc(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

type Builder = (p: Record<string, unknown>) => string;

interface Recipe {
  aliases: string[];
  app: string; // AppleScript application name
  extra?: Record<string, Builder>; // app-specific mutating actions
  status?: Builder; // read-only player/state read
}

const APP_RECIPES: Record<string, Recipe> = {
  spotify: {
    aliases: ['spotify'],
    app: 'Spotify',
    extra: {
      play: (p) => `tell application "Spotify"\n  open location "${esc(String(p.uri ?? ''))}"\n  play\nend tell`,
      playPause: () => 'tell application "Spotify" to playpause',
      next: () => 'tell application "Spotify" to next track',
      prev: () => 'tell application "Spotify" to previous track',
    },
    status: () => 'tell application "Spotify"\n  set p to player state\n  set t to ""\n  set a to ""\n  try\n    set t to name of current track\n    set a to artist of current track\n  end try\n  return p & "|" & t & "|" & a\nend tell',
  },
  music: {
    aliases: ['apple music', 'itunes'],
    app: 'Music',
    extra: {
      play: (p) => `tell application "Music"\n  play playlist "${esc(String(p.playlist ?? p.uri ?? ''))}"\nend tell`,
      playPause: () => 'tell application "Music" to playpause',
      next: () => 'tell application "Music" to next track',
      prev: () => 'tell application "Music" to previous track',
    },
    status: () => 'tell application "Music"\n  set p to player state\n  set t to ""\n  set a to ""\n  try\n    set t to name of current track\n    set a to artist of current track\n  end try\n  return p & "|" & t & "|" & a\nend tell',
  },
  notes: {
    aliases: ['notes'],
    app: 'Notes',
    extra: { newNote: (p) => `tell application "Notes" to make new note with properties {body:"${esc(String(p.text ?? ''))}"}` },
  },
  messages: {
    aliases: ['messages', 'imessage'],
    app: 'Messages',
    extra: { send: (p) => `tell application "Messages" to send "${esc(String(p.text ?? ''))}" to buddy "${esc(String(p.contact ?? ''))}"` },
  },
  safari: {
    aliases: ['safari'],
    app: 'Safari',
    extra: {
      openUrl: (p) => `tell application "Safari" to open location "${esc(String(p.url ?? ''))}"`,
      newTab: (p) => `tell application "Safari"\n  make new document with properties {URL:"${esc(String(p.url ?? ''))}"}\nend tell`,
      back: () => 'tell application "Safari" to tell front window to go back',
      forward: () => 'tell application "Safari" to tell front window to go forward',
    },
  },
  chrome: {
    aliases: ['google chrome', 'chrome'],
    app: 'Google Chrome',
    extra: {
      openUrl: (p) => `tell application "Google Chrome" to open location "${esc(String(p.url ?? ''))}"`,
      newTab: (p) => `tell application "Google Chrome" to open location "${esc(String(p.url ?? ''))}"`,
      back: () => 'tell application "Google Chrome" to tell active tab of front window to go back',
      forward: () => 'tell application "Google Chrome" to tell active tab of front window to go forward',
    },
  },
  calendar: {
    aliases: ['calendar'],
    app: 'Calendar',
    extra: { addEvent: (p) => calendarEvent(String(p.title ?? ''), String(p.date ?? '')) },
  },
  finder: { aliases: ['finder'], app: 'Finder' },
  calculator: { aliases: ['calculator'], app: 'Calculator' },
  clock: { aliases: ['clock'], app: 'Clock' },
  preview: { aliases: ['preview'], app: 'Preview' },
  terminal: { aliases: ['terminal'], app: 'Terminal' },
  vscodium: { aliases: ['vscodium', 'vs code'], app: 'VSCodium' },
  settings: { aliases: ['settings', 'system settings'], app: 'System Settings' },
  photos: { aliases: ['photos'], app: 'Photos' },
};

/** Build a locale-independent AppleScript date from an ISO string. */
function dateLines(iso: string, indent: string): string[] {
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return [];
  return [
    `${indent}set d to current date`,
    `${indent}set year of d to ${t.getFullYear()}`,
    `${indent}set month of d to ${t.getMonth() + 1}`,
    `${indent}set day of d to ${t.getDate()}`,
    `${indent}set hours of d to ${t.getHours()}`,
    `${indent}set minutes of d to ${t.getMinutes()}`,
    `${indent}set seconds of d to 0`,
  ];
}

function calendarEvent(title: string, iso: string): string {
  const lines = [
    'tell application "Calendar"',
    '  make new event with properties {summary:"' + esc(title) + '"}',
  ];
  lines.push(...dateLines(iso, '  '));
  lines.push('  set start date of last event to d', '  set end date of last event to (d + 3600 seconds)', 'end tell');
  return lines.join('\n');
}

const SYSTEM_ACTIONS: Record<string, Builder> = {
  sleep: () => 'tell application "System Events" to sleep',
  lock: () => 'do shell script "/System/Library/CoreServices/Menu Extras/User.menu/Contents/Resources/CGSession -suspend"',
  displaySleep: () => 'do shell script "pmset displaysleepnow"',
  volumeSet: (p) => `set volume output volume ${Math.min(100, Math.max(0, Math.round(Number(p.value ?? 0) || 0)))}`,
  volumeUp: () => 'set volume output volume ((output volume of (get volume settings)) + 10)',
  volumeDown: () => 'set volume output volume ((output volume of (get volume settings)) - 10)',
  mute: () => 'set volume output muted true',
  unmute: () => 'set volume output muted false',
  clipboardSet: (p) => `set the clipboard to "${esc(String(p.text ?? ''))}"`,
};

function findRecipe(app: string): { key: string; recipe: Recipe } | null {
  const q = app.trim().toLowerCase();
  for (const [key, recipe] of Object.entries(APP_RECIPES)) {
    if (key === q || recipe.aliases.includes(q)) return { key, recipe };
  }
  return null;
}

const ALL_APPS = Object.keys(APP_RECIPES).join(', ');

export function appsTools(): ToolDefinition[] {
  return [
    {
      name: 'app_command',
      description:
        `Drive an app or the system with one curated command — the manual actions a person would take. Apps: ${ALL_APPS}. Every app supports open and quit. ` +
        'Spotify/Music: play (uri), playPause, next, prev. Notes: newNote. Messages: send. Safari/Chrome: openUrl, newTab, back, forward. Calendar: addEvent (title, date). ' +
        'System: sleep, lock, displaySleep, volumeSet (value 0-100), volumeUp/Down, mute, unmute, brightnessUp/Down, clipboardSet. ' +
        'One call does the whole action — no UI clicking. Setting volume never changes playback. REQUIRES consent.',
      inputSchema: {
        type: 'object',
        properties: {
          app: { type: 'string', description: `App name: ${ALL_APPS}, or system.` },
          action: { type: 'string', description: 'Action for that app (open/quit are always available).' },
          uri: { type: 'string', description: 'Spotify URI, e.g. spotify:likedsongs (spotify play).' },
          playlist: { type: 'string', description: 'Playlist name (music play).' },
          title: { type: 'string', description: 'Event title (calendar addEvent).' },
          date: { type: 'string', description: 'ISO date/time for calendar addEvent, e.g. 2026-08-08T19:00:00.' },
          text: { type: 'string', description: 'Note body, message text, or clipboard text.' },
          contact: { type: 'string', description: 'Buddy for messages send.' },
          url: { type: 'string', description: 'URL for safari/chrome.' },
          value: { type: 'number', description: 'Volume level 0-100 (system volumeSet).' },
        },
        required: ['app', 'action'],
      },
      consequential: true,
      handler: async (args) => {
        const app = String(args.app ?? '').trim().toLowerCase();
        const action = String(args.action ?? '').trim();

        if (app === 'system' || app === 'mac') {
          const builder = SYSTEM_ACTIONS[action];
          if (!builder) return { ok: false, error: `no system action "${action}" — supported: ${Object.keys(SYSTEM_ACTIONS).join(', ')}` };
          try {
            await runAppleScript(builder(args));
            return { ok: true, app: 'system', action };
          } catch (err) {
            return { ok: false, error: err instanceof Error ? err.message : String(err) };
          }
        }

        const found = findRecipe(app);
        if (!found) return { ok: false, error: `no recipe for app "${app}" — supported: ${ALL_APPS}` };
        const { recipe } = found;

        if (action === 'open') {
          try {
            await runAppleScript(`tell application "${esc(recipe.app)}" to activate`);
            return { ok: true, app: found.key, action };
          } catch (err) {
            return { ok: false, error: err instanceof Error ? err.message : String(err) };
          }
        }
        if (action === 'quit') {
          try {
            await runAppleScript(`tell application "${esc(recipe.app)}" to quit`);
            return { ok: true, app: found.key, action };
          } catch (err) {
            return { ok: false, error: err instanceof Error ? err.message : String(err) };
          }
        }
        const builder = recipe.extra?.[action];
        if (!builder) {
          return {
            ok: false,
            error: `no action "${action}" for ${found.key} — supported: open, quit${recipe.extra ? ', ' + Object.keys(recipe.extra).join(', ') : ''}`,
          };
        }
        try {
          await runAppleScript(builder(args));
          return { ok: true, app: found.key, action };
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      },
    },
    {
      name: 'app_status',
      description:
        'Read-only status of an app: whether it is running, and player state/track for Spotify or Music. Never prompts for consent.',
      inputSchema: {
        type: 'object',
        properties: { app: { type: 'string', description: 'App name, e.g. spotify, music.' } },
        required: ['app'],
      },
      handler: async (args) => {
        const found = findRecipe(String(args.app ?? ''));
        if (!found) return { ok: false, error: `no recipe for app "${args.app}"` };
        const { recipe } = found;
        try {
          const pid = await execFileAsync('pgrep', ['-x', recipe.app]).catch(() => ({ stdout: '' }));
          const running = pid.stdout.trim().length > 0;
          let player: Record<string, unknown> | undefined;
          if (recipe.status) {
            const out = (await runAppleScript(recipe.status({}))).trim();
            const [state, track, artist] = out.split('|');
            player = { state, track, artist };
          }
          return { ok: true, app: found.key, running, ...(player ? { player } : {}) };
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      },
    },
    {
      name: 'process_list',
      description: 'Read-only: list the GUI applications currently running on the Mac, so you know what is open.',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        try {
          const out = await runAppleScript('tell application "System Events" to get name of every process whose background only is false');
          const apps = out
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
            .sort();
          return { ok: true, count: apps.length, apps };
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      },
    },
  ];
}
