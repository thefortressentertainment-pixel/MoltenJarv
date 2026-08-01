#!/usr/bin/env node
import { runDoctor, runOneShot, runRepl, buildAgent } from './cli/index.js';
import { runKeyCommand } from './cli/keys.js';
import { ensureConfigFile } from './config/index.js';
import { VERSION } from './config/defaults.js';
import { runMcpServer } from './mcp/server.js';
import { serveUi, type UiServerOptions } from './ui/server.js';

interface Args {
  mode: 'repl' | 'oneshot' | 'mcp' | 'doctor' | 'help';
  prompt?: string;
  mcpTransport?: 'stdio' | 'http';
  mcpPort?: number;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { mode: 'repl' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--mcp':
        out.mode = 'mcp';
        break;
      case '--transport': {
        const t = argv[++i];
        out.mcpTransport = t === 'http' ? 'http' : 'stdio';
        break;
      }
      case '--port':
        out.mcpPort = Number(argv[++i]);
        break;
      case '--doctor':
        out.mode = 'doctor';
        break;
      case '--help':
      case '-h':
        out.mode = 'help';
        break;
      case '--version':
      case '-v':
        process.stdout.write(`jarv-genie ${VERSION}\n`);
        process.exit(0);
        break;
      default:
        if (a && !a.startsWith('-')) {
          out.mode = 'oneshot';
          out.prompt = a;
        }
        break;
    }
  }
  return out;
}

function parseUiArgs(argv: string[]): UiServerOptions {
  const out: UiServerOptions = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') out.port = Number(argv[++i]);
    else if (a === '--host') out.host = argv[++i];
    else if (a === '--no-open') out.open = false;
  }
  return out;
}

async function main(): Promise<void> {
  ensureConfigFile();
  const raw = process.argv.slice(2);

  if (raw[0] === 'key') {
    await runKeyCommand(raw.slice(1));
    return;
  }

  if (raw[0] === 'ui') {
    const ctx = await buildAgent();
    await serveUi(ctx, parseUiArgs(raw.slice(1)));
    return;
  }

  const args = parseArgs(raw);

  switch (args.mode) {
    case 'help':
      process.stdout.write(
        `jarv-genie ${VERSION} — a standalone, local-first personal AI assistant\n\n` +
          'Usage:\n' +
          '  jarv-genie                      interactive session\n' +
          '  jarv-genie "prompt"             one-shot\n' +
          '  jarv-genie --doctor             check endpoints and memory\n' +
          '  jarv-genie --mcp [--transport http --port 3000]   run as an MCP server\n' +
          '  jarv-genie ui [--port N] [--host H] [--no-open]    app-style chat UI\n' +
          '  jarv-genie key <set|rm|list>    manage API keys (stored securely)\n' +
          '  jarv-genie --version\n',
      );
      break;

    case 'mcp': {
      const ctx = await buildAgent();
      await runMcpServer(ctx.tools, ctx.memory, ctx.config, {
        transport: args.mcpTransport ?? 'stdio',
        port: args.mcpPort ?? 3000,
      });
      break;
    }

    case 'doctor': {
      const ctx = await buildAgent();
      await runDoctor(ctx);
      break;
    }

    case 'oneshot': {
      const ctx = await buildAgent();
      await runOneShot(ctx, args.prompt ?? '');
      break;
    }

    default: {
      const ctx = await buildAgent();
      await runRepl(ctx);
      break;
    }
  }
}

main().catch((err) => {
  process.stderr.write(`fatal: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
