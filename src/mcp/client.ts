import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { ToolDefinition } from '../agent/types.js';
import type { McpServerConfig } from '../config/index.js';
import { MCP_VERSION, SERVER_NAME } from '../config/defaults.js';

export interface ExternalToolsResult {
  tools: ToolDefinition[];
  errors: string[];
}

const CONNECT_TIMEOUT_MS = 15_000;

/**
 * Connect to each external MCP server in the config and wrap its tools so the
 * agent can call them natively, namespaced as `<server>__<tool>`.
 */
export async function loadExternalMcpTools(servers: McpServerConfig[]): Promise<ExternalToolsResult> {
  const tools: ToolDefinition[] = [];
  const errors: string[] = [];

  for (const cfg of servers) {
    try {
      const client = new Client({ name: SERVER_NAME, version: MCP_VERSION });

      if (cfg.command) {
        await withTimeout(client.connect(new StdioClientTransport({ command: cfg.command, args: cfg.args ?? [], stderr: 'pipe' })));
      } else if (cfg.url) {
        const opts = cfg.headers ? { requestInit: { headers: cfg.headers } } : undefined;
        await withTimeout(client.connect(new StreamableHTTPClientTransport(new URL(cfg.url), opts)));
      } else {
        throw new Error('MCP server config needs either command+args or url');
      }

      const listed = await withTimeout(client.listTools());
      for (const t of listed.tools) {
        tools.push({
          name: `${cfg.name}__${t.name}`,
          description: `${t.description ?? ''}\n(external MCP server: ${cfg.name})`,
          inputSchema: (t.inputSchema ?? { type: 'object', properties: {} }) as ToolDefinition['inputSchema'],
          handler: async (args) => {
            const res = await client.callTool({ name: t.name, arguments: args as Record<string, unknown> });
            return contentToJson(res.content);
          },
        });
      }
    } catch (err) {
      errors.push(`${cfg.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { tools, errors };
}

function withTimeout<T>(promise: Promise<T>): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error('timed out connecting to MCP server')), CONNECT_TIMEOUT_MS);
    }),
  ]);
}

function contentToJson(content: unknown): unknown {
  if (!Array.isArray(content)) return content;
  const blocks = content as Array<{ type?: string; text?: string }>;
  const texts = blocks.filter((b) => b.type === 'text' && typeof b.text === 'string').map((b) => b.text);
  return texts.length === blocks.length ? texts.join('\n') : content;
}
