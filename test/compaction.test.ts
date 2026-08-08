import assert from 'node:assert';
import { test } from 'node:test';
import {
  estimateTokens,
  shouldCompact,
  pickBoundary,
  extractUserMessages,
  extractWorkingState,
  compactWorkingContext,
} from '../src/agent/compaction.js';
import type { ChatMessage } from '../src/agent/types.js';

const msg = (role: ChatMessage['role'], content: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({
  role, content, ...extra,
});

const sys = () => msg('system', 'You are Jarv.');
const user = (c: string) => msg('user', c);
const asst = (c: string, toolCalls?: ChatMessage['toolCalls']) => msg('assistant', c, { toolCalls });
const tool = (id: string, name: string, content: string) => msg('tool', content, { toolCallId: id, name });

test('estimateTokens uses chars/4', () => {
  assert.strictEqual(estimateTokens([user('1234')]), 1);
  assert.strictEqual(estimateTokens([user('x'.repeat(40))]), 10);
});

test('estimateTokens counts tool-call arguments', () => {
  const msgs = [asst('', [{ id: 't1', name: 'run_shell', arguments: { command: 'ls' } }])];
  const onlyText = estimateTokens([asst('')]);
  assert.ok(estimateTokens(msgs) > onlyText, 'tool-call args add to the estimate');
});

test('shouldCompact trips at 0.75 x window', () => {
  // ~400k chars => ~100k tokens, over 0.75 x 100_000 = 75k tokens.
  const big = [sys(), user('y'.repeat(400_000))];
  assert.ok(shouldCompact(big, 100_000));
  assert.ok(!shouldCompact([sys(), user('small')], 100_000));
});

test('pickBoundary returns null when the whole context already fits the keep budget', () => {
  const msgs = [sys(), user('first'), asst('a'), user('last')];
  assert.strictEqual(pickBoundary(msgs, 10_000), null, 'nothing to summarize if everything fits');
});

test('pickBoundary picks a user boundary whose verbatim tail fits a tight keep budget', () => {
  const big = 'z'.repeat(5000);
  const msgs = [sys(), user('old1'), asst(big), user('old2'), asst('x'), user('keep me')];
  // keepTokens ~ 2 (tokens): only the last 2 messages fit, boundary lands at the
  // newest user turn that leaves a fitting suffix.
  const boundary = pickBoundary(msgs, 200);
  assert.ok(boundary !== null, 'a fitting tail boundary exists');
  assert.ok(boundary >= 1, 'boundary is after the system message');
  assert.ok(estimateTokens(msgs.slice(boundary)) <= 200, 'tail fits keep budget');
});

test('pickBoundary returns null for a system-only context', () => {
  assert.strictEqual(pickBoundary([sys()], 10_000), null);
});

test('extractUserMessages preserves user words verbatim and caps', () => {
  const msgs = [sys(), user('  sudo nvim   config  '), asst('x'), user('remind me later')];
  const out = extractUserMessages(msgs);
  assert.strictEqual(out.length, 2);
  assert.match(out[0]!, /sudo nvim config/); // whitespace collapsed
  assert.ok(!out.some((u) => u === 'x'), 'assistant text is not a user message');
});

test('extractWorkingState pulls files, commands, artifacts, tools from tool records', () => {
  const msgs = [
    asst('', [
      { id: 'a', name: 'file_write', arguments: { path: 'src/x.ts', content: 'hi' } },
      { id: 'b', name: 'run_shell', arguments: { command: 'npm test' } },
    ]),
    tool('a', 'file_write', '{"ok":true}'),
    tool('b', 'run_shell', '{"exit_code":0}'),
    asst('', [{ id: 'c', name: 'deploy_app_stub', arguments: { url: 'https://x.app' } }]),
    tool('c', 'deploy_app_stub', '{}'),
  ];
  const state = extractWorkingState(msgs);
  assert.match(state, /src\/x\.ts/);
  assert.match(state, /npm test/);
  assert.match(state, /https:\/\/x\.app/);
  assert.match(state, /Tools used/);
});

test('compactWorkingContext with a router emits a summary block and verbatim tail', async () => {
  // A large filler push the context well over the 5000-token window; the tail
  // stays small so it fits the keep budget and compaction succeeds.
  const filler = 'y'.repeat(30_000);
  const msgs = [sys(), user(filler), asst('did steps'), user('also test it'), msg('assistant', 'final intention')];
  const router = { chat: async () => ({ content: 'Summary: built most of the feature.', toolCalls: null, provider: 't', model: 't' }) };
  const result = await compactWorkingContext(msgs, { router: router as never, window: 5000 });
  assert.ok(result.compacted, 'compaction ran');
  assert.ok(!result.trimmed, 'summarizer succeeded');
  const text = result.messages.map((m) => m.content ?? '').join('\n');
  assert.match(text, /Summary: built most of the feature\./);
});

test('compactWorkingContext trim fallback works without a router (mechanical-only)', async () => {
  const filler = 'y'.repeat(30_000);
  const msgs = [sys(), user(filler), asst('ok'), user('then done')];
  const result = await compactWorkingContext(msgs, { window: 5000 });
  assert.strictEqual(result.compacted, true);
  assert.strictEqual(result.trimmed, true);
  const text = result.messages.map((m) => m.content ?? '').join('\n');
  assert.match(text, /pre-emptively trimmed/);
});
