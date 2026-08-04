import assert from 'node:assert';
import { test } from 'node:test';
import {
  RECENT_WINDOW_MS,
  composeRecentContextBlock,
  recentContext,
} from '../src/agent/recentContext.js';
import type { ChatMessage } from '../src/agent/types.js';

const u = (content: string): ChatMessage => ({ role: 'user', content: `u:${content}` } as never);
const a = (content: string): ChatMessage => ({ role: 'assistant', content: `a:${content}` });
const sys = (content: string): ChatMessage => ({ role: 'system', content });
const tool = (content: string): ChatMessage => ({ role: 'tool', toolCallId: 't1', name: 'x', content });

test('recentContext returns empty for empty history', () => {
  assert.strictEqual(recentContext([]), '');
});

test('recentContext includes recent user/genie turns and skips system nudges', () => {
  const history: ChatMessage[] = [u('first'), a('reply one'), sys('you were empty'), u('second')];
  const out = recentContext(history, RECENT_WINDOW_MS, 100000);
  assert.match(out, /USER: u:first/);
  assert.match(out, /GENIE: a:reply one/);
  assert.match(out, /USER: u:second/);
  // The system nudge should be pruned from the scroll.
  assert.ok(!/you were empty/.test(out));
});

test('recentContext prunes turns older than the window when timestamps exist', () => {
  const old = { ...u('stale'), ts: 1000 };
  const fresh = { ...u('current'), ts: 7000000 }; // within 2h of now=10_000_000
  const now = 10_000_000;
  const out = recentContext([old, fresh], RECENT_WINDOW_MS, now);
  assert.ok(!/stale/.test(out));
  assert.match(out, /current/);
});

test('recentContext truncates tool payloads to a short hint', () => {
  const big = { role: 'tool', toolCallId: 't1', name: 'x', content: 'x'.repeat(500) };
  const out = recentContext([big], RECENT_WINDOW_MS, 0);
  // Tool line is capped at 120 chars + ellipsis; no 500-char blob leaks through.
  assert.ok(out.length < 160);
});

test('composeRecentContextBlock wraps the excerpt with the skill hint and is empty when no history', () => {
  assert.strictEqual(composeRecentContextBlock([]), '');
  const block = composeRecentContextBlock([u('hello'), a('hi there')]);
  assert.match(block, /# Recent context/);
  assert.match(block, /last ~2 hours/);
  assert.match(block, /redo or continue/);
  assert.match(block, /USER: u:hello/);
  assert.match(block, /GENIE: a:hi there/);
});

test('recentContext caps the number of retained turns', () => {
  const history: ChatMessage[] = [];
  for (let i = 0; i < 200; i++) history.push(u(`msg-${i}`));
  const out = recentContext(history);
  // Only the last ~40 turns appear.
  assert.match(out, /USER: u:msg-199/);
  assert.ok(!/USER: u:msg-0/.test(out));
});
