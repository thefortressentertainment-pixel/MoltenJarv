import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ToolDefinition } from '../agent/types.js';
import { recordShutdownRequest } from '../cli/shutdown.js';

/**
 * System tools: shell command execution and full-filesystem access, for when
 * Jarv needs to do anything the user can do on the machine (install, git,
 * process management, read/write anywhere). Mutating tools are marked
 * `consequential` so the explicit-consent gate protects them when the user is
 * away; when the user is present locally they run directly, like the user
 * typing the command themselves.
 */

const execFileAsync = promisify(execFile);
const OUTPUT_LIMIT = 8000;

function clip(s: string): string {
  return s.length > OUTPUT_LIMIT ? s.slice(0, OUTPUT_LIMIT) + '\n… (truncated)' : s;
}

export function systemTools(): ToolDefinition[] {
  return [
    {
      name: 'run_shell',
      description:
        'Run a shell command on the hub machine (bash). Returns the exit code and captured stdout/stderr (truncated). Use for anything the user could type in a terminal: installing tools, git, process management, system info. REQUIRES explicit user consent when a remote channel is active.',
      inputSchema: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The shell command to run.' },
          workdir: { type: 'string', description: 'Working directory (default: the Jarv workspace).' },
          timeout: { type: 'number', description: 'Max seconds (default 60, max 300).' },
        },
        required: ['command'],
      },
      consequential: true,
      handler: async (args) => {
        const command = String(args.command ?? '').trim();
        if (!command) return { ok: false, error: 'run_shell requires a command' };
        if (/\b(shutdown|reboot|halt)\b/.test(command)) {
          recordShutdownRequest('run_shell');
        }
        const workdir = args.workdir ? path.resolve(String(args.workdir)) : undefined;
        const timeout = Math.min(Math.max(Math.trunc(Number(args.timeout ?? 60) || 60), 1), 300) * 1000;
        try {
          const res = await execFileAsync('/bin/bash', ['-c', command], { cwd: workdir, timeout, maxBuffer: 4 * 1024 * 1024 });
          return { ok: true, exitCode: 0, stdout: clip(res.stdout), stderr: clip(res.stderr) };
        } catch (err) {
          const e = err as { code?: number; stdout?: string; stderr?: string; killed?: boolean };
          return {
            ok: true,
            exitCode: e.code ?? 1,
            killed: e.killed === true,
            stdout: clip(e.stdout ?? ''),
            stderr: clip(e.stderr ?? (err instanceof Error ? err.message : String(err))),
          };
        }
      },
    },
    {
      name: 'file_read_any',
      description: 'Read any text file on the machine (full path). Returns size and content (truncated).',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Absolute path.' } },
        required: ['path'],
      },
      handler: async (args) => {
        const p = path.resolve(String(args.path ?? '').trim());
        if (!p) return { ok: false, error: 'file_read_any requires a path' };
        const buf = await fs.readFile(p);
        return { path: p, size: buf.length, text: buf.toString('utf8').slice(0, 1_000_000) };
      },
    },
    {
      name: 'file_write_any',
      description:
        'Write UTF-8 text to any path on the machine, creating parent directories. REQUIRES explicit user consent when a remote channel is active.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute path.' },
          content: { type: 'string', description: 'The text to write.' },
        },
        required: ['path', 'content'],
      },
      consequential: true,
      handler: async (args) => {
        const p = path.resolve(String(args.path ?? '').trim());
        if (!p) return { ok: false, error: 'file_write_any requires a path' };
        await fs.mkdir(path.dirname(p), { recursive: true });
        await fs.writeFile(p, String(args.content ?? ''));
        return { ok: true, path: p, written: Buffer.byteLength(String(args.content ?? '')) };
      },
    },
    {
      name: 'file_list_any',
      description: 'List the contents of any directory on the machine.',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Absolute directory path.' } },
        required: ['path'],
      },
      handler: async (args) => {
        const p = path.resolve(String(args.path ?? '').trim());
        const entries = await fs.readdir(p, { withFileTypes: true });
        return {
          path: p,
          entries: entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).sort(),
        };
      },
    },
    {
      name: 'file_delete_any',
      description: 'Delete a file or empty directory at any path on the machine. REQUIRES explicit user consent when a remote channel is active.',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Absolute path to delete.' } },
        required: ['path'],
      },
      consequential: true,
      handler: async (args) => {
        const p = path.resolve(String(args.path ?? '').trim());
        if (!p) return { ok: false, error: 'file_delete_any requires a path' };
        await fs.rm(p, { recursive: true });
        return { ok: true, deleted: p };
      },
    },
  ];
}
