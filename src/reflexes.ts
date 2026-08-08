import type { ToolCall } from './agent/types.js';
import type { JarvGenieConfig, PermissionRule } from './config/index.js';
import { evaluatePermissions, securityInvariant, type RuleDecision } from './permission.js';

/**
 * The spinal cord — Jarv's reflex layer.
 *
 * In the body plan (docs/ANATOMY.md) the spinal cord sits between the senses
 * and the cortex: it fires deterministic responses without the brain having to
 * deliberate. Three kinds, in order of precedence:
 *
 *  1. **Immune invariants** (non-overridable): credential/secret file
 *     protection. Never disabled by config, evaluated first.
 *  2. **User permission rules** (`permissions` in config, deny-by-default):
 *     user-defined allow/deny/fast rules, evaluated before built-ins.
 *  3. **Built-in default rules**: the safe-read-only fast-path and the
 *     placeholder-recipient guardrails, used when no user rule matches.
 *
 * The conscious approval gate (src/approvals.ts) remains the veto on top of
 * these reflexes — a reflex never overrides a deliberate consent decision.
 */

const PLACEHOLDER_EMAIL = /@(\[?[a-z0-9.-]*\.)?(example\.(?:com|org|net|test|edu|io)|test|invalid|localhost|local|domain\.(?:invalid|test)|example\.com\.br|foo\.com)\b/i;
const PLACEHOLDER_BUDDY = /@example\.|^buddy$|^test([\s@]|$)|placeholder/i;

/**
 * Built-in default rules preserve Jarv's historical guardrails. They apply only
 * when the user hasn't provided an overriding `permissions` rule for the same
 * tool. These are expressible in config, so a user can relax or strengthen them.
 */
function builtInRules(): PermissionRule[] {
  return [
    // Routine safe organs — run without cortex deliberation (the old FAST_SAFE).
    { action: 'fast', tool: 'get_datetime' },
    { action: 'fast', tool: 'system_status' },
    { action: 'fast', tool: 'process_list' },
    { action: 'fast', tool: 'app_status' },
    { action: 'fast', tool: 'calendar_agenda' },
    { action: 'fast', tool: 'reminder_list' },
    { action: 'fast', tool: 'schedule_list' },
    { action: 'fast', tool: 'shutdown_status' },
    { action: 'fast', tool: 'deliverylog_verify' },
    { action: 'fast', tool: 'self_review' },
    { action: 'fast', tool: 'list_facts' },
    { action: 'fast', tool: 'recall' },
    { action: 'fast', tool: 'file_list' },
    { action: 'fast', tool: 'file_list_any' },
    { action: 'fast', tool: 'code_search' },
    { action: 'fast', tool: 'web_search' },
    { action: 'fast', tool: 'web_read' },
    { action: 'fast', tool: 'file_find' },
    { action: 'fast', tool: 'clipboard_get' },
  ];
}

export interface ReflexResult {
  kind: 'pass' | 'blocked' | 'fast';
  reason?: string;
  /** True when a user permission rule produced this decision (not a fallback). */
  ruleMatched?: boolean;
}

function resultFor(decision: RuleDecision): ReflexResult | null {
  if (!decision) return null;
  switch (decision.action) {
    case 'deny':
      return { kind: 'blocked', ruleMatched: true };
    case 'fast':
      return { kind: 'fast', ruleMatched: true };
    case 'allow':
    default:
      return { kind: 'pass', ruleMatched: true };
  }
}

/**
 * Run the reflex layer over a proposed tool call. Order:
 *  1. immune invariants (credentials/secrets) — hard block, non-overridable.
 *  2. user permission rules — first match wins.
 *  3. built-in default rules.
 */
export function reflex(call: ToolCall, config?: JarvGenieConfig): ReflexResult {
  // 1. Non-overridable immune invariants.
  const guard = securityInvariant(call);
  if (guard.blocked) {
    return { kind: 'blocked', reason: guard.reason ?? 'blocked by reflex' };
  }

  // 2. User permission rules (deny-by-default; empty list falls through).
  const userDecision = evaluatePermissions(call, (config?.permissions ?? []) as PermissionRule[]);
  const userResult = resultFor(userDecision);
  if (userResult) return userResult;

  // 3. Built-in default rules, plus the placeholder guardrail handlers that the
  //    simple rule engine can't express on its own.
  const builtIn = evaluatePermissions(call, builtInRules());
  const builtInResult = resultFor(builtIn);
  if (builtInResult) return builtInResult;

  // Placeholder-recipient guardrails (kept here so the message stays clear even
  // when a user rule didn't match them).
  if (call.name === 'email_send') {
    const to = String((call.arguments ?? {}).to ?? '').trim();
    if (!to) return { kind: 'blocked', reason: 'reflex: email_send requires a recipient (to)' };
    if (to && PLACEHOLDER_EMAIL.test(to)) {
      return { kind: 'blocked', reason: `reflex: refusing email_send to placeholder/test domain "${to}"` };
    }
  }
  if (call.name === 'app_command') {
    const a = call.arguments ?? {};
    const app = String(a.app ?? '').trim().toLowerCase();
    const action = String(a.action ?? '').trim().toLowerCase();
    if ((app === 'messages' || app === 'imessage') && action === 'send') {
      const contact = String(a.contact ?? '').trim();
      if (!contact) {
        return { kind: 'blocked', reason: 'reflex: messages send requires a recipient (contact)' };
      }
      if (contact && PLACEHOLDER_BUDDY.test(contact)) {
        return { kind: 'blocked', reason: `reflex: refusing messages send to placeholder/test buddy "${contact}"` };
      }
    }
  }

  return { kind: 'pass' };
}
