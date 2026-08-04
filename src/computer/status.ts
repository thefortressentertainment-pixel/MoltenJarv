import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

/**
 * macOS system-status probe: the state of the machine (battery, power, CPU
 * load, memory, disk, uptime, network). Read-only; used by the system_status
 * tool so the agent always knows the state of the environment it runs on.
 */

const execFileAsync = promisify(execFile);

async function run(cmd: string, args: string[]): Promise<string> {
  try {
    const res = await execFileAsync(cmd, args, { timeout: 10_000 });
    return res.stdout;
  } catch {
    return '';
  }
}

function line(output: string, needle: string): string {
  const hit = output.split('\n').find((l) => l.includes(needle));
  return hit ?? '';
}

export interface SystemStatus {
  platform: string;
  hostname: string;
  user: string;
  power: {
    source: string;
    batteryPercent: number | null;
    charging: boolean | null;
    timeRemaining: string;
  };
  cpu: {
    cores: number;
    loadAvg: number[];
  };
  memory: {
    totalGb: number;
    usedGb: number;
    freeGb: number;
  };
  disk: {
    totalGb: number;
    usedGb: number;
    freeGb: number;
  };
  uptime: {
    seconds: number;
    human: string;
  };
  network: {
    ipv4: string[];
    wifi: string | null;
  };
}

export async function systemStatus(): Promise<SystemStatus> {
  if (process.platform !== 'darwin') {
    return {
      platform: process.platform,
      hostname: '',
      user: '',
      power: { source: 'unknown', batteryPercent: null, charging: null, timeRemaining: '' },
      cpu: { cores: 0, loadAvg: [] },
      memory: { totalGb: 0, usedGb: 0, freeGb: 0 },
      disk: { totalGb: 0, usedGb: 0, freeGb: 0 },
      uptime: { seconds: 0, human: 'unknown' },
      network: { ipv4: [], wifi: null },
    };
  }

  // Power / battery.
  const batt = await run('pmset', ['-g', 'batt']);
  const battLine = line(batt, '%');
  const powerMatch = batt.match(/'(AC Power|Battery Power)'/);
  const pctMatch = battLine.match(/(\d+)%/);
  const charged = battLine.includes('charged');
  const charging = battLine.includes('charging') || charged;

  // CPU.
  const coresRaw = (await run('sysctl', ['-n', 'hw.ncpu'])).trim();
  const loadRaw = (await run('sysctl', ['-n', 'vm.loadavg'])).trim();
  const loadAvg = (loadRaw.match(/(\d+\.\d+)/g) ?? []).map(Number).slice(0, 3);

  // Memory.
  const pageSizeRaw = (await run('sysctl', ['-n', 'vm.pagesize'])).trim();
  const pageSize = Number(pageSizeRaw) || 16384;
  const vm = await run('vm_stat', []);
  const page = (key: string): number => {
    const hit = vm.split('\n').find((l) => l.startsWith(key));
    if (!hit) return 0;
    return Number((hit.match(/(\d+)/) ?? [])[1] ?? 0);
  };
  const memFreePages = page('Pages free') + page('Pages speculative') + page('Pages inactive');
  const memTotalPages = memFreePages + page('Pages active') + page('Pages wired down') + page('Pages occupied by compressor');
  const memTotalBytes = memTotalPages * pageSize;
  const memFreeBytes = memFreePages * pageSize;

  // Disk (root volume).
  const df = await run('df', ['-k', '/']);
  const dfParts = df.trim().split('\n').pop()?.split(/\s+/) ?? [];
  const dfTotalKb = Number(dfParts[1] ?? 0);
  const dfUsedKb = Number(dfParts[2] ?? 0);
  const dfFreeKb = Number(dfParts[3] ?? 0);

  // Uptime.
  const bootRaw = (await run('sysctl', ['-n', 'kern.boottime'])).trim();
  const bootSec = Number((bootRaw.match(/sec\s*=\s*(\d+)/) ?? [])[1] ?? 0);
  const upSeconds = bootSec ? Math.max(0, Math.floor(Date.now() / 1000 - bootSec)) : 0;

  // Network.
  const ipv4: string[] = [];
  for (const iface of ['en0', 'en1', 'en2']) {
    const ip = (await run('ipconfig', ['getifaddr', iface])).trim();
    if (ip) ipv4.push(ip);
  }
  let wifi: string | null = null;
  for (const iface of ['en0', 'en1']) {
    const out = (await run('networksetup', ['-getairportnetwork', iface])).trim();
    const hit = out.match(/Current Wi-Fi Network:\s*(.+)/);
    if (hit && hit[1]) {
      wifi = hit[1].trim();
      break;
    }
  }

  return {
    platform: process.platform,
    hostname: (await run('scutil', ['--get', 'ComputerName'])).trim() || '',
    user: (await run('whoami', [])).trim(),
    power: {
      source: powerMatch?.[1] ?? 'unknown',
      batteryPercent: pctMatch ? Number(pctMatch[1]) : null,
      charging: battLine ? charging : null,
      timeRemaining: battLine.replace(/\s+/g, ' ').trim(),
    },
    cpu: { cores: Number(coresRaw) || 0, loadAvg },
    memory: {
      totalGb: round1(memTotalBytes / 1e9),
      usedGb: round1(Math.max(0, (memTotalBytes - memFreeBytes) / 1e9)),
      freeGb: round1(memFreeBytes / 1e9),
    },
    disk: {
      totalGb: round1(dfTotalKb / 1e6),
      usedGb: round1(dfUsedKb / 1e6),
      freeGb: round1(dfFreeKb / 1e6),
    },
    uptime: {
      seconds: upSeconds,
      human: humanDuration(upSeconds),
    },
    network: { ipv4, wifi },
  };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

export function humanDuration(sec: number): string {
  if (sec <= 0) return 'just now';
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const parts: string[] = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  return parts.join(' ') || `${sec}s`;
}

export function statusSummary(s: SystemStatus): string {
  const power =
    s.power.batteryPercent !== null
      ? `${s.power.batteryPercent}% ${s.power.charging ? '(charging)' : `on ${s.power.source}`}`
      : `on ${s.power.source}`;
  const cpu = s.cpu.loadAvg.length ? `${s.cpu.loadAvg.map((v) => v.toFixed(2)).join('/')} load (${s.cpu.cores} cores)` : `${s.cpu.cores} cores`;
  return (
    `power: ${power}; cpu: ${cpu}; memory: ${s.memory.usedGb}/${s.memory.totalGb} GB free ${s.memory.freeGb} GB; ` +
    `disk free: ${s.disk.freeGb} GB of ${s.disk.totalGb} GB; uptime: ${s.uptime.human}; ` +
    `network: ${s.network.ipv4.join(', ') || 'none'}${s.network.wifi ? ` (wi-fi ${s.network.wifi})` : ''}`
  );
}
