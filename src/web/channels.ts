import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getSecretStore } from '../config/secrets.js';

/**
 * Internet-channel routing + doctor, adapted from the *multi-backend routing*
 * idea in Panniantong/Agent-Reach (MIT).
 *
 * The design: each internet capability ("channel") has an ordered list of
 * backends. `doctor` probes them in turn and the first that's genuinely usable
 * is the active route. When a backend breaks (e.g. a platform blocks a
 * scraper), fixing it is a one-line list reorder — not a code rewrite. The
 * doctor reports which backend is active per channel and how to fix a broken
 * one.
 *
 * This module is intentionally injectable: each backend's probe is a plain
 * async function, so tests can substitute fakes and the same table drives the
 * runtime tools (A1 later) and the doctor report (A2 now).
 */

const execFileAsync = promisify(execFile);

async function commandExists(cmd: string): Promise<boolean> {
  try {
    await execFileAsync('/bin/sh', ['-c', `command -v ${cmd}`], { timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

async function httpOk(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(8000) });
    return res.ok || res.status < 500;
  } catch {
    return false;
  }
}

export interface Backend {
  id: string;
  label: string;
  /** Probe this backend for the channel; must actually work (not just exist). */
  probe: () => Promise<boolean>;
  /** Human hint for enabling/connecting this backend. */
  setupHint: string;
}

export interface Channel {
  /** stable id, e.g. "youtube". */
  id: string;
  label: string;
  /** Ordered backends; the first whose probe passes is the active route. */
  backends: Backend[];
  /** Shown when the whole channel is down. */
  brokenHint: string;
}

export interface ChannelStatus {
  id: string;
  label: string;
  ok: boolean;
  activeBackend?: string;
  hint?: string;
}

/** Reference channel table — the "current selection" (mirrors Agent-Reach's
 *  channels/ backends that need no key). */
export function internetChannels(): Channel[] {
  return [
    {
      id: 'web',
      label: 'Read web pages',
      backends: [
        {
          id: 'jina',
          label: 'Jina Reader (https://r.jina.ai)',
          probe: () => httpOk('https://r.jina.ai/'),
          setupHint: 'No setup (free, no key).',
        },
      ],
      brokenHint: 'Jina Reader unreachable — check network.',
    },
    {
      id: 'web_search',
      label: 'Web search',
      backends: [
        {
          id: 'duckduckgo',
          label: 'DuckDuckGo HTML',
          probe: () => httpOk('https://html.duckduckgo.com/html/'),
          setupHint: 'No setup.',
        },
      ],
      brokenHint: 'DuckDuckGo search unreachable — check network/rate-limit.',
    },
    {
      id: 'github',
      label: 'GitHub read/search',
      backends: [
        {
          id: 'gh',
          label: 'GitHub CLI (gh)',
          probe: async () =>
            (await commandExists('gh')) && ((await ghAuthenticated()) || Boolean(secretTokenFor('github'))),
          setupHint: 'Install gh CLI and run `gh auth login`, or store a token: jarv-genie key set GH_TOKEN <token>',
        },
      ],
      brokenHint: 'gh CLI missing, or not authenticated and no GH_TOKEN in the secret store.',
    },
    {
      id: 'youtube',
      label: 'YouTube transcripts/search',
      backends: [
        {
          id: 'yt-dlp',
          label: 'yt-dlp',
          probe: () => commandExists('yt-dlp'),
          setupHint: 'Install yt-dlp: brew install yt-dlp',
        },
      ],
      brokenHint: 'yt-dlp not installed.',
    },
    {
      id: 'rss',
      label: 'RSS/Atom feeds',
      backends: [
        {
          id: 'feedparser',
          label: 'feedparser (Python)',
          probe: () => pythonModule('feedparser'),
          setupHint: 'Install: pip3 install feedparser',
        },
      ],
      brokenHint: 'feedparser not installed.',
    },
    {
      id: 'semantic_search',
      label: 'Semantic web search (Exa)',
      backends: [
        {
          id: 'exa-mcp',
          label: 'Exa via MCP',
          probe: () => commandExists('mcporter'),
          setupHint: 'Configure Exa via an MCP server (free, no key).',
        },
      ],
      brokenHint: 'Exa/MCP not configured — falls back to DuckDuckGo.',
    },
  ];
}

async function ghAuthenticated(): Promise<boolean> {
  try {
    await execFileAsync('gh', ['auth', 'status'], { timeout: 8000 });
    return true;
  } catch {
    return false;
  }
}

/** A platform token from the secret store (never the prompt), if the user set one. */
function secretTokenFor(platform: 'github'): string | undefined {
  if (platform === 'github') {
    const store = getSecretStore();
    return store.get('GH_TOKEN') ?? store.get('GITHUB_TOKEN');
  }
  return undefined;
}

async function pythonModule(mod: string): Promise<boolean> {
  try {
    await execFileAsync('python3', ['-c', `import ${mod}`], { timeout: 8000 });
    return true;
  } catch {
    return false;
  }
}

/** Probe a channel's ordered backends; returns the first that works (or null). */
export async function activeBackend(channel: Channel): Promise<{ id: string; label: string } | null> {
  for (const backend of channel.backends) {
    let ok = false;
    try {
      ok = await backend.probe();
    } catch {
      ok = false;
    }
    if (ok) return { id: backend.id, label: backend.label };
  }
  return null;
}

/** Doctor over all channels: which is up, which backend is active, and a fix hint. */
export async function internetChannelsDoctor(channels: Channel[] = internetChannels()): Promise<ChannelStatus[]> {
  const out: ChannelStatus[] = [];
  for (const channel of channels) {
    const active = await activeBackend(channel);
    if (active) {
      out.push({ id: channel.id, label: channel.label, ok: true, activeBackend: active.label });
    } else {
      out.push({ id: channel.id, label: channel.label, ok: false, hint: channel.brokenHint });
    }
  }
  return out;
}

/** Render the doctor report for the terminal (matches existing `[...]` style). */
export function renderInternetDoctor(statuses: ChannelStatus[]): string {
  const lines = statuses.map((s) =>
    s.ok
      ? `[OK] ${s.label} — via ${s.activeBackend}`
      : `[FAIL] ${s.label} — ${s.hint}`,
  );
  lines.push('');
  lines.push('Security: tokens/cookies live only in the secret store (never the prompt).');
  lines.push('For cookie-login platforms (Twitter/X, Reddit, etc.) use a dedicated throwaway account, not your main one.');
  return lines.join('\n');
}

// Only the injectable probe helpers are exported for tests; runtime tools built on
// top (A1) will consume `activeBackend()` / `internetChannels()`.
export { commandExists };
