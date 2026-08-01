import type { RemoteClient } from '../remote/client.js';
import { VERSION } from '../config/defaults.js';
import type { AgentContext } from './index.js';
import { SESSION } from './index.js';

export interface ChatReply {
  text: string;
  provider: string;
  model: string;
}

export interface MemorySummary {
  count: number;
  samples: string[];
}

/** Abstraction the CLI talks to: a local brain or a remote hub. */
export interface ChatBackend {
  kind: 'local' | 'remote';
  describe(): Promise<string[]>;
  chat(message: string): Promise<ChatReply>;
  /** Stream a chat, yielding text deltas as they arrive. Optional. */
  chatStream?(message: string, onDelta: (delta: string) => void): Promise<ChatReply>;
  reset(): Promise<void>;
  model(): Promise<string>;
  setModel(model: string): Promise<string>;
  listTools(): Promise<Array<{ name: string; description: string }>>;
  memorySummary(): Promise<MemorySummary>;
}

export function localBackend(ctx: AgentContext): ChatBackend {
  return {
    kind: 'local',
    async describe() {
      const tools = await ctx.tools.list();
      return [
        `Jarv Genie v${VERSION}`,
        `  primary : ${ctx.router.providers[0]?.label ?? 'none'}`,
        `  memory  : ${ctx.config.memory.dir}`,
        `  tools   : ${tools.length} registered (${ctx.externalErrors.length ? `${ctx.externalErrors.length} external failed` : 'all connected'})`,
        'Type /help for commands, or just talk.',
      ];
    },
    async chat(message) {
      const result = await ctx.agent.run(message, SESSION);
      return { text: result.text, provider: result.provider, model: result.model };
    },
    async chatStream(message, onDelta) {
      const result = await ctx.agent.runStream(message, SESSION, onDelta);
      return { text: result.text, provider: result.provider, model: result.model };
    },
    async reset() {
      await ctx.memory.sessionReset(SESSION);
    },
    async model() {
      return ctx.router.primaryModel;
    },
    async setModel(model) {
      ctx.router.setPrimaryModel(model);
      return ctx.router.primaryModel;
    },
    async listTools() {
      return ctx.tools.list().map((t) => ({ name: t.name, description: t.description?.split('\n')[0] ?? '' }));
    },
    async memorySummary() {
      const facts = await ctx.memory.listFacts();
      return { count: facts.length, samples: facts.slice(0, 10).map((f) => `  [${f.id.slice(0, 8)}] ${f.text}`) };
    },
  };
}

export function remoteBackend(client: RemoteClient): ChatBackend {
  return {
    kind: 'remote',
    async describe() {
      const s = await client.status();
      return [
        `Jarv Genie v${s.version} (remote hub)`,
        `  primary : ${s.providers.join(' · ') || 'none'}`,
        `  tools   : ${s.tools.length} registered (${s.externalErrors.length ? `${s.externalErrors.length} external failed` : 'all connected'})`,
        'Type /help for commands, or just talk.',
      ];
    },
    async chat(message) {
      const result = await client.chat(message);
      return { text: result.text, provider: result.provider, model: result.model };
    },
    async chatStream(message, onDelta) {
      const result = await client.chatStream(message, onDelta);
      return { text: result.text, provider: result.provider, model: result.model };
    },
    async reset() {
      await client.reset();
    },
    async model() {
      return (await client.status()).model;
    },
    async setModel(model) {
      const res = await client.setModel(model);
      return res.model;
    },
    async listTools() {
      const s = await client.status();
      return s.tools.map((name) => ({ name, description: '' }));
    },
    async memorySummary() {
      const s = await client.status();
      return { count: s.facts, samples: [] };
    },
  };
}
