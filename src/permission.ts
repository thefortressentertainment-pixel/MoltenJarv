import path from 'node:path';
import type { PermissionRule } from './config/index.js';
import type { ToolCall } from './agent/types.js';

/**
 * Configurable reflex rules, modeled on grok-build's deny-by-default permission
 * engine (`config-types/permission.rs`, Apache-2.0). These run AFTER the
 * non-overridable security invariants in `reflexes.ts` (credential/secret
 * protection). Rules are evaluated in order; the first that matches wins.
 *
 * An unset `action` or a rule that doesn't match never flips the default —
 * that is the deny-by-default guarantee.
 */

export type RuleDecision = { action: 'allow' | 'deny' | 'fast' } | null;

/**
 * Shell metacontrol operators that disqualify a command from auto-approval.
 * Modeled on openworker's shell gate (`permissions.py:21-25`): allow-listing
 * `git status` must never auto-run as the head of `git status && rm -rf ~`.
 * Any command containing these must NOT be auto-approved — it goes to consent.
 */
const SHELL_OPERATOR_RE = /[;&|><`"']|\$\{|\b(?:&&|\|\|)\b|\b(?:rm|sudo|shutdown|reboot|halt|mkfs|dd)\b|\r?\n/;

function hasShellOperator(command: string): boolean {
  return SHELL_OPERATOR_RE.test(command);
}

/** Tokenize a command like a POSIX shell does for prefix comparison: split on
 *  runs of whitespace, stripping balancing quotes. `git status` matches
 *  `git status -s` but never `git statusfoo`. */
export function tokenizeCommand(command: string): string[] {
  return command
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0)
    .map((t) => t.replace(/^(['"])(.*)\1$/, '$2'));
}

/** True when `pattern`'s tokens are a prefix of the (tokenized) command. This is
 *  the safe, token-conscious form of command auto-approval matching. */
export function tokenizedPrefixMatch(pattern: string, command: string): boolean {
  const pat = tokenizeCommand(pattern);
  const cmd = tokenizeCommand(command);
  if (pat.length === 0) return false;
  if (cmd.length < pat.length) return false;
  for (let i = 0; i < pat.length; i++) {
    if (pat[i] !== cmd[i]) return false;
  }
  return true;
}

/** Match a `tool` selector (exact name, `*`, or glob) against a tool name. */
function toolMatches(selector: string, name: string): boolean {
  if (selector === '*' || selector === name) return true;
  if (selector.includes('*')) {
    const escaped = selector.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*');
    return new RegExp(`^${escaped}$`).test(name);
  }
  return false;
}

/** Candidate strings to match a rule `pattern` against: path-like args, plus
 *  the serialized full argument map so shell commands and free-text match. */
function argStrings(call: ToolCall): string[] {
  const a = call.arguments ?? {};
  const strings: string[] = [];
  for (const value of Object.values(a)) {
    if (typeof value === 'string' && value.trim().length > 0) strings.push(value);
  }
  if (strings.length === 0 || call.arguments) {
    try {
      strings.push(JSON.stringify(a));
    } catch {
      /* ignore */
    }
  }
  return strings;
}

function patternMatches(pattern: string, mode: string | undefined, call: ToolCall): boolean {
  if (mode === 'regex') {
    let re: RegExp;
    try {
      re = new RegExp(pattern);
    } catch {
      return false; // malformed regex never blocks — fail-open
    }
    for (const s of argStrings(call)) if (re.test(s)) return true;
    return false;
  }
  // glob mode (default): match against path args and the serialized map.
  const globRe = new RegExp(
    `^` + pattern.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + `$`,
    'i',
  );
  for (const s of argStrings(call)) if (globRe.test(s)) return true;
  return false;
}

/** Evaluate user permission rules (in order, first match wins). Pass an empty
 *  rules array (the default) to get `null` → fall through to built-ins. */
export function evaluatePermissions(call: ToolCall, rules: PermissionRule[] = []): RuleDecision {
  for (const rule of rules) {
    const tool = typeof rule.tool === 'string' ? rule.tool : '';
    if (!tool || !toolMatches(tool, call.name)) continue;

    // Shell rules match commands with tokenized-PREFIX semantics (openworker):
    // `git status` matches `git status -s` but never `git statusfoo`, and a
    // pattern-less shell rule auto-approves only operator-free commands.
    const isShell = call.name === 'run_shell';
    const command = String((call.arguments ?? {}).command ?? '').trim();
    if (rule.pattern) {
      if (isShell && rule.pattern_mode !== 'regex') {
        if (!command || !tokenizedPrefixMatch(rule.pattern, command)) continue;
      } else if (!patternMatches(rule.pattern, rule.pattern_mode, call)) {
        continue;
      }
    }

    // First rule that selects this tool (+ optional pattern) wins.
    let decision: RuleDecision;
    switch (rule.action) {
      case 'deny':
        decision = { action: 'deny' as const };
        break;
      case 'fast':
        decision = { action: 'fast' as const };
        break;
      case 'allow':
      default:
        decision = { action: 'allow' as const };
    }
    // Shell safety gate: an auto-approval/fast-path rule must never fire on a
    // command that chains operators or uses a destructive verb — that would let
    // `git status && rm -rf ~` sneak past an allow-rule for `git`.
    if (isShell && (decision.action === 'allow' || decision.action === 'fast')) {
      if (!command || hasShellOperator(command)) continue;
    }
    return decision;
  }
  return null;
}

/** Detect a credential/secret file path — a non-overridable invariant. */
function isSensitivePath(p: string): boolean {
  const SENSITIVE_NAMES = new Set(['secrets.json', 'auth.json', 'link.json']);
  return SENSITIVE_NAMES.has(path.basename(p));
}

/** Detect shell commands / args that reference secrets — non-overridable. */
function mentionsSecrets(args: Record<string, unknown> | undefined): boolean {
  if (!args) return false;
  const hay = JSON.stringify(args);
  return /(secrets\.json|auth\.json|link\.json|api[_-]?key|token|password|secret)/i.test(hay);
}

export interface SecurityGateResult {
  blocked: boolean;
  reason?: string;
}

/**
 * Non-overridable immune invariants. Runs first, before any user rule. These
 * protect credentials/auth state and can never be disabled by config.
 */
export function securityInvariant(call: ToolCall): SecurityGateResult {
  const name = call.name;
  const a = call.arguments ?? {};

  if (name.startsWith('file_') || name === 'run_shell' || name === 'open_file' || name === 'reveal_in_finder') {
    const p = String(a.path ?? a.from ?? '');
    if (p && isSensitivePath(p)) {
      return { blocked: true, reason: `reflex: refusing to touch credential file "${path.basename(p)}"` };
    }
    if (name === 'run_shell' && mentionsSecrets(a)) {
      return { blocked: true, reason: 'reflex: refusing a shell command that references secrets, keys, or auth state' };
    }
  }
  if (name === 'code_edit') {
    const p = String(a.path ?? '');
    if (p && isSensitivePath(p)) {
      return { blocked: true, reason: `reflex: refusing to edit credential file "${path.basename(p)}"` };
    }
  }
  return { blocked: false };
}
