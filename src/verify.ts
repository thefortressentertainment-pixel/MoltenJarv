import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Deterministic 3-state AI-code verification (skylos harvest — `skylos verify`,
 * `core/verify_change_schema.py`, Apache-2.0).
 *
 * The idea lifted from skylos: verify AI-edited code *deterministically*, with
 * NO execution, NO package managers, NO LLM judge in the loop. Return one of:
 *
 *   pass       — no verified finding AND every applicable check completed.
 *   fail       — at least one verified finding (takes precedence over coverage).
 *   incomplete — no finding, but one or more required proofs were not achievable
 *                statically (parser gap, unresolvable third-party import,
 *                computed member). "incomplete" is a distinct NON-pass: a
 *                would-be clean verdict is degraded rather than a false pass.
 *
 * The core check is **phantom references** (skylos SKY-L012): resolve a file's
 * `import {x} from './local'` and `fileRef.x` usages against a locally built
 * symbol surface (declared/exported members) of the referenced local module.
 * We only emit a finding when the surface is COMPLETE; an unresolvable/
 * third-party/unsupported reference makes the check `incomplete`.
 *
 * This is the deterministic spine to which Jarv's existing LLM judge, self_review,
 * and Delivery Track Record attach.
 */

export type VerifyStatus = 'pass' | 'fail' | 'incomplete';

export interface VerifyFinding {
  ruleId: string;
  category: string;
  file: string;
  line: number | null;
  message: string;
  suggestedFix?: string;
  confidence: 'high' | 'medium' | 'low';
}

export interface CoverageEntry {
  check: string;
  support: 'supported' | 'unsupported';
  status: 'complete' | 'incomplete';
  reason?: string;
}

export interface VerifyResult {
  schema_version: 2;
  tool: 'verify_change';
  status: VerifyStatus;
  target: { path: string };
  findings: VerifyFinding[];
  coverage: CoverageEntry[];
  summary: string;
}

const EXPORT_RE = /^\s*export\s+(?:async\s+)?(?:function|const|let|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm;
// `import { a } from 'x'` | `import Def from 'x'` | `import Def, { a } from 'x'` | `import 'x'`
const IMPORT_RE =
  /^\s*import\s+(?:([A-Za-z_$][\w$]*)\s*(?:,\s*)?)?(?:\{\s*([^}]*)\s*}\s*from\s*['"]([^'"]+)['"]|from\s*['"]([^'"]+)['"]|['"]([^'"]+)['"])/gm;

/** Extract exported/declared symbol names from a module's source text. */
export function collectExports(source: string): string[] {
  const out = new Set<string>();
  let m: RegExpExecArray | null;
  EXPORT_RE.lastIndex = 0;
  while ((m = EXPORT_RE.exec(source)) !== null) {
    if (m[1]) out.add(m[1]);
  }
  // Also collect `export { a, b as c }` named exports (the EXPORT name is used).
  const named = source.match(/^\s*export\s*\{([^}]*)\}/gm) ?? [];
  for (const block of named) {
    for (const part of block.replace(/^\s*export\s*\{/, '').replace(/\}$/, '').split(',')) {
      const pieces = part.trim().split(/\s+as\s+/);
      const name = (pieces[1] ?? pieces[0])?.replace(/\s+/g, '');
      if (name && name.length > 0) out.add(name);
    }
  }
  return [...out];
}

export interface ResolvedImport {
  specifier: string;
  /** SOURCE names (before `as`): must be exported by the referenced module. */
  names: string[];
  /** LOCAL binding names (after `as`) — what this file references. */
  localNames: string[];
  absolute: boolean;
  localPath?: string;
}

/** For `a, b as bee` → source names `['a','b']`, local bindings `['a','bee']`. */
export function importNames(named: string): { names: string[]; localNames: string[] } {
  const names: string[] = [];
  const localNames: string[] = [];
  for (const part of named.split(',')) {
    const clean = part.trim().replace(/\s+/g, ' ');
    if (!clean) continue;
    const pieces = clean.split(/\s+as\s+/);
    const source = pieces[0]?.trim();
    const local = (pieces[1] ?? pieces[0])?.trim();
    if (source) names.push(source);
    if (local) localNames.push(local);
  }
  return { names, localNames };
}

/** Parse `import { a, b as bee } from './x'` (and side-effect `import './x'`) into pieces. */
export function parseImports(source: string): ResolvedImport[] {
  const out: ResolvedImport[] = [];
  let m: RegExpExecArray | null;
  IMPORT_RE.lastIndex = 0;
  while ((m = IMPORT_RE.exec(source)) !== null) {
    const defName = (m[1] ?? '').trim();
    const named = (m[2] ?? '').trim();
    const specifier = (m[3] ?? m[4] ?? m[5] ?? '').trim();
    if (!specifier) continue;
    const { names, localNames } = importNames(named);
    if (defName) localNames.push(defName); // default binding is a local reference
    const absolute = !specifier.startsWith('.');
    out.push({ specifier, names, localNames, absolute, localPath: absolute ? undefined : specifier });
  }
  return out;
}

/** First existing path for a specifier resolved against the importing file.
 *  Tries the literal path then common TS/JS extensions and index files. */
export async function resolveLocal(file: string, specifier: string): Promise<string> {
  const dir = path.dirname(file);
  const base = path.resolve(dir, specifier);
  const candidates = [base, `${base}.ts`, `${base}.js`, `${base}.tsx`, `${base}.jsx`, path.join(base, 'index.ts'), path.join(base, 'index.js')];
  for (const candidate of candidates) {
    const st = await fs.stat(candidate).catch(() => null);
    if (st?.isFile()) return candidate;
  }
  return candidates[0]!;
}

/** Read a local file, or return null (covers missing/unreadable). */
export async function readIfExists(file: string): Promise<string | null> {
  try {
    const st = await fs.stat(file);
    if (!st.isFile()) return null;
    if (st.size > 1_000_000) return null;
    return await fs.readFile(file, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Verify one edited file's local imports for phantom references.
 * Deterministic, no execution. Returns findings + per-check coverage.
 */
export async function verifyFile(file: string, source: string): Promise<{ findings: VerifyFinding[]; coverage: CoverageEntry[] }> {
  const findings: VerifyFinding[] = [];
  const coverage: CoverageEntry[] = [];
  const imports = parseImports(source);

  for (const imp of imports) {
    // Deterministic proof only covers local relative modules.
    if (imp.absolute) {
      coverage.push({ check: `import:${imp.specifier}`, support: 'unsupported', status: 'incomplete', reason: 'third-party/absolute import — cannot prove locally without deps' });
      continue;
    }
    const localPath = await resolveLocal(file, imp.specifier);
    const depSource = await readIfExists(localPath);
    if (depSource === null) {
      coverage.push({ check: `import:${imp.specifier}`, support: 'supported', status: 'incomplete', reason: 'referenced local module not resolvable/readable' });
      continue;
    }
    const surface = new Set(collectExports(depSource));
    const missing = imp.names.filter((n) => !surface.has(n));
    if (missing.length > 0) {
      findings.push({
        ruleId: 'JV-V001',
        category: 'phantom_reference',
        file,
        line: null,
        message: `import(s) {${missing.join(', ')}} from '${imp.specifier}' are not exported by the referenced local module`,
        suggestedFix: `check the exports of ${path.basename(localPath)} and import exported names only, or fix a stale/renamed reference`,
        confidence: 'high',
      });
    }
    coverage.push({ check: `import:${imp.specifier}`, support: 'supported', status: 'complete' });
  }

  if (imports.length === 0) {
    coverage.push({ check: 'imports', support: 'supported', status: 'complete', reason: 'no local imports to verify' });
  }
  return { findings, coverage };
}

/** Roll the findings + coverage into a versioned 3-state verdict. */
export function verdict(file: string, source: string, res: Awaited<ReturnType<typeof verifyFile>>): VerifyResult {
  const findings = res.findings;
  const coverage = res.coverage;
  let status: VerifyStatus;
  if (findings.length > 0) {
    status = 'fail'; // findings take precedence
  } else if (coverage.some((c) => c.status === 'incomplete')) {
    status = 'incomplete'; // no finding, but proof incomplete → not a clean pass
  } else {
    status = 'pass';
  }
  const summary =
    status === 'pass'
      ? `Verified ${path.basename(file)}: imports resolve against local modules, no phantom references.`
      : status === 'fail'
        ? `Verified ${path.basename(file)}: ${findings.length} verified finding(s) — do not ship as-is.`
        : `Verified ${path.basename(file)}: no finding, but coverage INCOMPLETE — not a clean pass (cannot prove locally).`;
  return {
    schema_version: 2,
    tool: 'verify_change',
    status,
    target: { path: file },
    findings,
    coverage,
    summary,
  };
}

/** One-shot convenience: read a file, verify it, and roll the verdict. */
export async function verifyFileOnDisk(file: string): Promise<VerifyResult> {
  const source = await readIfExists(file);
  if (source === null) {
    return {
      schema_version: 2,
      tool: 'verify_change',
      status: 'incomplete',
      target: { path: file },
      findings: [],
      coverage: [{ check: 'read', support: 'supported', status: 'incomplete', reason: 'file not readable' }],
      summary: `Cannot verify ${path.basename(file)}: file not readable.`,
    };
  }
  return verdict(file, source, await verifyFile(file, source));
}
