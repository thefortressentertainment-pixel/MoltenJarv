import type { ToolDefinition } from '../agent/types.js';
import { createInitiativeStore, type InitiativeStatus } from '../initiatives.js';
import { getSecretStore } from '../config/secrets.js';
import { TelegramClient } from '../telegram/client.js';
import { appendDelivery } from './deliverylog.js';

const VALID_STATUS: InitiativeStatus[] = ['proposed', 'approved', 'declined', 'in_progress', 'done'];

/** Notify the owner on Telegram that Jarv has a new initiative idea. */
async function notifyIdea(idea: string, rationale: string): Promise<void> {
  const secrets = getSecretStore();
  const token = secrets.get('TELEGRAM_BOT_TOKEN');
  const chatId = secrets.get('TELEGRAM_CHAT_ID');
  if (!token || !chatId) return;
  try {
    await new TelegramClient(token).sendMessage(
      chatId,
      `💡 Jarv's initiative idea:\n\n${idea}\n\n${rationale}\n\nReply with: approve / decline / refine it.`,
    );
  } catch {
    // best effort — the idea is still stored
  }
}

export function initiativeTools(): ToolDefinition[] {
  const store = createInitiativeStore();
  return [
    {
      name: 'initiative_propose',
      system: 'autonomic',
      description:
        'Invent and record a new proactive idea/opportunity, and notify the owner on Telegram. Use when you spot something worth doing that the user did not ask for — an opportunity, an automation, an improvement, or a strategy tied to your capabilities. It is stored and surfaced for approval; it is NOT executed until approved.',
      inputSchema: {
        type: 'object',
        properties: {
          idea: { type: 'string', description: 'The idea, in one clear sentence.' },
          rationale: { type: 'string', description: 'Why this is worth doing, and how it connects to the user’s goals.' },
          value: { type: 'string', description: 'Expected value (short).' },
          effort: { type: 'string', description: 'Low / medium / high effort.' },
        },
        required: ['idea', 'rationale'],
      },
      consequential: true,
      handler: async (args) => {
        const idea = String(args.idea ?? '').trim();
        const rationale = String(args.rationale ?? '').trim();
        if (!idea || !rationale) return { ok: false, error: 'initiative_propose requires idea and rationale' };
        const initiative = store.add({
          idea,
          rationale,
          value: String(args.value ?? '').trim() || 'not stated',
          effort: String(args.effort ?? '').trim() || 'medium',
        });
        await notifyIdea(initiative.idea, initiative.rationale);
        return { ok: true, initiative, note: 'stored and sent to the owner — awaiting approval before any action' };
      },
    },
    {
      name: 'initiative_list',
      system: 'autonomic',
      description: 'List all tracked initiatives and their status. Read-only.',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        const initiatives = store.list();
        return { ok: true, count: initiatives.length, open: store.openCount(), initiatives };
      },
    },
    {
      name: 'initiative_status',
      system: 'autonomic',
      description: 'Update an initiative’s status (proposed / approved / declined / in_progress / done). Use when the owner approves or declines, or when you start/finish one.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Initiative id.' },
          status: { type: 'string', description: 'proposed, approved, declined, in_progress, or done.' },
        },
        required: ['id', 'status'],
      },
      consequential: true,
      handler: async (args) => {
        const id = String(args.id ?? '').trim();
        const status = String(args.status ?? '').trim() as InitiativeStatus;
        if (!id || !VALID_STATUS.includes(status)) {
          return { ok: false, error: `initiative_status requires id and a valid status (${VALID_STATUS.join(', ')})` };
        }
        const updated = store.setStatus(id, status);
        if (!updated) return { ok: false, error: `no initiative with id "${id}"` };

        // An initiative that reaches "done" is a delivered thing — prove it in
        // the hash-chained Delivery Track Record automatically.
        let loggedHash: string | undefined;
        let logError: string | undefined;
        if (status === 'done') {
          try {
            const logged = await appendDelivery(
              `Completed initiative ${id}: ${updated.idea}`,
              'other',
              `Initiative marked done — tracked in the initiative ledger, entry hash-chained to the Delivery Track Record.`,
            );
            if (!logged.ok) logError = logged.error;
            else loggedHash = logged.hash;
          } catch (err) {
            logError = err instanceof Error ? err.message : String(err);
          }
        }
        return {
          ok: true,
          initiative: updated,
          ...(loggedHash ? { deliveryHash: loggedHash } : {}),
          ...(logError ? { deliveryLogError: logError } : {}),
        };
      },
    },
  ];
}
