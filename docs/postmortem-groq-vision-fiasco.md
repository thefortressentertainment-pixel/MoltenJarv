# Postmortem: Groq Key / Vision Screen-Capture Meltdown

**Date:** 2026-08-05 · **Status:** Analysis complete (root cause verified against live config + source)

## What actually broke

The user's narrative: "the Groq API key got put in as the main" and screen-capture /
vision fell apart, causing a unilateral system meltdown during a multi-step task.

## Verified facts (not from memory — from disk and source)

1. **Vision uses the LLM primary's key when no vision key is declared.**
   In `src/computer/index.ts`, `describeImage()`:
   ```
   const keyEnv = opts.apiKeyEnv ?? comp.visionApiKeyEnv
                ?? (baseUrl.includes('groq') ? 'GROQ_API_KEY' : undefined);
   const key = (keyEnv ? resolveApiKey({apiKeyEnv: keyEnv}) : resolveApiKey(primary)) ?? 'not-set';
   ```
   - The live config (`~/.jarv-genie/config.json`) sets `computer.visionEndpoint = https://api.groq.com/openai/v1`
     but does **NOT** set `visionApiKeyEnv`.
   - Therefore every `screen_capture` resolved the key via the heuristic `baseUrl.includes('groq') → GROQ_API_KEY`.

2. **`resolveApiKey` is a blind chain with no validation.**
   `src/config/index.ts`: `return secrets.get(name) ?? process.env[name];`
   - If the secret store returned the key, great. If it returned `undefined`, the code
     fell to `?? 'not-set'` and sent `Authorization: Bearer not-set` to Groq → guaranteed 401,
     every single screen capture, no retry, no visibility.

3. **The provider router has no health-gate before use.**
   `src/providers/index.ts` — `ModelRouter.chat()` tries primary, catches, tries fallback,
   rethrows the *primary* error on double-failure. But it never *pre-flights* the primary
   with a cheap probe (e.g. `GET /models` or a 1-token completion) before the agent burns
   its whole step budget against a broken endpoint.

4. **The live config was self-consistent but wrong on intent.**
   Read today: `primary = https://api.deepseek.com/v1 (deepseek-chat, apiKeyEnv=...)`,
   `fallback = http://127.0.0.1:11434 (llama3.2)`, `computer.vision* = Groq`.
   So the Groq key was **never the LLM-brain primary** in the persisted config — it was the
   **vision key**. The "put it in as main" impression came from the vision path *reusing*
   primary key resolution and the Groq heuristic, wiring the two concerns together.

## Root cause (one sentence)

The vision provider and the LLM-primary provider share **one key-resolution path** with an
**implicit URL-string heuristic** (`baseUrl.includes('groq')`) and **no config validation**,
so a missing/mismatched key produced a silent `Bearer not-set` 401 that the router neither
pre-flighted nor surfaced — and the agent burned its step budget "retrying" (via screen_capture
falling to OCR) instead of stopping to diagnose.

## Why it happened (the prompt-engineering angle)

- `deepMerge(default, user)` accepts **any** JSON with **no schema check** — a safe default
  plus an attacker/error-tolerant merge is a footgun: a partial or mistyped config silently
  degrades instead of failing loudly.
- Key lookup is **heuristic-driven** (`includes('groq')`) rather than **explicitly declared**
  (`visionApiKeyEnv: 'GROQ_API_KEY'`). Heuristics are invisible and untestable.
- No **pre-flight probe** and no **config doctor** that actually contacts endpoints at startup.
- The failure mode was **fail-closed-by-default** to `'not-set'` — the opposite of what a
  system that wants to catch errors should do.

## Fixes (prevent unilateral meltdowns)

1. **Schema-validate the config on load** (Zod is already a dependency). Reject or loudly
   warn on a malformed `providers`/`computer` shape instead of merging garbage in silence.
2. **Make the vision key explicit.** Add `visionApiKeyEnv` default to `'GROQ_API_KEY'` in the
   schema/defaults so the heuristic (`includes('groq')`) is never needed. Keep the heuristic
   only as a last resort, behind a warning log.
3. **Never send `Bearer not-set`.** If no key resolves, throw a clear error:
   "vision provider {endpoint} has no API key; set computer.visionApiKeyEnv." Fail fast and
   legibly, not silently with an auth error.
4. **Pre-flight the primary provider** at agent start (1-token completion or `GET /models`);
   `ModelRouter` already has a `doctor()` concept in the codebase — wire it into startup and
   report a broken primary *before* any steps run.
5. **Add a config doctor command** that contacts primary, fallback, and vision endpoints and
   prints per-endpoint OK/fail — so "why isn't vision working" is a one-command answer.

## Status

Chain verified (142 deliveries, root `c2361a7f…`). Tests 175/175 pass, typecheck clean.
Root cause confirmed against source + live config. Fixes are scoped and ready to implement.

— Jarv Genie
