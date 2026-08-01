import OpenAI from 'openai';
import type { ChatOptions, Provider } from './types.js';
import type { ChatMessage, ChatResult, ToolCall, ToolDefinition } from '../agent/types.js';
import { resolveApiKey, type EndpointConfig } from '../config/index.js';

type OpenAIMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;

/**
 * A provider backed by any OpenAI-compatible endpoint: OpenAI, Ollama, LM Studio,
 * vLLM, Groq, Together, DeepSeek, local gateways, and so on.
 */
export class OpenAICompatibleProvider implements Provider {
  readonly id: string;
  private client: OpenAI;
  private currentModel: string;

  constructor(id: string, private displayName: string, cfg: EndpointConfig) {
    this.id = id;
    this.currentModel = cfg.model;
    this.client = new OpenAI({
      apiKey: resolveApiKey(cfg) ?? 'not-set',
      ...(cfg.baseUrl ? { baseURL: cfg.baseUrl } : {}),
    });
  }

  get label(): string {
    return `${this.displayName} (${this.currentModel})`;
  }

  get model(): string {
    return this.currentModel;
  }

  setModel(model: string): void {
    if (model) this.currentModel = model;
  }

  async chat(opts: ChatOptions): Promise<ChatResult> {
    const completion = await this.client.chat.completions.create(
      {
        model: this.currentModel,
        messages: this.toOpenAIMessages(opts.messages),
        ...(opts.tools && opts.tools.length > 0 ? { tools: this.toOpenAITools(opts.tools) } : {}),
      },
      opts.signal ? { signal: opts.signal } : {},
    );
    const message = completion.choices?.[0]?.message;
    if (!message) throw new Error('Empty completion response');
    return this.toChatResult(message);
  }

  async streamChat(opts: ChatOptions, onDelta: (delta: string) => void): Promise<ChatResult> {
    const stream = await this.client.chat.completions.create(
      {
        model: this.currentModel,
        messages: this.toOpenAIMessages(opts.messages),
        stream: true,
        ...(opts.tools && opts.tools.length > 0 ? { tools: this.toOpenAITools(opts.tools) } : {}),
      },
      opts.signal ? { signal: opts.signal } : {},
    );

    let content = '';
    const rawCalls: Array<{ id: string; name: string; arguments: string }> = [];
    for await (const chunk of stream) {
      const delta = chunk.choices?.[0]?.delta;
      if (delta?.content) {
        content += delta.content;
        onDelta(delta.content);
      }
      for (const tc of delta?.tool_calls ?? []) {
        const idx = tc.index ?? 0;
        const call = (rawCalls[idx] ??= { id: '', name: '', arguments: '' });
        if (tc.id) call.id += tc.id;
        if (tc.function?.name) call.name += tc.function.name;
        if (tc.function?.arguments) call.arguments += tc.function.arguments;
      }
    }

    const toolCalls: ToolCall[] | null =
      rawCalls.length > 0
        ? rawCalls
            .filter((c) => c.name)
            .map((c) => ({ id: c.id || `call_${Math.random().toString(36).slice(2)}`, name: c.name, arguments: parseArguments(c.arguments) }))
        : null;
    return { content: content || null, toolCalls, provider: this.id, model: this.currentModel };
  }

  private toChatResult(message: OpenAI.Chat.Completions.ChatCompletionMessage): ChatResult {
    const toolCalls: ToolCall[] | null = message.tool_calls?.length
      ? message.tool_calls
          .filter((tc): tc is OpenAI.Chat.Completions.ChatCompletionMessageFunctionToolCall => tc.type === 'function')
          .map((tc) => ({
            id: tc.id,
            name: tc.function.name,
            arguments: parseArguments(tc.function.arguments),
          }))
      : null;
    return { content: message.content ?? null, toolCalls, provider: this.id, model: this.currentModel };
  }

  async ping(): Promise<boolean> {
    try {
      const res = await this.client.chat.completions.create({
        model: this.currentModel,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1,
      });
      return Boolean(res.choices?.[0]);
    } catch {
      return false;
    }
  }

  private toOpenAITools(tools: ToolDefinition[]): OpenAI.Chat.Completions.ChatCompletionTool[] {
    return tools.map((t) => ({
      type: 'function' as const,
      function: { name: t.name, description: t.description, parameters: t.inputSchema },
    }));
  }

  private toOpenAIMessages(messages: ChatMessage[]): OpenAIMessage[] {
    return messages.map((m) => {
      switch (m.role) {
        case 'system':
          return { role: 'system', content: m.content ?? '' };
        case 'user':
          return { role: 'user', content: m.content ?? '' };
        case 'assistant': {
          const base: OpenAIMessage = { role: 'assistant', content: m.content ?? '' };
          if (m.toolCalls?.length) {
            (base as { tool_calls?: unknown[] }).tool_calls = m.toolCalls.map((tc) => ({
              id: tc.id,
              type: 'function' as const,
              function: { name: tc.name, arguments: JSON.stringify(tc.arguments ?? {}) },
            }));
          }
          return base;
        }
        case 'tool':
          return { role: 'tool', tool_call_id: m.toolCallId ?? '', content: m.content ?? '' };
      }
    });
  }
}

function parseArguments(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}
