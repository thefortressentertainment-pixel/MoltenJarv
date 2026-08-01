import type { ChatMessage, ChatResult, ToolDefinition } from '../agent/types.js';

export interface ChatOptions {
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  signal?: AbortSignal;
}

export interface Provider {
  readonly id: string;
  readonly label: string;
  readonly model: string;
  setModel(model: string): void;
  chat(opts: ChatOptions): Promise<ChatResult>;
  ping(): Promise<boolean>;
}
