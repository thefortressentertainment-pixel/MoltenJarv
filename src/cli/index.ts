import { createInterface } from 'node:readline/promises';
import { Agent } from '../agent/agent.js';
import type { ChatBackend } from './backend.js';
import type { JarvGenieConfig } from '../config/index.js';
import { ensureConfigFile, loadConfig } from '../config/index.js';
import { VERSION } from '../config/defaults.js';
import { buildMemory, type Memory } from '../memory/index.js';
import { loadExternalMcpTools } from '../mcp/client.js';
import { ModelRouter } from '../providers/index.js';
import { fileTools } from '../tools/filesystem.js';
import { computerTools } from '../tools/computer.js';
import { memoryTools } from '../tools/memory.js';
import { speechTools } from '../tools/speech.js';
import { ToolRegistry } from '../tools/registry.js';
import { timeTools } from '../tools/time.js';
import { webTools } from '../tools/web.js';
import { moltbookTools } from '../tools/moltbook.js';
import { emailTools } from '../tools/email.js';
import { reminderTools } from '../tools/reminders.js';
import { schedulerTools } from '../tools/scheduler.js';
import { systemTools } from '../tools/system.js';
import { uiTools } from '../tools/ui.js';
import { drawTools } from '../tools/draw.js';
import { telegramTools } from '../tools/telegram.js';
import { selfReviewTools } from '../tools/selfreview.js';
import { statusTools } from '../tools/status.js';
import { cameraTools } from '../tools/camera.js';
import { calendarTools } from '../tools/calendar.js';
import { briefingTools } from '../tools/briefing.js';

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
  registry.registerMany([...timeTools(), ...fileTools(), ...memoryTools(), ...webTools(), ...speechTools(), ...computerTools(), ...moltbookTools(), ...emailTools(), ...reminderTools(), ...schedulerTools(), ...systemTools(), ...uiTools(), ...drawTools(), ...telegramTools(), ...statusTools(), ...cameraTools(), ...calendarTools(), ...briefingTools(), ...selfReviewTools()]);

  const { tools: externalTools, errors: externalErrors } = await loadExternalMcpTools(config.mcp.servers);
  registry.registerMany(externalTools);

  const router = new ModelRouter(config);
  const agent = new Agent({ router, tools: registry, memory, config });

  return { agent, router, memory, config, tools: registry, externalErrors };
}

export async function runRepl(backend: ChatBackend): Promise<void> {
  const banner = await backend.describe();
  process.stdout.write(banner.join('\n') + '\n');

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  rl.on('SIGINT', () => {
    process.stdout.write('\nbye\n');
    process.exit(0);
  });

  for (;;) {
    let line: string;
    try {
      line = (await rl.question('jarv-genie> ')).trim();
    } catch {
      break;
    }
    if (!line) continue;

    if (line.startsWith('/')) {
      await handleCommand(line, backend);
      continue;
    }

    try {
      if (backend.chatStream) {
        process.stdout.write('\n');
        await backend.chatStream(line, (d) => process.stdout.write(d));
        process.stdout.write('\n\n');
      } else {
        const result = await backend.chat(line);
        process.stdout.write(`\n${result.text}\n\n`);
      }
    } catch (err) {
      process.stdout.write(`\nError: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }
}

async function handleCommand(line: string, backend: ChatBackend): Promise<void> {
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
      await backend.reset();
      process.stdout.write('Session reset. Memory kept.\n');
      break;
    case 'model':
      if (arg) {
        const model = await backend.setModel(arg);
        process.stdout.write(`Primary model set to ${model}\n`);
      } else {
        process.stdout.write(`Primary model is ${await backend.model()}\n`);
      }
      break;
    case 'tools':
      for (const t of await backend.listTools()) {
        process.stdout.write(`  ${t.name}${t.description ? ` — ${t.description}` : ''}\n`);
      }
      break;
    case 'memory': {
      const summary = await backend.memorySummary();
      process.stdout.write(`${summary.count} fact${summary.count === 1 ? '' : 's'} remembered\n`);
      for (const s of summary.samples) process.stdout.write(s + '\n');
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

export async function runOneShot(backend: ChatBackend, prompt: string): Promise<void> {
  try {
    const result = await backend.chat(prompt);
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

  const voice = await import('../voice/index.js');
  process.stdout.write(`[${voice.hasTts() ? 'OK' : '--'}] tts: ${voice.voiceStatus.tts}\n`);
  process.stdout.write(
    `[${voice.hasWhisperCli() && voice.locateWhisperModel() ? 'OK' : '--'}] stt: ${voice.voiceStatus.stt}\n`,
  );

  const computer = await import('../computer/index.js');
  process.stdout.write(`[${computer.computerStatus(config).implemented ? 'OK' : '--'}] computer: ${computer.computerStatus(config).note}\n`);

  for (const err of externalErrors) process.stdout.write(`[FAIL] external mcp: ${err}\n`);
}

export { SESSION };
