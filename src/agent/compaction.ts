import type { ChatMessage } from './types.js';
import type { ModelRouter } from '../providers/index.js';

/**
 * Auto-compaction of long working contexts, adapted from andrewyng/openworker's
 * `coworker/compaction.py` (MIT).
 *
 * The problem: Jarv's task loop extends the working context with a full
 * assistant+tool round every step. Old code dropped whole rounds on a hard char
 * budget (`trimWorkingContext`) — losing intent and the user's actual words. This
 * module instead REPLACES the over-budget prefix with:
 *
 *   [system] + <LLM summary of the prefix> + <mechanical state> + <verbatim tail>
 *
 * Compaction is an OUTBOUND-ONLY transform: it never mutates the persisted
 * session/checkpoint history — only the message array sent to the model on the
 * next step. All pure helpers are exported for testing without a model.
 *
 * Safety (mirrors openworker):
 *  - Trigger is a hard token budget (0.8 × window), not a judgment call.
 *  - Boundary is mechanical and zero-LLM: earliest turn-start whose verbatim tail
 *    fits the keep budget; prefers user boundaries.
 *  - User messages are preserved mechanically (ground truth of intent), capped.
 *  - Mechanical working state (files, commands, artifacts, tools) is extracted
 *    from tool records — no hallucination.
 *  - If the summarizer fails, a no-LLM trim still advances the boundary so the
 *    loop never hard-blocks (and reports `trimmed: true`).
 */

const THRESHOLD_PCT = 0.75;
const DEFAULT_WINDOW = 128_000;
const KEEP_RECENT_FRACTION = 0.25;
const SUMMARY_MAX_TOKENS = 3_000;
const USER_MESSAGE_CLIP = 600;
const USER_MESSAGES_MAX = 40;
const TRIM_FRACTION = 0.1;

export function estimateTokens(messages: ChatMessage[]): number {
  let total = 0;
  for (const m of messages) {
    total += (m.content ?? '').length;
    if (m.toolCalls) {
      for (const tc of m.toolCalls) total += JSON.stringify(tc).length;
    }
  }
  return Math.floor(total / 4);
}

export function shouldCompact(messages: ChatMessage[], window = DEFAULT_WINDOW): boolean {
  return estimateTokens(messages) >= Math.floor(THRESHOLD_PCT * window);
}

/** Index of message 0..n whose [i:] is system+rest (i starts after the system msg). */
function contentStart(messages: ChatMessage[]): number {
  return messages[0]?.role === 'system' ? 1 : 0;
}

function turnStarts(messages: ChatMessage[]): { users: number[]; assistants: number[] } {
  const users: number[] = [];
  const assistants: number[] = [];
  const start = contentStart(messages);
  for (let i = start; i < messages.length; i++) {
    const r = messages[i]!.role;
    if (r === 'user') users.push(i);
    else if (r === 'assistant') assistants.push(i);
  }
  return { users, assistants };
}

function fits(messages: ChatMessage[], from: number, keepTokens: number): boolean {
  return estimateTokens(messages.slice(from)) <= keepTokens;
}

/** The canonical index where the verbatim tail begins (openworker `pick_boundary`). */
export function pickBoundary(messages: ChatMessage[], keepTokens: number): number | null {
  const start = contentStart(messages);
  const { users, assistants } = turnStarts(messages);
  const fitCandidate = (list: number[]): number | null => {
    for (const i of list) if (fits(messages, i, keepTokens)) return i; // earliest-first
    return null;
  };
  let boundary = fitCandidate(users);
  if (boundary === null && users.length > 0) {
    const inside = assistants.filter((i) => i > users[users.length - 1]!);
    boundary = fitCandidate(inside);
    if (boundary === null) boundary = inside[inside.length - 1] ?? users[users.length - 1]!;
  }
  if (boundary === null) boundary = fitCandidate(assistants) ?? (assistants.length ? assistants[assistants.length - 1]! : null);
  if (boundary === null || boundary <= start) return null;
  return boundary;
}

/** Mechanical working state from the span's tool records (openworker `extract_working_state`). */
export function extractWorkingState(span: ChatMessage[]): string {
  const files: string[] = [];
  const commands: Array<{ line: string; status: string }> = [];
  const artifacts: string[] = [];
  const tools: string[] = [];

  const results = new Map<string, unknown>();
  for (const m of span) if (m.role === 'tool' && m.toolCallId) results.set(m.toolCallId, m.content);

  for (const m of span) {
    if (m.role !== 'assistant' || !m.toolCalls) continue;
    for (const tc of m.toolCalls) {
      const name = tc.name;
      if (name && !tools.includes(name)) tools.push(name);
      const args = (tc.arguments ?? {}) as Record<string, unknown>;
      const lowered = name.toLowerCase();
      const path = args.path ?? args.file_path;
      if (typeof path === 'string' && /(write|edit|append|save|create|patch)/.test(lowered)) files.push(path);
      if (lowered === 'run_shell' && typeof args.command === 'string') {
        const result = results.get(tc.id);
        let status = '';
        try {
          const parsed = JSON.parse(typeof result === 'string' ? result : '');
          if (parsed?.error) status = 'error';
          else if ('exit_code' in parsed) status = parsed.exit_code === 0 ? 'ok' : `exit ${parsed.exit_code}`;
        } catch {
          /* not json */
        }
        const line = String(args.command).trim().split(/\s+/).join(' ').slice(0, 160);
        commands.push({ line, status });
      }
      if (/(artifact|publish|deploy)/.test(lowered)) {
        const loc = args.url ?? args.path ?? args.title;
        if (typeof loc === 'string' && loc) artifacts.push(loc);
      }
    }
  }

  const dedupeRecent = (items: string[], limit: number) => {
    const out: string[] = [];
    for (const item of [...items].reverse()) {
      if (!out.includes(item)) out.push(item);
      if (out.length >= limit) break;
    }
    return out;
  };

  const lines: string[] = ['## Working state (extracted mechanically from tool records)'];
  const written = dedupeRecent(files, 20);
  if (written.length) {
    lines.push('Files written/edited (most recent first):');
    for (const p of written) lines.push(`- ${p}`);
  }
  const recent = commands.slice(-10);
  if (recent.length) {
    lines.push('Recent shell commands:');
    for (const c of recent) lines.push(`- ${c.line}` + (c.status ? `  [${c.status}]` : ''));
  }
  const made = dedupeRecent(artifacts, 10);
  if (made.length) {
    lines.push('Artifacts produced:');
    for (const a of made) lines.push(`- ${a}`);
  }
  if (tools.length) lines.push('Tools used in the summarized span: ' + [...tools].sort().join(', '));
  return lines.length > 1 ? lines.join('\n') : '';
}

/** User messages preserved mechanically, trimmed of pasted bulk (capped). */
export function extractUserMessages(span: ChatMessage[], clip = USER_MESSAGE_CLIP): string[] {
  const out: string[] = [];
  for (const m of span) {
    if (m.role !== 'user') continue;
    const text = (m.content ?? '').trim().split(/\s+/).join(' ');
    if (!text) continue;
    out.push(text.length > clip ? text.slice(0, clip - 1) + '…' : text);
  }
  return out.slice(-USER_MESSAGES_MAX);
}

const SUMMARY_SYSTEM_PROMPT = `You are summarizing the older portion of a long task's working context so the agent can continue losslessly.
Produce a concise, structured summary covering:
- The primary request and any hard constraints.
- Key decisions made, with WHY.
- Files read or written (note THAT they exist and where — never embed full file contents as truth; the agent can re-read them).
- Errors encountered and fixes applied.
- User messages (paraphrased) that established intent.
- Pending tasks / what is still in-flight.
- The single most important "what to do next".
Do NOT carry full file contents. Keep it tight and factual.` +
  '\nContinue where you left off on the next step. Do not mention that the context was compacted.';

const SUMMARY_USER = (span: string) =>
  `Summarize this older span of the working context so a fresh window can continue:\n\n"""\n${span}\n"""\n\nReturn only the summary text.`;

/** Build the compacted outbound block. `summary` may be '' for the no-LLM trim. */
function renderBlock(summary: string, state: string, users: string[], trimmed: boolean): string {
  const lines: string[] = ['## Summary of earlier work in this task'];
  if (summary.trim()) lines.push(summary.trim());
  else lines.push('(pre-emptively trimmed without an LLM summary.)');
  if (users.length) {
    lines.push('\nEarlier user instructions (verbatim):');
    for (const u of users) lines.push(`- ${u}`);
  }
  if (state) lines.push(`\n${state}`);
  if (trimmed) lines.push('\n[Some earlier turns were trimmed during a failed-summarization pass.]');
  return lines.join('\n');
}

export interface CompactResult {
  messages: ChatMessage[];
  compacted: boolean;
  trimmed: boolean;
}

/**
 * Compress an over-budget working context into an outbound-safe form. Never
 * mutates the input. If `router` is given and the span summarizer succeeds, a
 * real summary is used; otherwise a mechanical-only trim still frees space and
 * the loop never hard-blocks.
 */
export async function compactWorkingContext(
  messages: ChatMessage[],
  opts: { router?: ModelRouter; window?: number } = {},
): Promise<CompactResult> {
  const window = opts.window ?? DEFAULT_WINDOW;
  const keepTokens = Math.floor(Math.floor(THRESHOLD_PCT * window) * KEEP_RECENT_FRACTION);
  if (!shouldCompact(messages, window)) return { messages, compacted: false, trimmed: false };

  const boundary = pickBoundary(messages, keepTokens);
  if (boundary === null || boundary <= 1) {
    // Nothing worth summarizing relative to a system + one-turn context: fall back
    // to dropping the oldest complete rounds (safe, preserves user + latest tool).
    return { messages, compacted: false, trimmed: false };
  }

  const span = messages.slice(0, boundary);
  const head = messages.slice(0, contentStart(messages));
  const tail = messages.slice(boundary);
  const state = extractWorkingState(span);
  const users = extractUserMessages(span);

  let summary = '';
  let trimmed = false;
  if (opts.router) {
    // Cap the summarizer span to avoid its own input overflow.
    const spanText = span.map((m) => (m.content ?? '')).join('\n').slice(0, 400_000);
    try {
      const chat = await opts.router.chat({
        messages: [
          { role: 'system', content: SUMMARY_SYSTEM_PROMPT },
          { role: 'user', content: SUMMARY_USER(spanText) },
        ],
      });
      summary = (chat.content ?? '').trim().slice(0, SUMMARY_MAX_TOKENS * 4);
    } catch {
      trimmed = true;
    }
  } else {
    trimmed = true; // no router → mechanical-only
  }

  const block = renderBlock(summary, state, users, trimmed);
  const outbound: ChatMessage[] = [...head, { role: 'user', content: block }, ...tail];
  return { messages: outbound, compacted: true, trimmed };
}
