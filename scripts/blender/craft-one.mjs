#!/usr/bin/env node
/**
 * One-shot craft runner for the M1: reference photo -> real mesh GLB via the
 * native MLX Hunyuan3D binary (staged at ~/.jarv-genie/craft/).
 *
 * Usage:
 *   node scripts/blender/craft-one.mjs <image.png> [--octree 192] [--quantize 4]
 *
 * RAM CRITICAL: the craft is a multi-GB Metal compute. It MUST run with Blender
 * (and any other memory hogs) closed. This script refuses if the Blender bridge
 * is live.
 */
import path from 'node:path';
import fs from 'node:fs';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(process.env.HOME, '.jarv-genie', 'craft');
const bin = path.join(root, 'hy3d');
const weights = path.join(root, 'weights', 'shape-small');

const args = process.argv.slice(2);
const image = args.find((a) => !a.startsWith('--'));
if (!image) {
  console.error('usage: craft-one.mjs <image.png> [--octree N] [--quantize 4|8] [--steps N]');
  process.exit(2);
}
const flag = (k, d) => { const i = args.indexOf(k); return i >= 0 ? Number(args[i + 1]) : d; };
const octree = flag('--octree', 192);
const quantize = flag('--quantize', 4);
const steps = flag('--steps', 30);

if (!fs.existsSync(bin)) { console.error('[craft] hy3d binary missing at', bin); process.exit(1); }
if (!fs.existsSync(path.join(weights, 'model.fp16.safetensors'))) { console.error('[craft] shape weights missing'); process.exit(1); }
if (!fs.existsSync(image)) { console.error('[craft] image not found:', image); process.exit(1); }

// Guard: Blender bridge live -> refuse.
const stateFile = path.join(process.env.HOME, '.jarv-genie', 'blender-state.json');
try {
  const s = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  if (s.live === true) {
    console.error('[craft] Blender bridge is LIVE. The craft needs several GB of RAM and cannot share the machine with Blender. Close Blender, then retry.');
    process.exit(3);
  }
} catch { /* no state file — proceed */ }

const out = '/tmp/jarv_crafted.glb';
try { fs.unlinkSync(out); } catch {}

// Free-RAM pre-flight via macOS's authoritative memory_pressure free percentage.
// (vm_stat "Pages free" undercounts — macOS keeps most RAM as reclaimable cache.)
let freePct = Infinity;
try {
  const mp = execFileSync('memory_pressure', [], { encoding: 'utf8' });
  const pm = /System-wide memory free percentage:\s+(\d+)%/.exec(mp);
  if (pm) freePct = Number(pm[1]);
} catch {}
if (freePct !== Infinity && freePct < 25) {
  console.error(`[craft] RAM is tight (~${freePct}% memory free). Close Docker Desktop / large VMs / editors and retry.`);
  process.exit(3);
}

console.log(`[craft] hy3d shape image=${image} quantize=${quantize} octree=${octree} steps=${steps} (memory free ≈${freePct === Infinity ? 'n/a' : freePct}%)`);
console.log('[craft] this is a multi-GB Metal compute — please be patient (30s-few min).');
const started = Date.now();
promisify(execFile)(bin, ['shape', image, '-o', out, '--weights', weights, '--quantize', String(quantize), '--octree', String(octree), '--steps', String(steps)],
  { timeout: 15 * 60_000, maxBuffer: 8 * 1024 * 1024 },
).then((res) => {
  const created = fs.existsSync(out) && fs.statSync(out).size > 0;
  const secs = Math.round((Date.now() - started) / 1000);
  if (!created) { console.error('[craft] ran but produced no GLB. stdout tail:\n' + (res.stdout || '').slice(-800)); process.exit(1); }
  console.log(`[craft] DONE in ${secs}s -> ${out} (${(fs.statSync(out).size / 1e6).toFixed(1)} MB). Load in Blender: FIle>Import>glTF 2.0, or via bpy_craft.`);
}).catch((err) => {
  const secs = Math.round((Date.now() - started) / 1000);
  console.error(`[craft] failed after ${secs}s:`, err.killed ? 'timed out (15m)' : err.message);
  console.error((err.stdout || '') + (err.stderr || ''));
  process.exit(1);
});
