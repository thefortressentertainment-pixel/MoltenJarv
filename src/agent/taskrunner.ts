import type { ModelRouter } from '../providers/index.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { JarvGenieConfig } from '../config/index.js';
import type { ChatMessage, MemoryService, ToolCall, ToolContext } from './types.js';
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

  private systemPrompt(): string {
    const today = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    return `You are Jarv Genie, a helpful assistant running on the user's Mac. Today is ${today}.
Answer the user directly and concisely, or use the provided tools to complete their request when useful.
You have shell, UI-control, file, image-drawing, scheduling, web, and code tools. You can open or install apps, run commands, draw shapes, type, click, and edit code.
NEVER open, activate, or draw into apps (open_app, ui_activate, open_alarms, draw_shape, camera_capture) unless the user explicitly asks you to open, view, or create an image on screen. Checks, searches, test runs, and reports never require opening apps — use screen_capture if you need to see the screen (it opens nothing).
When using code_search, search for SPECIFIC identifiers (function or class names like composeSystemPrompt) rather than vague words — vague terms match documentation and miss the source.
To check the test suite or typecheck status, use self_review (returns a summary in one call) rather than running raw npm test.
You can take several tool steps in sequence; after each result you decide the next one, until you have enough to answer.
Never say you cannot do something unless you actually tried the tools and they failed.
For schedules use numeric cron fields (0-6, Sunday=0, Saturday=6) and ISO 8601 dates relative to today.
Be honest: only ever claim an action succeeded if its tool result says it did.`;
  }

  private async execute(calls: ToolCall[]): Promise<Array<Record<string, unknown>>> {
    const ctx: ToolContext = { memory: this.opts.memory, config: this.opts.config, workdir: this.opts.config.agent.workdir };
    const tools = this.opts.tools.list();
    const results: Array<Record<string, unknown>> = [];
    for (const call of calls) {
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
        const approved = await requireApproval(`${call.name}${JSON.stringify(call.arguments ?? {})}`);
        if (!approved) {
          results.push({ tool: call.name, denied: true, error: 'user denied this action — not performed' });
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
    const toolNames = this.opts.tools.list().map((t) => t.name);
    let steps = 0;
    let toolCalls = 0;
    let provider = 'primary';
    let model = 'local';
    let text = '';
    let nudged = false;

    while (steps < maxSteps) {
      steps++;
      const chat = await this.opts.router.chat({ messages, tools: this.opts.tools.list() });
      provider = chat.provider;
      model = chat.model;
      messages.push({ role: 'assistant', content: chat.content, toolCalls: chat.toolCalls ?? undefined });

      if (!chat.toolCalls || chat.toolCalls.length === 0) {
        const content = (chat.content ?? '').trim();
        const extracted = content ? extractTextToolCalls(content, toolNames) : [];
        if (extracted.length > 0) {
          toolCalls += extracted.length;
          const calls: ToolCall[] = extracted.map((e, i) => ({ id: `text-${i}`, name: e.name, arguments: e.args }));
          const results = await this.execute(calls);
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
      const results = await this.execute(chat.toolCalls);
      chat.toolCalls.forEach((call, i) => {
        messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content: JSON.stringify(results[i] ?? {}) });
      });
    }

    return { text: text || "I couldn't complete that within my step budget. Please try again.", steps, toolCalls, provider, model };
  }

  /** Same iterative loop, streaming only the final answer's text deltas. */
  async runStream(input: string, onDelta: (delta: string) => void): Promise<TaskResult> {
    const messages: ChatMessage[] = [
      { role: 'system', content: this.systemPrompt() },
      { role: 'user', content: input },
    ];
    const maxSteps = Math.max(1, this.opts.config.agent?.maxSteps ?? 8);
    const toolNames = this.opts.tools.list().map((t) => t.name);
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
        { messages, tools: this.opts.tools.list() },
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
          const results = await this.execute(calls);
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
      const results = await this.execute(chat.toolCalls);
      chat.toolCalls.forEach((call, i) => {
        messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content: JSON.stringify(results[i] ?? {}) });
      });
    }

    return { text: text || "I couldn't complete that within my step budget. Please try again.", steps, toolCalls, provider, model };
  }
}
