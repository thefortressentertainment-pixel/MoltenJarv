import OpenAI from 'openai';
import { resolveApiKey, type EndpointConfig } from '../config/index.js';

/** Embeds text via any OpenAI-compatible /embeddings endpoint (OpenAI, Ollama, etc.). */
export class EmbeddingClient {
  private client: OpenAI | null;

  constructor(private cfg: EndpointConfig) {
    const key = resolveApiKey(cfg);
    this.client = cfg.baseUrl || key ? new OpenAI({ apiKey: key ?? 'not-set', ...(cfg.baseUrl ? { baseURL: cfg.baseUrl } : {}) }) : null;
  }

  get enabled(): boolean {
    return this.client !== null;
  }

  get model(): string {
    return this.cfg.model;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (!this.client) throw new Error('Embeddings endpoint not configured');
    const res = await this.client.embeddings.create({ model: this.cfg.model, input: texts });
    return res.data.map((d) => d.embedding);
  }
}
