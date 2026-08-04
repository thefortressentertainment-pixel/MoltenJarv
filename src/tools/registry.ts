import type { ToolContext, ToolDefinition } from '../agent/types.js';
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
