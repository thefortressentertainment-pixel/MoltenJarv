/**
 * Consent gate. When a human channel (e.g. Telegram) is active, the agent
 * pauses before consequential tool calls and waits for explicit user approval.
 * When no channel is active (the user is present locally at the machine), the
 * gate is open and consequential tools run directly.
 */

export type ApprovalHandler = (question: string) => Promise<boolean>;

let handler: ApprovalHandler | null = null;

/** Register the channel that asks the human and resolves yes/no. */
export function setApprovalHandler(h: ApprovalHandler | null): void {
  handler = h;
}

/** True when a human channel is active, so the agent must seek consent. */
export function approvalActive(): boolean {
  return handler !== null;
}

/** True while the channel is auto-approving every remaining step of the task
 *  (e.g. the owner replied "yes all"). Lets the task runner grant a generous
 *  step budget in that mode, since the human is no longer in the wait-loop. */
export function isAutoApproving(): boolean {
  return autoApproveFlag;
}

let autoApproveFlag = false;

/** Set/clear the auto-approve flag for the current task. */
export function setAutoApprove(v: boolean): void {
  autoApproveFlag = v;
}

/**
 * Ask the human for consent. Returns true (proceed) when no channel is
 * active, or when the human explicitly approves over the active channel.
 */
export async function requireApproval(question: string): Promise<boolean> {
  if (!handler) return true;
  return handler(question);
}

/**
 * Ask the human for consent to a fail-closed tool. Fail-closed tools are
 * externally visible, irreversible, or otherwise too consequential to ever
 * auto-fire silently — so unlike requireApproval, they NEVER auto-approve.
 * If no consent channel is active, the tool refuses rather than running.
 *
 * Returns true to proceed. Otherwise throws a clear error explaining the
 * action was blocked because no one could be asked for consent.
 */
export async function requireFailClosedApproval(question: string): Promise<boolean> {
  if (!handler) {
    throw new Error(
      `${question}

This action is fail-closed: it is externally visible and irreversible, so it cannot run silently without your consent. No approval channel is active right now, so I refused to perform it.

To proceed, run this action interactively (with a channel that can ask you for approval), or approve it explicitly.`,
    );
  }
  return handler(question);
}

// Tool arguments shown in an approval question are capped so large payloads
// (e.g. file_write_any writing a whole file) can't exceed a channel's message
// limit — an undeliverable approval stalls the task forever.
const MAX_APPROVAL_ARGS_CHARS = 800;

/** Build a size-capped approval prompt for one tool call. */
export function approvalQuestion(name: string, args: Record<string, unknown> | undefined): string {
  const raw = JSON.stringify(args ?? {});
  const shown =
    raw.length > MAX_APPROVAL_ARGS_CHARS
      ? raw.slice(0, MAX_APPROVAL_ARGS_CHARS) + '… [arguments truncated — the tool will receive the full value]'
      : raw;
  return `${name}${shown}`;
}
