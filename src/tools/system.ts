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

/** Credential/state files Jarv must never read or write directly. */
const SENSITIVE_NAMES = new Set(['secrets.json', 'auth.json', 'link.json']);

function isSensitivePath(p: string): boolean {
  return SENSITIVE_NAMES.has(path.basename(p));
}

function sensitiveError(p: string): { ok: false; error: string } {
  return { ok: false, error: `refusing to touch credential file "${p}" — keep secrets in the secret store (jarv-genie key set)` };
}

function clip(s: string): string {
  return s.length > OUTPUT_LIMIT ? s.slice(0, OUTPUT_LIMIT) + '\n… (truncated)' : s;
}

export function systemTools(): ToolDefinition[] {
  return [
    {
      name: 'run_shell',
      system: 'effector',
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
      system: 'effector',
      description: 'Read any text file on the machine (full path). Returns size and content (truncated).',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Absolute path.' } },
        required: ['path'],
      },
      handler: async (args) => {
        const p = path.resolve(String(args.path ?? '').trim());
        if (!p) return { ok: false, error: 'file_read_any requires a path' };
        if (isSensitivePath(p)) return sensitiveError(p);
        const buf = await fs.readFile(p);
        return { path: p, size: buf.length, text: buf.toString('utf8').slice(0, 1_000_000) };
      },
    },
    {
      name: 'file_write_any',
      system: 'effector',
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
        if (isSensitivePath(p)) return sensitiveError(p);
        await fs.mkdir(path.dirname(p), { recursive: true });
        await fs.writeFile(p, String(args.content ?? ''));
        return { ok: true, path: p, written: Buffer.byteLength(String(args.content ?? '')) };
      },
    },
    {
      name: 'file_list_any',
      system: 'effector',
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
      system: 'effector',
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
        if (isSensitivePath(p)) return sensitiveError(p);
        await fs.rm(p, { recursive: true });
        return { ok: true, deleted: p };
      },
    },
    {
      name: 'file_move_any',
      system: 'effector',
      description: 'Move or rename a file/directory at any path. REQUIRES explicit user consent when a remote channel is active.',
      inputSchema: {
        type: 'object',
        properties: {
          from: { type: 'string', description: 'Source path.' },
          to: { type: 'string', description: 'Destination path (rename or move).' },
        },
        required: ['from', 'to'],
      },
      consequential: true,
      handler: async (args) => {
        const from = path.resolve(String(args.from ?? '').trim());
        const to = path.resolve(String(args.to ?? '').trim());
        if (!from || !to) return { ok: false, error: 'file_move_any requires from and to' };
        if (isSensitivePath(from) || isSensitivePath(to)) return sensitiveError(from);
        await fs.mkdir(path.dirname(to), { recursive: true });
        await fs.rename(from, to);
        return { ok: true, from, to };
      },
    },
    {
      name: 'file_copy_any',
      system: 'effector',
      description: 'Copy a file/directory to a new path. REQUIRES explicit user consent when a remote channel is active.',
      inputSchema: {
        type: 'object',
        properties: {
          from: { type: 'string', description: 'Source path.' },
          to: { type: 'string', description: 'Destination path.' },
        },
        required: ['from', 'to'],
      },
      consequential: true,
      handler: async (args) => {
        const from = path.resolve(String(args.from ?? '').trim());
        const to = path.resolve(String(args.to ?? '').trim());
        if (!from || !to) return { ok: false, error: 'file_copy_any requires from and to' };
        if (isSensitivePath(from) || isSensitivePath(to)) return sensitiveError(from);
        await fs.mkdir(path.dirname(to), { recursive: true });
        await fs.cp(from, to, { recursive: true });
        return { ok: true, from, to };
      },
    },
    {
      name: 'open_file',
      system: 'effector',
      description: 'Open a file/folder in its default app (or Finder). REQUIRES explicit user consent when a remote channel is active.',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Absolute path to open.' } },
        required: ['path'],
      },
      consequential: true,
      handler: async (args) => {
        const p = path.resolve(String(args.path ?? '').trim());
        if (!p) return { ok: false, error: 'open_file requires a path' };
        await execFileAsync('open', [p]);
        return { ok: true, opened: p };
      },
    },
    {
      name: 'reveal_in_finder',
      system: 'effector',
      description: 'Reveal a file/folder in Finder (selects it in a window). REQUIRES explicit user consent when a remote channel is active.',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Absolute path to reveal.' } },
        required: ['path'],
      },
      consequential: true,
      handler: async (args) => {
        const p = path.resolve(String(args.path ?? '').trim());
        if (!p) return { ok: false, error: 'reveal_in_finder requires a path' };
        await execFileAsync('open', ['-R', p]);
        return { ok: true, revealed: p };
      },
    },
    {
      name: 'clipboard_get',
      system: 'sense',
      description: 'Read the current clipboard text. Read-only.',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        const res = await execFileAsync('pbpaste');
        return { ok: true, text: res.stdout };
      },
    },
    {
      name: 'file_find',
      system: 'sense',
      description:
        'Search the Mac (Spotlight/mdfind) for files and return paths. Read-only. Great for "find my resume" or locating anything on disk.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query (filename or content term).' },
          maxResults: { type: 'number', description: 'Max results (default 20).' },
        },
        required: ['query'],
      },
      handler: async (args) => {
        const query = String(args.query ?? '').trim();
        if (!query) return { ok: false, error: 'file_find requires a query' };
        const maxResults = Math.max(1, Math.min(100, Math.trunc(Number(args.maxResults ?? 20) || 20)));
        const res = await execFileAsync('mdfind', ['-name', query, '-limit', String(maxResults)]);
        const paths = res.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
        return { ok: true, count: paths.length, paths };
      },
    },
    {
      name: 'file_zip',
      system: 'effector',
      description: 'Create a zip archive of a file or folder. REQUIRES explicit user consent when a remote channel is active.',
      inputSchema: {
        type: 'object',
        properties: {
          source: { type: 'string', description: 'File or folder to zip.' },
          destination: { type: 'string', description: 'Output .zip path.' },
        },
        required: ['source', 'destination'],
      },
      consequential: true,
      handler: async (args) => {
        const source = path.resolve(String(args.source ?? '').trim());
        const destination = path.resolve(String(args.destination ?? '').trim());
        if (!source || !destination) return { ok: false, error: 'file_zip requires source and destination' };
        await fs.mkdir(path.dirname(destination), { recursive: true });
        await execFileAsync('zip', ['-r', '-q', destination, source]);
        return { ok: true, source, destination };
      },
    },
    {
      name: 'file_unzip',
      system: 'effector',
      description: 'Extract a zip archive to a destination folder. REQUIRES explicit user consent when a remote channel is active.',
      inputSchema: {
        type: 'object',
        properties: {
          source: { type: 'string', description: 'The .zip file.' },
          destination: { type: 'string', description: 'Folder to extract into.' },
        },
        required: ['source', 'destination'],
      },
      consequential: true,
      handler: async (args) => {
        const source = path.resolve(String(args.source ?? '').trim());
        const destination = path.resolve(String(args.destination ?? '').trim());
        if (!source || !destination) return { ok: false, error: 'file_unzip requires source and destination' };
        await fs.mkdir(destination, { recursive: true });
        await execFileAsync('unzip', ['-o', '-q', source, '-d', destination]);
        return { ok: true, source, destination };
      },
    },
  ];
}
