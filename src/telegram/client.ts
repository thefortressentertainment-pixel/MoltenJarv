/**
 * Minimal Telegram Bot API client (no dependencies, uses fetch). Configure the
 * bot token with: jarv-genie key set TELEGRAM_BOT_TOKEN <token>
 * and the authorized chat id with: jarv-genie key set TELEGRAM_CHAT_ID <id>
 */

export interface TgUpdate {
  update_id: number;
  message?: {
    message_id: number;
    chat: { id: number | string };
    text?: string;
    caption?: string;
    reply_to_message?: {
      message_id: number;
      text?: string;
      caption?: string;
    };
    photo?: { file_id: string; width?: number; height?: number; file_size?: number }[];
    document?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number };
  };
}

export class TelegramClient {
  constructor(private token: string) {}

  private url(method: string, params?: Record<string, string | number>): string {
    const base = `https://api.telegram.org/bot${this.token}/${method}`;
    if (!params) return base;
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) qs.set(k, String(v));
    return `${base}?${qs.toString()}`;
  }

  private async call<T>(method: string, body?: Record<string, unknown>, params?: Record<string, string | number>): Promise<T> {
    const res = await fetch(this.url(method, params), {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(35_000),
    });
    const data = (await res.json()) as { ok: boolean; description?: string; result?: T };
    if (!data.ok) throw new Error(`telegram ${method}: ${data.description ?? 'error'}`);
    return data.result as T;
  }

  async getMe(): Promise<{ id: number; username?: string }> {
    return this.call('getMe');
  }

  /** Long-poll for updates. `offset` acknowledges handled updates. */
  async getUpdates(offset: number, timeout = 30): Promise<TgUpdate[]> {
    const result = await this.call<TgUpdate[]>('getUpdates', undefined, { offset, timeout, limit: 10 });
    return result ?? [];
  }

  async sendMessage(chatId: number | string, text: string): Promise<{ message_id: number }> {
    return this.call('sendMessage', { chat_id: chatId, text }, undefined);
  }

  /** Resolve a file_id to a downloadable path on Telegram's file server. */
  async getFile(fileId: string): Promise<{ file_id: string; file_path: string; file_size?: number }> {
    return this.call('getFile', { file_id: fileId }, undefined);
  }

  /** Download a file returned by getFile to a local path. Returns the path. */
  async downloadFile(filePath: string, dest: string): Promise<string> {
    const res = await fetch(`https://api.telegram.org/file/bot${this.token}/${filePath}`, {
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new Error(`telegram file download failed: ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const fs = await import('node:fs');
    const { dirname } = await import('node:path');
    fs.mkdirSync(dirname(dest), { recursive: true });
    fs.writeFileSync(dest, buf);
    return dest;
  }
}
