import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { activeBackend, internetChannels, type Channel } from '../web/channels.js';
import { resolveSecret, redactSecrets } from '../credentials.js';

const execFileAsync = promisify(execFile);

/**
 * Route-aware subprocess helpers for the internet-channel tools (Agent-Reach
 * multi-backend pattern, MIT). Each helper confirms its channel's active backend
 * is up before shelling out to the corresponding CLI, and returns the route used
 * so the call is transparent.
 */

export interface RouteResult<T> {
  ok: boolean;
  route?: string;
  data?: T;
  error?: string;
  hint?: string;
}

/** Resolve a channel by id; returns the channel + active backend (id label) or null. */
async function readyChannel(channelId: string): Promise<{ channel: Channel; backend: string } | null> {
  const channel = internetChannels().find((c) => c.id === channelId);
  if (!channel) return null;
  const active = await activeBackend(channel);
  if (!active) return null;
  return { channel, backend: active.id };
}

async function run(cmd: string, args: string[], timeoutMs = 60_000): Promise<string> {
  const { stdout } = await execFileAsync(cmd, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 });
  return stdout;
}

/** Run a command with extra env secrets; throws are surfaced so callers redact. */
async function runWithEnv(cmd: string, args: string[], env: Record<string, string>, timeoutMs = 60_000): Promise<string> {
  const { stdout } = await execFileAsync(cmd, args, { env: { ...process.env, ...env }, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 });
  return stdout;
}

/** A GH token from the secret store (never argv); undefined when the system gh auth is used. */
function githubToken(): string | undefined {
  return resolveSecret('GH_TOKEN', ['GITHUB_TOKEN']);
}

/** Fetch a YouTube transcript via yt-dlp (auto subtitles, returns SRT text). */
export async function youtubeTranscript(url: string, lang = 'en'): Promise<RouteResult<string>> {
  const ready = await readyChannel('youtube');
  if (!ready) {
    return { ok: false, hint: 'yt-dlp not installed — install with: brew install yt-dlp' };
  }
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarv-yt-'));
  try {
    // Write auto subtitles to a unique file in a temp dir, then read it back.
    await run(
      'yt-dlp',
      ['--skip-download', '--write-auto-subs', '--sub-langs', lang, '--sub-format', 'vtt/srt', '-o', path.join(dir, 'sub.%(ext)s'), '--no-playlist', url],
      90_000,
    );
    const subFile = ['.vtt', '.srt', '.en.vtt', '.en.srt']
      .map((ext) => path.join(dir, `sub${ext}`))
      .filter((p) => fs.existsSync(p))[0];
    if (!subFile) throw new Error('no caption file produced');
    const text = fs.readFileSync(subFile, 'utf8').slice(0, 30_000);
    return { ok: true, route: ready.backend, data: text };
  } catch (err) {
    return { ok: false, route: ready.backend, error: err instanceof Error ? err.message : String(err), hint: 'yt-dlp transcript failed — the video may have no captions or is age-restricted.' };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Parse an RSS/Atom feed via feedparser (Python worker subprocess). */
export async function readRss(feedUrl: string, limit = 20): Promise<RouteResult<Array<{ title: string; link: string; summary: string }>>> {
  const ready = await readyChannel('rss');
  if (!ready) {
    return { ok: false, hint: 'feedparser not installed — install with: pip3 install feedparser' };
  }
  const script = `import sys,json,feedparser
d=feedparser.parse(sys.argv[1])
out=[{"title":e.get("title"),"link":e.get("link"),"summary":e.get("summary","")} for e in d.entries[:${Math.max(1, Math.min(50, limit))}]]
print(json.dumps(out))`;
  try {
    const out = await run('python3', ['-c', script, feedUrl], 30_000);
    const parsed = JSON.parse(out.trim()) as Array<{ title: string; link: string; summary: string }>;
    return { ok: true, route: ready.backend, data: Array.isArray(parsed) ? parsed : [] };
  } catch (err) {
    return { ok: false, route: ready.backend, error: err instanceof Error ? err.message : String(err), hint: 'feedparser failed — is the feed URL valid/RSS?' };
  }
}

/** GitHub repo read via gh CLI (gh repo view / raw file). */
export async function githubRepoInfo(repo: string): Promise<RouteResult<string>> {
  const ready = await readyChannel('github');
  if (!ready) return { ok: false, hint: 'gh CLI not configured — install and run: gh auth login' };
  const token = githubToken();
  try {
    const out = token
      ? await runWithEnv('gh', ['repo', 'view', repo, '--json', 'description,primaryLanguage,stargazerCount,url', '-q', '.'], { GH_TOKEN: token })
      : await run('gh', ['repo', 'view', repo, '--json', 'description,primaryLanguage,stargazerCount,url', '-q', '.']);
    return { ok: true, route: ready.backend, data: redactSecrets(out, token) };
  } catch (err) {
    const message = redactSecrets(err instanceof Error ? err.message : String(err), token);
    return { ok: false, route: ready.backend, error: message, hint: `gh could not read "${repo}" — does it exist / are you authenticated?` };
  }
}

/** Search GitHub code/repos via gh CLI. */
export async function githubSearch(query: string, limit = 10): Promise<RouteResult<string>> {
  const ready = await readyChannel('github');
  if (!ready) return { ok: false, hint: 'gh CLI not configured — install and run: gh auth login' };
  const token = githubToken();
  try {
    const args = ['search', 'repos', query, '--limit', String(Math.max(1, Math.min(50, limit))), '--json', 'name,url,description,stargazersCount', '-q', '.'];
    const out = token
      ? await runWithEnv('gh', args, { GH_TOKEN: token })
      : await run('gh', args);
    return { ok: true, route: ready.backend, data: redactSecrets(out, token) };
  } catch (err) {
    const message = redactSecrets(err instanceof Error ? err.message : String(err), token);
    return { ok: false, route: ready.backend, error: message, hint: 'gh search failed.' };
  }
}
