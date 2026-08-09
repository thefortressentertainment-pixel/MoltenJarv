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
    voice?: { file_id: string; duration: number; mime_type?: string; file_size?: number };
    audio?: { file_id: string; duration: number; mime_type?: string; file_size?: number; title?: string };
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

  /** Send a photo (multipart/form-data so the image bytes are uploaded). Downscales
   *  large stills to keep the payload small, and re-encodes to JPEG. Returns the
   *  message id. */
  async sendPhoto(chatId: number | string, imagePath: string, caption?: string): Promise<{ message_id: number }> {
    const buf = await downscaleImage(imagePath);
    const boundary = '----jarv' + Date.now().toString(36);
    const parts: Buffer[] = [];
    if (caption) {
      parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="caption"\r\n\r\n${caption}\r\n`));
    }
    const photoField =
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="photo"; filename="render.jpg"\r\n` +
      `Content-Type: image/jpeg\r\n\r\n`;
    parts.push(Buffer.from(photoField));
    parts.push(buf);
    parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
    const body = Buffer.concat(parts);

    const res = await fetch(this.url('sendPhoto'), {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      body,
      signal: AbortSignal.timeout(60_000),
    });
    const data = (await res.json()) as { ok: boolean; description?: string; result?: { message_id: number } };
    if (!data.ok) throw new Error(`telegram sendPhoto: ${data.description ?? 'error'}`);
    return (data.result as { message_id: number }) ?? { message_id: 0 };
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

/** Downscale + re-encode an image to a JPEG <= ~1280px on the long edge so a
 *  Telegram photo payload stays small (Telegram caps ~10MB and thumbs at ~1280).
 *  Uses macOS `sips` (always present) — pure on-device, no extra deps, ~zero RAM.
 *  Returns the re-encoded image bytes. Falls back to the raw bytes if sips is
 *  unavailable / the input isn't a raster image. */
/** @internal exported for tests */ export async function downscaleImage(imagePath: string): Promise<Buffer> {
  const { promises: fs } = await import('node:fs');
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const tmp = `${imagePath}.tg.jpg`;
  try {
    await promisify(execFile)('sips', [
      '-Z', '1280', // fit within 1280 on the longest side
      '-s', 'format', 'jpeg',
      '-s', 'formatOptions', '82',
      imagePath, '--out', tmp,
    ], { timeout: 30_000 });
    const buf = await fs.readFile(tmp);
    await fs.unlink(tmp).catch(() => {});
    return buf;
  } catch {
    try { await fs.unlink(tmp).catch(() => {}); } catch { /* ignore */ }
    // sips unavailable or failed — send the original bytes.
    return fs.readFile(imagePath);
  }
}
