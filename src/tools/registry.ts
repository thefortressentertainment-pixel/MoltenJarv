import type { ToolContext, ToolDefinition } from '../agent/types.js';

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
