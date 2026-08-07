import type { JarvGenieConfig, EndpointConfig } from '../config/index.js';
import { resolveApiKey } from '../config/index.js';
import type { ComputerConfig } from '../computer/index.js';
import { OpenAICompatibleProvider } from './openai.js';
import type { ChatOptions, Provider } from './types.js';
import type { ChatResult } from '../agent/types.js';

export interface DoctorEntry {
  name: string;
  model: string;
  ok: boolean;
  error?: string;
}

/** Only use the fallback when it can actually authenticate (or needs no key). */
function fallbackReady(cfg: EndpointConfig): boolean {
  if (!cfg.apiKey && !cfg.apiKeyEnv) return true;
  return Boolean(resolveApiKey(cfg));
}

/**
 * Local-first routing: try the primary provider, transparently retry on the
 * fallback when the primary is unreachable or errors out.
 */
export class ModelRouter {
  private primary: Provider;
  private fallback: Provider | null;
  private lastError: unknown = undefined;

  private config: JarvGenieConfig;

  constructor(config: JarvGenieConfig) {
    this.config = config;
    this.primary = new OpenAICompatibleProvider('primary', 'Primary', config.providers.primary);
    this.fallback = config.providers.fallback && fallbackReady(config.providers.fallback)
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
      if (this.fallback) {
        try {
          return await this.fallback.chat(opts);
        } catch {
          // Fallback failed too (e.g. the local model is offline). Surface the
          // primary error instead — it is almost always the real one, and
          // hiding it behind a dead-fallback "Connection error" makes bugs
          // impossible to diagnose.
          throw err;
        }
      }
      throw err;
    }
  }

  async streamChat(opts: ChatOptions, onDelta: (delta: string) => void): Promise<ChatResult> {
    try {
      return await this.primary.streamChat(opts, onDelta);
    } catch (err) {
      this.lastError = err;
      if (this.fallback) {
        try {
          return await this.fallback.streamChat(opts, onDelta);
        } catch {
          throw err;
        }
      }
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
    const comp = (this.config as unknown as { computer?: ComputerConfig }).computer ?? {};
    for (const model of [comp.visionModel, comp.cameraModel].filter(Boolean) as string[]) {
      const endpoint = comp.visionEndpoint ?? 'http://127.0.0.1:11434/v1';
      try {
        const res = await fetch(`${endpoint.replace(/\/v1$/, '')}/api/tags`, { signal: AbortSignal.timeout(5000) });
        const data = (await res.json()) as { models?: { name: string }[] };
        const installed = (data.models ?? []).some((m) => m.name.split(':')[0] === model.split('/').pop());
        entries.push({
          name: 'vision:' + model,
          model,
          ok: installed,
          error: installed ? undefined : `vision model "${model}" not found on ${endpoint}`,
        });
      } catch (err) {
        entries.push({ name: 'vision:' + model, model, ok: false, error: (err as Error).message });
      }
    }
    return entries;
  }
}
