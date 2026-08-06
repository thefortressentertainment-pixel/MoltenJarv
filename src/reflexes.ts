import path from 'node:path';
import type { ToolCall } from './agent/types.js';

/**
 * The spinal cord — Jarv's reflex layer.
 *
 * In the body plan (docs/ANATOMY.md) the spinal cord sits between the senses
 * and the cortex: it fires deterministic responses without the brain having to
 * deliberate. Here that means:
 *
 *  - **Immune reflexes (hard blocks):** tool names / arguments that touch
 *    credentials, secrets, or auth state are denied instantly, before any
 *    model round-trip. This is the same protection the tools enforce at their
 *    handler, but at the spinal level it happens even earlier and with zero
 *    model cost.
 *  - **Routine fast-path:** known-safe, read-only organs short-circuit their
 *    execution so the cortex never spends a token deliberating them.
 *
 * The conscious approval gate (src/approvals.ts) remains the veto on top of
 * these reflexes — a reflex never overrides a deliberate consent decision.
 */

/** Credential/state files no organ may ever read or write directly. */
const SENSITIVE_NAMES = new Set(['secrets.json', 'auth.json', 'link.json']);

function isSensitivePath(p: string): boolean {
  return SENSITIVE_NAMES.has(path.basename(p));
}

function mentionsSecrets(args: Record<string, unknown> | undefined): boolean {
  if (!args) return false;
  const hay = JSON.stringify(args);
  return /(secrets\.json|auth\.json|link\.json|api[_-]?key|token|password|secret)/i.test(hay);
}

export interface ReflexResult {
  kind: 'pass' | 'blocked' | 'fast';
  reason?: string;
}

/**
 * Run the reflex layer over a proposed tool call. Returns:
 *  - `pass` — no reflex fires; let the cortex deliberate.
 *  - `blocked` — immune reflex: refuse deterministically, no model call.
 *  - `fast` — routine safe organ; safe to run without cortex deliberation.
 */
export function reflex(call: ToolCall): ReflexResult {
  const name = call.name;

  // ── Immune reflexes: hard blocks ──────────────────────────────────────
  // Credential-adjacent tools never touch secret files, even if the model
  // tries to route around the tools' own guards.
  if (name.startsWith('file_') || name === 'run_shell' || name === 'open_file' || name === 'reveal_in_finder') {
    const p = String((call.arguments ?? {}).path ?? (call.arguments ?? {}).from ?? '');
    if (p && isSensitivePath(p)) {
      return { kind: 'blocked', reason: `reflex: refusing to touch credential file "${path.basename(p)}"` };
    }
    if (name === 'run_shell' && mentionsSecrets(call.arguments)) {
      return { kind: 'blocked', reason: 'reflex: refusing a shell command that references secrets, keys, or auth state' };
    }
  }
  if (name === 'code_edit') {
    const p = String((call.arguments ?? {}).path ?? '');
    if (p && isSensitivePath(p)) {
      return { kind: 'blocked', reason: `reflex: refusing to edit credential file "${path.basename(p)}"` };
    }
  }

  // ── Routine fast-path: organs safe to fire without cortex deliberation ──
  const FAST_SAFE = new Set([
    'get_datetime',
    'system_status',
    'process_list',
    'app_status',
    'calendar_agenda',
    'reminder_list',
    'schedule_list',
    'moltbook_status',
    'moltbook_home',
    'moltbook_feed',
    'moltbook_search',
    'moltbook_notifications',
    'shutdown_status',
    'deliverylog_verify',
    'self_review',
    'list_facts',
    'recall',
    'file_list',
    'file_list_any',
    'code_search',
    'web_search',
    'web_read',
    'file_find',
    'clipboard_get',
  ]);
  if (FAST_SAFE.has(name)) return { kind: 'fast' };

  return { kind: 'pass' };
}
