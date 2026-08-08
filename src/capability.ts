import type { ToolDefinition } from './agent/types.js';

/**
 * Capability modes, modeled on grok-build's `xai-grok-workspace/capability.rs`
 * (Apache-2.0). A coarse partial order filters which tools a session may expose:
 *
 *   ReadOnly  ⊂ ReadWrite
 *   ReadOnly  ⊂ Execute
 *   ReadOnly ⊂ {ReadWrite, Execute} ⊂ All
 *
 * A child/plan-mode session can never *widen* its parent's capability. This
 * gives a cheap, principled "plan mode" (read-only) and a "headless sandbox"
 * (execute) without hand-editing allowlists.
 */

export type Capability = 'read-only' | 'read-write' | 'execute' | 'all';

const ORDER: Record<Capability, number> = { 'read-only': 0, 'read-write': 1, execute: 1, all: 2 };

/** Is capability `a` at least as permissive as `b`? (a ⊇ b) */
export function capabilityCovers(a: Capability, b: Capability): boolean {
  if (a === 'all') return true;
  if (b === 'all') return false; // a is not all (handled above)
  if (a === b) return true;
  // read-write and execute are incomparable with each other.
  if (a === 'read-only') return false; // only covers read-only, and b !== a
  if (b === 'read-only') return true; // a is read-write or execute, which cover read-only
  return false; // a vs b are the two strong modes, incomparable here
}

/** Tools that only need to read (never write to user state outside memory/read caches). */
export const READ_ONLY_TOOLS = new Set([
  'get_datetime', 'system_status', 'process_list', 'app_status', 'calendar_agenda',
  'reminder_list', 'schedule_list', 'shutdown_status', 'deliverylog_verify',
  'self_review', 'list_facts', 'recall', 'file_read', 'file_list', 'file_list_any',
  'code_search', 'web_search', 'web_read', 'file_find', 'clipboard_get', 'vision_analyze',
  'camera_capture', 'screen_read', 'screen_capture', 'read_event', 'briefing_get',
  'rag_query', 'rag_status', 'memory_history', 'verify_change', 'refine_code',
]);

/** Tools that execute or spawn processes (not merely read/write files). */
export const EXECUTE_TOOLS = new Set([
  'run_shell', 'run_apple_script', 'app_command', 'open_app', 'speak_text',
]);

/** Classify a tool into the minimum capability required to run it. Untagged /
 *  unknown tools default to read-write so mode-filtering is conservative. */
export function toolCapability(def: ToolDefinition): Capability {
  if (READ_ONLY_TOOLS.has(def.name)) return 'read-only';
  if (EXECUTE_TOOLS.has(def.name)) return 'execute';
  // Effector/write organs are read-write; keep default conservative.
  return 'read-write';
}

/** Filter a tool list down to those reachable under a given capability mode. */
export function filterByCapability(tools: ToolDefinition[], mode: Capability): ToolDefinition[] {
  return tools.filter((t) => capabilityCovers(mode, toolCapability(t)));
}
