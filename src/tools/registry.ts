import type { ToolContext, ToolDefinition, BodySystem } from '../agent/types.js';
import fs from 'node:fs';

export interface ExecutionResult {
  ok: boolean;
  result: unknown;
}

/** Central registry of tools available to the agent and to the MCP server. */
export class ToolRegistry {
  private map = new Map<string, ToolDefinition>();

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
    try {
      const result = await tool.handler(args, ctx);
      return { ok: true, result };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, result: message };
    }
  }
}
