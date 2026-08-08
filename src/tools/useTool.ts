import type { ToolDefinition } from '../agent/types.js';

/**
 * `use_tool` — a stable meta-dispatch tool for dynamically-loaded tools,
 * modeled on grok-build's `use_tool/` (Apache-2.0).
 *
 * The point is a *stable* advertised interface: instead of the model seeing the
 * registry's set of (possibly changing) tools spread across many schema entries,
 * it can route an MCP/discovered tool through a single `use_tool { tool, input }`
 * call. If the model mistakenly routes a **native** tool through it, a corrective
 * error tells it which are native vs. external so it recovers in one shot.
 */
export function useToolTools(): ToolDefinition[] {
  return [
    {
      name: 'use_tool',
      system: 'integration',
      description:
        'Call an external (MCP) tool by name. Pass `tool` as the full namespaced name (e.g. "weather__get"), and `input` as the argument object that tool expects. Use this for any tool not listed directly in your schema. If you pass a native tool name, it will refuse with a corrective message.',
      inputSchema: {
        type: 'object',
        properties: {
          tool: { type: 'string', description: 'The namespaced tool name to invoke, e.g. "servername__toolname".' },
          input: { type: 'object', description: 'Arguments for the target tool.' },
        },
        required: ['tool'],
      },
      handler: async (args, ctx) => {
        const toolName = String(args.tool ?? '').trim();
        if (!toolName) throw new Error('use_tool requires a `tool` name');
        if (!ctx.tools) throw new Error('use_tool is unavailable (no tool registry in context)');

        const input = (args.input ?? {}) as Record<string, unknown>;
        const target = ctx.tools.list().find((t) => t.name === toolName);
        if (!target) {
          const natives = ctx.tools.list().filter((t) => !t.mcpServer).map((t) => t.name);
          const external = ctx.tools.list().filter((t) => t.mcpServer).map((t) => t.name);
          const hint =
            external.length > 0
              ? `Not an external tool. Try one of: ${external.join(', ')}`
              : 'There are no external (MCP) tools loaded right now.';
          throw new Error(`unknown tool "${toolName}" via use_tool. ${hint} Native tools you should call directly include: ${natives.slice(0, 8).join(', ')}`);
        }
        if (!target.mcpServer) {
          throw new Error(`"${toolName}" is a native tool — call it directly, not through use_tool.`);
        }
        const res = await ctx.tools.execute(toolName, input, ctx);
        if (!res.ok) throw new Error(String(res.result));
        return res.result;
      },
    },
  ];
}
