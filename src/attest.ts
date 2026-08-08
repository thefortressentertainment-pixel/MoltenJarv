import crypto from 'node:crypto';

/**
 * Canonical attestation (skylos harvest — `defend/attestation.py`, Apache-2.0).
 *
 * A reproducible, byte-identical SHA-256 digest over a set of stable inputs, so
 * an auditor/reviewer can re-run on the same inputs and confirm the digest
 * matches. The discipline from skylos:
 *
 *   - `_sha256_json` hashes canonical JSON: sorted object keys, compact
 *     separators, stable string conversion — identical inputs ⇒ identical bytes.
 *   - The digest-input is ORDER-INDEPENDENT and VALUE-STABLE (objects, arrays,
 *     and scalars are canonicalized/sorted), so the digest is reproducible on
 *     any machine — the timestamp is EXCLUDED from the digest input.
 *
 * This hardens Jarv's Delivery Track Record: instead of only hashing concatenated
 * state, we bind the changelog's canonical entries + version + file hashes + gate
 * metadata into a verifiable attestation digest a reviewer recomputes and
 * compares. No model involvement; deterministic and local.
 */

/** Canonical SHA-256 of a JSON value (sorted keys, compact separators, stable str). */
export function sha256Json(value: unknown): string {
  return crypto.createHash('sha256').update(canonicalString(value), 'utf8').digest('hex');
}

/** Deterministic string form: objects with SORTED keys, arrays sorted, numbers stable. */
function canonicalString(v: unknown): string {
  if (Array.isArray(v)) {
    return '[' + v.map(canonicalString).sort().join(',') + ']';
  }
  if (v !== null && typeof v === 'object') {
    const sortedKeys = Object.keys(v as Record<string, unknown>).sort();
    const parts: string[] = [];
    for (const k of sortedKeys) {
      const val = (v as Record<string, unknown>)[k];
      if (val === undefined) continue;
      parts.push(JSON.stringify(k) + ':' + canonicalString(val));
    }
    return '{' + parts.join(',') + '}';
  }
  const stable = normalizeScalar(v);
  return typeof stable === 'string' ? JSON.stringify(stable) : String(stable);
}

/** Scalar stabilization: non-finite numbers → null; drop undefined. */
function normalizeScalar(v: unknown): unknown {
  if (v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  return v;
}

/** Canonical, timestamp-excluded inputs document for an attestation. */
export interface AttestationInputs {
  schema: string;
  version: string;
  /** Sorted RELATIVE POSIX paths → sha256 of each file's content (bounded). */
  files?: Record<string, string>;
  /** Freeform stable metadata (gates engaged, tool set, judge verdict, results) — canonicalized. */
  metadata?: unknown;
}

/** Build the stable, canonical inputs object (no timestamp). */
function stableInputs(inputs: AttestationInputs): { schema: string; version: string; files: Record<string, string>; metadata: unknown } {
  return { schema: inputs.schema, version: inputs.version, files: inputs.files ?? {}, metadata: inputs.metadata ?? null };
}

/** Compute a canonical attestation over the given inputs, timestamp-excluded.
 *  Re-runnable on the same inputs ⇒ identical `digest`. `generatedAt` is surfaced
 *  but NOT hashed (skylos discipline). */
export function attest(inputs: AttestationInputs): { digest: string; generatedAt: string } {
  return {
    digest: sha256Json(stableInputs(inputs)),
    generatedAt: new Date().toISOString(),
  };
}
