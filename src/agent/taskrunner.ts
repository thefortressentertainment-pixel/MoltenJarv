import type { ModelRouter } from '../providers/index.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { JarvGenieConfig } from '../config/index.js';
import type { ChatMessage, MemoryService, ToolCall, ToolContext, ToolDefinition } from './types.js';
import { approvalActive, requireApproval } from '../approvals.js';
import { extractTextToolCalls } from './agent.js';

/**
 * Plan → execute → report task runner. Unlike the conversational Agent, this
 * never mixes the user's chat history into the working context:
 *
 *   1. PLAN: ask the model (clean context, real tools exposed for native
 *      function calling) what it wants to do — a set of tool calls or an answer.
 *   2. EXECUTE: run each planned tool for real, with the consent gate applied
 *      to consequential tools.
 *   3. REPORT: ask the model to summarize the actual results honestly.
 *
 * The result is sent back to the user; the working context is discarded. This
 * is what keeps Jarv from getting confused by the conversation and faking work.
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

  private async ask(messages: ChatMessage[], tools: ToolDefinition[]): Promise<{ content: string | null; toolCalls: ToolCall[] | null; provider: string; model: string }> {
    const chat = await this.opts.router.chat({ messages, tools });
    return { content: chat.content, toolCalls: chat.toolCalls ?? null, provider: chat.provider, model: chat.model };
  }

  private async plan(input: string): Promise<{ calls: ToolCall[] | null; answer: string; provider: string; model: string }> {
    const today = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    const system = `You are Jarv Genie, a helpful assistant running on the user's Mac. Today is ${today}.
Answer the user directly and concisely, or use the provided tools to complete their request when useful.
You have shell, UI-control, file, image-drawing, scheduling, and web tools. You can open or install apps, run commands, draw shapes, type, and click.
Never say you cannot do something unless you actually tried the tools and they failed.
For schedules use numeric cron fields (0-6, Sunday=0, Saturday=6) and ISO 8601 dates relative to today.
Be honest: only ever claim an action succeeded if its tool result says it did.`;
    const messages: ChatMessage[] = [
      { role: 'system', content: system },
      { role: 'user', content: input },
    ];
    const toolNames = this.opts.tools.list().map((t) => t.name);

    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await this.ask(messages, this.opts.tools.list());
      if (res.toolCalls && res.toolCalls.length > 0) {
        return { calls: res.toolCalls, answer: '', provider: res.provider, model: res.model };
      }
      const content = (res.content ?? '').trim();
      // Fallback: the model may have written a tool call as text.
      const extracted = content ? extractTextToolCalls(content, toolNames) : [];
      if (extracted.length > 0) {
        const calls: ToolCall[] = extracted.map((e, i) => ({ id: `text-${i}`, name: e.name, arguments: e.args }));
        return { calls, answer: '', provider: res.provider, model: res.model };
      }
      if (content) return { calls: null, answer: content, provider: res.provider, model: res.model };
      messages.push({ role: 'system', content: 'Your response was empty. Answer the user or call a tool.' });
    }
    return { calls: null, answer: "I couldn't produce a response. Please try again.", provider: 'primary', model: 'qwen2.5:3b' };
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

  private async report(input: string, results: Array<Record<string, unknown>>): Promise<{ text: string; provider: string; model: string }> {
    const system =
      'You are reporting what was just executed on the user\'s machine. Summarize concisely and naturally what happened and the outcome. If a step failed, was denied, or did nothing, say so honestly — never claim something succeeded that did not.';
    const messages: ChatMessage[] = [
      { role: 'system', content: system },
      { role: 'user', content: `Request: ${input}\n\nTool results:\n${JSON.stringify(results, null, 2)}` },
    ];
    let res = await this.ask(messages, []);
    for (let attempt = 0; attempt < 2 && !(res.content ?? '').trim(); attempt++) {
      messages.push({ role: 'system', content: 'Your report was empty. Give the user a short, honest summary of the results.' });
      res = await this.ask(messages, []);
    }
    const text = (res.content ?? '').trim();
    if (text) return { text, provider: res.provider, model: res.model };
    return { text: `Done. Results:\n${JSON.stringify(results, null, 2)}`, provider: res.provider, model: res.model };
  }

  async run(input: string): Promise<TaskResult> {
    const { calls, answer, provider, model } = await this.plan(input);

    if (!calls || calls.length === 0) {
      return { text: answer || '(no response)', steps: 1, toolCalls: 0, provider, model };
    }

    const results = await this.execute(calls);
    const reported = await this.report(input, results);
    return { text: reported.text, steps: 2, toolCalls: calls.length, provider: reported.provider, model: reported.model };
  }

  /**
   * Same plan→execute→report flow, but streams the final report's text deltas
   * via `onDelta`. Planning and execution are hidden; only the summary streams.
   */
  async runStream(input: string, onDelta: (delta: string) => void): Promise<TaskResult> {
    const { calls, answer, provider, model } = await this.plan(input);

    if (!calls || calls.length === 0) {
      onDelta(answer || '(no response)');
      return { text: answer || '(no response)', steps: 1, toolCalls: 0, provider, model };
    }

    const results = await this.execute(calls);
    const system =
      'You are reporting what was just executed on the user\'s machine. Summarize concisely and naturally what happened and the outcome. If a step failed, was denied, or did nothing, say so honestly — never claim something succeeded that did not.';
    const messages: ChatMessage[] = [
      { role: 'system', content: system },
      { role: 'user', content: `Request: ${input}\n\nTool results:\n${JSON.stringify(results, null, 2)}` },
    ];
    const chat = await this.opts.router.streamChat({ messages, tools: [] }, onDelta);
    const text = (chat.content ?? '').trim();
    return { text: text || 'Done.', steps: 2, toolCalls: calls.length, provider: chat.provider, model: chat.model };
  }
}
