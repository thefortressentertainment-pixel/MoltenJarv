import type { JarvGenieConfig } from '../config/index.js';
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
    const config = this.opts.config;
    const system: ChatMessage = { role: 'system', content: config.agent.systemPrompt };
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
      const chat = await this.opts.router.chat({ messages, tools: this.opts.tools.list() });
      provider = chat.provider;
      model = chat.model;

      messages.push({ role: 'assistant', content: chat.content, toolCalls: chat.toolCalls ?? undefined });

      if (!chat.toolCalls || chat.toolCalls.length === 0) {
        text = chat.content ?? '';
        break;
      }

      toolCalls += chat.toolCalls.length;
      const ctx: ToolContext = { memory: this.opts.memory, config, workdir: config.agent.workdir };

      for (const call of chat.toolCalls) {
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
