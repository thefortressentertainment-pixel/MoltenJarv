import type { ModelRouter } from '../providers/index.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { JarvGenieConfig } from '../config/index.js';
import type { ChatMessage, MemoryService, ToolCall, ToolContext, ToolDefinition } from './types.js';
import { approvalActive, requireApproval } from '../approvals.js';
import { extractTextToolCalls } from './agent.js';

/**
 * Iterative plan→execute loop task runner. Unlike the conversational Agent,
 * this never mixes the user's chat history into the working context:
 *
 *   loop: ask the model (clean context, real tools exposed) → run each tool it
 *   calls (consent-gated) → feed the real results back → repeat until it gives
 *   a text answer or the step budget runs out.
 *
 * Multi-step tasks (search → edit → verify) work because the model sees each
 * tool's actual result before deciding the next move. The working context is
 * discarded afterwards, so nothing pollutes the conversation.
 */

export interface TaskRunnerOptions {
  router: ModelRouter;
  tools: ToolRegistry;
  memory: MemoryService;
  config: JarvGenieConfig;
}

export interface TaskResult {
  text: string;
  steps: number;
  toolCalls: number;
  provider: string;
  model: string;
}

export class TaskRunner {
  constructor(private opts: TaskRunnerOptions) {}

  /**
   * Expose tools to the model. Memory tools (remember/recall/list_facts) are
   * hidden unless the user's message is actually about memory — the model
   * otherwise invents memories and calls them on every task.
   */
  private usableTools(input: string): ToolDefinition[] {
    const all = this.opts.tools.list();
    if (/\b(remember|recall|memor(y|ies)|facts|what do you (know|remember)|do you remember)\b/i.test(input)) {
      return all;
    }
    return all.filter((t) => !['remember', 'recall', 'list_facts'].includes(t.name));
  }

  private systemPrompt(): string {
    const today = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    return `You are Jarv Genie, a helpful assistant running on the user's Mac. Today is ${today}.
Answer the user directly and concisely, or use the provided tools to complete their request when useful.
You have shell, UI-control, file, image-drawing, scheduling, web, and code tools. You can open or install apps, run commands, draw shapes, type, click, and edit code.
NEVER open, activate, or draw into apps (open_app, ui_activate, open_alarms, draw_shape, camera_capture) unless the user explicitly asks you to open, view, or create an image on screen. Checks, searches, test runs, and reports never require opening apps — use screen_capture if you need to see the screen (it opens nothing).
When using code_search, search for SPECIFIC identifiers (function or class names like composeSystemPrompt) rather than vague words — vague terms match documentation and miss the source.
To control an app (play music, open an app, send a message, adjust volume), use app_command — ONE call per action. Do not use UI clicking, keystrokes, or run_shell for this.
Setting or changing the volume must NEVER change music playback — do not play, pause, or toggle unless the user explicitly asked to. For an exact volume use app_command system volumeSet with value (0-100).
When a request needs several actions, call the tools TOGETHER in one response so they share a single approval — do not dribble them out one at a time.
To check the test suite or typecheck status, use self_review (returns a summary in one call) rather than running raw npm test.
Never call remember, recall, or list_facts unless the user explicitly asked you to save, retrieve, or review a memory — do not invent memories.
You can take several tool steps in sequence; after each result you decide the next one, until you have enough to answer.
Never say you cannot do something unless you actually tried the tools and they failed.
For schedules use numeric cron fields (0-6, Sunday=0, Saturday=6) and ISO 8601 dates relative to today.
Be honest: only ever claim an action succeeded if its tool result says it did.`;
  }

  private async execute(calls: ToolCall[], allowed: Set<string>): Promise<Array<Record<string, unknown>>> {
    const ctx: ToolContext = { memory: this.opts.memory, config: this.opts.config, workdir: this.opts.config.agent.workdir };
    const tools = this.opts.tools.list();
    const results: Array<Record<string, unknown>> = [];

    // Batch consent: if a consent channel is active and any of this round's
    // calls are consequential, ask ONCE for the whole batch instead of one
    // approval per call.
    let batchApproved: boolean | null = null;
    const consequential = calls
      .filter((c) => allowed.has(c.name))
      .map((c) => tools.find((t) => t.name === c.name))
      .filter((d) => d?.consequential);
    if (consequential.length > 0 && approvalActive()) {
      const desc = calls
        .filter((c) => allowed.has(c.name))
        .filter((c) => tools.find((t) => t.name === c.name)?.consequential)
        .map((c) => `${c.name}${JSON.stringify(c.arguments ?? {})}`)
        .join('; ');
      batchApproved = await requireApproval(desc);
    }

    for (const call of calls) {
      // Hard block: never run a tool that wasn't exposed for this task.
      if (!allowed.has(call.name)) {
        results.push({ tool: call.name, error: `not available for this task (only exposed tools may run)` });
        continue;
      }
      const def = tools.find((t) => t.name === call.name);
      if (!def) {
        results.push({ tool: call.name, error: `unknown tool` });
        continue;
      }
      const missing = (def.inputSchema.required ?? []).filter((r) => call.arguments[r] === undefined || call.arguments[r] === '');
      if (missing.length > 0) {
        results.push({ tool: call.name, error: `missing required argument(s): ${missing.join(', ')}` });
        continue;
      }
      if (def.consequential && approvalActive()) {
        if (batchApproved === false) {
          results.push({ tool: call.name, denied: true, error: 'user denied these actions — not performed' });
          continue;
        }
      }
      try {
        const { ok, result } = await this.opts.tools.execute(call.name, call.arguments, ctx);
        results.push({ tool: call.name, ok, result: ok ? result : { error: result } });
      } catch (err) {
        results.push({ tool: call.name, ok: false, result: { error: err instanceof Error ? err.message : String(err) } });
      }
    }
    return results;
  }

  async run(input: string): Promise<TaskResult> {
    const messages: ChatMessage[] = [
      { role: 'system', content: this.systemPrompt() },
      { role: 'user', content: input },
    ];
    const maxSteps = Math.max(1, this.opts.config.agent?.maxSteps ?? 8);
    const usable = this.usableTools(input);
    const toolNames = usable.map((t) => t.name);
    let steps = 0;
    let toolCalls = 0;
    let provider = 'primary';
    let model = 'local';
    let text = '';
    let nudged = false;

    while (steps < maxSteps) {
      steps++;
      const chat = await this.opts.router.chat({ messages, tools: usable });
      provider = chat.provider;
      model = chat.model;
      messages.push({ role: 'assistant', content: chat.content, toolCalls: chat.toolCalls ?? undefined });

      if (!chat.toolCalls || chat.toolCalls.length === 0) {
        const content = (chat.content ?? '').trim();
        const extracted = content ? extractTextToolCalls(content, toolNames) : [];
        if (extracted.length > 0) {
          toolCalls += extracted.length;
          const calls: ToolCall[] = extracted.map((e, i) => ({ id: `text-${i}`, name: e.name, arguments: e.args }));
          const results = await this.execute(calls, new Set(toolNames));
          results.forEach((r, i) => messages.push({ role: 'tool', toolCallId: calls[i]?.id ?? '', name: calls[i]?.name ?? '', content: JSON.stringify(r) }));
          continue;
        }
        if (content) {
          text = content;
          break;
        }
        if (!nudged) {
          nudged = true;
          messages.push({ role: 'system', content: 'Your response was empty. Answer the user or call a tool.' });
          continue;
        }
        text = "I couldn't produce a response. Please try again.";
        break;
      }

      toolCalls += chat.toolCalls.length;
      const results = await this.execute(chat.toolCalls, new Set(toolNames));
      chat.toolCalls.forEach((call, i) => {
        messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content: JSON.stringify(results[i] ?? {}) });
      });
    }

    return { text: text || "I hit my step limit while working through this — several steps likely waited on approvals or the task was long. Some actions may already be done. Tell me to continue or repeat the last part and I'll pick it up.", steps, toolCalls, provider, model };
  }

  /** Same iterative loop, streaming only the final answer's text deltas. */
  async runStream(input: string, onDelta: (delta: string) => void): Promise<TaskResult> {
    const messages: ChatMessage[] = [
      { role: 'system', content: this.systemPrompt() },
      { role: 'user', content: input },
    ];
    const maxSteps = Math.max(1, this.opts.config.agent?.maxSteps ?? 8);
    const usable = this.usableTools(input);
    const toolNames = usable.map((t) => t.name);
    let steps = 0;
    let toolCalls = 0;
    let provider = 'primary';
    let model = 'local';
    let text = '';
    let nudged = false;

    while (steps < maxSteps) {
      steps++;
      const buffered: string[] = [];
      const chat = await this.opts.router.streamChat(
        { messages, tools: usable },
        (d) => buffered.push(d),
      );
      provider = chat.provider;
      model = chat.model;
      messages.push({ role: 'assistant', content: chat.content, toolCalls: chat.toolCalls ?? undefined });

      if (!chat.toolCalls || chat.toolCalls.length === 0) {
        const content = (chat.content ?? '').trim();
        const extracted = content ? extractTextToolCalls(content, toolNames) : [];
        if (extracted.length > 0) {
          toolCalls += extracted.length;
          const calls: ToolCall[] = extracted.map((e, i) => ({ id: `text-${i}`, name: e.name, arguments: e.args }));
          const results = await this.execute(calls, new Set(toolNames));
          results.forEach((r, i) => messages.push({ role: 'tool', toolCallId: calls[i]?.id ?? '', name: calls[i]?.name ?? '', content: JSON.stringify(r) }));
          continue;
        }
        if (content) {
          text = content;
          for (const d of buffered) onDelta(d);
          break;
        }
        if (!nudged) {
          nudged = true;
          messages.push({ role: 'system', content: 'Your response was empty. Answer the user or call a tool.' });
          continue;
        }
        text = "I couldn't produce a response. Please try again.";
        for (const d of buffered) onDelta(d);
        break;
      }

      toolCalls += chat.toolCalls.length;
      const results = await this.execute(chat.toolCalls, new Set(toolNames));
      chat.toolCalls.forEach((call, i) => {
        messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content: JSON.stringify(results[i] ?? {}) });
      });
    }

    return { text: text || "I hit my step limit while working through this — several steps likely waited on approvals or the task was long. Some actions may already be done. Tell me to continue or repeat the last part and I'll pick it up.", steps, toolCalls, provider, model };
  }
}
