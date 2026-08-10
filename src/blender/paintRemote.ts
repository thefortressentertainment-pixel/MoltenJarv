/**
 * `bpy_paint_remote` — hand the heavy texture/paint stage to a FREE 0-cost GPU host.
 *
 * The M1 can craft a real mesh (hy3d shape, ~2-4GB) but CANNOT run the paint
 * stage (Hunyuan3D-2.1 paint needs ~38GB RAM). Free 0-cost GPU notebooks exist in
 * 2026 and CAN run it via GPU+CPU offload:
 *   - Kaggle: free dual NVIDIA T4 (32GB VRAM), ~30 GPU-hrs/week, 12h headless
 *   - Google Colab: free T4 (16GB), ~10-15h/wk
 * This module is the M1-side client: it POSTs the crafted mesh + reference to a
 * remote paint endpoint (a Jupyter notebook running Hunyuan3D-2.1, exposed via an
 * ngrok/Cloudflare tunnel), triggers the paint, polls, and downloads the textured
 * GLB back. The bot/bpy_import_craft then loads it into Blender.
 *
 * Cost: $0 for the GPU host. RAM-light on the M1 (only upload/download + networking).
 * Keep it scoped to Blender (no bleed into Jarv memory/agent).
 */

import path from 'node:path';
import fs from 'node:fs';
import { getSecretStore } from '../config/secrets.js';

export interface PaintRemoteConfig {
  /** Base URL of the remote paint service, e.g. https://xxxx.ngrok-free.app or a colab tunnel. */
  endpoint: string;
  /** Bearer token the notebook expects (or empty if none). */
  token?: string;
}

/** Resolve remote paint config from secrets (BLENDER_PAINT_URL / BLENDER_PAINT_TOKEN).
 *  Returns null when not configured. */
export function paintRemoteConfig(): PaintRemoteConfig | null {
  try {
    const secrets = getSecretStore();
    const endpoint = secrets.get('BLENDER_PAINT_URL');
    if (!endpoint) return null;
    return { endpoint, token: secrets.get('BLENDER_PAINT_TOKEN') || undefined };
  } catch {
    return null;
  }
}

export interface PaintResult {
  ok: boolean;
  glb?: string;
  error?: string;
  detail?: string;
}

/** Pre-flight check: is remote paint configured AND the host reachable? Returns
 *  {ok, error?} where error is a clear, actionable message (config missing vs the
 *  tunnel/host not responding). Used as a fail-safe BEFORE a full upload. */
export async function pingRemotePaint(): Promise<{ ok: boolean; endpoint?: string; error?: string }> {
  const cfg = paintRemoteConfig();
  if (!cfg) {
    return { ok: false, error: 'Remote paint not configured. Set:  jarv-genie key set BLENDER_PAINT_URL <url>  (+ BLENDER_PAINT_TOKEN)' };
  }
  try {
    const res = await fetch(`${cfg.endpoint.replace(/\/+$/, '')}/ping`, {
      headers: authHeaders(cfg),
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 401 || res.status === 403) return { ok: true, endpoint: cfg.endpoint, error: 'warning: tunnel reachable but auth token may be wrong (check BLENDER_PAINT_TOKEN)' };
    return { ok: res.ok, endpoint: cfg.endpoint, error: res.ok ? undefined : `remote paint host returned HTTP ${res.status}` };
  } catch (err) {
    return {
      ok: false,
      endpoint: cfg.endpoint,
      error: `Cannot reach the paint host at ${cfg.endpoint} (${err instanceof Error ? err.message : String(err)}). Start the Kaggle cell (kaggle_notebook.py) and keep it running, then re-set BLENDER_PAINT_URL if the tunnel URL changed.`,
    };
  }
}

function authHeaders(cfg: PaintRemoteConfig): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (cfg.token) h.Authorization = `Bearer ${cfg.token}`;
  return h;
}

const CLOUDFLARE_BLIPS = new Set([530, 502, 503, 504]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** fetch() that retries transient Cloudflare/tunnel errors (530/502/503/504) and
 *  network resets, with a short backoff. trycloudflare drops connections
 *  intermittently (HTTP 530 'origin unreachable' blips) right after requests. */
async function fetchRetry(url: string, init: RequestInit, tries = 3): Promise<Response> {
  let last: Error | Response | undefined;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, init);
      if (!res.ok && CLOUDFLARE_BLIPS.has(res.status) && i < tries - 1) {
        last = res;
        await sleep(3000 * (i + 1));
        continue;
      }
      return res;
    } catch (err) {
      last = err as Error;
      if (i < tries - 1) await sleep(3000 * (i + 1));
    }
  }
  if (last instanceof Response) throw new Error(`HTTP ${last.status}`);
  throw last ?? new Error('fetch failed');
}

/** Multipart upload of the mesh GLB + reference to the remote paint service.
 *  Remote returns the key under which it stored the job. */
async function uploadJob(cfg: PaintRemoteConfig, glb: string, reference: string): Promise<string> {
  const boundary = '----jarv' + Date.now().toString(36);
  const parts: Buffer[] = [];
  const addField = (name: string, value: string) => {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  };
  const addFile = (field: string, filename: string, data: Buffer, mime: string) => {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`));
    parts.push(data);
    parts.push(Buffer.from('\r\n'));
  };
  addField('job_type', 'paint');
  addFile('mesh', path.basename(glb), fs.readFileSync(glb), 'model/gltf-binary');
  addFile('reference', path.basename(reference), fs.readFileSync(reference), 'image/jpeg');
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  const body = Buffer.concat(parts);

  const res = await fetchRetry(`${cfg.endpoint.replace(/\/+$/, '')}/jobs`, {
    method: 'POST',
    headers: { ...authHeaders(cfg), 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    body,
    signal: AbortSignal.timeout(180_000),
  });
  const data = (await res.json().catch(() => ({}))) as { job_id?: string; error?: string };
  if (!res.ok) throw new Error(data.error || `upload HTTP ${res.status}`);
  if (!data.job_id) throw new Error('remote did not return a job_id');
  return data.job_id;
}

/** Poll the remote paint job until done or timeout. Returns status + remote error. */
async function waitForJob(cfg: PaintRemoteConfig, jobId: string, timeoutMs = 30 * 60_000): Promise<{ status: string; error?: string }> {
  const base = cfg.endpoint.replace(/\/+$/, '');
  const started = Date.now();
  for (;;) {
    const res = await fetchRetry(`${base}/jobs/${jobId}`, { headers: authHeaders(cfg), signal: AbortSignal.timeout(30_000) });
    const data = (await res.json().catch(() => ({}))) as { status?: string; error?: string };
    const status = data.status || 'running';
    if (status === 'done' || status === 'failed') return { status, error: data.error };
    if (Date.now() - started > timeoutMs) return { status: 'timeout' };
    await new Promise((r) => setTimeout(r, 5000));
  }
}

/** Download the painted textured GLB back to a local path. */
async function downloadResult(cfg: PaintRemoteConfig, jobId: string, dest: string): Promise<string> {
  const res = await fetchRetry(`${cfg.endpoint.replace(/\/+$/, '')}/jobs/${jobId}/result`, {
    headers: authHeaders(cfg),
    signal: AbortSignal.timeout(180_000),
  });
  if (!res.ok) throw new Error(`download HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(dest, buf);
  return dest;
}

/** Run the remote paint handoff end-to-end: upload -> wait -> download painted GLB. */
export async function runRemotePaint(
  glb: string,
  reference: string,
  out = '/tmp/jarv_painted.glb',
): Promise<PaintResult> {
  const cfg = paintRemoteConfig();
  if (!cfg) return { ok: false, error: 'Remote paint not configured — set BLENDER_PAINT_URL (and BLENDER_PAINT_TOKEN) via: jarv-genie key set BLENDER_PAINT_URL <url>' };
  if (!fs.existsSync(glb)) return { ok: false, error: `mesh GLB not found: ${glb}` };
  if (!fs.existsSync(reference)) return { ok: false, error: `reference not found: ${reference}` };
  try {
    const jobId = await uploadJob(cfg, glb, reference);
    const status = await waitForJob(cfg, jobId);
    if (status.status === 'failed') return { ok: false, error: `remote paint job failed: ${status.error || 'unknown error on the GPU host'}` };
    if (status.status === 'timeout') return { ok: false, error: 'remote paint timed out (30m)' };
    const dest = await downloadResult(cfg, jobId, out);
    return { ok: true, glb: dest };
  } catch (err) {
    return { ok: false, error: `remote paint error: ${err instanceof Error ? err.message : String(err)}` };
  }
}
