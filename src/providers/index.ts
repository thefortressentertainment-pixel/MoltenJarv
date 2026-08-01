import type { JarvGenieConfig } from '../config/index.js';
import { OpenAICompatibleProvider } from './openai.js';
import type { ChatOptions, Provider } from './types.js';
import type { ChatResult } from '../agent/types.js';

export interface DoctorEntry {
  name: string;
  model: string;
  ok: boolean;
  error?: string;
}

/**
 * Local-first routing: try the primary provider, transparently retry on the
 * fallback when the primary is unreachable or errors out.
 */
export class ModelRouter {
  private primary: Provider;
  private fallback: Provider | null;
  private lastError: unknown = undefined;

  constructor(config: JarvGenieConfig) {
    this.primary = new OpenAICompatibleProvider('primary', 'Primary', config.providers.primary);
    this.fallback = config.providers.fallback
      ? new OpenAICompatibleProvider('fallback', 'Fallback', config.providers.fallback)
      : null;
  }

  get providers(): Provider[] {
    return this.fallback ? [this.primary, this.fallback] : [this.primary];
  }

  get primaryModel(): string {
    return this.primary.model;
  }

  setPrimaryModel(model: string): void {
    this.primary.setModel(model);
  }

  get lastFailure(): unknown {
    return this.lastError;
  }

  async chat(opts: ChatOptions): Promise<ChatResult> {
    try {
      return await this.primary.chat(opts);
    } catch (err) {
      this.lastError = err;
      if (this.fallback) return await this.fallback.chat(opts);
      throw err;
    }
  }

  async doctor(): Promise<DoctorEntry[]> {
    const entries: DoctorEntry[] = [];
    for (const provider of this.providers) {
      try {
        const ok = await provider.ping();
        entries.push({ name: provider.label, model: provider.model, ok, error: ok ? undefined : 'unreachable' });
      } catch (err) {
        entries.push({ name: provider.label, model: provider.model, ok: false, error: (err as Error).message });
      }
    }
    return entries;
  }
}
