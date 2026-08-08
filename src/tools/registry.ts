import type { ToolContext, ToolDefinition, BodySystem } from '../agent/types.js';
import fs from 'node:fs';
import { validateArgs } from './validate.js';
import { filterByCapability, capabilityCovers, toolCapability, type Capability } from '../capability.js';
import { makeRootsHandle } from '../roots.js';

export interface ExecutionResult {
  ok: boolean;
  result: unknown;
}

/**
 * Declarative toolset consistency rules, in the spirit of grok-build's
 * `requirements.rs` (Apache-2.0). Guarantees the model is never handed a toolset
 * that is internally incoherent — e.g. a scheduling tool whose sibling list/remove
 * tools aren't loaded, or a code-editing tool whose search partner is missing.
 * These are advisory: a violated rule surfaces a clear issue rather than crashing,
 * so a minimal registration (as in tests) still works.
 */
export interface ToolsetConstraint {
  /** The tool that, when present, imposes the requirement. */
  if: string;
  /** Tool names that must also be present when `if` is enabled. */
  requires: string[];
  /** Human-readable problem statement (uses the would-be sibling names). */
  why: string;
}

export const TOOLSET_CONSTRAINTS: ToolsetConstraint[] = [
  { if: 'schedule_add', requires: ['schedule_list', 'schedule_remove'], why: 'scheduling is a matched trio (add/list/remove)' },
  { if: 'code_edit', requires: ['code_search'], why: 'code editing prompts the model to use code_search to locate targets first' },
  { if: 'remember', requires: ['recall', 'list_facts'], why: 'memory write is only coherent when recall/list are present' },
];

/** Finalize-time consistency check. Returns issues describing any tool enabled
 *  whose required siblings are missing. Empty array means the toolset is sound. */
export function validateToolset(tools: ToolDefinition[]): string[] {
  const present = new Set(tools.map((t) => t.name));
  const issues: string[] = [];
  for (const c of TOOLSET_CONSTRAINTS) {
    if (!present.has(c.if)) continue;
    for (const req of c.requires) {
      if (!present.has(req)) issues.push(`tool "${c.if}" enabled but required companion "${req}" is missing (${c.why})`);
    }
  }
  return issues;
}


/** Central registry of tools available to the agent and to the MCP server. */
export class ToolRegistry {
  private map = new Map<string, ToolDefinition>();
  private activeMode: Capability = 'all';

  register(tool: ToolDefinition): void {
    this.map.set(tool.name, tool);
  }

  registerMany(tools: ToolDefinition[]): void {
    for (const tool of tools) this.register(tool);
  }

  list(): ToolDefinition[] {
    return [...this.map.values()];
  }

  has(name: string): boolean {
    return this.map.has(name);
  }

  /** The current capability mode; 'all' exposes every registered tool. */
  get capability(): Capability {
    return this.activeMode;
  }

  /** Restrict this session to a capability mode (never widens — see note on
   *  capabilityCovers; callers set a *narrower* mode to enter read-only/plan. */
  setCapability(mode: Capability): void {
    this.activeMode = mode;
  }

  /** The tools exposed under the current capability mode. */
  listInMode(): ToolDefinition[] {
    return filterByCapability(this.list(), this.activeMode);
  }

  /** The tools exposed under a specific capability mode (no side effects). */
  listForCapability(mode: Capability): ToolDefinition[] {
    return filterByCapability(this.list(), mode);
  }

  /** All tools that belong to a body system (see docs/ANATOMY.md). */
  bySystem(system: BodySystem): ToolDefinition[] {
    return this.list().filter((t) => t.system === system);
  }

  /** Perception organs: eyes, ears, reading, proprioception. */
  senses(): ToolDefinition[] {
    return this.bySystem('sense');
  }

  /** Action organs: hands, arms, fingers, legs. */
  effectors(): ToolDefinition[] {
    return this.bySystem('effector');
  }

  /** Group every organ by its body system, for introspection. */
  organs(): Map<BodySystem, ToolDefinition[]> {
    const out = new Map<BodySystem, ToolDefinition[]>();
    for (const system of ['sense', 'effector', 'memory', 'voice', 'autonomic', 'immune', 'integration'] as BodySystem[]) {
      const tools = this.bySystem(system);
      if (tools.length > 0) out.set(system, tools);
    }
    return out;
  }

  async execute(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ExecutionResult> {
    if (process.env.JARV_GENIE_DEBUG_TOOLS) {
      try {
        fs.appendFileSync(
          '/tmp/jarv-toollog.txt',
          `${new Date().toISOString()} pid=${process.pid} argv=${process.argv.slice(1).join(' ').slice(0, 60)} ${name} ${JSON.stringify(args)}\n`,
        );
      } catch {
        /* best effort */
      }
    }
    const tool = this.map.get(name);
    if (!tool) return { ok: false, result: `Unknown tool: ${name}` };
    // Capability-mode enforcement: a read-only (plan) session must not sneak a
    // write/execute through, even if the model routes around the tool list.
    if (this.activeMode !== 'all' && !capabilityCovers(this.activeMode, toolCapability(tool))) {
      return { ok: false, result: `tool "${name}" is not allowed in ${this.activeMode} mode` };
    }
    try {
      // Structured, lenient validation (see validate.ts): coerce well-formed
      // values to the declared schema and return a path-bearing structured
      // error on a genuinely-wrong required arg, so the model can self-correct
      // instead of retry-looping on opaque failures.
      const { args: coerced, errors } = validateArgs(tool, args);
      if (errors.length > 0) {
        return { ok: false, result: { error: `invalid argument(s): ${errors[0]!.message}`, issues: errors } };
      }
      // Give the handler a handle back to this registry so meta-tools like
      // `use_tool` can dispatch to other registered tools by name, and the
      // writable-roots sandbox so file tools can enforce write-scoping.
      const roots = makeRootsHandle({
        workdir: ctx.workdir,
        readRoots: ctx.config?.agent?.extraReadRoots ?? [],
        enabled: true,
      });
      const result = await tool.handler(coerced, { ...ctx, tools: this, roots });
      return { ok: true, result };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, result: message };
    }
  }
}
