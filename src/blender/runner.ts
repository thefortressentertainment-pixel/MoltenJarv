import type { ToolDefinition, ToolCall, ChatMessage } from '../agent/types.js';
import type { ModelRouter } from '../providers/index.js';
import { ToolRegistry } from '../tools/registry.js';
import { systemTools } from '../tools/system.js';
import { fileTools } from '../tools/filesystem.js';
import { webTools } from '../tools/web.js';
import { extractTextToolCalls } from '../agent/agent.js';
import type { JarvGenieConfig } from '../config/index.js';

/**
 * Dedicated RAM-light Blender runner.
 *
 * WHY THIS EXISTS: the full `TaskRunner` + 84-tool registry + memory/RAG/judge
 * is memory-heavy and spawns lots of concurrent work. When Blender (and the GUI)
 * are already eating RAM on an 8GB M1, firing that at a "replicate Spyro" prompt
 * saturates memory → the Rainbow Wheel.
 *
 * This runner is deliberately minimal and memory-bounded:
 *  - A SCOPED tool registry with only Blender-relevant tools (run_shell,
 *    file read/write, web_search, screen_capture) — tiny schema, tiny context.
 *  - NO memory search, NO RAG, NO judge, NO skill bloat in the loop.
 *  - A fresh, isolated ModelRouter pointed at the SMALL local model (qwen2.5:0.5b)
 *    so work happens without a big cloud/context footprint.
 *  - Sequential single-step execution with a small step budget.
 *
 * The Blender add-on hits this handler (not /api/chat) so "he focuses only on
 * Blender at that moment."
 */

/** Only the tools a Blender prompt needs. `run_shell` drives headless blender;
 *  file read/write saves scripts/results; web finds assets; screen shows output. */
const BLENDER_TOOL_NAMES = new Set<string>([
  'run_shell',
  'file_read', 'file_write', 'file_list', 'file_delete',
  'web_search', 'web_read',
  'screen_capture',
]);

export interface BlenderRunInput {
  message: string;
  /** Blender path override; defaults to the primary (smart) model. */
  model?: string;
  /** Max agent steps (CPU bound). Default 8. */
  maxSteps?: number;
  /** Route to the small local model instead of the smart primary. */
  local?: boolean;
}

export interface BlenderRunResult {
  text: string;
  steps: number;
  toolCalls: number;
  provider: string;
  model: string;
  /** True when this used the small local model (not the heavy cloud path). */
  local: boolean;
}

const BLENDER_SYSTEM = (today: string): string =>
  `You are Jarv, working ONLY on a Blender task. The user is using Blender right now and memory/CPU are limited, so be terse and efficient.
Rules:
- Use run_shell to drive Blender HEADLESS: blender --background --python <script.py> -- <in> <out> <result.json>. Never open the Blender GUI for your own work.
- Before writing bpy code, introspect the real bpy API signature (Blender versions differ) rather than guessing symbol names.
- Write bpy scripts with file_write, run them with run_shell, read the JSON result, fix and retry (cap ~5 attempts).
- Use web_search/web_read only to find an asset or reference if the task needs one; prefer building in bpy when that's lighter.
- Keep each headless Blender invocation short-lived and bounded (~60-120s). Do not leave processes running.
- Stay on the ONE Blender task. Do not explore unrelated tools or memory. Reply concisely with what was done and where output is.
Today is ${today}.`;

export async function newBlenderRouter(config: JarvGenieConfig, forceLocal = false): Promise<ModelRouter> {
  const { ModelRouter } = await import('../providers/index.js');
  const router = new ModelRouter(config);
  // RAM is consumed by LOADED machinery (memory/RAG/84-tool registry), not by an
  // HTTP API call. So the default (smart cloud primary) is still RAM-light — the
  // isolated tiny toolset + no memory is what prevents the wheel. `forceLocal`
  // lets callers opt into the small local model for fully-offline/quiet work.
  if (forceLocal) {
    try {
      router.setPrimaryModel('qwen2.5:0.5b');
    } catch {
      /* keep configured primary */
    }
  }
  return router;
}

/** Build a scoped registry holding only Blender tools. */
export function blenderToolRegistry(config: JarvGenieConfig): ToolRegistry {
  const registry = new ToolRegistry();
  const all: ToolDefinition[] = [
    ...systemTools(),
    ...fileTools(),
    ...webTools(),
  ];
  const scoped = all.filter((t) => BLENDER_TOOL_NAMES.has(t.name));
  registry.registerMany(scoped);
  return registry;
}

/** Run the Blender task through the minimal, RAM-bounded loop. */
export async function runBlenderTask(config: JarvGenieConfig, input: BlenderRunInput): Promise<BlenderRunResult> {
  const forceLocal = input.local === true;
  const router = await newBlenderRouter(config, forceLocal);
  // Track whether we ended up on the small local model (qwen2.5:0.5b) or a cloud
  // primary. The isolation (tiny toolset + no memory) is what prevents the wheel;
  // the model choice affects capability, not RAM-at-rest.
  let usedLocal = forceLocal || String(input.model ?? '').includes('0.5b');
  const registry = blenderToolRegistry(config);
  const tools = registry.list();
  const toolNames = tools.map((t) => t.name);
  const maxSteps = Math.min(input.maxSteps ?? 8, 16);

  const today = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const messages: ChatMessage[] = [
    { role: 'system', content: BLENDER_SYSTEM(today) },
    { role: 'user', content: input.message },
  ];

  let steps = 0;
  let toolCalls = 0;
  let model = '';
  let provider = '';

  // Blender tools (run_shell, file, web) don't touch memory; a minimal no-op
  // stub satisfies the ToolContext type without loading the real memory store
  // (which would add RAM — the whole point of this runner).
  const noopMemory = {
    addFact: async () => ({ id: 'noop' }),
    updateFact: async () => null,
    recall: async () => [],
    listFacts: async () => [],
    deleteFact: async () => false,
    sessionLoad: async () => [],
    sessionAppend: async () => {},
    sessionReset: async () => {},
  };
  const ctx = { memory: noopMemory, config, workdir: config.agent.workdir };

  while (steps < maxSteps) {
    steps++;
    let chat;
    try {
      chat = await router.chat({ messages, tools });
    } catch (err) {
      return { text: `Blender runner model error: ${err instanceof Error ? err.message : String(err)}`, steps, toolCalls, provider, model, local: usedLocal };
    }
    provider = chat.provider;
    model = chat.model;
    if (String(chat.model).includes('0.5b') || String(chat.model).includes('llama')) usedLocal = true;
    messages.push({ role: 'assistant', content: chat.content, toolCalls: chat.toolCalls ?? undefined });

    const textCalls = chat.toolCalls ?? extractTextToolCalls(chat.content ?? '', toolNames).map((e, i) => ({ id: `text-${i}`, name: e.name, arguments: e.args }));
    const calls: ToolCall[] = Array.isArray(chat.toolCalls) ? chat.toolCalls : textCalls;
    if (calls.length === 0) {
      // Final answer.
      return { text: chat.content ?? '', steps, toolCalls, provider, model, local: usedLocal };
    }

    toolCalls += calls.length;
    for (const call of calls) {
      try {
        const { ok, result } = await registry.execute(call.name, call.arguments, ctx);
        messages.push({
          role: 'tool',
          toolCallId: call.id,
          name: call.name,
          content: JSON.stringify(ok ? result : { error: result }),
        });
      } catch (err) {
        messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) });
      }
    }
  }

  return { text: `Reached the ${maxSteps}-step budget for this Blender task; background work may continue. For more, split the request.`, steps, toolCalls, provider, model, local: usedLocal };
}

/** One-shot convenience for tests: run with a stubbed producer already wired. */
export async function runBlenderShell(config: JarvGenieConfig, script: string): Promise<{ ok: boolean; output: string }> {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const fs = await import('node:fs');
  const execFileAsync = promisify(execFile);
  // Locate the Blender binary: prefer PATH, then the macOS /Applications location.
  let blenderBin = 'blender';
  if (!await commandOnPath('blender')) {
    for (const p of ['/Applications/Blender.app/Contents/MacOS/Blender', '/Applications/Blender.app/Contents/MacOS/blender']) {
      if (fs.existsSync(p)) { blenderBin = p; break; }
    }
  }
  try {
    const res = await execFileAsync(blenderBin, ['--background', '--python-expr', script], { timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
    return { ok: true, output: res.stdout.trim() };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    return { ok: false, output: ((e.stdout ?? '') + (e.stderr ?? '')).slice(0, 2000) };
  }
}

async function commandOnPath(cmd: string): Promise<boolean> {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execFileAsync = promisify(execFile);
  try {
    await execFileAsync('which', [cmd]);
    return true;
  } catch {
    return false;
  }
}
