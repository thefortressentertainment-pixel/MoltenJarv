import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * The Inbox — a persisted, idempotent "parked ask" queue, adapted from
 * andrewyng/openworker's `coworker/inbox.py` (MIT).
 *
 * Blocking actions (approvals, questions, plan confirmations) become first-class
 * `pending → resolved` items. Each is keyed by `(sessionId, toolCallId)` so a
 * durable resume re-raises the same prompt safely (idempotent). Visibility splits
 * into `inline` (attended: redeliver on reconnect) vs `inbox` (unattended:
 * cross-session queue the human answers later). Resolution is first-responder-wins,
 * so answering from any surface is safe.
 *
 * This store is `indexed by item and keyed so nothing is lost and nothing is
 * double-answered`.
 */

export type InboxVisibility = 'inline' | 'inbox';
export type InboxStatus = 'pending' | 'resolved';

export interface InboxItem {
  id: string;
  sessionId: string;
  toolCallId: string;
  prompt: string;
  visibility: InboxVisibility;
  status: InboxStatus;
  createdAt: string;
  resolvedAt?: string;
  resolution?: boolean;
  note?: string;
}

export interface InboxOptions {
  inline?: boolean;
}

export class Inbox {
  private items: InboxItem[] = [];
  private loaded = false;

  constructor(private file: string) {}

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    try {
      const raw = JSON.parse(await fs.readFile(this.file, 'utf8')) as InboxItem[];
      this.items = Array.isArray(raw) ? raw : [];
    } catch {
      this.items = [];
    }
    this.loaded = true;
  }

  private async save(): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await fs.writeFile(this.file, JSON.stringify(this.items, null, 2) + '\n');
  }

  /**
   * Park an ask. Idempotent by `(sessionId, toolCallId)`: raising the same prompt
   * again returns the existing pending item rather than duplicating it. Returns
   * the item. When a pending item already exists, its visibility is upgraded to
   * `inline` only if the prior was inline (keeps unattended traffic in the inbox).
   */
  async park(
    sessionId: string,
    toolCallId: string,
    prompt: string,
    opts: InboxOptions = {},
  ): Promise<InboxItem> {
    await this.ensureLoaded();
    const existing = this.items.find(
      (i) => i.sessionId === sessionId && i.toolCallId === toolCallId && i.status === 'pending',
    );
    if (existing) {
      if (opts.inline && existing.visibility !== 'inline') existing.visibility = 'inline';
      return existing;
    }
    const item: InboxItem = {
      id: `inbox-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      sessionId,
      toolCallId,
      prompt,
      visibility: opts.inline ? 'inline' : 'inbox',
      status: 'pending',
      createdAt: new Date().toISOString(),
    };
    this.items.push(item);
    await this.save();
    return item;
  }

  /** All pending items, oldest first. */
  async pending(): Promise<InboxItem[]> {
    await this.ensureLoaded();
    return this.items.filter((i) => i.status === 'pending').sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async list(): Promise<InboxItem[]> {
    await this.ensureLoaded();
    return [...this.items].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** First-responder-wins resolution. Returns true if this caller resolved it. */
  async resolve(sessionId: string, toolCallId: string, approval: boolean, note?: string): Promise<boolean> {
    await this.ensureLoaded();
    const item = this.items.find(
      (i) => i.sessionId === sessionId && i.toolCallId === toolCallId && i.status === 'pending',
    );
    if (!item) return false;
    item.status = 'resolved';
    item.resolvedAt = new Date().toISOString();
    item.resolution = approval;
    if (note !== undefined) item.note = note;
    await this.save();
    return true;
  }

  /** Resolve by item id (used when answering from a mirror that only shows the id). */
  async resolveById(id: string, approval: boolean, note?: string): Promise<boolean> {
    await this.ensureLoaded();
    const item = this.items.find((i) => i.id === id && i.status === 'pending');
    if (!item) return false;
    item.status = 'resolved';
    item.resolvedAt = new Date().toISOString();
    item.resolution = approval;
    if (note !== undefined) item.note = note;
    await this.save();
    return true;
  }

  async get(id: string): Promise<InboxItem | undefined> {
    await this.ensureLoaded();
    return this.items.find((i) => i.id === id);
  }
}
