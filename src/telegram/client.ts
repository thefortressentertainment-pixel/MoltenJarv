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

  async sendMessage(chatId: number | string, text: string): Promise<void> {
    await this.call('sendMessage', { chat_id: chatId, text }, undefined);
  }
}
