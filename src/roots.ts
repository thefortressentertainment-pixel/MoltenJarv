import path from 'node:path';

/**
 * Writable-roots sandbox, adapted from andrewyng/openworker's `coworker/roots.py`
 * (MIT). The agent works inside a shared set of directory roots, each with a
 * `writable` flag. Writes must resolve to a writable root; reads may target any
 * listed root. The same list is used by the file tools (enforcement) and injected
 * into the system prompt (so the model knows the boundary), matching openworker's
 * "enforce AND communicate" approach.
 */

export interface RootDir {
  /** Absolute, resolved path. */
  path: string;
  /** Whether the agent may write inside this root. */
  writable: boolean;
  /** Short label for prompt display, e.g. "workspace". */
  label: string;
}

export interface RootsConfig {
  /** The primary writable workspace. */
  workdir: string;
  /** Additional read-only roots the agent may read from. */
  readRoots?: string[];
  /** Whether to enforce the sandbox on file tools (default true). */
  enabled?: boolean;
}

export interface Roots {
  roots: RootDir[];
}

export function buildRoots(cfg: RootsConfig): Roots {
  const list: RootDir[] = [];
  const workdir = path.resolve(cfg.workdir);
  list.push({ path: workdir, writable: true, label: 'workspace' });
  for (const r of cfg.readRoots ?? []) {
    const abs = path.resolve(r);
    // A read root that duplicates/contains the workdir is redundant.
    if (!list.some((root) => root.path === abs)) list.push({ path: abs, writable: false, label: 'read-only' });
  }
  return { roots: list };
}

/** True when a request path stays inside some listed root. Canonicalizes and
 *  resolves to protect against `..` escapes. */
export function underAnyRoot(roots: Roots, request: string): boolean {
  const target = path.resolve(request);
  return roots.roots.some((root) => {
    const base = root.path;
    return target === base || target.startsWith(base + path.sep);
  });
}

/** True when a request path resolves specifically under a WRITABLE root. */
export function underWritableRoot(roots: Roots, request: string): boolean {
  const target = path.resolve(request);
  return roots.roots.some((root) => {
    if (!root.writable) return false;
    const base = root.path;
    return target === base || target.startsWith(base + path.sep);
  });
}

/** Render the boundary for system-prompt injection (openworker `render_context`). */
export function renderRootsBoundary(roots: Roots): string {
  if (roots.roots.length === 0) return '';
  const lines = ['You may use file and shell tools within these directories:'];
  for (const r of roots.roots) {
    lines.push(`- ${r.path} ${r.writable ? '(writable)' : '(read-only)'} — ${r.label}`);
  }
  lines.push('Writes are only allowed inside writable directories. Do not attempt to read or write outside these roots.');
  return lines.join('\n');
}

/** Build the `ToolContext.roots` handle (enforcement closures) from a config. */
export function makeRootsHandle(cfg: RootsConfig): ToolContextRoots {
  const roots = buildRoots(cfg);
  return {
    underAnyRoot: (request: string) => underAnyRoot(roots, request),
    underWritableRoot: (request: string) => underWritableRoot(roots, request),
    renderBoundary: () => renderRootsBoundary(roots),
  };
}

export interface ToolContextRoots {
  underAnyRoot(request: string): boolean;
  underWritableRoot(request: string): boolean;
  renderBoundary(): string;
}
