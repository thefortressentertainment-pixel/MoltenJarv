import { createInterface } from 'node:readline/promises';
import { Agent } from '../agent/agent.js';
import type { JarvGenieConfig } from '../config/index.js';
import { ensureConfigFile, loadConfig } from '../config/index.js';
import { VERSION } from '../config/defaults.js';
import { buildMemory, type Memory } from '../memory/index.js';
import { loadExternalMcpTools } from '../mcp/client.js';
import { ModelRouter } from '../providers/index.js';
import { fileTools } from '../tools/filesystem.js';
import { memoryTools } from '../tools/memory.js';
import { ToolRegistry } from '../tools/registry.js';
import { timeTools } from '../tools/time.js';
import { webTools } from '../tools/web.js';

const SESSION = 'default';

export interface AgentContext {
  agent: Agent;
  router: ModelRouter;
  memory: Memory;
  config: JarvGenieConfig;
  tools: ToolRegistry;
  externalErrors: string[];
}

export async function buildAgent(): Promise<AgentContext> {
  ensureConfigFile();
  const config = loadConfig();
  const memory = buildMemory(config);

  const registry = new ToolRegistry();
  registry.registerMany([...timeTools(), ...fileTools(), ...memoryTools(), ...webTools()]);

  const { tools: externalTools, errors: externalErrors } = await loadExternalMcpTools(config.mcp.servers);
  registry.registerMany(externalTools);

  const router = new ModelRouter(config);
  const agent = new Agent({ router, tools: registry, memory, config });

  return { agent, router, memory, config, tools: registry, externalErrors };
}

export async function runRepl(ctx: AgentContext): Promise<void> {
  const { agent, router, memory, config, tools, externalErrors } = ctx;

  process.stdout.write(
    `Jarv Genie v${VERSION}\n` +
      `  primary : ${router.providers[0]?.label ?? 'none'}\n` +
      `  memory  : ${config.memory.dir}\n` +
      `  tools   : ${tools.list().length} registered (${externalErrors.length ? `${externalErrors.length} external failed` : 'all connected'})\n` +
      `Type /help for commands, or just talk.\n`,
  );

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  rl.on('SIGINT', () => {
    process.stdout.write('\nbye\n');
    process.exit(0);
  });

  for (;;) {
    const line = (await rl.question('jarv-genie> ')).trim();
    if (!line) continue;

    if (line.startsWith('/')) {
      await handleCommand(line, ctx);
      continue;
    }

    try {
      const result = await agent.run(line, SESSION);
      process.stdout.write(`\n${result.text}\n\n`);
    } catch (err) {
      process.stdout.write(`\nError: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }
}

async function handleCommand(line: string, ctx: AgentContext): Promise<void> {
  const { agent, router, memory, tools } = ctx;
  const [cmd, ...rest] = line.slice(1).split(/\s+/);
  const arg = rest.join(' ');

  switch (cmd) {
    case 'help':
      process.stdout.write(
        'Commands:\n' +
          '  /help          show this help\n' +
          '  /new           start a fresh conversation (memory is kept)\n' +
          '  /model <name>  switch the primary model, e.g. /model llama3.2:3b\n' +
          '  /tools         list available tools\n' +
          '  /memory        show how many facts are remembered\n' +
          '  /quit          exit\n',
      );
      break;
    case 'new':
      await memory.sessionReset('default');
      process.stdout.write('Session reset. Memory kept.\n');
      break;
    case 'model':
      if (arg) {
        router.setPrimaryModel(arg);
        process.stdout.write(`Primary model set to ${arg}\n`);
      } else {
        process.stdout.write(`Primary model is ${router.primaryModel}\n`);
      }
      break;
    case 'tools':
      for (const t of tools.list()) process.stdout.write(`  ${t.name} — ${t.description.split('\n')[0]}\n`);
      break;
    case 'memory': {
      const facts = await memory.listFacts();
      process.stdout.write(`${facts.length} fact${facts.length === 1 ? '' : 's'} remembered\n`);
      for (const f of facts.slice(0, 10)) process.stdout.write(`  [${f.id.slice(0, 8)}] ${f.text}\n`);
      break;
    }
    case 'quit':
    case 'exit':
      process.stdout.write('bye\n');
      process.exit(0);
      break;
    default:
      process.stdout.write(`Unknown command: /${cmd} (try /help)\n`);
  }
}

export async function runOneShot(ctx: AgentContext, prompt: string): Promise<void> {
  try {
    const result = await ctx.agent.run(prompt);
    process.stdout.write(result.text + '\n');
    if (!result.text) {
      process.stdout.write('[no response generated; run --doctor to check connectivity]\n');
      process.exitCode = 1;
    }
  } catch (err) {
    process.stdout.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  }
}

export async function runDoctor(ctx: AgentContext): Promise<void> {
  const { router, memory, config, externalErrors } = ctx;

  process.stdout.write(`Config: ${config.memory.dir}\n\n`);

  for (const entry of await router.doctor()) {
    process.stdout.write(`[${entry.ok ? 'OK' : 'FAIL'}] ${entry.name}${entry.error ? ` — ${entry.error}` : ''}\n`);
  }

  const embed = memory.embeddings;
  process.stdout.write(
    `[${embed ? (embed.enabled ? 'OK' : 'FAIL') : 'OFF'}] embeddings: ${embed ? embed.model : 'not configured (keyword search only)'}\n`,
  );

  for (const err of externalErrors) process.stdout.write(`[FAIL] external mcp: ${err}\n`);
}

export { SESSION };
