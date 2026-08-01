#!/usr/bin/env node
import { runDoctor, runOneShot, runRepl, buildAgent } from './cli/index.js';
import { localBackend, remoteBackend } from './cli/backend.js';
import { runKeyCommand } from './cli/keys.js';
import { runVoiceSession, type VoiceSessionOptions } from './cli/voice.js';
import { ensureConfigFile } from './config/index.js';
import { VERSION } from './config/defaults.js';
import { getTokenStore } from './hub/auth.js';
import { runMcpServer } from './mcp/server.js';
import { getLinkStore, RemoteClient } from './remote/client.js';
import { serveUi, type UiServerOptions } from './ui/server.js';

interface Args {
  mode: 'repl' | 'oneshot' | 'mcp' | 'doctor' | 'help';
  prompt?: string;
  mcpTransport?: 'stdio' | 'http';
  mcpPort?: number;
  remoteUrl?: string;
}

const HELP = `jarv-genie ${VERSION} — a standalone, local-first personal AI assistant

Usage:
  jarv-genie                      interactive session (local)
  jarv-genie "prompt"             one-shot (local)
  jarv-genie --remote [URL]       use the linked hub (or URL) for any mode
  jarv-genie hub [--host H] [--port N] [--no-open] [--no-auth|--auth]   start the brain
  jarv-genie hub --token          print the hub token
  jarv-genie link <url> <token>   pair this machine to a hub (token via hub --token)
  jarv-genie unlink               forget the hub
  jarv-genie voice [--voice N] [--no-tts] [--remote]   talk to the brain out loud
  jarv-genie --doctor             check endpoints and memory
  jarv-genie --mcp [--transport http --port 3000]   run as an MCP server
  jarv-genie key <set|rm|list>    manage API keys (stored securely)
  jarv-genie --version
`;

function parseArgs(argv: string[]): Args {
  const out: Args = { mode: 'repl' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--mcp':
        out.mode = 'mcp';
        break;
      case '--transport': {
        const t = argv[++i];
        out.mcpTransport = t === 'http' ? 'http' : 'stdio';
        break;
      }
      case '--port':
        out.mcpPort = Number(argv[++i]);
        break;
      case '--doctor':
        out.mode = 'doctor';
        break;
      case '--remote': {
        const next = argv[i + 1];
        if (next && /^https?:\/\//.test(next)) {
          out.remoteUrl = next;
          i++;
        } else {
          out.remoteUrl = '';
        }
        break;
      }
      case '--help':
      case '-h':
        out.mode = 'help';
        break;
      case '--version':
      case '-v':
        process.stdout.write(`jarv-genie ${VERSION}\n`);
        process.exit(0);
        break;
      default:
        if (a && !a.startsWith('-')) {
          out.mode = 'oneshot';
          out.prompt = a;
        }
        break;
    }
  }
  return out;
}

function parseHubArgs(argv: string[]): UiServerOptions & { token?: boolean; newToken?: boolean } {
  const out: UiServerOptions & { token?: boolean; newToken?: boolean } = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') out.port = Number(argv[++i]);
    else if (a === '--host') out.host = argv[++i];
    else if (a === '--no-open') out.open = false;
    else if (a === '--no-auth') out.auth = false;
    else if (a === '--auth') out.auth = true;
    else if (a === '--token') out.token = true;
    else if (a === '--new-token') out.newToken = true;
  }
  return out;
}

function parseVoiceArgs(argv: string[]): { opts: VoiceSessionOptions; remoteUrl: string | undefined } {
  const opts: VoiceSessionOptions = {};
  let remoteUrl: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--voice') opts.voice = argv[++i];
    else if (a === '--no-tts') opts.tts = false;
    else if (a === '--model') opts.model = argv[++i];
    else if (a === '--max-seconds') opts.maxSeconds = Number(argv[++i]);
    else if (a === '--remote') {
      const n = argv[i + 1];
      if (n && /^https?:\/\//.test(n)) {
        remoteUrl = n;
        i++;
      } else {
        remoteUrl = '';
      }
    }
  }
  return { opts, remoteUrl };
}

function resolveRemote(urlOrEmpty: string): RemoteClient {
  const url = urlOrEmpty || getLinkStore().get()?.url;
  const token = getLinkStore().get()?.token;
  if (!url || !token) {
    process.stderr.write('not linked to a hub — run `jarv-genie link <url> <token>` first (or pass `--remote <url>` after linking)\n');
    process.exit(1);
  }
  return new RemoteClient(url, token);
}

async function runRemoteDoctor(client: RemoteClient): Promise<void> {
  try {
    const s = await client.status();
    process.stdout.write(`Hub: v${s.version} (${s.providers.join(' · ') || 'no providers'})\n`);
    process.stdout.write(`[${s.facts > 0 ? 'OK' : '--'}] memory: ${s.facts} facts\n`);
    for (const err of s.externalErrors) process.stdout.write(`[FAIL] external mcp: ${err}\n`);
  } catch (err) {
    process.stdout.write(`[FAIL] hub unreachable: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  }
}

async function main(): Promise<void> {
  ensureConfigFile();
  const raw = process.argv.slice(2);

  if (raw[0] === 'key') {
    await runKeyCommand(raw.slice(1));
    return;
  }

  if (raw[0] === 'link') {
    const [url, token] = raw.slice(1);
    if (!url || !token) {
      process.stderr.write('Usage: jarv-genie link <hub-url> <token>\n');
      process.exit(1);
    }
    getLinkStore().set(url, token);
    process.stdout.write(`Linked to ${url}\n`);
    return;
  }

  if (raw[0] === 'unlink') {
    getLinkStore().clear();
    process.stdout.write('Unlinked.\n');
    return;
  }

  if (raw[0] === 'voice') {
    const { opts, remoteUrl } = parseVoiceArgs(raw.slice(1));
    const backend =
      remoteUrl !== undefined ? remoteBackend(resolveRemote(remoteUrl)) : localBackend(await buildAgent());
    await runVoiceSession(backend, opts);
    return;
  }

  if (raw[0] === 'hub' || raw[0] === 'ui') {
    const opts = parseHubArgs(raw.slice(1));
    if (opts.token || opts.newToken) {
      const store = getTokenStore();
      const token = opts.newToken ? store.rotate() : store.get();
      process.stdout.write(`${token}\n`);
      return;
    }
    const ctx = await buildAgent();
    await serveUi(ctx, opts);
    return;
  }

  const args = parseArgs(raw);
  const client = args.remoteUrl !== undefined ? resolveRemote(args.remoteUrl) : null;

  switch (args.mode) {
    case 'help':
      process.stdout.write(HELP);
      break;

    case 'mcp': {
      if (client) {
        process.stderr.write('--mcp does not work in remote mode; run --mcp on the hub machine\n');
        process.exit(1);
      }
      const ctx = await buildAgent();
      await runMcpServer(ctx.tools, ctx.memory, ctx.config, {
        transport: args.mcpTransport ?? 'stdio',
        port: args.mcpPort ?? 3000,
      });
      break;
    }

    case 'doctor': {
      if (client) {
        await runRemoteDoctor(client);
      } else {
        const ctx = await buildAgent();
        await runDoctor(ctx);
      }
      break;
    }

    case 'oneshot': {
      if (client) {
        await runOneShot(remoteBackend(client), args.prompt ?? '');
      } else {
        const ctx = await buildAgent();
        await runOneShot(localBackend(ctx), args.prompt ?? '');
      }
      break;
    }

    default: {
      if (client) {
        await runRepl(remoteBackend(client));
      } else {
        const ctx = await buildAgent();
        await runRepl(localBackend(ctx));
      }
      break;
    }
  }
}

main().catch((err) => {
  process.stderr.write(`fatal: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
