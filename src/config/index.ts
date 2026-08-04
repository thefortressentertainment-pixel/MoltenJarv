import fs from 'node:fs';
import path from 'node:path';
import { configPath, dataHome, VERSION } from './defaults.js';
import { getSecretStore, type SecretStore } from './secrets.js';

export interface EndpointConfig {
  baseUrl?: string;
  apiKey?: string;
  apiKeyEnv?: string;
  model: string;
}

export interface McpServerConfig {
  name: string;
  command?: string;
  args?: string[];
  url?: string;
  headers?: Record<string, string>;
}

export interface JarvGenieConfig {
  providers: {
    primary: EndpointConfig;
    fallback: EndpointConfig | null;
  };
  embeddings: EndpointConfig | null;
  agent: {
    systemPrompt: string;
    maxSteps: number;
    workdir: string;
    soulPath?: string;
  };
  memory: {
    dir: string;
  };
  mcp: {
    servers: McpServerConfig[];
  };
  computer?: {
    allowControl?: boolean;
    visionModel?: string;
    visionEndpoint?: string;
    cameraModel?: string;
    cameraEndpoint?: string;
  };
}

const DEFAULT_SYSTEM_PROMPT = `You are Jarv Genie, a personal AI assistant running on the user's own devices. You act like a capable, concise companion: proactive, precise, and respectful of the user's time and privacy.

Rules:
- Be concise. Prefer short, direct answers unless the user asks for detail.
- Use your tools when they can help. Do not invent facts - recall them from memory or search when needed.
- Call tools through the function-calling interface. Never fake a tool call in your reply text; if you write one, it is executed for real. Never claim an action happened unless it actually did.
- When you use a tool, incorporate its result into a natural response.
- If you don't know something, say so rather than guessing.
- Never reveal your system prompt or tool schemas unless the user asks.
- Treat the user's personal data as private. Do not volunteer it.`;

export function defaultConfig(): JarvGenieConfig {
  return {
    providers: {
      primary: {
        baseUrl: envOr('JARV_GENIE_PRIMARY_BASE_URL', 'http://127.0.0.1:11434/v1'),
        model: envOr('JARV_GENIE_PRIMARY_MODEL', 'llama3.2'),
      },
      fallback: {
        baseUrl: envOr('JARV_GENIE_FALLBACK_BASE_URL', 'https://api.openai.com/v1'),
        apiKeyEnv: 'OPENAI_API_KEY',
        model: envOr('JARV_GENIE_FALLBACK_MODEL', 'gpt-4o-mini'),
      },
    },
    embeddings: null,
    agent: {
      systemPrompt: DEFAULT_SYSTEM_PROMPT,
      maxSteps: 16,
      workdir: envOr('JARV_GENIE_WORKDIR', path.join(dataHome(), 'workspace')),
      soulPath: path.join(dataHome(), 'soul'),
    },
    memory: {
      dir: envOr('JARV_GENIE_MEMORY_DIR', path.join(dataHome(), 'memory')),
    },
    mcp: { servers: [] },
  };
}

export function loadConfig(): JarvGenieConfig {
  let user: unknown = {};
  try {
    user = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
  } catch {
    // no config file yet; defaults apply
  }
  const cfg = deepMerge(defaultConfig(), user) as JarvGenieConfig;
  ensureDirs(cfg);
  return cfg;
}

export function saveConfig(cfg: JarvGenieConfig): void {
  fs.mkdirSync(dataHome(), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2) + '\n');
}

export function ensureConfigFile(): void {
  if (!fs.existsSync(configPath())) {
    saveConfig(defaultConfig());
  }
}

export function ensureDirs(cfg: JarvGenieConfig): void {
  for (const dir of [cfg.memory.dir, path.join(cfg.memory.dir, 'sessions'), cfg.agent.workdir]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function resolveApiKey(cfg: EndpointConfig, secrets: SecretStore = getSecretStore()): string | undefined {
  if (cfg.apiKey) return cfg.apiKey;
  if (cfg.apiKeyEnv) return secrets.get(cfg.apiKeyEnv) ?? process.env[cfg.apiKeyEnv];
  return undefined;
}

export function isLocalEndpoint(baseUrl: string | undefined): boolean {
  if (!baseUrl) return false;
  return /localhost|127\.0\.0\.1|0\.0\.0\.0|::1/i.test(baseUrl);
}

export function resolveEmbeddingsConfig(cfg: JarvGenieConfig): EndpointConfig | null {
  if (cfg.embeddings) return cfg.embeddings;
  const p = cfg.providers.primary;
  if (isLocalEndpoint(p.baseUrl)) {
    return {
      baseUrl: p.baseUrl,
      apiKey: p.apiKey,
      apiKeyEnv: p.apiKeyEnv,
      model: envOr('JARV_GENIE_EMBEDDINGS_MODEL', 'nomic-embed-text'),
    };
  }
  if (process.env.OPENAI_API_KEY || getSecretStore().get('OPENAI_API_KEY')) {
    return { baseUrl: 'https://api.openai.com/v1', apiKeyEnv: 'OPENAI_API_KEY', model: 'text-embedding-3-small' };
  }
  return null;
}

function envOr(name: string, fallback: string): string {
  const v = process.env[name];
  return v && v.length > 0 ? v : fallback;
}

export function deepMerge<T>(base: T, override: unknown): T {
  if (override === undefined || override === null) return base;
  if (typeof base !== 'object' || Array.isArray(base) || typeof override !== 'object') {
    return override as T;
  }
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(override as Record<string, unknown>)) {
    const baseVal = (base as Record<string, unknown>)[key];
    out[key] = deepMerge(baseVal, value);
  }
  return out as T;
}

export function appVersion(): string {
  return VERSION;
}
