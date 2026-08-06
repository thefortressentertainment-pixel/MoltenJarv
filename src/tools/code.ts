import fs from 'node:fs';
import path from 'node:path';
import type { ToolDefinition } from '../agent/types.js';

/**
 * Code tools: the primitives that let Jarv work on code the way an editor does —
 * search a codebase like VSCodium's find-in-files, and make one precise, verified
 * edit at a time. Together with run_shell (tests) and self_review, this is the
 * "function like VSCodium" capability.
 */

const IGNORED = new Set([
  'node_modules',
  '.git',
  'dist',
  '.next',
  'coverage',
  '.cache',
  'target',
  'build',
  'out',
  'bin',
  'obj',
  'vendor',
  'Pods',
  'DerivedData',
  '.terraform',
  'tmp',
]);

const REPO_ROOT = '/Users/tfe/jarv-genie';

/** Absolute paths as-is; relative paths resolve against the repo root. */
function resolvePath(p: string): string {
  return path.isAbsolute(p) ? path.resolve(p) : path.resolve(REPO_ROOT, p);
}

/** Treat a file as binary if it contains a null byte in its head — skip those. */
function isBinary(buf: Buffer): boolean {
  const head = buf.subarray(0, 8000);
  return head.includes(0);
}

function walk(dir: string, depth: number, out: string[]): void {
  if (depth > 12) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!IGNORED.has(e.name)) walk(full, depth + 1, out);
    } else {
      out.push(full);
    }
  }
}

export function codeTools(): ToolDefinition[] {
  return [
    {
      name: 'code_search',
      system: 'sense',
      description:
        'Search a codebase for a text or regex pattern, returning file:line matches. Skips node_modules, .git, dist, build/target dirs, and binary files. Use to find where things are defined or referenced before editing.',
      inputSchema: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Text or regex to find.' },
          dir: { type: 'string', description: 'Directory to search (default: /Users/tfe/jarv-genie).' },
          maxResults: { type: 'number', description: 'Max matches to return (default 30).' },
        },
        required: ['pattern'],
      },
      handler: async (args) => {
        const raw = String(args.pattern ?? '');
        if (!raw) return { ok: false, error: 'code_search requires a pattern' };
        let re: RegExp;
        try {
          re = new RegExp(raw, 'i');
        } catch {
          return { ok: false, error: `invalid regex: ${raw}` };
        }
        const dir = args.dir ? resolvePath(String(args.dir)) : REPO_ROOT;
        const maxResults = Math.max(1, Math.min(200, Math.trunc(Number(args.maxResults ?? 30) || 30)));
        const files: string[] = [];
        walk(dir, 0, files);
        const matches: Array<{ file: string; line: number; text: string }> = [];
        for (const f of files) {
          if (matches.length >= maxResults) break;
          let buf: Buffer;
          try {
            const stat = fs.statSync(f);
            if (stat.size > 2 * 1024 * 1024) continue;
            buf = fs.readFileSync(f);
            if (isBinary(buf)) continue;
          } catch {
            continue;
          }
          const text = buf.toString('utf8');
          const lines = text.split('\n');
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i] ?? '';
            if (re.test(line) && line.trim()) {
              matches.push({ file: f, line: i + 1, text: line.trim().slice(0, 160) });
              if (matches.length >= maxResults) break;
            }
          }
        }
        return { ok: true, count: matches.length, matches };
      },
    },
    {
      name: 'code_edit',
      system: 'effector',
      description:
        'Make ONE precise, verified edit to a file: find an exact string and replace it. The string must appear exactly once, otherwise it refuses (no guesswork, no accidental multi-edit). Path may be absolute or relative to the repo (/Users/tfe/jarv-genie). Returns the affected line before/after. Use for small surgical changes; run self_review after to verify.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path to the file (absolute or relative to /Users/tfe/jarv-genie).' },
          find: { type: 'string', description: 'Exact text to find (must appear exactly once).' },
          replace: { type: 'string', description: 'Replacement text.' },
        },
        required: ['path', 'find', 'replace'],
      },
      consequential: true,
      handler: async (args) => {
        const file = resolvePath(String(args.path ?? '').trim());
        const find = String(args.find ?? '');
        const replace = String(args.replace ?? '');
        if (!file || !find) return { ok: false, error: 'code_edit requires path and find' };
        let content: string;
        try {
          content = fs.readFileSync(file, 'utf8');
        } catch (err) {
          return { ok: false, error: `cannot read ${file}: ${err instanceof Error ? err.message : String(err)}` };
        }
        const first = content.indexOf(find);
        if (first === -1) return { ok: false, error: `"${find.slice(0, 60)}" not found in ${file}` };
        const second = content.indexOf(find, first + 1);
        if (second !== -1) return { ok: false, error: `"${find.slice(0, 60)}" appears more than once in ${file} — narrow the find text` };
        const line = content.slice(0, first).split('\n').length;
        const lineStart = content.lastIndexOf('\n', first) + 1;
        const lineEnd = content.indexOf('\n', first);
        const before = content.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);
        const next = content.slice(0, first) + replace + content.slice(first + find.length);
        const afterLineStart = content.slice(0, first).split('\n').slice(0, -1).join('\n');
        const afterLine = next.slice(afterLineStart.length ? afterLineStart.length + 1 : 0).split('\n')[0] ?? '';
        try {
          fs.writeFileSync(file, next);
        } catch (err) {
          return { ok: false, error: `cannot write ${file}: ${err instanceof Error ? err.message : String(err)}` };
        }
        return { ok: true, file, line, before: before.slice(0, 200), after: afterLine.slice(0, 200) };
      },
    },
  ];
}
