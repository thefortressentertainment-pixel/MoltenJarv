import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { MemoryService } from '../agent/types.js';
import type { JarvGenieConfig } from '../config/index.js';
import { MCP_VERSION, SERVER_NAME } from '../config/defaults.js';
import type { ToolRegistry } from '../tools/registry.js';

export interface McpServerOptions {
  transport: 'stdio' | 'http';
  port?: number;
}

/** Expose every registered tool of Jarv Genie as an MCP server. */
export async function runMcpServer(registry: ToolRegistry, memory: MemoryService, config: JarvGenieConfig, opts: McpServerOptions): Promise<void> {
  const server = new McpServer({ name: SERVER_NAME, version: MCP_VERSION });

  for (const tool of registry.list()) {
    const inputSchema = jsonSchemaToZod(tool.inputSchema);
    server.registerTool(
      tool.name,
      { title: tool.name, description: tool.description, ...(inputSchema ? { inputSchema } : {}) },
      async (args: unknown) => {
        try {
          const result = await tool.handler((args ?? {}) as Record<string, unknown>, { memory, config, workdir: config.agent.workdir });
          return { content: [{ type: 'text', text: JSON.stringify(result) }] };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return { content: [{ type: 'text', text: JSON.stringify({ error: message }) }], isError: true };
        }
      },
    );
  }

  if (opts.transport === 'http') {
    await serveHttp(server, opts.port ?? 3000);
  } else {
    const transport = new StdioServerTransport();
    await server.connect(transport);
  }
}

function serveHttp(server: McpServer, port: number): Promise<void> {
  const transports = new Map<string, StreamableHTTPServerTransport>();

  const httpServer = http.createServer(async (req, res) => {
    try {
      if (req.method === 'GET') {
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID(), onsessioninitialized: () => {} });
        const sid = transport.sessionId;
        if (sid) transports.set(sid, transport);
        await server.connect(transport);
        await transport.handleRequest(req, res, undefined);
      } else if (req.method === 'POST') {
        const sessionId = String(req.headers['mcp-session-id'] ?? '');
        const body = await readBody(req);
        let transport = transports.get(sessionId);
        if (!transport) {
          transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID(), onsessioninitialized: () => {} });
          const sid = transport.sessionId;
          if (sid) transports.set(sid, transport);
          await server.connect(transport);
        }
        await transport.handleRequest(req, res, body);
      } else {
        res.writeHead(405, { 'Content-Type': 'text/plain' });
        res.end('Method not allowed');
      }
    } catch {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Internal server error');
      }
    }
  });

  return new Promise((resolve) => {
    httpServer.listen(port, '127.0.0.1', () => {
      process.stdout.write(`[jarv-genie] MCP HTTP server listening on http://127.0.0.1:${port}\n`);
      resolve();
    });
  });
}

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      try {
        resolve(raw.length ? JSON.parse(raw) : {});
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

/** Convert a minimal JSON object schema into a Zod object for registerTool. */
function jsonSchemaToZod(schema: { type?: string; properties?: Record<string, unknown>; required?: string[] } | undefined): z.ZodTypeAny | undefined {
  if (!schema || schema.type !== 'object' || !schema.properties || Object.keys(schema.properties).length === 0) return undefined;

  const required = new Set(schema.required ?? []);
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [key, raw] of Object.entries(schema.properties)) {
    const prop = (raw ?? {}) as { type?: string; description?: string; enum?: unknown[] };
    let field: z.ZodTypeAny;
    switch (prop.type) {
      case 'string':
        field = z.string();
        break;
      case 'number':
        field = z.number();
        break;
      case 'integer':
        field = z.number().int();
        break;
      case 'boolean':
        field = z.boolean();
        break;
      case 'array':
        field = z.array(z.any());
        break;
      default:
        field = Array.isArray(prop.enum) && prop.enum.length > 0 ? z.enum(prop.enum as [string, ...string[]]) : z.any();
        break;
    }
    if (prop.description) field = field.describe(prop.description);
    if (!required.has(key)) field = field.optional();
    shape[key] = field;
  }
  return z.object(shape);
}
