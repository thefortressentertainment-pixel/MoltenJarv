import type { ToolDefinition } from '../agent/types.js';
import { runAppleScript } from '../computer/index.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

/**
 * Generalized, safe app control. Every app/action here is a CURATED recipe — a
 * fixed, vetted AppleScript command. There is no free-form AppleScript, no
 * shell, no file writes, and no System Events UI scripting (so no extra macOS
 * Automation/Accessibility popups). Unknown apps or actions are refused.
 *
 * One request → one or two tool calls → one (batched) approval, instead of a
 * dozen UI-clicking micro-steps.
 */

const execFileAsync = promisify(execFile);

function esc(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

type Builder = (p: Record<string, unknown>) => string;

interface Recipe {
  aliases: string[];
  actions: Record<string, Builder>;
  status?: Builder;
}

const RECIPES: Record<string, Recipe> = {
  spotify: {
    aliases: ['spotify'],
    actions: {
      open: () => 'tell application "Spotify" to activate',
      play: (p) => `tell application "Spotify"\n  open location "${esc(String(p.uri ?? ''))}"\n  play\nend tell`,
      playPause: () => 'tell application "Spotify" to playpause',
      next: () => 'tell application "Spotify" to next track',
      prev: () => 'tell application "Spotify" to previous track',
    },
    status: () => 'tell application "Spotify"\n  set p to player state\n  set t to ""\n  set a to ""\n  try\n    set t to name of current track\n    set a to artist of current track\n  end try\n  return p & "|" & t & "|" & a\nend tell',
  },
  music: {
    aliases: ['apple music', 'itunes'],
    actions: {
      open: () => 'tell application "Music" to activate',
      playPlaylist: (p) => `tell application "Music"\n  play playlist "${esc(String(p.playlist ?? ''))}"\nend tell`,
      playPause: () => 'tell application "Music" to playpause',
      next: () => 'tell application "Music" to next track',
      prev: () => 'tell application "Music" to previous track',
    },
    status: () => 'tell application "Music"\n  set p to player state\n  set t to ""\n  set a to ""\n  try\n    set t to name of current track\n    set a to artist of current track\n  end try\n  return p & "|" & t & "|" & a\nend tell',
  },
  notes: {
    aliases: ['notes'],
    actions: {
      open: () => 'tell application "Notes" to activate',
      newNote: (p) => `tell application "Notes" to make new note with properties {body:"${esc(String(p.text ?? ''))}"}`,
    },
  },
  messages: {
    aliases: ['messages', 'imessage', 'imessage'],
    actions: {
      open: () => 'tell application "Messages" to activate',
      send: (p) => `tell application "Messages" to send "${esc(String(p.text ?? ''))}" to buddy "${esc(String(p.contact ?? ''))}"`,
    },
  },
  safari: {
    aliases: ['safari'],
    actions: {
      open: () => 'tell application "Safari" to activate',
      openUrl: (p) => `tell application "Safari" to open location "${esc(String(p.url ?? ''))}"`,
    },
  },
  chrome: {
    aliases: ['google chrome', 'chrome'],
    actions: {
      open: () => 'tell application "Google Chrome" to activate',
      openUrl: (p) => `tell application "Google Chrome" to open location "${esc(String(p.url ?? ''))}"`,
    },
  },
  calendar: {
    aliases: ['calendar'],
    actions: { open: () => 'tell application "Calendar" to activate' },
  },
  calculator: {
    aliases: ['calculator'],
    actions: { open: () => 'tell application "Calculator" to activate' },
  },
  clock: {
    aliases: ['clock'],
    actions: { open: () => 'tell application "Clock" to activate' },
  },
  preview: {
    aliases: ['preview'],
    actions: { open: () => 'tell application "Preview" to activate' },
  },
  system: {
    aliases: ['system', 'mac'],
    actions: {
      sleep: () => 'tell application "System Events" to sleep',
      volumeUp: () => 'set volume output volume ((output volume of (get volume settings)) + 10)',
      volumeDown: () => 'set volume output volume ((output volume of (get volume settings)) - 10)',
      mute: () => 'set volume output muted true',
      unmute: () => 'set volume output muted false',
    },
  },
};

function findRecipe(app: string): { key: string; recipe: Recipe } | null {
  const q = app.trim().toLowerCase();
  for (const [key, recipe] of Object.entries(RECIPES)) {
    if (key === q || recipe.aliases.includes(q)) return { key, recipe };
  }
  return null;
}

export function appsTools(): ToolDefinition[] {
  return [
    {
      name: 'app_command',
      description:
        'Drive an app or the system with one curated command. Apps: spotify, music, notes, messages, safari, chrome, calendar, calculator, clock, preview, system. Actions: open, play (spotify/music), playPause, next, prev, playPlaylist (music), newNote (notes), send (messages), openUrl (safari/chrome), sleep/volumeUp/volumeDown/mute/unmute (system). One call does the whole action — no UI clicking. REQUIRES consent.',
      inputSchema: {
        type: 'object',
        properties: {
          app: { type: 'string', description: 'App name, e.g. spotify, music, notes, messages, safari, chrome, system.' },
          action: { type: 'string', description: 'Action for that app.' },
          uri: { type: 'string', description: 'Spotify URI, e.g. spotify:likedsongs (spotify play).' },
          playlist: { type: 'string', description: 'Playlist name (music playPlaylist).' },
          text: { type: 'string', description: 'Note body (notes newNote) or message text (messages send).' },
          contact: { type: 'string', description: 'Buddy for messages send.' },
          url: { type: 'string', description: 'URL for safari/chrome openUrl.' },
        },
        required: ['app', 'action'],
      },
      consequential: true,
      handler: async (args) => {
        const found = findRecipe(String(args.app ?? ''));
        if (!found) return { ok: false, error: `no recipe for app "${args.app}" — supported: ${Object.keys(RECIPES).join(', ')}` };
        const { recipe } = found;
        const action = String(args.action ?? '').trim();
        const builder = recipe.actions[action];
        if (!builder) return { ok: false, error: `no action "${action}" for ${found.key} — supported: ${Object.keys(recipe.actions).join(', ')}` };
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
      description: 'Read-only status of an app: whether it is running, and player state/track for Spotify or Music. Never prompts for consent.',
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
          const pid = await execFileAsync('pgrep', ['-x', found.key]).catch(() => ({ stdout: '' }));
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
  ];
}
