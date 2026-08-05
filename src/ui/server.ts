import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { createReadStream } from 'node:fs';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { SESSION, type AgentContext } from '../cli/index.js';
import { TaskRunner } from '../agent/taskrunner.js';
import { createInitiativeStore, type InitiativeStatus } from '../initiatives.js';
import { VERSION } from '../config/defaults.js';
import { getTokenStore, type TokenStore } from '../hub/auth.js';
import { getLinkStore } from '../remote/client.js';
import { DeviceStore, pushNotify } from '../sidecar/devices.js';
import { speakToWav, transcribe } from '../voice/index.js';
import { artifactPath, checkUpdateStatus, readManifest } from '../updates/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ASSETS = new Set(['index.html', 'app.css', 'app.js']);
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '::ffff:127.0.0.1']);
const VALID_INITIATIVE_STATUSES: InitiativeStatus[] = ['proposed', 'approved', 'declined', 'in_progress', 'done'];

export interface UiServerOptions {
  host?: string;
  port?: number;
  open?: boolean;
  /** Require a bearer token on /api routes even on loopback. Default: only when bound beyond loopback. */
  auth?: boolean;
  /** Token store used when auth is on. Default: the real ~/.jarv-genie store. */
  tokenStore?: TokenStore;
  /** Device registry + push queue. Default: the real ~/.jarv-genie store. */
  deviceStore?: DeviceStore;
  /** Update server to check for newer builds (default: this hub's own published update). */
  updateUrl?: string;
}

function requireAuth(host: string, opts: UiServerOptions): boolean {
  return opts.auth ?? !LOOPBACK.has(host);
}

/** Bearer token for talking to the update server, when it's the hub we're linked to. */
function updateToken(updateUrl: string | undefined): string | undefined {
  const linked = getLinkStore().get();
  if (!updateUrl || !linked?.url) return undefined;
  return updateUrl.replace(/\/+$/, '') === linked.url.replace(/\/+$/, '') ? linked.token : undefined;
}

function handler(ctx: AgentContext, opts: UiServerOptions, host: string) {
  const guard = requireAuth(host, opts);
  const tokenStore = guard ? (opts.tokenStore ?? getTokenStore()) : null;
  const devices = opts.deviceStore ?? new DeviceStore();

  const deviceRoutes = async (req: http.IncomingMessage, res: http.ServerResponse, route: string): Promise<boolean> => {
    if (req.method === 'GET' && route === '/api/devices') {
      json(res, 200, { devices: devices.list() });
      return true;
    }
    if (req.method === 'POST' && route === '/api/devices/register') {
      const body = await readJson(req);
      const name = String(body.name ?? '').trim() || `device-${Date.now().toString(36)}`;
      const capabilities = Array.isArray(body.capabilities) ? body.capabilities.map(String) : [];
      const device = devices.register(name, String(body.platform ?? os.platform()), capabilities);
      json(res, 200, { device });
      return true;
    }
    if (req.method === 'POST' && route === '/api/notify') {
      const body = await readJson(req);
      const text = String(body.text ?? '').trim();
      if (!text) {
        json(res, 400, { error: 'text is required' });
        return true;
      }
      const enqueued = pushNotify(devices, text, {
        device: String(body.device ?? '').trim() || undefined,
        speak: body.speak === true,
      });
      json(res, 200, { enqueued: enqueued.length });
      return true;
    }
    const m = route.match(/^\/api\/devices\/([^/]+)\/events$/);
    if (req.method === 'GET' && m) {
      const deviceId = decodeURIComponent(m[1] ?? '');
      const timeout = Math.min(Math.max(Number(new URL(req.url ?? '/', 'http://localhost').searchParams.get('timeout') ?? 25), 1), 55);
      const existing = devices.dequeue(deviceId);
      if (existing) {
        json(res, 200, { event: existing });
        return true;
      }
      await devices.waitFor(deviceId, timeout * 1000);
      json(res, 200, { event: devices.dequeue(deviceId) });
      return true;
    }
    return false;
  };

  return async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    try {
      const route = (new URL(req.url ?? '/', 'http://localhost')).pathname;

      if (req.method === 'GET' && route === '/') return await sendFile(res, 'index.html', 'text/html');
      if (req.method === 'GET' && ASSETS.has(route.slice(1))) {
        const name = route.slice(1);
        const type = name.endsWith('.css') ? 'text/css' : name.endsWith('.js') ? 'text/javascript' : 'text/plain';
        return await sendFile(res, name, type);
      }

      if (!route.startsWith('/api/')) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found');
        return;
      }

      if (tokenStore) {
        const header = req.headers.authorization ?? '';
        const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined;
        if (!tokenStore.matches(token)) {
          return json(res, 401, { error: 'unauthorized: provide a hub token (see jarv-genie link)' });
        }
      }

      if (await deviceRoutes(req, res, route)) return;

      if (req.method === 'POST' && route === '/api/voice/transcribe') {
        const buf = await readBodyBuffer(req);
        const dir = mkdtempSync(path.join(os.tmpdir(), 'jarv-audio-'));
        const wav = path.join(dir, 'in.wav');
        try {
          await fs.writeFile(wav, buf);
          const text = await transcribe(wav);
          json(res, 200, { text });
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
        return;
      }
      if (req.method === 'POST' && route === '/api/voice/speak') {
        const body = await readJson(req);
        const text = String(body.text ?? '').trim();
        if (!text) {
          json(res, 400, { error: 'text is required' });
          return;
        }
        try {
          const wav = await speakToWav(text);
          res.writeHead(200, { 'Content-Type': 'audio/wav', 'Cache-Control': 'no-store' });
          res.end(wav);
        } catch (err) {
          json(res, 500, { error: err instanceof Error ? err.message : String(err) });
        }
        return;
      }

      if (req.method === 'GET' && route === '/api/status') return json(res, 200, await status(ctx));
      if (req.method === 'GET' && route === '/api/session') return json(res, 200, await loadSession(ctx));

      const initiativeMatch = route.match(/^\/api\/initiatives(?:\/([^/]+)\/status)?$/);
      if (initiativeMatch && (route === '/api/initiatives' || initiativeMatch[1])) {
        if (req.method === 'GET' && route === '/api/initiatives') {
          const initiatives = createInitiativeStore();
          const list = initiatives.list();
          return json(res, 200, { count: list.length, open: initiatives.openCount(), initiatives: list });
        }
        if (req.method === 'POST' && initiativeMatch[1]) {
          const body = await readJson(req);
          const status = String(body.status ?? '').trim() as InitiativeStatus;
          if (!VALID_INITIATIVE_STATUSES.includes(status)) {
            return json(res, 400, { error: `invalid status (${VALID_INITIATIVE_STATUSES.join(', ')})` });
          }
          const updated = createInitiativeStore().setStatus(initiativeMatch[1], status);
          if (!updated) return json(res, 404, { error: `no initiative with id "${initiativeMatch[1]}"` });
          return json(res, 200, { initiative: updated });
        }
      }

      if (req.method === 'GET' && route === '/api/update') {
        const m = readManifest();
        if (!m) return json(res, 404, { error: 'no update published' });
        return json(res, 200, m);
      }
      if (req.method === 'GET' && route === '/api/update/status') {
        return json(res, 200, await checkUpdateStatus(opts.updateUrl, updateToken(opts.updateUrl)));
      }
      if (req.method === 'GET' && route === '/api/update/download') {
        const m = readManifest();
        if (!m) return json(res, 404, { error: 'no update published' });
        try {
          const st = await fs.stat(artifactPath(m));
          res.writeHead(200, {
            'Content-Type': 'application/octet-stream',
            'Content-Length': st.size,
            'Content-Disposition': `attachment; filename="${m.artifact}"`,
          });
          createReadStream(artifactPath(m)).pipe(res);
        } catch {
          return json(res, 404, { error: 'artifact missing' });
        }
        return;
      }
      if (req.method === 'GET' && route === '/api/update/fetch') {
        const m = readManifest();
        if (!m) return json(res, 404, { error: 'no update published' });
        const downloads = path.join(os.homedir(), 'Downloads');
        const target = path.join(downloads, m.artifact);
        try {
          if (opts.updateUrl) {
            const dl = `${opts.updateUrl.replace(/\/+$/, '')}/api/update/download`;
            const token = updateToken(opts.updateUrl);
            const remote = await fetch(dl, {
              headers: token ? { Authorization: `Bearer ${token}` } : {},
              signal: AbortSignal.timeout(120_000),
            });
            if (!remote.ok) throw new Error(`download failed: HTTP ${remote.status}`);
            await fs.mkdir(downloads, { recursive: true });
            await fs.writeFile(target, Buffer.from(await remote.arrayBuffer()));
          } else {
            await fs.mkdir(downloads, { recursive: true });
            await fs.copyFile(artifactPath(m), target);
          }
          if (process.platform === 'darwin') execFile('open', [target], () => {});
          return json(res, 200, { savedTo: target, artifact: m.artifact });
        } catch (err) {
          return json(res, 502, { error: err instanceof Error ? err.message : String(err) });
        }
      }

      if (req.method === 'POST' && route === '/api/chat') {
        const body = await readJson(req);
        const message = String(body.message ?? '');
        if (!message.trim()) return json(res, 400, { error: 'message is required' });
        const runner = new TaskRunner({ router: ctx.router, tools: ctx.tools, memory: ctx.memory, config: ctx.config, sessionId: 'chat' });
        if (body.stream === true) return await streamChat(res, req, runner, message);
        try {
          const result = await runner.run(message);
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

async function streamChat(res: http.ServerResponse, req: http.IncomingMessage, runner: TaskRunner, message: string): Promise<void> {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 2000\n\n');
  let closed = false;
  req.on('close', () => {
    closed = true;
  });
  const send = (data: unknown): void => {
    if (closed || res.writableEnded) return;
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };
  try {
    const result = await runner.runStream(message, (delta) => send({ text: delta }));
    send({ meta: { provider: result.provider, model: result.model, steps: result.steps, toolCalls: result.toolCalls } });
    send({ done: true });
    res.end();
  } catch (err) {
    send({ error: err instanceof Error ? err.message : String(err) });
    res.end();
  }
}

async function status(ctx: AgentContext): Promise<Record<string, unknown>> {
  const facts = await ctx.memory.listFacts();
  const computer = (ctx.config as unknown as { computer?: { allowControl?: boolean } }).computer;
  return {
    version: VERSION,
    model: ctx.router.primaryModel,
    providers: ctx.router.providers.map((p) => p.label),
    tools: ctx.tools.list().map((t) => t.name),
    facts: facts.length,
    allowControl: computer?.allowControl === true,
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
  const server = http.createServer(handler(ctx, opts, host));
  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  const addr = server.address();
  const actualPort = typeof addr === 'object' && addr ? addr.port : port;
  const displayHost = host === '0.0.0.0' ? '127.0.0.1' : host;
  return { server, url: `http://${displayHost}:${actualPort}` };
}

export async function serveUi(ctx: AgentContext, opts: UiServerOptions): Promise<void> {
  const { url } = await listenUi(ctx, opts);
  const auth = requireAuth(opts.host ?? '127.0.0.1', opts);
  process.stdout.write(
    `[jarv-genie] hub listening on ${url}  (Ctrl+C to stop)\n` +
      (auth ? `[jarv-genie] api auth required — token: ${getTokenStore().get()}\n` : '[jarv-genie] api auth disabled (loopback only)\n'),
  );
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

async function readBodyBuffer(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}
