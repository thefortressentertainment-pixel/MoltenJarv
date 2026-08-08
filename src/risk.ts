import type { ToolDefinition } from './agent/types.js';
import { READ_ONLY_TOOLS, EXECUTE_TOOLS } from './capability.js';

/**
 * Risk classes, modeled on andrewyng/openworker's `coworker/risk.py` (MIT).
 * A tool's *intrinsic* side-effect category drives permission gating and (later)
 * unattended routing. This is data-driven: a single `isConsequential()` gate
 * replaces scattered "is this tool safe?" checks.
 *
 *   READ        — no side effects; always allowed (reflex fast-path trigger).
 *   WRITE_LOCAL — mutates the workspace; consent-gated.
 *   EXEC        — runs commands; consent-gated.
 *   EXTERNAL    — side effects off the machine; consent-gated + should never
 *                 auto-fire unattended (fail-closed).
 */

export type RiskClass = 'read' | 'write-local' | 'exec' | 'external';

/**
 * Effective risk of a tool. Precedence:
 *   1. explicit `risk` field on the definition,
 *   2. `failClosed` → external (externally visible, irreversibly consequential),
 *   3. `consequential` → write-local (mutates the workspace),
 *   4. name-based base table (read-only / exec),
 *   5. default → read.
 * So a tool only becomes consequential by being *declared* so (via `risk`,
 * `consequential`, or `failClosed`) — this intentionally preserves each tool's
 * current consent behavior while giving every tool a queryable classification.
 */
export function toolRisk(def: ToolDefinition): RiskClass {
  if (def.risk) return def.risk;
  if (def.failClosed) return 'external';
  if (def.consequential) return 'write-local';
  if (READ_ONLY_TOOLS.has(def.name)) return 'read';
  if (EXECUTE_TOOLS.has(def.name)) return 'exec';
  return 'read';
}

/** Anything but a pure read needs the consent engine's attention. Mirrors
 *  openworker's `is_consequential()`: risk is not READ. */
export function isConsequential(def: ToolDefinition): boolean {
  return toolRisk(def) !== 'read';
}

export function isRiskRead(def: ToolDefinition): boolean {
  return toolRisk(def) === 'read';
}

export function isRiskExec(def: ToolDefinition): boolean {
  return toolRisk(def) === 'exec';
}

export function isRiskExternal(def: ToolDefinition): boolean {
  return toolRisk(def) === 'external';
}

/**
 * Read-vs-write policy split (ha-mcp pattern, MIT). A two-way classification
 * that drives *approval posture*, complementing the 4-class risk model:
 *
 *   `read`  — harmless, non-mutating; auto-approve, never gated. (risk 'read'.)
 *   `mutating` — write-local / exec / external; must pass the consent gate
 *                (auto-approve only when a human is present, fail-closed for
 *                external/fail-closed tools).
 *
 * The ha-mcp doctrine is: auto-approve reads, prompt writes. This lifts that
 * one decision to a single, data-driven helper so no tool schema needs a
 * bespoke check.
 *
 * Defense-in-depth: a tool on the READ_ONLY_TOOLS name table (an authoritative
 * list of non-mutating tools) is always `read` — even if someone mis-flags it
 * `consequential`. Pinning's safety floor and the consent gate both trust this
 * so an accidental harmful flag can't gate a genuinely read-only tool.
 */
export type ToolPolicy = 'read' | 'mutating';

export function policyFor(def: ToolDefinition): ToolPolicy {
  if (READ_ONLY_TOOLS.has(def.name)) return 'read';
  return toolRisk(def) === 'read' ? 'read' : 'mutating';
}

/** True when a tool's declared risk says it is harmful (not a pure read). */
export function isMutating(def: ToolDefinition): boolean {
  return policyFor(def) === 'mutating';
}
