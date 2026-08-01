import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { dataHome } from '../config/defaults.js';

const AUTH_FILE = 'auth.json';

/**
 * Bearer token used to authenticate remote machines to the hub.
 * Stored at ~/.jarv-genie/auth.json with 0600 permissions.
 */
export class TokenStore {
  private token: string | null = null;

  constructor(private file: string) {}

  get(): string {
    if (this.token) return this.token;
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      const tok: unknown = raw.token;
      if (typeof tok === 'string' && tok.length > 0) {
        this.token = tok;
        return this.token;
      }
    } catch {
      // no token yet
    }
    this.token = `jarv-${randomBytes(24).toString('base64url')}`;
    this.persist();
    return this.token;
  }

  rotate(): string {
    this.token = `jarv-${randomBytes(24).toString('base64url')}`;
    this.persist();
    return this.token;
  }

  matches(provided: string | undefined): boolean {
    if (!provided) return false;
    return provided === this.get();
  }

  private persist(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(this.file, JSON.stringify({ token: this.token }, null, 2) + '\n', { mode: 0o600 });
    try {
      fs.chmodSync(this.file, 0o600);
    } catch {
      // best effort on platforms without chmod
    }
  }
}

let singleton: TokenStore | null = null;

export function getTokenStore(): TokenStore {
  if (!singleton) singleton = new TokenStore(path.join(dataHome(), AUTH_FILE));
  return singleton;
}
