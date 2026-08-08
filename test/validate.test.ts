import assert from 'node:assert';
import { test } from 'node:test';
import { validateArgs } from '../src/tools/validate.js';
import type { ToolDefinition } from '../src/agent/types.js';

function toolWith(schema: NonNullable<ToolDefinition['inputSchema']>): ToolDefinition {
  return {
    name: 't',
    description: 't',
    inputSchema: schema,
    handler: async (args) => args,
  };
}

test('validateArgs coerces a numeric-string int to a number', () => {
  const def = toolWith({
    type: 'object',
    properties: { count: { type: 'integer' }, name: { type: 'string' } },
    required: ['count'],
  });
  const { args, errors } = validateArgs(def, { count: '42' });
  assert.deepStrictEqual(errors, []);
  assert.strictEqual(args.count, 42);
});

test('validateArgs accepts whole-float-string int ("30000.0")', () => {
  const def = toolWith({
    type: 'object',
    properties: { n: { type: 'integer' } },
    required: ['n'],
  });
  const { args, errors } = validateArgs(def, { n: '30000.0' });
  assert.deepStrictEqual(errors, []);
  assert.strictEqual(args.n, 30000);
});

test('validateArgs rejects a fractional int with a path-bearing error', () => {
  const def = toolWith({
    type: 'object',
    properties: { n: { type: 'integer' } },
    required: ['n'],
  });
  const { errors } = validateArgs(def, { n: '3.7' });
  assert.strictEqual(errors.length, 1);
  assert.strictEqual(errors[0]!.path, 'n');
  assert.match(errors[0]!.message, /integer/);
});

test('validateArgs reports a missing required arg with the right path', () => {
  const def = toolWith({
    type: 'object',
    properties: { prompt: { type: 'string' } },
    required: ['prompt'],
  });
  const { errors } = validateArgs(def, {});
  assert.strictEqual(errors.length, 1);
  assert.strictEqual(errors[0]!.path, 'prompt');
});

test('validateArgs coerces booleans and leaves unknown values untouched', () => {
  const def = toolWith({
    type: 'object',
    properties: { enabled: { type: 'boolean' } },
    required: ['enabled'],
  });
  const { args, errors } = validateArgs(def, { enabled: 'false', extra: { a: 1 } });
  assert.deepStrictEqual(errors, []);
  assert.strictEqual(args.enabled, false);
  assert.deepStrictEqual(args.extra, { a: 1 });
});

test('validateArgs passes through ambiguous strings without error', () => {
  const def = toolWith({
    type: 'object',
    properties: { note: { type: 'string' }, level: { type: 'number' } },
    required: ['note'],
  });
  const { args, errors } = validateArgs(def, { note: 'hello', level: 'n/a' });
  assert.deepStrictEqual(errors, []);
  assert.strictEqual(args.note, 'hello');
  assert.strictEqual(args.level, 'n/a'); // non-numeric, left for the handler
});
