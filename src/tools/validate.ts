import type { ToolDefinition } from '../agent/types.js';

/**
 * Structured, lenient tool-argument validation, in the spirit of grok-build's
 * `params_validation.rs` + `schema.rs` (Apache-2.0, xai-org/grok-build).
 *
 * Models routinely emit near-JSON that is almost-but-not-quite the declared
 * schema: a number as a string ("30000.0"), a whole float for an int field, an
 * explicit `null` for an optional. The old code only checked that *required*
 * names were present and then let each handler `String(...)`-cast munge the
 * rest. That produced opaque errors and needless retry loops.
 *
 * This module is deliberately lenient and fail-safe:
 *  - Coerces well-formed values to the declared schema type (number/string/boolean).
 *  - If anything is ambiguous or unknown, it leaves the value untouched so a
 *    handler's own casting still gets a fair chance — we never reject a value
 *    the handler would have accepted.
 *  - On a genuinely wrong required value it returns a structured, path-bearing
 *    error (`path`, `expected`, `got`) so the model can correct itself in one
 *    shot instead of looping.
 */

export interface ArgError {
  path: string;
  expected: string;
  got: string;
  message: string;
}

export interface ValidatedArgs {
  /** The (possibly cleaned) argument map to hand to the handler. */
  args: Record<string, unknown>;
  /** Fatal errors. When non-empty the tool call must NOT run. */
  errors: ArgError[];
}

type CoerceResult =
  | { kind: 'value'; value: unknown }
  | { kind: 'error'; error: ArgError };

/** Coerce a single value toward a declared JSON-schema type. Returns undefined
 *  to mean "leave it as-is" (lenient: unknown/ambiguous → pass through). */
function coerceValue(kind: unknown, value: unknown): CoerceResult | undefined {
  switch (kind) {
    case 'string': {
      if (typeof value === 'number' && !Number.isNaN(value)) return { kind: 'value', value: String(value) };
      if (value === true || value === false) return { kind: 'value', value: String(value) };
      return undefined; // string/null/other → pass through for handler casting
    }
    case 'number': {
      if (typeof value === 'number') return undefined; // already a number
      if (typeof value === 'string' && value.trim() !== '') {
        const n = Number(value);
        if (!Number.isNaN(n)) return { kind: 'value', value: n };
        return undefined; // non-numeric string → let the handler decide
      }
      if (typeof value === 'boolean') return { kind: 'value', value: value ? 1 : 0 };
      return undefined;
    }
    case 'integer': {
      if (typeof value === 'number' && Number.isInteger(value)) return undefined;
      if (typeof value === 'string' && value.trim() !== '') {
        const n = Number(value);
        // Accept whole numbers and whole floats ("30000.0", "12"), reject
        // fractional strings so a "3.7" isn't silently truncated.
        if (Number.isInteger(n)) return { kind: 'value', value: n };
        if (Number.isFinite(n) && Number.isInteger(n) === false) {
          return {
            kind: 'error',
            error: {
              path: '',
              expected: 'integer',
              got: String(value),
              message: `expected an integer, received a fractional number "${String(value)}"`,
            },
          };
        }
        return undefined;
      }
      if (typeof value === 'boolean') return { kind: 'value', value: value ? 1 : 0 };
      return undefined;
    }
    case 'boolean': {
      if (typeof value === 'boolean') return undefined;
      if (value === 'true' || value === '1') return { kind: 'value', value: true };
      if (value === 'false' || value === '0') return { kind: 'value', value: false };
      return undefined;
    }
    default:
      return undefined; // array/object/etc. → pass through
  }
}

/**
 * Validate + leniently coerce `raw` arguments against `def.inputSchema`.
 *
 * Rules:
 *  - Missing required → fatal structured error (path = the param name).
 *  - Present-but-wrong-type required value → fatal only when we are *certain*
 *    it can't be salvaged (e.g. a fractional integer); otherwise pass through.
 *  - Optional/unknown coercion applies best-effort and never hard-fails.
 */
export function validateArgs(def: ToolDefinition, raw: Record<string, unknown>): ValidatedArgs {
  const schema = def.inputSchema;
  const properties = (schema?.properties ?? {}) as Record<string, unknown>;
  const required = Array.isArray(schema?.required) ? schema.required : [];
  const args: Record<string, unknown> = { ...raw };
  const errors: ArgError[] = [];

  for (const name of required) {
    const present = raw[name] !== undefined && raw[name] !== null;
    if (!present) {
      errors.push({
        path: name,
        expected: 'required',
        got: String(raw[name] ?? ''),
        message: `missing required argument "${name}"`,
      });
      continue;
    }
    const prop = properties[name] as { type?: unknown } | undefined;
    const coerced = prop ? coerceValue(prop.type, raw[name]) : undefined;
    if (coerced?.kind === 'error') {
      errors.push({ ...coerced.error, path: name });
    } else if (coerced?.kind === 'value') {
      args[name] = coerced.value;
    }
  }

  // Best-effort lenient coercion for non-required present params too.
  for (const [name, value] of Object.entries(raw)) {
    if (value === undefined || value === null) continue;
    if (required.includes(name)) continue; // already handled
    const prop = properties[name] as { type?: unknown } | undefined;
    if (!prop) continue;
    const coerced = coerceValue(prop.type, value);
    if (coerced?.kind === 'value') args[name] = coerced.value;
  }

  return { args, errors };
}
