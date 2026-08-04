import type { ChatMessage } from './types.js';

/**
 * Recent-context skill.
 *
 * The full session history is always loaded back into the prompt (see
 * Agent.loop), but once a thread grows long the model's attention can drift
 * away from earlier turns — so "redo what you said two minutes ago" can get
 * dropped or misread as a fresh idea.
 *
 * To fix that, we maintain a compact, always-in-view scroll of the most
 * recent ~2 hours of conversation. It is injected straight into the system
 * prompt on every run, so it is never squeezed out by context windowing. It is
 * deliberately terse (role prefixes, short excerpts) to keep the token cost
 * tiny while preserving the thread the user is actively working in.
 */

/** How far back we keep conversational turns, in milliseconds (2 hours). */
export const RECENT_WINDOW_MS = 2 * 60 * 60 * 1000;

const MAX_CONTENT_CHARS = 400;

function roleTag(role: ChatMessage['role']): string {
  switch (role) {
    case 'user':
      return 'USER';
    case 'assistant':
      return 'GENIE';
    case 'system':
      return 'SYS';
    case 'tool':
      return 'TOOL';
  }
}

function isSystemRole(m: ChatMessage): boolean {
  // Only consider conversational turns user/genie. System nudges and tool
  // results describe machinery, not what the user and I agreed on.
  return m.role === 'system';
}

function isToolRole(m: ChatMessage): boolean {
  return m.role === 'tool';
}

/**
 * Build a compact excerpt of the last `windowMs` of conversational turns.
 * The order returned is oldest→newest so it reads like a thread.
 */
export function recentContext(
  history: ChatMessage[],
  windowMs: number = RECENT_WINDOW_MS,
  now: number = Date.now(),
): string {
  if (!history.length) return '';

  // The session JSONL store does not persist timestamps per message, so we
  // cannot know exact ages of past turns. Instead we approximate the window by
  // tailing the most recent batch of turns — the last N conversational
  // exchanges. This keeps the skill robust to a session that runs for days.
  //
  // If forwards-compatible timestamps exist on messages (older data won't have
  // them), use them to prune precisely.
  const recent: ChatMessage[] = [];
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (!m) break; // defensive: no entry at this index
    const t = (m as unknown as { ts?: number }).ts;
    if (typeof t === 'number' && now - t > windowMs) break; // older than window
    // Skip system nudges and tool chatter for the condensed scroll, but keep a
    // short user-facing line so the thread reads naturally.
    if (!isSystemRole(m)) recent.push(m);
    // Hard cap so a very long active session can't bloat the prompt.
    if (recent.length >= 40) break;
  }
  recent.reverse();

  const lines = recent.map((m) => {
    let label = roleTag(m.role);
    if (isToolRole(m)) label = 'TOOL';
    let text = (m.content ?? '').trim();
    // Tool payloads are noisy; reduce to a one-line hint.
    if (isToolRole(m)) {
      text = text.length > 120 ? text.slice(0, 120) + '…' : text;
    } else if (text.length > MAX_CONTENT_CHARS) {
      text = text.slice(0, MAX_CONTENT_CHARS) + '…';
    }
    return `${label}: ${text}`;
  });

  if (!lines.length) return '';
  return lines.join('\n');
}

/** Wrap the excerpt in a system-prompt block ready to be appended. */
export function composeRecentContextBlock(
  history: ChatMessage[],
  windowMs: number = RECENT_WINDOW_MS,
  now: number = Date.now(),
): string {
  const excerpt = recentContext(history, windowMs, now);
  if (!excerpt) return '';
  return (
    '\n\n# Recent context (last ~2 hours)\n' +
    'Recall these recent turns if the user refers to "earlier", "before", or asks you to redo or continue something you just said. Treat this as authoritative context you should already know.\n\n' +
    excerpt
  );
}
