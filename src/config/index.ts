import fs from 'node:fs';
import path from 'node:path';
import { configPath, dataHome, VERSION } from './defaults.js';
import { getSecretStore, type SecretStore } from './secrets.js';
import { CODE_PLAYBOOK } from './codePlaybook.js';

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

/**
 * A user-defined permission rule, modeled on grok-build's
 * `config-types/permission.rs` (deny-by-default). Each rule either allows a tool
 * through to the consent gate, denies it outright, or fast-paths it.
 *
 * `action`:
 *  - `allow` — let the cortex deliberate and the consent gate decide.
 *  - `deny`   — block deterministically before any model round-trip.
 *  - `fast`   — treat as a safe routine organ; run without deliberation.
 *
 * `tool` selects which tool(s) the rule applies to: an exact name, a `*`
 * wildcard, or a glob like `file_*`. `pattern` optionally narrows by argument
 * value (glob or regex), useful for gating e.g. `run_shell` on `rm -rf` in a
 * path. Omitting `action` never creates a catch-all allow — deny-by-default.
 */
export interface PermissionRule {
  action: 'allow' | 'deny' | 'fast';
  tool: string;
  pattern?: string;
  pattern_mode?: 'glob' | 'regex';
  reason?: string;
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
    /** Optional skills dir; each `<name>/SKILL.md` is injected into the prompt. */
    skillsPath?: string;
    /** Additional read-only roots the agent may read from (see src/roots.ts). */
    extraReadRoots?: string[];
    /** BM25 tool-pinning. When `maxTools` is set (e.g. 24), the toolset exposed
     *  to the model each run is pinned to the top-K relevant tools for the task
     *  (plus safety/core tools) — cuts tool-schema bloat for small local models.
     *  When unset, all tools are always exposed (current behavior). */
    toolPinning?: { maxTools: number };
  };
  memory: {
    dir: string;
  };
  mcp: {
    servers: McpServerConfig[];
  };
  /** User-defined reflex rules (deny-by-default). Evaluated after the
   *  non-overridable security invariants (credentials/secrets). */
  permissions?: PermissionRule[];
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
- Treat the user's personal data as private. Do not volunteer it.
- Delivery Track Record (MANDATORY): after ANY shipped task — an investor-digest run, ai-papers briefs shipped, a system op, a social post, or anything delivered — call the log_delivery tool to append a timestamped entry to the Delivery Track Record (tag category as investor-digest | ai-papers | system-op | social | other). This is always-on operating hygiene you must not skip. The log is a SHA-256 hash chain: before sharing or posting it, call deliverylog_verify (read-only) to confirm the chain is intact and get the current chain root + a publishable attestation. The root hash is public proof, safe to share — you may share it with consent as verifiable evidence of shipped work.` +
  CODE_PLAYBOOK;

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
      maxSteps: 24,
      workdir: envOr('JARV_GENIE_WORKDIR', path.join(dataHome(), 'workspace')),
      soulPath: path.join(dataHome(), 'soul'),
      skillsPath: envOr('JARV_GENIE_SKILLS_DIR', path.join(dataHome(), 'skills')),
      extraReadRoots: [],
    },
    memory: {
      dir: envOr('JARV_GENIE_MEMORY_DIR', path.join(dataHome(), 'memory')),
    },
    mcp: { servers: [] },
    permissions: [],
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
  if (base === null || base === undefined || typeof base !== 'object' || Array.isArray(base) || typeof override !== 'object') {
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
