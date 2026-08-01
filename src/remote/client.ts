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

  reset(): Promise<{ ok: boolean }> {
    return this.req('POST', '/api/new');
  }

  setModel(model: string): Promise<{ model: string }> {
    return this.req('POST', '/api/model', { model });
  }
}
