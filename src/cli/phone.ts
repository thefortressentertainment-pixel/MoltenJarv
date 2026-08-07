import { execFile as ef, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { dataHome } from '../config/defaults.js';

const execFile = promisify(ef);

/**
 * ADB phone bridge.
 *
 * Pairs a phone to this Mac over the debug bridge (wireless debugging), then
 * drives it for file upload/download and inspection. The endpoint (Tailscale
 * IP + port) is remembered so Jarv can reconnect reliably without asking the
 * owner to read ports off the screen each time.
 *
 *   jarv-genie phone pair <host:port> <code>      one-time TLS pairing
 *   jarv-genie phone connect <host:port>           connect to a paired phone
 *   jarv-genie phone push  <local> <remote>        upload a file to the phone
 *   jarv-genie phone pull  <remote> <local>        download a file from the phone
 *   jarv-genie phone ls    <remote-dir>            list files on the phone
 *   jarv-genie phone devices                       list connected phones
 *   jarv-genie phone set   <host:port>             remember the endpoint
 *
 * The remembered endpoint defaults to the Tailscale address so the phone is
 * reachable from anywhere, and reconnects are transparent.
 */

interface PhoneConfig {
  endpoint?: string;
  host?: string;
  port?: number;
}

const PHONE_FILE = 'phone.json';

export function phonePath(): string {
  return path.join(dataHome(), PHONE_FILE);
}

export function loadPhone(): PhoneConfig {
  try {
    const raw = JSON.parse(fs.readFileSync(phonePath(), 'utf8')) as PhoneConfig;
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

function savePhone(cfg: PhoneConfig): void {
  fs.mkdirSync(path.dirname(phonePath()), { recursive: true, mode: 0o700 });
  fs.writeFileSync(phonePath(), JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
}

/** Split "host:port" into parts, validating the port. */
function splitEndpoint(endpoint: string): { host: string; port: string } {
  const m = /^([^:]+):(\d+)$/.exec(endpoint.trim());
  if (!m) throw new Error(`invalid endpoint "${endpoint}" (expected host:port)`);
  return { host: m[1]!, port: m[2]! };
}

/** Preference: an explicitly remembered endpoint, else the phone host on port 5930. */
function resolveEndpoint(): string {
  const cfg = loadPhone();
  if (cfg.endpoint) return cfg.endpoint;
  if (cfg.host && cfg.port) return `${cfg.host}:${cfg.port}`;
  throw new Error('no phone configured — run `jarv-genie phone connect <host:port>` or `jarv-genie phone set <host:port>` first');
}

function deviceArg(): string {
  return `-s ${resolveEndpoint()}`;
}

async function adb(args: string[]): Promise<{ stdout: string; stderr: string }> {
  try {
    const res = await execFile('adb', args);
    return { stdout: res.stdout.trim(), stderr: res.stderr.trim() };
  } catch (err) {
    const code = (err as { code?: number | string }).code;
    const message = err instanceof Error ? err.message : String(err);
    // adb reports "device offline/not found" via exit codes; surface plainly.
    throw new Error(`adb ${args.join(' ')} failed${code !== undefined ? ` (${code})` : ''}: ${message}`);
  }
}

async function connect(endpoint = resolveEndpoint()): Promise<boolean> {
  const hostPart = endpoint.split(':')[0] ?? '';
  const existing = listDevices();
  if (existing.some((l) => l.includes('device') && l.includes(hostPart))) {
    return true;
  }
  await adb(['connect', endpoint]);
  return listDevices().some((l) => l.includes('device'));
}

function listDevices(): string[] {
  try {
    const out = execFileSync('adb', ['devices'], { encoding: 'utf8' });
    return out
      .split('\n')
      .slice(1)
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
  } catch {
    return [];
  }
}

export async function phoneCommand(argv: string[]): Promise<void> {
  const sub = argv[0];

  if (sub === 'pair') {
    const endpoint = argv[1];
    const code = argv[2];
    if (!endpoint || !code) {
      process.stdout.write('Usage: jarv-genie phone pair <host:port> <pairing-code>\n');
      process.exitCode = 1;
      return;
    }
    const out = await adb(['pair', endpoint, code]);
    if (out.stderr || /success/i.test(out.stdout)) process.stdout.write(`${out.stdout || out.stderr}\n`);
    // After pairing, remember the host (port for pairing expires; the connect
    // port is discovered by `connect` from mdns / the owner's input).
    const { host } = splitEndpoint(endpoint);
    savePhone({ ...loadPhone(), host });
    return;
  }

  if (sub === 'connect') {
    const endpoint = argv[1];
    if (!endpoint) {
      process.stdout.write('Usage: jarv-genie phone connect <host:port>\n');
      process.exitCode = 1;
      return;
    }
    const { host } = splitEndpoint(endpoint);
    const ok = await connect(endpoint);
    savePhone({ ...loadPhone(), host, endpoint });
    process.stdout.write(ok ? `connected to ${endpoint}\n` : `could not reach ${endpoint}\n`);
    if (!ok) process.exitCode = 1;
    return;
  }

  if (sub === 'set') {
    const endpoint = argv[1];
    if (!endpoint) {
      process.stdout.write('Usage: jarv-genie phone set <host:port>\n');
      process.exitCode = 1;
      return;
    }
    const { host } = splitEndpoint(endpoint);
    savePhone({ ...loadPhone(), host, endpoint });
    process.stdout.write(`phone endpoint set to ${endpoint}\n`);
    return;
  }

  if (sub === 'devices') {
    process.stdout.write(listDevices().join('\n') + '\n');
    return;
  }

  if (sub === 'push' || sub === 'pull' || sub === 'ls' || sub === 'shell') {
    const endpoint = resolveEndpoint();
    if (!(await connect(endpoint))) {
      process.stderr.write(`phone at ${endpoint} is not reachable — re-run \`jarv-genie phone connect ${endpoint}\`\n`);
      process.exitCode = 1;
      return;
    }
    if (sub === 'push') {
      const [local, remote] = argv.slice(1);
      if (!local || !remote) {
        process.stdout.write('Usage: jarv-genie phone push <local-path> /sdcard/Download/<name>\n');
        process.exitCode = 1;
        return;
      }
      const out = await adb(['-s', endpoint, 'push', local, remote]);
      process.stdout.write(`${out.stdout || out.stderr}\n`);
      return;
    }
    if (sub === 'pull') {
      const [remote, local] = argv.slice(1);
      if (!remote || !local) {
        process.stdout.write('Usage: jarv-genie phone pull <phone-path> <local-dir-or-file>\n');
        process.exitCode = 1;
        return;
      }
      const out = await adb(['-s', endpoint, 'pull', remote, local]);
      process.stdout.write(`${out.stdout || out.stderr}\n`);
      return;
    }
    if (sub === 'ls') {
      const dir = argv[1] ?? '/sdcard/Download';
      const out = await adb(['-s', endpoint, 'shell', 'ls', '-la', dir]);
      process.stdout.write(`${out.stdout || out.stderr}\n`);
      return;
    }
    // shell: run a raw device command (powertool for the owner/Jarv)
    const out = await adb(['-s', endpoint, 'shell', ...argv.slice(1)]);
    process.stdout.write(out.stdout + '\n');
    return;
  }

  if (sub === 'open') {
    // Convenience: open/launch a remote package (e.g. a built APK's app).
    const [pkg, activity] = argv.slice(1);
    if (!pkg) {
      process.stdout.write('Usage: jarv-genie phone open <package> [activity]\n');
      process.exitCode = 1;
      return;
    }
    const endpoint = resolveEndpoint();
    if (!(await connect(endpoint))) {
      process.stderr.write(`phone at ${endpoint} is not reachable\n`);
      process.exitCode = 1;
      return;
    }
    const target = activity ? `${pkg}/${activity}` : pkg;
    const out = await adb(['-s', endpoint, 'shell', 'am', 'start', '-n', target]);
    process.stdout.write(`${out.stdout || out.stderr}\n`);
    return;
  }

  if (sub === undefined) {
    const cfg = loadPhone();
    process.stdout.write(
      `phone: ${cfg.endpoint ? cfg.endpoint : cfg.host ? `${cfg.host}:<unknown-connect-port>` : 'not configured'}\n` +
        `devices:\n${listDevices().map((l) => '  ' + l).join('\n') || '  (none connected)'}\n` +
        `\ncommands: pair | connect | set | devices | push | pull | ls | open | shell\n`,
    );
    return;
  }

  process.stdout.write(`unknown subcommand "${sub}"\n`);
  process.exitCode = 1;
}
