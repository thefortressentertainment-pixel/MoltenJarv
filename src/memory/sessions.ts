import fs from 'node:fs/promises';
import path from 'node:path';
import type { ChatMessage } from '../agent/types.js';

/** Append-only JSONL store of conversation turns, keyed by session id. */
export class SessionStore {
  constructor(private dir: string) {}

  private file(id: string): string {
    return path.join(this.dir, `${id}.jsonl`);
  }

  async append(id: string, messages: ChatMessage[]): Promise<void> {
    if (messages.length === 0) return;
    await fs.mkdir(this.dir, { recursive: true });
    const lines = messages.map((m) => JSON.stringify(m)).join('\n');
    await fs.appendFile(this.file(id), lines + '\n');
  }

  async load(id: string): Promise<ChatMessage[]> {
    try {
      const raw = await fs.readFile(this.file(id), 'utf8');
      return raw.split('\n').filter((l) => l.length > 0).map((l) => JSON.parse(l) as ChatMessage);
    } catch {
      return [];
    }
  }

  async reset(id: string): Promise<void> {
    try {
      await fs.unlink(this.file(id));
    } catch {
      // nothing to reset
    }
  }
}
