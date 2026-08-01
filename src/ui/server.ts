import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SESSION, type AgentContext } from '../cli/index.js';
import { VERSION } from '../config/defaults.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ASSETS = new Set(['index.html', 'app.css', 'app.js']);

export interface UiServerOptions {
  host?: string;
  port?: number;
  open?: boolean;
}

function handler(ctx: AgentContext) {
  return async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    try {
      const route = (new URL(req.url ?? '/', 'http://localhost')).pathname;

      if (req.method === 'GET' && route === '/') return await sendFile(res, 'index.html', 'text/html');
      if (req.method === 'GET' && ASSETS.has(route.slice(1))) {
        const name = route.slice(1);
        const type = name.endsWith('.css') ? 'text/css' : name.endsWith('.js') ? 'text/javascript' : 'text/plain';
        return await sendFile(res, name, type);
      }

      if (req.method === 'GET' && route === '/api/status') return json(res, 200, await status(ctx));
      if (req.method === 'GET' && route === '/api/session') return json(res, 200, await loadSession(ctx));
      if (req.method === 'POST' && route === '/api/chat') {
        const body = await readJson(req);
        const message = String(body.message ?? '');
        if (!message.trim()) return json(res, 400, { error: 'message is required' });
        try {
          const result = await ctx.agent.run(message, SESSION);
          return json(res, 200, result);
        } catch (err) {
          return json(res, 502, { error: err instanceof Error ? err.message : String(err) });
        }
      }
      if (req.method === 'POST' && route === '/api/new') {
        await ctx.memory.sessionReset(SESSION);
        return json(res, 200, { ok: true });
      }
      if (req.method === 'POST' && route === '/api/model') {
        const body = await readJson(req);
        const model = String(body.model ?? '').trim();
        if (!model) return json(res, 400, { error: 'model is required' });
        ctx.router.setPrimaryModel(model);
        return json(res, 200, { model: ctx.router.primaryModel });
      }

      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
    } catch (err) {
      json(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  };
}

async function status(ctx: AgentContext): Promise<Record<string, unknown>> {
  const facts = await ctx.memory.listFacts();
  return {
    version: VERSION,
    model: ctx.router.primaryModel,
    providers: ctx.router.providers.map((p) => p.label),
    tools: ctx.tools.list().map((t) => t.name),
    facts: facts.length,
    externalErrors: ctx.externalErrors,
  };
}

async function loadSession(ctx: AgentContext): Promise<Array<{ role: string; content: string }>> {
  const messages = await ctx.memory.sessionLoad(SESSION);
  return messages
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({ role: m.role, content: m.content ?? '' }));
}

export async function listenUi(ctx: AgentContext, opts: UiServerOptions): Promise<{ server: http.Server; url: string }> {
  const host = opts.host ?? '127.0.0.1';
  const port = opts.port ?? 3001;
  const server = http.createServer(handler(ctx));
  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  const addr = server.address();
  const actualPort = typeof addr === 'object' && addr ? addr.port : port;
  const displayHost = host === '0.0.0.0' ? '127.0.0.1' : host;
  return { server, url: `http://${displayHost}:${actualPort}` };
}

export async function serveUi(ctx: AgentContext, opts: UiServerOptions): Promise<void> {
  const { url } = await listenUi(ctx, opts);
  process.stdout.write(`[jarv-genie] UI running at ${url}  (Ctrl+C to stop)\n`);
  if (opts.open ?? true) await openBrowser(url);
}

function openBrowser(url: string): Promise<void> {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  return new Promise((resolve) => {
    execFile(cmd, args, (err) => (err ? resolve() : resolve()));
  });
}

async function sendFile(res: http.ServerResponse, name: string, type: string): Promise<void> {
  const buf = await fs.readFile(path.join(__dirname, name));
  res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8` });
  res.end(buf);
}

function json(res: http.ServerResponse, code: number, data: unknown): void {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        const parsed = JSON.parse(raw);
        resolve(parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {});
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}
