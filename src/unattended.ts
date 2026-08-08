import type { Inbox } from './inbox.js';
import type { ToolDefinition } from './agent/types.js';
import { toolRisk } from './risk.js';

/**
 * Unattended routing, adapted from andrewyng/openworker's `coworker/unattended.py`
 * (MIT).
 *
 * "Unattended" is about *where the human is reached*, not *how autonomous the
 * agent may be*. It never changes the autonomy ceiling (that's the permission
 * mode / ref-ex gate). It only decides what happens when a blocking action can't
 * be answered in the moment:
 *
 *  - Attended: the ask goes inline and is answered by a live channel.
 *  - Unattended: the ask is parked into the Inbox for the human to answer later.
 *
 * `routeBlocker()` returns a decision the caller acts on: run, park-to-inbox, or
 * refuse (fail-closed tools never auto-run unattended).
 */

export type BlockerRouting = { outcome: 'run' } | { outcome: 'park'; itemId?: string } | { outcome: 'refuse'; reason: string };

/**
 * Decide what to do with a consequential blocker.
 * @param tool     the tool being gated.
 * @param unattended whether this session/run is unattended.
 * @param inbox    the inbox to park into (when unattended and parking is wanted).
 * @param sessionId / @param toolCallId identity for idempotent parking.
 * @param prompt   the approval question text.
 * @param opts     can force fail-closed tools to refuse rather than park.
 */
export async function routeBlocker(opts: {
  tool: ToolDefinition;
  unattended: boolean;
  inbox: Inbox;
  sessionId: string;
  toolCallId: string;
  prompt: string;
  failClosed?: boolean;
}): Promise<BlockerRouting> {
  const risk = toolRisk(opts.tool);

  // Attended → the consent engine runs its normal inline path.
  if (!opts.unattended) return { outcome: 'run' };

  // EXTERNAL risk (externally visible, irreversible) must never auto-fire or even
  // park-and-wait — it refuses and requires an attended channel.
  if (risk === 'external' || opts.failClosed) {
    return {
      outcome: 'refuse',
      reason: `"${opts.tool.name}" is fail-closed/external and cannot run unattended. Parked to the inbox for explicit approval.`,
    };
  }

  // Unattended non-external blocker → park into the inbox.
  const item = await opts.inbox.park(opts.sessionId, opts.toolCallId, opts.prompt, { inline: false });
  return { outcome: 'park', itemId: item.id };
}
