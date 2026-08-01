import type { JarvGenieConfig } from '../config/index.js';

export type JSONValue = string | number | boolean | null | JSONValue[] | { [key: string]: JSONValue };

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  name?: string;
}

export interface ChatResult {
  content: string | null;
  toolCalls: ToolCall[] | null;
  provider: string;
  model: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
  handler: (args: Record<string, unknown>, ctx: ToolContext) => Promise<unknown>;
}

export interface ToolContext {
  memory: MemoryService;
  config: JarvGenieConfig;
  workdir: string;
}

export interface MemoryService {
  addFact(text: string, source?: string): Promise<{ id: string }>;
  recall(query: string, opts?: { k?: number; threshold?: number }): Promise<Array<{ id: string; text: string; score: number }>>;
  listFacts(): Promise<Array<{ id: string; text: string; createdAt: string }>>;
  deleteFact(id: string): Promise<boolean>;
  sessionLoad(sessionId: string): Promise<ChatMessage[]>;
  sessionAppend(sessionId: string, messages: ChatMessage[]): Promise<void>;
  sessionReset(sessionId: string): Promise<void>;
}
