#!/usr/bin/env node
import os from 'node:os';
import { runDoctor, runOneShot, runRepl, buildAgent } from './cli/index.js';
import {
  addSchedule,
  printSchedules,
  removeSchedule,
  runAdHoc,
  runAgentSchedule,
  runScheduleNow,
} from './cli/agent.js';
import { localBackend, remoteBackend } from './cli/backend.js';
import { runKeyCommand } from './cli/keys.js';
import { runUpdateCommand } from './cli/update.js';
import { runSidecar, sendNotify } from './cli/sidecar.js';
import { runTelegram } from './cli/telegram.js';
import { runPerms } from './cli/perms.js';
import { addMonitor, printMonitors, removeMonitor, runMonitorDaemon } from './cli/monitor.js';
import { runVoiceSession, runWakeSession, type VoiceSessionOptions } from './cli/voice.js';
import { phoneCommand } from './cli/phone.js';
import { installPiper } from './voice/index.js';
import { ensureConfigFile } from './config/index.js';
import { VERSION } from './config/defaults.js';
import { getTokenStore } from './hub/auth.js';
import { runMcpServer } from './mcp/server.js';
import { getLinkStore, RemoteClient } from './remote/client.js';
import { loadAgentConfig, recordDaemonCrash, resetDaemonCrashCount } from './scheduler/index.js';
import { runDreamCommand } from './cli/dream.js';
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
  jarv-genie hub --url            print the hub's reachable URLs (local + network/Tailscale)
  jarv-genie link <url> <token>   pair this machine to a hub (token via hub --token)
  jarv-genie unlink               forget the hub
  jarv-genie sidecar [--name X] [--speak] [--no-notify] [--remote]   connect a device to the hub
  jarv-genie notify "text" [--device NAME] [--speak] [--remote]   push to connected devices
  jarv-genie phone pair <host:port> <code>    pair a phone (wireless debugging pair code)
  jarv-genie phone connect <host:port>        connect to a paired phone
  jarv-genie phone push <local> <remote>      upload a file to the phone (e.g. /sdcard/Download)
  jarv-genie phone pull <remote> <local>      download a file from the phone
  jarv-genie phone ls [dir]                   list files on the phone
  jarv-genie phone devices / set <host:port> / open <pkg> / shell <args>
  jarv-genie telegram    run the Telegram bridge (talk to Jarv + approve consequential actions remotely)
  jarv-genie perms       one-time: check/grant the macOS permissions Jarv needs
  jarv-genie monitor [add <dir|web|metric> <target> "<prompt>" [--every N] [--notify] [--speak] | list | remove <id>]   long-horizon watches
  jarv-genie monitor    run the monitor daemon (fires when a watched target changes)
  jarv-genie update publish <file> [--version X] [--notes "..."]   stage a build for distribution
  jarv-genie update list          show what's published for updates
  jarv-genie update check [--url <hub>] [--remote]   check for a newer build
  jarv-genie hub --update-url <hub>   auto-check this update server for new builds
  jarv-genie voice [--voice N] [--no-tts] [--remote] [--live] [--wake [--wake-phrase "..."] [--quiet]] [--setup-piper]   talk to the brain out loud
  jarv-genie voice --live   show live captions as you speak (streaming STT)
  jarv-genie voice --wake   hands-free: answers when you say "hey jarv" (wake word)
  jarv-genie voice --setup-piper   install neural TTS (Piper) for faster replies
  jarv-genie agent [schedule|list|run|once|remove]     scheduled briefings & reminders
  jarv-genie dream [--force] [--min-count N]   consolidate long-term memory now
  jarv-genie agent schedule "@daily" "<prompt>" [--notify] [--speak]   add a schedule
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

function parseHubArgs(argv: string[]): UiServerOptions & { token?: boolean; newToken?: boolean; printUrl?: boolean } {
  const out: UiServerOptions & { token?: boolean; newToken?: boolean; printUrl?: boolean } = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') out.port = Number(argv[++i]);
    else if (a === '--host') out.host = argv[++i];
    else if (a === '--no-open') out.open = false;
    else if (a === '--no-auth') out.auth = false;
    else if (a === '--auth') out.auth = true;
    else if (a === '--token') out.token = true;
    else if (a === '--new-token') out.newToken = true;
    else if (a === '--update-url') out.updateUrl = argv[++i];
    else if (a === '--url') out.printUrl = true;
  }
  return out;
}

/** Reachable IPv4 addresses for the hub, best for sharing a URL with a phone. */
function hubIps(): string[] {
  const out: string[] = [];
  const interfaces = os.networkInterfaces();
  for (const list of Object.values(interfaces ?? {})) {
    for (const itf of list ?? []) {
      if (itf.family === 'IPv4' && !itf.internal) out.push(itf.address);
    }
  }
  // Prefer a Tailscale address so the hub is reachable from a phone anywhere.
  return [...out].sort((a) => (a.startsWith('100.') || a.startsWith('fd7:') ? -1 : 1));
}

function extractRemote(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--remote') {
      const n = argv[i + 1];
      return n && /^https?:\/\//.test(n) ? n : '';
    }
  }
  return undefined;
}

function parseVoiceArgs(argv: string[]): { opts: VoiceSessionOptions; remoteUrl: string | undefined } {
  const opts: VoiceSessionOptions = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--voice') opts.voice = argv[++i];
    else if (a === '--no-tts') opts.tts = false;
    else if (a === '--model') opts.model = argv[++i];
    else if (a === '--max-seconds') opts.maxSeconds = Number(argv[++i]);
    else if (a === '--live') opts.live = true;
    else if (a === '--wake') opts.wake = true;
    else if (a === '--quiet') opts.quiet = true;
    else if (a === '--setup-piper') opts.setupPiper = true;
    else if (a === '--wake-phrase') {
      const p = argv[++i];
      if (p) (opts.wakePhrases ??= []).push(p);
    }
  }
  return { opts, remoteUrl: extractRemote(argv) };
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

  if (raw[0] === 'update') {
    await runUpdateCommand(raw.slice(1));
    return;
  }

  if (raw[0] === 'telegram') {
    const ctx = await buildAgent();
    await runTelegram(ctx);
    return;
  }

  if (raw[0] === 'shutdown') {
    const { powerDown } = await import('./cli/shutdown.js');
    const res = await powerDown('cli');
    process.stdout.write(`${res.message}\n`);
    if (!res.ok) process.exit(1);
    return;
  }

  if (raw[0] === 'perms') {
    await runPerms();
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

  if (raw[0] === 'sidecar') {
    const rest = raw.slice(1);
    const remoteUrl = extractRemote(rest);
    const client = remoteUrl !== undefined ? resolveRemote(remoteUrl) : resolveRemote('');
    const opts = {
      name: rest.find((a, i) => rest[i - 1] === '--name'),
      speak: rest.includes('--speak'),
      notify: !rest.includes('--no-notify'),
    };
    await runSidecar(client, opts);
    return;
  }

  if (raw[0] === 'notify') {
    const rest = raw.slice(1);
    const remoteUrl = extractRemote(rest);
    const text = rest.filter((a) => !a.startsWith('-')).join(' ');
    if (!text) {
      process.stderr.write('Usage: jarv-genie notify "<text>" [--device NAME] [--speak] [--remote]\n');
      process.exit(1);
    }
    const client = remoteUrl !== undefined ? resolveRemote(remoteUrl) : resolveRemote('');
    const device = rest.find((a, i) => rest[i - 1] === '--device');
    await sendNotify(client, text, { device, speak: rest.includes('--speak') });
    return;
  }

  if (raw[0] === 'monitor') {
    const rest = raw.slice(1);
    const remoteUrl = extractRemote(rest);
    const backend =
      remoteUrl !== undefined ? remoteBackend(resolveRemote(remoteUrl)) : localBackend(await buildAgent());
    const sub = rest[0];

    if (sub === 'add') {
      const kind = rest[1];
      const target = rest[2];
      const withoutFlags = rest.slice(3).filter((a, i, arr) => {
        if (a === '--every') return false;
        return !(arr[i - 1] === '--every');
      });
      const prompt = withoutFlags.filter((a) => !a.startsWith('-')).join(' ');
      const every = Number(rest.find((a, i) => rest[i - 1] === '--every') ?? NaN);
      try {
        await addMonitor(kind ?? '', target ?? '', prompt, {
          every: Number.isFinite(every) ? every : undefined,
          notify: rest.includes('--notify'),
          speak: rest.includes('--speak'),
        });
      } catch (err) {
        process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
      }
      return;
    }
    if (sub === 'list') {
      printMonitors();
      return;
    }
    if (sub === 'remove') {
      try {
        removeMonitor(rest[1] ?? '');
      } catch (err) {
        process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
      }
      return;
    }

    await runMonitorDaemon(backend);
    return;
  }

  if (raw[0] === 'phone') {
    await phoneCommand(raw.slice(1));
    return;
  }

  if (raw[0] === 'voice') {
    const { opts, remoteUrl } = parseVoiceArgs(raw.slice(1));
    if (opts.setupPiper) {
      const model = await installPiper();
      process.stdout.write(`Piper neural TTS installed (${model})\n`);
      return;
    }
    const backend =
      remoteUrl !== undefined ? remoteBackend(resolveRemote(remoteUrl)) : localBackend(await buildAgent());
    const session = opts.wake ? runWakeSession : runVoiceSession;
    await session(backend, opts);
    return;
  }

  if (raw[0] === 'agent') {
    const rest = raw.slice(1);
    const remoteUrl = extractRemote(rest);
    const backend =
      remoteUrl !== undefined ? remoteBackend(resolveRemote(remoteUrl)) : localBackend(await buildAgent());
    const sub = rest[0];

    if (sub === 'schedule') {
      const cron = rest[1];
      const prompt = rest.slice(2).filter((a) => !a.startsWith('-')).join(' ');
      const flags = { notify: rest.includes('--notify'), speak: rest.includes('--speak') };
      if (!cron || !prompt) {
        process.stderr.write('Usage: jarv-genie agent schedule "<cron>" "<prompt>" [--notify] [--speak]\n');
        process.exit(1);
      }
      addSchedule(cron, prompt, flags);
      return;
    }
    if (sub === 'list') {
      printSchedules(loadAgentConfig());
      return;
    }
    if (sub === 'remove') {
      removeSchedule(rest[1] ?? '');
      return;
    }
    if (sub === 'run') {
      if (!rest[1]) {
        process.stderr.write('Usage: jarv-genie agent run <id>\n');
        process.exit(1);
      }
      await runScheduleNow(rest[1], backend);
      return;
    }
    if (sub === 'once') {
      const prompt = rest.filter((a) => !a.startsWith('-')).slice(1).join(' ');
      if (!prompt) {
        process.stderr.write('Usage: jarv-genie agent once "<prompt>" [--notify] [--speak]\n');
        process.exit(1);
      }
      await runAdHoc(prompt, backend, { notify: rest.includes('--notify'), speak: rest.includes('--speak') });
      return;
    }

    // default: run the daemon
    process.stdout.write(`[jarv-genie] agent daemon (${backend.kind}) — ctrl-c to stop\n`);
    printSchedules(loadAgentConfig());
    let stopped = false;
    // A single bad tick must never bubble out of the daemon: this service runs
    // under launchd with KeepAlive=true, so an uncaught throw would let the
    // process exit(1) hot and get respawned in a crash-loop. Each tick is fully
    // isolated and, on repeated failures, we back off exponentially so a bona
    // fide stuck subsystem can't pin the machine.
    let cleanTicks = 0;
    const CLEAN_RESET = 6; // consecutive clean ticks before arming the breaker is cleared
    const tick = async () => {
      try {
        await runAgentSchedule(loadAgentConfig(), backend);
        cleanTicks++;
        if (cleanTicks >= CLEAN_RESET) {
          resetDaemonCrashCount();
          cleanTicks = 0;
        }
      } catch (err) {
        cleanTicks = 0;
        process.stdout.write(`[jarv-genie] tick error: ${err instanceof Error ? err.message : String(err)}\n`);
        const delay = recordDaemonCrash();
        process.stdout.write(`[jarv-genie] backing off ${Math.round(delay / 1000)}s after repeated failures\n`);
        if (!stopped) setTimeout(tick, Math.max(delay, 1_000));
        return;
      }
      // Wait for the previous tick to finish before scheduling the next one,
      // so a long-running schedule can't stack overlapping ticks.
      if (!stopped) setTimeout(tick, 30_000);
    };
    await tick();
    process.on('SIGINT', () => {
      stopped = true;
      process.exit(0);
    });
    await new Promise(() => {});
  }

  if (raw[0] === 'dream') {
    const ctx = await buildAgent();
    await runDreamCommand(ctx, raw.slice(1));
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
    if (opts.printUrl) {
      const port = opts.port ?? 3001;
      const host = opts.host ?? '127.0.0.1';
      process.stdout.write(`loopback:  http://${host}:${port}\n`);
      for (const ip of hubIps()) process.stdout.write(`network:   http://${ip}:${port}\n`);
      process.stdout.write(`token:     ${getTokenStore().get()}\n`);
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
