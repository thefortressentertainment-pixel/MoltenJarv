import type { ToolDefinition } from '../agent/types.js';
import { youtubeTranscript, readRss, githubSearch, githubRepoInfo } from './network.js';

export interface WebResult {
  title: string;
  url: string;
  snippet: string;
}

const USER_AGENT = 'Mozilla/5.0 (compatible; jarv-genie/0.1; local assistant)';

export function webTools(): ToolDefinition[] {
  return [
    {
      name: 'web_search',
      system: 'integration',
      description:
        'Search the web and return a list of results with title, url, and snippet. Best-effort, no API key needed. Use for current events, facts, and anything outside the user\'s local data.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'The search query.' },
          max_results: { type: 'number', description: 'Max results to return (default 5).' },
        },
        required: ['query'],
      },
      handler: async (args) => {
        const query = String(args.query ?? '').trim();
        if (!query) throw new Error('web_search requires a query');
        const maxResults = typeof args.max_results === 'number' ? Math.max(1, Math.min(10, Math.floor(args.max_results))) : 5;
        return duckDuckGoSearch(query, maxResults);
      },
    },
    {
      name: 'web_read',
      system: 'integration',
      description:
        'Fetch a URL and return its content as clean, readable text (via Jina Reader, no API key). Use to read a specific page, article, or result found with web_search.',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'The http(s) URL to read.' },
          max_chars: { type: 'number', description: 'Max characters to return (default 8000).' },
        },
        required: ['url'],
      },
      handler: async (args) => {
        const url = String(args.url ?? '').trim();
        if (!url) throw new Error('web_read requires a url');
        if (!/^https?:\/\//i.test(url)) throw new Error('web_read requires an http(s) URL');
        const maxChars = typeof args.max_chars === 'number' ? Math.max(500, Math.min(50_000, Math.floor(args.max_chars))) : 8000;
        return readPage(url, maxChars);
      },
    },
    {
      name: 'youtube_transcript',
      system: 'integration',
      description:
        'Get the (auto) subtitle transcript of a YouTube video as text. Provide a video URL. Uses yt-dlp; run `jarv-genie --doctor` to check the YouTube channel.',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'A YouTube video URL, e.g. https://youtube.com/watch?v=...' },
          lang: { type: 'string', description: 'Subtitle language code (default "en").' },
        },
        required: ['url'],
      },
      handler: async (args) => {
        const url = String(args.url ?? '').trim();
        if (!url) throw new Error('youtube_transcript requires a url');
        return youtubeTranscript(url, String(args.lang ?? 'en'));
      },
    },
    {
      name: 'read_rss',
      system: 'integration',
      description:
        'Read an RSS or Atom feed and return its recent entries (title, link, summary). Provide a feed URL. Uses feedparser (Python).',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'The RSS/Atom feed URL.' },
          limit: { type: 'number', description: 'Max entries to return (default 20).' },
        },
        required: ['url'],
      },
      handler: async (args) => {
        const url = String(args.url ?? '').trim();
        if (!url) throw new Error('read_rss requires a url');
        const limit = typeof args.limit === 'number' ? Math.max(1, Math.min(50, Math.floor(args.limit))) : 20;
        return readRss(url, limit);
      },
    },
    {
      name: 'github_search',
      system: 'integration',
      description:
        'Search GitHub repositories by query (via the gh CLI). Returns repo name, url, description, stars. Requires `gh auth login`.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'The GitHub search query.' },
          limit: { type: 'number', description: 'Max results (default 10).' },
        },
        required: ['query'],
      },
      handler: async (args) => {
        const query = String(args.query ?? '').trim();
        if (!query) throw new Error('github_search requires a query');
        const limit = typeof args.limit === 'number' ? Math.max(1, Math.min(50, Math.floor(args.limit))) : 10;
        return githubSearch(query, limit);
      },
    },
    {
      name: 'github_read',
      system: 'integration',
      description:
        'Get metadata (description, language, stars, url) for a GitHub repository by "owner/name". Uses the gh CLI.',
      inputSchema: {
        type: 'object',
        properties: {
          repo: { type: 'string', description: 'Repository as "owner/name", e.g. "Panniantong/Agent-Reach".' },
        },
        required: ['repo'],
      },
      handler: async (args) => {
        const repo = String(args.repo ?? '').trim();
        if (!repo) throw new Error('github_read requires a repo like "owner/name"');
        return githubRepoInfo(repo);
      },
    },
  ];
}

export async function readPage(target: string, maxChars = 8000): Promise<{ url: string; content: string; truncated: boolean }> {
  const jinaUrl = 'https://r.jina.ai/' + target;
  const res = await fetch(jinaUrl, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Read failed: HTTP ${res.status}`);
  const text = (await res.text()).trim();
  if (text.length <= maxChars) return { url: target, content: text, truncated: false };
  return { url: target, content: text.slice(0, maxChars), truncated: true };
}

async function duckDuckGoSearch(query: string, maxResults: number): Promise<WebResult[]> {
  const url = 'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query);
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) throw new Error(`Search failed: HTTP ${res.status}`);
  const html = await res.text();
  return parseResults(html, maxResults);
}

function parseResults(html: string, maxResults: number): WebResult[] {
  const out: WebResult[] = [];
  const blockRe = /<div class="result[^"]*"[\s\S]*?class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:class="result__snippet"[^>]*>([\s\S]*?)<\/a>)?/g;
  let match: RegExpExecArray | null;
  while ((match = blockRe.exec(html)) !== null && out.length < maxResults) {
    const url = decodeHref(match[1] ?? '');
    const title = stripTags(decodeEntities(match[2] ?? '')).trim();
    const snippet = stripTags(decodeEntities(match[3] ?? '')).trim();
    if (title) out.push({ title, url, snippet });
  }
  return out;
}

function decodeHref(href: string): string {
  if (href.includes('/l/?uddg=')) {
    const target = href.split('/l/?uddg=')[1]?.split('&')[0];
    if (target) {
      try {
        return decodeURIComponent(target);
      } catch {
        return href;
      }
    }
  }
  return href;
}

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, '');
}

function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}
