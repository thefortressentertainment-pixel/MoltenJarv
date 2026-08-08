import type { JarvGenieConfig } from '../config/index.js';

export type JSONValue = string | number | boolean | null | JSONValue[] | { [key: string]: JSONValue };

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/**
 * The body system a tool belongs to — Jarv is modeled as an organism, and
 * every tool is an organ of that organism. See docs/ANATOMY.md.
 */
export type BodySystem =
  | 'sense'       // perception: eyes, ears, reading, proprioception
  | 'effector'    // action: hands, arms, fingers, legs
  | 'memory'      // storage and recall
  | 'voice'       // speaking and hearing surfaces
  | 'autonomic'   // self-regulation: monitors, scheduler, shutdown
  | 'immune'      // defense and verification
  | 'integration'; // external channels: Telegram, web, calendar, email, Moltbook

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
  /** The body system this organ belongs to (see docs/ANATOMY.md). */
  system?: BodySystem;
  /** When true, the agent must get explicit human consent before executing (when a consent channel is active). */
  consequential?: boolean;
  /** Intrinsic side-effect category (see src/risk.ts). Overrides the consequential
   *  default classification: read | write-local | exec | external. */
  risk?: 'read' | 'write-local' | 'exec' | 'external';
  /** Set on tools imported from an external MCP server (namespaced `server__tool`). */
  mcpServer?: string;
  /**
   * Fail-closed consequential action. When true, the tool is externally visible,
   * irreversible, or otherwise too consequential to ever auto-fire silently.
   * Unlike a plain `consequential` tool (which auto-approves when the human is
   * physically present with no consent channel active), a `failClosed` tool
   * REQUIRES an explicit approval channel: if none is active, it refuses with a
   * clear error instead of running. Prevents hair-trigger external writes
   * (posts, emails, messages) during unattended scheduled runs.
   */
  failClosed?: boolean;
}

export interface ToolContext {
  memory: MemoryService;
  config: JarvGenieConfig;
  workdir: string;
  /** Writable/read-only roots sandboxing the file tools (see src/roots.ts). */
  roots?: {
    underAnyRoot(request: string): boolean;
    underWritableRoot(request: string): boolean;
    renderBoundary(): string;
  };
  /** The live tool registry, when the tool is running inside one (set by the
   *  registry before invoking a handler). Used by meta-tools like `use_tool`
   *  that need to dispatch to other registered tools by name. Structurally
   *  typed to avoid an import cycle with the registry module. */
  tools?: {
    execute(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<{ ok: boolean; result: unknown }>;
    list(): Array<{ name: string; mcpServer?: string }>;
  };
}

export interface MemoryService {
  addFact(text: string, source?: string): Promise<{ id: string }>;
  updateFact(id: string, text: string): Promise<{ id: string } | null>;
  recall(query: string, opts?: { k?: number; threshold?: number }): Promise<Array<{ id: string; text: string; score: number; rawScore?: number }>>;
  listFacts(): Promise<Array<{ id: string; text: string; createdAt: string }>>;
  deleteFact(id: string): Promise<boolean>;
  sessionLoad(sessionId: string): Promise<ChatMessage[]>;
  sessionAppend(sessionId: string, messages: ChatMessage[]): Promise<void>;
  sessionReset(sessionId: string): Promise<void>;
}
