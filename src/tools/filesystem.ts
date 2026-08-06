import fs from 'node:fs/promises';
import path from 'node:path';
import type { ToolDefinition } from '../agent/types.js';

function safeResolve(workdir: string, p: string): string {
  const base = path.resolve(workdir);
  const target = path.resolve(base, p);
  if (target !== base && !target.startsWith(base + path.sep)) {
    throw new Error(`Path escapes the workspace: ${p}`);
  }
  return target;
}

const READ_LIMIT = 1_000_000;

export function fileTools(): ToolDefinition[] {
  return [
    {
      name: 'file_read',
      system: 'effector',
      description: 'Read a text file from the workspace as UTF-8. Returns the size and content.',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Path relative to the workspace.' } },
        required: ['path'],
      },
      handler: async (args, ctx) => {
        const p = safeResolve(ctx.workdir, String(args.path ?? ''));
        const buf = await fs.readFile(p);
        return { path: path.relative(ctx.workdir, p), size: buf.length, text: buf.toString('utf8').slice(0, READ_LIMIT) };
      },
    },
    {
      name: 'file_write',
      system: 'effector',
      description: 'Write UTF-8 text to a file in the workspace, creating parent directories as needed.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path relative to the workspace.' },
          content: { type: 'string', description: 'The text to write.' },
        },
        required: ['path', 'content'],
      },
      handler: async (args, ctx) => {
        const p = safeResolve(ctx.workdir, String(args.path ?? ''));
        const content = String(args.content ?? '');
        await fs.mkdir(path.dirname(p), { recursive: true });
        await fs.writeFile(p, content, 'utf8');
        return { path: path.relative(ctx.workdir, p), bytes: content.length };
      },
    },
    {
      name: 'file_list',
      system: 'effector',
      description: 'List the entries of a directory in the workspace.',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Directory path relative to the workspace (default ".").' } },
      },
      handler: async (args, ctx) => {
        const p = safeResolve(ctx.workdir, args.path ? String(args.path) : '.');
        const entries = await fs.readdir(p, { withFileTypes: true });
        const out = await Promise.all(
          entries.map(async (e) => {
            const full = path.join(p, e.name);
            const stat = e.isDirectory() ? null : await fs.stat(full).catch(() => null);
            return { name: e.name, type: e.isDirectory() ? 'dir' : 'file', size: stat?.size ?? null };
          }),
        );
        return { path: path.relative(ctx.workdir, p) || '.', entries: out };
      },
    },
    {
      name: 'file_delete',
      system: 'effector',
      description: 'Delete a file or empty directory from the workspace.',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Path relative to the workspace.' } },
        required: ['path'],
      },
      handler: async (args, ctx) => {
        const p = safeResolve(ctx.workdir, String(args.path ?? ''));
        await fs.rm(p, { recursive: true, force: true });
        return { deleted: path.relative(ctx.workdir, p) };
      },
    },
  ];
}
