import type { ModelRouter } from '../providers/index.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { JarvGenieConfig } from '../config/index.js';
import type { ChatMessage, MemoryService, ToolContext } from './types.js';
import { approvalActive, requireApproval } from '../approvals.js';

/**
 * Plan → execute → report task runner. Unlike the conversational Agent, this
 * never mixes the user's chat history into the working context:
 *
 *   1. PLAN: ask the model (clean context, tool catalog as text) for a JSON
 *      plan — either tool calls or a plain answer.
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

interface Plan {
  action: 'tools' | 'answer';
  text?: string;
  calls?: Array<{ name: string; arguments: Record<string, unknown> }>;
}

function extractJson(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

export class TaskRunner {
  constructor(private opts: TaskRunnerOptions) {}

  private async ask(messages: ChatMessage[]): Promise<{ content: string | null; provider: string; model: string }> {
    const chat = await this.opts.router.chat({ messages, tools: [] });
    return { content: chat.content, provider: chat.provider, model: chat.model };
  }

  private toolCatalog(): string {
    return this.opts.tools
      .list()
      .map((t) => {
        const required = (t.inputSchema.required ?? []).join(', ');
        return `${t.name}${required ? ` (requires: ${required})` : ''} — ${t.description}`;
      })
      .join('\n');
  }

  private async plan(input: string): Promise<{ plan: Plan; provider: string; model: string }> {
    const today = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    const system = `You convert a user request into concrete tool calls. Today is ${today}.

Available tools:
${this.toolCatalog()}

Return ONLY a JSON object (no markdown fences, no prose) with one of these shapes:
1) To call tools: {"action":"tools","calls":[{"name":"<tool>","arguments":{...}}]}
2) To reply without tools: {"action":"answer","text":"<your reply>"}

Rules:
- Never invent tool names; use only the tools listed above.
- For schedules/reminders use numeric cron fields (0-6, Sunday=0, Saturday=6) and ISO 8601 dates relative to today.
- Only include arguments the tool actually requires or accepts.`;

    const messages: ChatMessage[] = [
      { role: 'system', content: system },
      { role: 'user', content: input },
    ];

    let res = await this.ask(messages);
    for (let attempt = 0; attempt < 2; attempt++) {
      const parsed = extractJson(res.content ?? '');
      if (parsed && typeof parsed === 'object') {
        const p = parsed as Plan;
        if (p.action === 'answer' || p.action === 'tools') {
          const validNames = new Set(this.opts.tools.list().map((t) => t.name));
          const calls = (p.calls ?? []).filter((c) => c && typeof c.name === 'string' && validNames.has(c.name));
          return { plan: { action: p.action, text: p.text, calls }, provider: res.provider, model: res.model };
        }
      }
      messages.push({ role: 'system', content: 'That was not a valid JSON plan. Return ONLY a JSON object with an "action" key.' });
      res = await this.ask(messages);
    }
    return { plan: { action: 'answer', text: res.content ?? "I couldn't parse that request into a task." }, provider: res.provider, model: res.model };
  }

  private async execute(calls: Array<{ name: string; arguments: Record<string, unknown> }>): Promise<Array<Record<string, unknown>>> {
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
    const res = await this.ask([
      { role: 'system', content: system },
      { role: 'user', content: `Request: ${input}\n\nTool results:\n${JSON.stringify(results, null, 2)}` },
    ]);
    return { text: res.content ?? '(no response)', provider: res.provider, model: res.model };
  }

  async run(input: string): Promise<TaskResult> {
    const { plan, provider, model } = await this.plan(input);

    if (plan.action === 'answer' || !plan.calls || plan.calls.length === 0) {
      return { text: plan.text ?? '(no response)', steps: 1, toolCalls: 0, provider, model };
    }

    const results = await this.execute(plan.calls);
    const reported = await this.report(input, results);
    return { text: reported.text, steps: 2, toolCalls: plan.calls.length, provider: reported.provider, model: reported.model };
  }
}
