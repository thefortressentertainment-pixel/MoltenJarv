import { getSecretStore } from './config/secrets.js';

/**
 * Credential passthrough (Agent-Reach / openworker pattern, MIT).
 *
 * Platform credentials (tokens, cookies) live ONLY in Jarv's secret store
 * (0600, never echoed). This module:
 *  - resolves a named secret (with platform fallbacks),
 *  - builds an env map for subprocess calls so CLIs authenticate without the
 *    value ever appearing in arguments or the prompt,
 *  - redacts any known secret from arbitrary strings (so a leaked token in a
 *    subprocess error/result is masked before it reaches the model).
 */

/** Resolve a secret by primary name, trying `fallbacks` in order. */
export function resolveSecret(name: string, fallbacks: string[] = []): string | undefined {
  const store = getSecretStore();
  for (const candidate of [name, ...fallbacks]) {
    const value = store.get(candidate);
    if (value && value.length > 0) return value;
  }
  return undefined;
}

/**
 * Build an env map for a subprocess from a single secret. `gh` accepts `GH_TOKEN`/
 * `GITHUB_TOKEN`; rate-limited APIs often accept a bearer via env. The value is
 * never placed in argv — only in process env for that one call.
 */
export function envForSecret(envName: string, secret: string): Record<string, string> {
  return { [envName]: secret };
}

/** Redact any known secrets from a string so they can never leak to a model/log. */
export function redactSecrets(text: string, ...secrets: (string | undefined)[]): string {
  let out = text;
  for (const s of secrets) {
    if (s && s.length >= 4) {
      out = out.split(s).join('****');
      // Also redact a URL-encoded or base64-ish variant defensively.
      try {
        out = out.split(encodeURIComponent(s)).join('****');
      } catch {
        /* ignore malformed */
      }
    }
  }
  return out;
}
