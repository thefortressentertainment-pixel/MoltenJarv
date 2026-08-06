import type { ToolDefinition } from '../agent/types.js';
import { getSecretStore } from '../config/secrets.js';
import { TelegramClient } from '../telegram/client.js';

/**
 * Proactive Telegram messaging. Jarv can message the owner on its own (not
 * only as a reply) — e.g. scheduled results, alerts, optimization reports.
 * Uses the same bot token + owner chat id as the Telegram bridge, so it works
 * from any process (hub, daemon, bridge).
 */

export function telegramTools(): ToolDefinition[] {
  return [
    {
      name: 'telegram_send',
      system: 'integration',
      description:
        'Send a message to the owner on Telegram on your own initiative (e.g. a scheduled result, an alert, or a report). Use when the user should be told something outside of the current reply. Requires the Telegram bridge to be configured.',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'The message to send.' },
        },
        required: ['text'],
      },
      consequential: true,
      failClosed: true,
      handler: async (args) => {
        const secrets = getSecretStore();
        const token = secrets.get('TELEGRAM_BOT_TOKEN');
        const chatId = secrets.get('TELEGRAM_CHAT_ID');
        if (!token || !chatId) {
          return { ok: false, error: 'Telegram not configured: set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID' };
        }
        const text = String(args.text ?? '').trim();
        if (!text) return { ok: false, error: 'text is required' };
        try {
          await new TelegramClient(token).sendMessage(chatId, text);
          return { ok: true, sent: text.slice(0, 120) };
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      },
    },
  ];
}
