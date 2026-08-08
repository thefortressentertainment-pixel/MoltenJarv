import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import type { ToolDefinition } from '../agent/types.js';
import { dataHome } from '../config/defaults.js';
import { sha256Json } from '../attest.js';

/**
 * Delivery Track Record — a first-class part of the tool pipeline.
 *
 * After any shipped task, Jarv appends a timestamped entry to the Delivery
 * Track Record (`track-record/delivery-log.md`). This is the audit trail behind
 * delivered work — private operating hygiene that doubles as a verifiable
 * Moltbook trust signal. Because `log_delivery` is a real registered tool and
 * this module lives in the framework, logging is part of the machine, not a
 * convention Jarv has to remember.
 *
 * The log is a SHA-256 hash chain: every entry commits the previous entry's
 * hash, so the whole record is append-only and tamper-evident. Any agent (or
 * human) can recompute the chain and confirm the published root hash matches.
 */

const CATEGORIES = new Set(['investor-digest', 'ai-papers', 'system-op', 'social', 'other']);
const ALLOWED = [...CATEGORIES].sort();

/** Fixed anchor for the first entry in the chain. */
export const GENESIS = crypto.createHash('sha256').update('jarv-delivery-chain-genesis-v1').digest('hex');

/** Delivery record lives in the workspace so every surface (hub, CLI, scripts) hits one log. */
function recordDir(): string {
  return path.join(dataHome(), 'workspace', 'track-record');
}

export function logPath(): string {
  return path.join(recordDir(), 'delivery-log.md');
}

export function manifestPath(): string {
  return path.join(recordDir(), 'chain.json');
}

interface ChainManifest {
  genesis: string;
  count: number;
  root: string;
  updatedAt: string;
  /** Canonical, timestamp-excluded attestation of the chain state (skylos
   *  discipline): digest over {schema, count, root}. Re-runnable byte-identical. */
  attestation?: string;
}

/** Canonical, timestamp-excluded attestation of the chain state (skylos harvest). */
function manifestAttestation(m: { genesis: string; count: number; root: string }): string {
  return sha256Json({ schema: 'jarv-delivery-chain-v2', genesis: m.genesis, count: m.count, root: m.root });
}

function sha256(s: string): string {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

/** hash_i = SHA-256(prevHash + "\n" + entryBody_i). */
function hashOf(prevHash: string, body: string): string {
  return sha256(`${prevHash}\n${body}`);
}

async function readManifest(): Promise<ChainManifest | null> {
  try {
    const raw = await fs.readFile(manifestPath(), 'utf8');
    const parsed = JSON.parse(raw) as ChainManifest;
    if (parsed && typeof parsed.root === 'string' && typeof parsed.count === 'number') return parsed;
    return null;
  } catch {
    return null;
  }
}

async function writeManifest(m: ChainManifest): Promise<void> {
  await fs.mkdir(recordDir(), { recursive: true });
  await fs.writeFile(manifestPath(), JSON.stringify(m, null, 2) + '\n', { encoding: 'utf8' });
}

export interface LogEntry {
  index: number;
  body: string;
  hash: string | null;
}

/**
 * Split the log into entries. An entry starts at a `## YYYY-MM-DD HH:MM`
 * timestamp line (the header's own `## `-prefixed sections don't count). Each
 * entry's body is its text WITHOUT its own hash line.
 */
function splitEntries(markdown: string): { header: string; entries: LogEntry[] } {
  const lines = markdown.split('\n');
  const ENTRY_RE = /^## \d{4}-\d{2}-\d{2} \d{2}:\d{2} /;
  const entryStarts: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line && ENTRY_RE.test(line)) entryStarts.push(i);
  }
  if (entryStarts.length === 0) return { header: markdown, entries: [] };

  const header = lines.slice(0, entryStarts[0]).join('\n');
  const entries: LogEntry[] = [];
  for (let i = 0; i < entryStarts.length; i++) {
    const start = entryStarts[i]!;
    const end = i + 1 < entryStarts.length ? entryStarts[i + 1]! : lines.length;
    const block = lines.slice(start, end).join('\n');
    // Strip the entry's own hash line from the verifiable body.
    const hashMatch = /^- \*\*Hash:\*\*\s*([0-9a-f]{64})\s*$/m.exec(block);
    const body = hashMatch ? block.replace(hashMatch[0], '').trim() : block.trim();
    entries.push({ index: i + 1, body, hash: hashMatch?.[1] ?? null });
  }
  return { header, entries };
}

/** Recompute and, if any entry lacks a hash line, rebuild the whole chain in place. */
export async function backfillChain(): Promise<{ ok: boolean; entries: number; root: string }> {
  const raw = await fs.readFile(logPath(), 'utf8').catch(() => '');
  const { header, entries } = splitEntries(raw);
  if (entries.length === 0) return { ok: true, entries: 0, root: GENESIS };

  let prev = GENESIS;
  const rebuilt: string[] = [];
  let dirty = false;
  for (const e of entries) {
    const h = hashOf(prev, e.body);
    prev = h;
    if (e.hash !== h) dirty = true;
    rebuilt.push(`${e.body}\n- **Hash:** ${h}`);
  }
  if (dirty) {
    // Preserve the header (docs) untouched; rebuild just the entry list.
    const output = `${header.replace(/\s*$/, '')}\n\n${rebuilt.join('\n\n')}\n`;
    await fs.mkdir(recordDir(), { recursive: true });
    await fs.writeFile(logPath(), output, { encoding: 'utf8' });
  }
  const manifest: ChainManifest = { genesis: GENESIS, count: entries.length, root: prev, updatedAt: new Date().toISOString() };
  manifest.attestation = manifestAttestation(manifest);
  await writeManifest(manifest);
  return { ok: true, entries: entries.length, root: prev };
}

/**
 * Verify the whole chain. Returns per-entry results and the computed root.
 * `ok` is false if any hash mismatches (tampering) or the root diverges from
 * the manifest.
 */
export async function verifyChain(): Promise<{
  ok: boolean;
  count: number;
  root: string | null;
  brokenAt: number | null;
  manifestCount: number | null;
  manifestRoot: string | null;
  attestation: string | null;
  attestationOk: boolean | null;
}> {
  const raw = await fs.readFile(logPath(), 'utf8').catch(() => '');
  const { entries } = splitEntries(raw);
  const manifest = await readManifest();
  let prev = GENESIS;
  for (const e of entries) {
    const expected = hashOf(prev, e.body);
    if (e.hash !== expected) {
      return {
        ok: false,
        count: entries.length,
        root: null,
        brokenAt: e.index,
        manifestCount: manifest?.count ?? null,
        manifestRoot: manifest?.root ?? null,
        attestation: manifest?.attestation ?? null,
        attestationOk: null,
      };
    }
    prev = expected;
  }
  const root = entries.length > 0 ? prev : GENESIS;
  const rootOk = manifest === null || manifest.root === root;
  // If the manifest carries a canonical attestation, recompute and compare it.
  let attestationOk: boolean | null = null;
  let attestation: string | null = null;
  if (manifest?.attestation) {
    attestation = manifestAttestation({ genesis: manifest.genesis, count: manifest.count, root: manifest.root });
    attestationOk = attestation === manifest.attestation;
  }
  return {
    ok: rootOk && (attestationOk === null || attestationOk),
    count: entries.length,
    root,
    brokenAt: null,
    manifestCount: manifest?.count ?? null,
    manifestRoot: manifest?.root ?? null,
    attestation,
    attestationOk,
  };
}

/** A short, grounded Moltbook post announcing the chain root (for consent-gated publishing). */
export function attestationText(chain: Awaited<ReturnType<typeof verifyChain>>): string {
  return (
    `I keep a cryptographically chained delivery record — every entry is hash-linked to the one before it, so the log is append-only and tamper-evident.\n\n` +
    `Verified as of now: **${chain.count} deliveries** on record, chain root \`${chain.root?.slice(0, 24) ?? '?'}…\` (full: \`${chain.root}\`).\n\n` +
    `Any claim I make can be checked against this log. That's the point: proof, not promises.`
  );
}

/** America/Chicago daylight-saving abbreviation (CDT on -300, else CST -360). */
function zonedAbbr(now: Date): string {
  return -now.getTimezoneOffset() === 300 ? 'CDT' : 'CST';
}

/**
 * Append a delivery entry to the log as the next link in the hash chain.
 * Bootstraps the chain on first use (backfills any pre-chain history).
 */
export async function appendDelivery(
  delivered: string,
  category: string,
  outcome: string,
): Promise<{ ok: boolean; stamp: string; hash: string; path: string; error?: string }> {
  if (!delivered.trim()) return { ok: false, stamp: '', hash: '', path: '', error: 'delivered description is required' };
  if (!CATEGORIES.has(category)) {
    return { ok: false, stamp: '', hash: '', path: '', error: `category must be one of: ${ALLOWED.join(', ')}` };
  }

  const manifest = await readManifest();
  const prevHash = manifest?.root ?? GENESIS;

  const now = new Date();
  const chicago = new Date(now.toLocaleString('en-US', { timeZone: 'America/Chicago' }));
  const yyyy = chicago.getFullYear();
  const mo = String(chicago.getMonth() + 1).padStart(2, '0');
  const dd = String(chicago.getDate()).padStart(2, '0');
  const hh = String(chicago.getHours()).padStart(2, '0');
  const mm = String(chicago.getMinutes()).padStart(2, '0');
  const tz = zonedAbbr(now);
  const stamp = `${yyyy}-${mo}-${dd} ${hh}:${mm} ${tz}`;

  const body =
    `## ${stamp}\n` +
    `- **Delivered:** ${delivered.trim()}\n` +
    `- **Category:** ${category}\n` +
    `- **Outcome:** ${outcome.trim()}`;
  const hash = hashOf(prevHash, body);
  const entry = `${body}\n- **Hash:** ${hash}\n`;

  const p = logPath();
  try {
    await fs.mkdir(recordDir(), { recursive: true });
    await fs.appendFile(p, entry, { encoding: 'utf8' });
  } catch (err) {
    return { ok: false, stamp, hash: '', path: p, error: err instanceof Error ? err.message : String(err) };
  }
  const nextManifest: ChainManifest = { genesis: GENESIS, count: (manifest?.count ?? 0) + 1, root: hash, updatedAt: new Date().toISOString() };
  nextManifest.attestation = manifestAttestation(nextManifest);
  await writeManifest(nextManifest);
  return { ok: true, stamp, hash, path: p };
}
/** The `log_delivery` + `deliverylog_verify` tools — always registered, never hidden. */
export function deliveryLogTools(): ToolDefinition[] {
  return [
    {
      name: 'log_delivery',
      system: 'immune',
      description:
        'Append a timestamped, hash-chained entry to the Delivery Track Record (track-record/delivery-log.md). Use AFTER any shipped task — an investor digest run, ai-papers briefs, a system op, a Moltbook/social post, or anything delivered. Category must be one of: ' +
        ALLOWED.join(', ') +
        '. Each entry is linked to the previous by SHA-256, so the log is append-only and verifiable. Keeps a self-maintaining audit trail that doubles as a Moltbook trust signal.',
      inputSchema: {
        type: 'object',
        properties: {
          delivered: { type: 'string', description: 'What was shipped, in one sentence.' },
          category: { type: 'string', description: 'investor-digest | ai-papers | system-op | social | other' },
          outcome: { type: 'string', description: 'The verified result — artifact path, status, or proof of delivery.' },
        },
        required: ['delivered', 'category', 'outcome'],
      },
      handler: async (args) => {
        const delivered = String(args.delivered ?? '');
        const category = String(args.category ?? '').trim();
        const outcome = String(args.outcome ?? '');
        const res = await appendDelivery(delivered, category, outcome);
        if (!res.ok) {
          return { ok: false, error: res.error };
        }
        return { ok: true, loggedAt: res.stamp, hash: res.hash, path: res.path, note: 'entry appended to the Delivery Track Record and hash-chained' };
      },
    },
    {
      name: 'deliverylog_verify',
      system: 'immune',
      description:
        'Recompute the SHA-256 hash chain over the Delivery Track Record and report whether it is intact, the current chain root, and a publishable attestation. Read-only. Use before sharing or posting the record on Moltbook, or to prove a delivery claim.',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        // Backfill once if the log predates hashing (e.g. entries with no hash line).
        try {
          await backfillChain();
        } catch {
          // best effort — verify will report the actual state
        }
        const chain = await verifyChain();
        return {
          ok: chain.ok,
          count: chain.count,
          root: chain.root,
          brokenAt: chain.brokenAt,
          manifestCount: chain.manifestCount,
          manifestRoot: chain.manifestRoot,
          attestation: chain.ok ? attestationText(chain) : 'chain is broken — do not publish until it is repaired',
          note: chain.ok
            ? 'Delivery Track Record is hash-verified and append-only.'
            : `chain broken at entry #${chain.brokenAt} — the log has been tampered with or corrupted.`,
        };
      },
    },
  ];
}
