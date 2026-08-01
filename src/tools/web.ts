import type { ToolDefinition } from '../agent/types.js';

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
  ];
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
