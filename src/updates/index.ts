import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { dataHome, VERSION } from '../config/defaults.js';

export interface UpdateManifest {
  version: string;
  notes?: string;
  /** Filename of the artifact inside the updates directory. */
  artifact: string;
  artifactSize: number;
  sha256: string;
  publishedAt: string;
}

export interface UpdateStatus {
  current: string;
  latest: string | null;
  available: boolean;
  notes?: string;
  artifact?: string;
  url?: string;
  checkedAt?: string;
  error?: string;
}

export function updatesDir(): string {
  return path.join(dataHome(), 'updates');
}

export function manifestPath(): string {
  return path.join(updatesDir(), 'update.json');
}

export function readManifest(): UpdateManifest | null {
  try {
    const raw = JSON.parse(fs.readFileSync(manifestPath(), 'utf8')) as Partial<UpdateManifest>;
    if (!raw || typeof raw.version !== 'string' || !raw.artifact) return null;
    return raw as UpdateManifest;
  } catch {
    return null;
  }
}

/** Stage an artifact for distribution: copy it into the updates dir and write the manifest. */
export function publishUpdate(artifact: string, opts: { version?: string; notes?: string } = {}): UpdateManifest {
  const stat = fs.statSync(artifact);
  if (!stat.isFile()) throw new Error(`not a file: ${artifact}`);
  const version = (opts.version ?? '').trim() || VERSION;
  fs.mkdirSync(updatesDir(), { recursive: true });
  const ext = path.extname(artifact) || '.bin';
  const dest = path.join(updatesDir(), `jarv-genie-${version}${ext}`);
  fs.copyFileSync(artifact, dest);
  const manifest: UpdateManifest = {
    version,
    notes: (opts.notes ?? '').trim() || undefined,
    artifact: path.basename(dest),
    artifactSize: stat.size,
    sha256: createHash('sha256').update(fs.readFileSync(dest)).digest('hex'),
    publishedAt: new Date().toISOString(),
  };
  fs.writeFileSync(manifestPath(), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}

/** Path on disk for a published manifest's artifact. */
export function artifactPath(m: UpdateManifest): string {
  return path.join(updatesDir(), m.artifact);
}

/** Numeric-ish version comparison: "0.1.0" < "0.1.1" < "0.2.0". Returns <0, 0, >0. */
export function cmpVersion(a: string, b: string): number {
  const pa = a.replace(/^v/, '').split(/[.+-]/);
  const pb = b.replace(/^v/, '').split(/[.+-]/);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] ?? '0';
    const y = pb[i] ?? '0';
    const nx = Number(x);
    const ny = Number(y);
    if (Number.isFinite(nx) && Number.isFinite(ny)) {
      if (nx !== ny) return nx < ny ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

/** Fetch another hub's published update manifest. Null when it has none published. */
export async function fetchManifest(base: string, token?: string): Promise<UpdateManifest | null> {
  const url = `${base.replace(/\/+$/, '')}/api/update`;
  const res = await fetch(url, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    signal: AbortSignal.timeout(10_000),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`update server returned HTTP ${res.status}`);
  return (await res.json()) as UpdateManifest;
}

let cached: { status: UpdateStatus; at: number; url: string } | null = null;
const STATUS_TTL_MS = 30 * 60 * 1000;

/** Compare this machine's version against an update server's latest. Cached 30 minutes. */
export async function checkUpdateStatus(updateUrl?: string, token?: string): Promise<UpdateStatus> {
  const base = updateUrl?.replace(/\/+$/, '');
  if (!base) {
    const m = readManifest();
    return {
      current: VERSION,
      latest: m?.version ?? null,
      available: !!m && cmpVersion(m.version, VERSION) > 0,
      notes: m?.notes,
      artifact: m?.artifact,
      checkedAt: new Date().toISOString(),
    };
  }
  const now = Date.now();
  if (cached && cached.url === base && cached.at > now - STATUS_TTL_MS) {
    return cached.status;
  }
  let status: UpdateStatus;
  try {
    const m = await fetchManifest(base, token);
    status = {
      current: VERSION,
      latest: m?.version ?? null,
      available: !!m && cmpVersion(m.version, VERSION) > 0,
      notes: m?.notes,
      artifact: m?.artifact,
      url: base,
      checkedAt: new Date().toISOString(),
    };
  } catch (err) {
    status = {
      current: VERSION,
      latest: null,
      available: false,
      url: base,
      checkedAt: new Date().toISOString(),
      error: err instanceof Error ? err.message : String(err),
    };
  }
  cached = { status, at: now, url: base };
  return status;
}
