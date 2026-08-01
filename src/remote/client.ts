import fs from 'node:fs';
import path from 'node:path';
import { dataHome } from '../config/defaults.js';

export interface LinkConfig {
  url: string;
  token: string;
}

const LINK_FILE = 'link.json';

/** Where this machine reaches its hub: url + bearer token. */
export class LinkStore {
  constructor(private file: string) {}

  get(): LinkConfig | null {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (typeof raw.url === 'string' && raw.url.length > 0 && typeof raw.token === 'string') {
        return { url: raw.url.replace(/\/+$/, ''), token: raw.token };
      }
    } catch {
      // not linked
    }
    return null;
  }

  set(url: string, token: string): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(this.file, JSON.stringify({ url: url.replace(/\/+$/, ''), token }, null, 2) + '\n', { mode: 0o600 });
    try {
      fs.chmodSync(this.file, 0o600);
    } catch {
      // best effort
    }
  }

  clear(): void {
    try {
      fs.unlinkSync(this.file);
    } catch {
      // nothing to clear
    }
  }
}

let singleton: LinkStore | null = null;

export function getLinkStore(): LinkStore {
  if (!singleton) singleton = new LinkStore(path.join(dataHome(), 'link.json'));
  return singleton;
}

export interface HubStatus {
  version: string;
  model: string;
  providers: string[];
  tools: string[];
  facts: number;
  externalErrors: string[];
}

export interface ChatReply {
  text: string;
  steps: number;
  toolCalls: number;
  provider: string;
  model: string;
}

/** Thin client that talks to a remote hub over HTTP. */
export class RemoteClient {
  constructor(
    private url: string,
    private token: string,
  ) {}

  private async req<T>(method: string, route: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.url}${route}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) {
      let message = `HTTP ${res.status}`;
      try {
        const data = (await res.json()) as { error?: string };
        message = data.error || message;
      } catch {
        // keep status fallback
      }
      throw new Error(message);
    }
    return (await res.json()) as T;
  }

  status(): Promise<HubStatus> {
    return this.req('GET', '/api/status');
  }

  session(): Promise<Array<{ role: string; content: string }>> {
    return this.req('GET', '/api/session');
  }

  chat(message: string): Promise<ChatReply> {
    return this.req('POST', '/api/chat', { message });
  }

  /** Stream a chat over SSE, yielding text deltas as they arrive. */
  async chatStream(message: string, onDelta: (delta: string) => void): Promise<ChatReply> {
    const res = await fetch(`${this.url}/api/chat`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify({ message, stream: true }),
    });
    if (!res.ok) {
      let err = `HTTP ${res.status}`;
      try {
        const data = (await res.json()) as { error?: string };
        err = data.error || err;
      } catch {
        // keep fallback
      }
      throw new Error(err);
    }
    if (!res.body) {
      const data = (await res.json()) as ChatReply;
      onDelta(data.text ?? '');
      return data;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let full = '';
    const meta: Partial<ChatReply> = {};
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        for (const line of block.split('\n')) {
          if (!line.startsWith('data: ')) continue;
          let data: unknown;
          try {
            data = JSON.parse(line.slice(6));
          } catch {
            continue;
          }
          if (data && typeof data === 'object' && typeof (data as { text?: unknown }).text === 'string') {
            const text = (data as { text: string }).text;
            full += text;
            onDelta(text);
          } else if (data && typeof (data as { meta?: unknown }).meta === 'object') {
            Object.assign(meta, (data as { meta: Partial<ChatReply> }).meta);
          } else if (data && typeof (data as { error?: unknown }).error === 'string') {
            throw new Error((data as { error: string }).error);
          }
        }
      }
    }
    return { text: full, steps: meta.steps ?? 0, toolCalls: meta.toolCalls ?? 0, provider: meta.provider ?? '', model: meta.model ?? '' };
  }

  reset(): Promise<{ ok: boolean }> {
    return this.req('POST', '/api/new');
  }

  setModel(model: string): Promise<{ model: string }> {
    return this.req('POST', '/api/model', { model });
  }
}
