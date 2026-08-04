import type { JarvGenieConfig } from '../config/index.js';
import { loadSoul, composeSystemPrompt } from '../config/soul.js';
import { approvalActive, requireApproval } from '../approvals.js';
import type { ModelRouter } from '../providers/index.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { ChatMessage, MemoryService, ToolContext } from './types.js';

export interface AgentResult {
  text: string;
  steps: number;
  toolCalls: number;
  provider: string;
  model: string;
}

export interface AgentStreamResult extends AgentResult {}

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
    const system: ChatMessage = { role: 'system', content: composeSystemPrompt(config.agent.systemPrompt, loadSoul(config.agent.soulPath)) };
    const history = sessionId ? await this.opts.memory.sessionLoad(sessionId) : [];
    const messages: ChatMessage[] = [system, ...history, { role: 'user', content: input }];
    const firstNewIndex = history.length + 1;

    let steps = 0;
    let toolCalls = 0;
    let text = '';
    let provider = '';
    let model = '';

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

      if (!chat.toolCalls || chat.toolCalls.length === 0) {
        text = chat.content ?? '';
        if (emit && onDelta) for (const d of buffered) onDelta(d);
        break;
      }

      toolCalls += chat.toolCalls.length;
      const ctx: ToolContext = { memory: this.opts.memory, config, workdir: config.agent.workdir };

      const toolNames = this.opts.tools.list().map((t) => t.name);
      for (const call of chat.toolCalls) {
        if (!toolNames.includes(call.name)) {
          messages.push({
            role: 'tool',
            toolCallId: call.id,
            name: call.name,
            content: JSON.stringify({
              error: `Unknown tool "${call.name}". Available tools: ${toolNames.join(', ')}. Choose one of these.`,
            }),
          });
          continue;
        }
        const def = this.opts.tools.list().find((t) => t.name === call.name);
        if (def?.consequential && approvalActive()) {
          const desc = `${call.name}${JSON.stringify(call.arguments ?? {})}`;
          const approved = await requireApproval(desc);
          if (!approved) {
            messages.push({
              role: 'tool',
              toolCallId: call.id,
              name: call.name,
              content: JSON.stringify({ error: 'the user denied this action — do not perform it' }),
            });
            continue;
          }
        }
        const { ok, result } = await this.opts.tools.execute(call.name, call.arguments, ctx);
        messages.push({
          role: 'tool',
          toolCallId: call.id,
          name: call.name,
          content: ok ? JSON.stringify(result) : JSON.stringify({ error: result }),
        });
      }
    }

    if (sessionId) {
      await this.opts.memory.sessionAppend(sessionId, messages.slice(firstNewIndex));
    }

    return { text, steps, toolCalls, provider, model };
  }
}
