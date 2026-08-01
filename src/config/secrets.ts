import fs from 'node:fs';
import path from 'node:path';
import { dataHome } from './defaults.js';

const SECRETS_FILE = 'secrets.json';

/**
 * API keys and other secrets, stored on disk separately from the config file.
 * The file is written with 0600 permissions and never exposed via `list`.
 */
export class SecretStore {
  private values: Record<string, string> | null = null;

  constructor(private file: string) {}

  private ensureLoaded(): void {
    if (this.values) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.values = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    } catch {
      this.values = {};
    }
  }

  private persist(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(this.file, JSON.stringify(this.values, null, 2) + '\n', { mode: 0o600 });
    try {
      fs.chmodSync(this.file, 0o600);
    } catch {
      // best effort on platforms without chmod
    }
  }

  get(name: string): string | undefined {
    this.ensureLoaded();
    return this.values![name];
  }

  set(name: string, value: string): void {
    this.ensureLoaded();
    this.values![name] = value;
    this.persist();
  }

  remove(name: string): boolean {
    this.ensureLoaded();
    if (!(name in this.values!)) return false;
    delete this.values![name];
    this.persist();
    return true;
  }

  list(): string[] {
    this.ensureLoaded();
    return Object.keys(this.values!);
  }
}

let singleton: SecretStore | null = null;

export function getSecretStore(): SecretStore {
  if (!singleton) singleton = new SecretStore(path.join(dataHome(), SECRETS_FILE));
  return singleton;
}
