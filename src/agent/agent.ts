import type { JarvGenieConfig } from '../config/index.js';
import { loadSoul, composeSystemPrompt } from '../config/soul.js';
import { approvalActive, requireApproval, approvalQuestion } from '../approvals.js';
import type { ModelRouter } from '../providers/index.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { ChatMessage, MemoryService, ToolCall, ToolContext } from './types.js';
import { composeRecentContextBlock } from './recentContext.js';

/** Parse tool invocations written as text, e.g. `schedule_add --cron "0 7 * * 6" --prompt "x"`. */
export function extractTextToolCalls(text: string, toolNames: string[]): Array<{ name: string; args: Record<string, unknown> }> {
  const out: Array<{ name: string; args: Record<string, unknown> }> = [];
  for (const name of toolNames) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`\\b${escaped}\\b((?:\\s+--[\\w-]+\\s+(?:"[^"]*"|'[^']*'|\\S+))+)`, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const args: Record<string, unknown> = {};
      const pairRe = /--([\w-]+)\s+(?:"([^"]*)"|'([^']*)'|([^\s"'"]+))/g;
      let p: RegExpExecArray | null;
      while ((p = pairRe.exec(m[1] ?? '')) !== null) {
        args[p[1] ?? ''] = p[2] ?? p[3] ?? p[4] ?? '';
      }
      if (Object.keys(args).length > 0) out.push({ name, args });
    }
  }
  return out;
}

export interface AgentResult {
  text: string;
  steps: number;
  toolCalls: number;
  provider: string;
  model: string;
}

export interface AgentStreamResult extends AgentResult {}

/** Budget for the in-context session tail, in characters (~20k tokens). The
 * recent-context block in the system prompt carries a compact excerpt of the
 * wider thread, so the tail only needs the most recent turns. */
const MAX_HISTORY_CHARS = 80_000;

/**
 * Bound the session history sent to the model. The session store appends every
 * turn forever (this REPL's default session is megabytes), which would exceed
 * any model's context window and fail the request. Keeps the newest turns up
 * to the budget, then drops any dangling tool results whose assistant
 * tool_calls were trimmed away so the OpenAI message chain stays valid.
 */
export function trimHistory(history: ChatMessage[]): ChatMessage[] {
  const tail: ChatMessage[] = [];
  let size = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (!m) continue;
    const cost = (m.content ?? '').length + 64;
    if (tail.length > 0 && size + cost > MAX_HISTORY_CHARS) break;
    tail.push(m);
    size += cost;
  }
  tail.reverse();
  const start = tail.findIndex((m) => m.role !== 'tool');
  return start > 0 ? tail.slice(start) : tail;
}

/**
 * Tool-calling agent loop: assemble context, ask the model, execute any tool
 * calls it makes, feed results back, and repeat until a final answer or the
 * step budget is exhausted.
 */
export class Agent {
  constructor(
    private opts: {
      router: ModelRouter;
      tools: ToolRegistry;
      memory: MemoryService;
      config: JarvGenieConfig;
    },
  ) {}

  async run(input: string, sessionId?: string): Promise<AgentResult> {
    return this.loop(input, sessionId, null);
  }

  /**
   * Run the loop and stream the final answer's text deltas via `onDelta`.
   * Text generated on intermediate (tool-calling) steps is not streamed —
   * only the eventual answer is.
   */
  async runStream(input: string, sessionId: string | undefined, onDelta: (delta: string) => void): Promise<AgentStreamResult> {
    return this.loop(input, sessionId, onDelta);
  }

  private async loop(input: string, sessionId: string | undefined, onDelta: ((delta: string) => void) | null): Promise<AgentResult> {
    const config = this.opts.config;
    const history = sessionId ? await this.opts.memory.sessionLoad(sessionId) : [];
    // Recent-context skill: keep the last ~2 hours of conversation pinned in
    // the system prompt so a long thread can't push it out of the model's
    // attention. Build the system message after loading history (it needs it).
    const system: ChatMessage = {
      role: 'system',
      content:
        composeSystemPrompt(config.agent.systemPrompt, loadSoul(config.agent.soulPath)) +
        composeRecentContextBlock(history),
    };
    // The session store grows unbounded, so the raw history can exceed any
    // model's context window (and break the request outright). Send a bounded
    // tail of the most recent turns; the recent-context block above still
    // carries a compact excerpt of the wider thread.
    const trimmed = trimHistory(history);
    const messages: ChatMessage[] = [system, ...trimmed, { role: 'user', content: input }];
    const firstNewIndex = trimmed.length + 1;

    let steps = 0;
    let toolCalls = 0;
    let text = '';
    let provider = '';
    let model = '';
    let nudged = false;
    let errorNudged = false;

    while (steps < config.agent.maxSteps) {
      steps++;
      const buffered: string[] = [];
      const emit = onDelta
        ? (d: string) => {
            buffered.push(d);
          }
        : null;
      const chat = emit
        ? await this.opts.router.streamChat({ messages, tools: this.opts.tools.list() }, emit)
        : await this.opts.router.chat({ messages, tools: this.opts.tools.list() });
      provider = chat.provider;
      model = chat.model;

      messages.push({ role: 'assistant', content: chat.content, toolCalls: chat.toolCalls ?? undefined });

      const ctx: ToolContext = { memory: this.opts.memory, config, workdir: config.agent.workdir };
      const toolNames = this.opts.tools.list().map((t) => t.name);

      if (!chat.toolCalls || chat.toolCalls.length === 0) {
        const content = chat.content ?? '';
        // The model may have written a tool invocation as text instead of calling
        // it. Intercept those and execute them for real (still consent-gated).
        const extracted = content.trim() ? extractTextToolCalls(content, toolNames) : [];
        if (extracted.length > 0) {
          toolCalls += extracted.length;
          let i = 0;
          for (const e of extracted) {
            const errored = await this.executeCall({ id: `text-${i++}`, name: e.name, arguments: e.args }, messages, ctx, toolNames);
            if (errored && !errorNudged) {
              errorNudged = true;
              messages.push({ role: 'system', content: 'A tool you called returned an error. Report this to the user honestly: say the action did NOT succeed and why. Do not claim it succeeded.' });
            }
          }
          continue;
        }
        if (content.trim()) {
          text = content;
          if (emit && onDelta) for (const d of buffered) onDelta(d);
          break;
        }
        if (!nudged) {
          nudged = true;
          messages.push({
            role: 'system',
            content: 'Your last response was empty. Respond to the user directly with a short text answer, using tools if needed.',
          });
          continue;
        }
        text = "I couldn't produce a response just now. Please rephrase, or try again.";
        if (emit && onDelta) for (const d of buffered) onDelta(d);
        break;
      }

      toolCalls += chat.toolCalls.length;
      for (const call of chat.toolCalls) {
        const errored = await this.executeCall(call, messages, ctx, toolNames);
        if (errored && !errorNudged) {
          errorNudged = true;
          messages.push({ role: 'system', content: 'A tool you called returned an error. Report this to the user honestly: say the action did NOT succeed and why. Do not claim it succeeded.' });
        }
      }
    }

    if (sessionId) {
      await this.opts.memory.sessionAppend(sessionId, messages.slice(firstNewIndex));
    }

    return { text, steps, toolCalls, provider, model };
  }

  /** Run one tool call with the consent gate. Returns true if the call errored. */
  private async executeCall(call: ToolCall, messages: ChatMessage[], ctx: ToolContext, toolNames: string[]): Promise<boolean> {
    if (!toolNames.includes(call.name)) {
      messages.push({
        role: 'tool',
        toolCallId: call.id,
        name: call.name,
        content: JSON.stringify({
          error: `Unknown tool "${call.name}". Available tools: ${toolNames.join(', ')}. Choose one of these.`,
        }),
      });
      return true;
    }
    const def = this.opts.tools.list().find((t) => t.name === call.name);
    if (def?.consequential && approvalActive()) {
      const approved = await requireApproval(approvalQuestion(call.name, call.arguments));
      if (!approved) {
        messages.push({
          role: 'tool',
          toolCallId: call.id,
          name: call.name,
          content: JSON.stringify({ error: 'the user denied this action — do not perform it' }),
        });
        return true;
      }
    }
    const { ok, result } = await this.opts.tools.execute(call.name, call.arguments, ctx);
    messages.push({
      role: 'tool',
      toolCallId: call.id,
      name: call.name,
      content: ok ? JSON.stringify(result) : JSON.stringify({ error: result }),
    });
    return !ok;
  }
}
