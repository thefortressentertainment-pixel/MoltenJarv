import { getSecretStore } from '../config/secrets.js';
import { setApprovalHandler } from '../approvals.js';
import { TelegramClient, type TgUpdate } from '../telegram/client.js';
import type { ChatBackend } from './backend.js';
import { SESSION } from './index.js';

/**
 * Telegram bridge: run `jarv-genie telegram`. Polls the bot for messages from
 * the authorized user, runs them through the agent, and replies. Consequential
 * tool calls are gated: the agent pauses and sends an approval request to
 * Telegram, waiting for an explicit yes/no before acting.
 *
 * Setup:
 *   jarv-genie key set TELEGRAM_BOT_TOKEN <bot-token-from-BotFather>
 *   jarv-genie key set TELEGRAM_CHAT_ID <your-chat-id>
 */

const APPROVAL_RE = /^(yes|y|approve|approved|ok|okay|go ahead|sure|confirm)\b/i;
const DENY_RE = /^(no|n|deny|denied|cancel|don'?t|stop)\b/i;

function verdict(text: string): boolean | null {
  if (APPROVAL_RE.test(text)) return true;
  if (DENY_RE.test(text)) return false;
  return null;
}

function usage(): string {
  return (
    'Telegram bridge needs two secrets:\n' +
    '  jarv-genie key set TELEGRAM_BOT_TOKEN <token from @BotFather>\n' +
    '  jarv-genie key set TELEGRAM_CHAT_ID <your chat id>\n' +
    'Then run: jarv-genie telegram'
  );
}

export async function runTelegram(backend: ChatBackend): Promise<void> {
  const secrets = getSecretStore();
  const token = secrets.get('TELEGRAM_BOT_TOKEN');
  const chatId = secrets.get('TELEGRAM_CHAT_ID');
  if (!token || !chatId) {
    process.stdout.write(usage() + '\n');
    return;
  }

  const client = new TelegramClient(token);
  const me = await client.getMe();
  process.stdout.write(`[jarv-genie] telegram online as @${me.username ?? me.id}\n`);

  let offset = 0;
  let pendingResolve: ((ok: boolean) => void) | null = null;

  setApprovalHandler((question: string) => {
    return client
      .sendMessage(chatId, `🔒 Jarv wants approval for:\n\n${question}\n\nReply **yes** to allow, **no** to deny.`)
      .then(() => new Promise<boolean>((resolve) => (pendingResolve = resolve)));
  });

  // Serialize message processing so agent runs don't interleave, but keep
  // polling so approval replies resolve the pending gate.
  let chain: Promise<void> = Promise.resolve();

  const processMessage = async (text: string): Promise<void> => {
    try {
      const result = await backend.chat(text);
      await client.sendMessage(chatId, result.text || '(no response)');
    } catch (err) {
      await client.sendMessage(chatId, `⚠️ ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const onUpdate = async (u: TgUpdate): Promise<void> => {
    const from = u.message?.chat?.id;
    const text = u.message?.text;
    if (from === undefined) return;
    if (String(from) !== String(chatId)) {
      await client.sendMessage(from, 'not authorized');
      return;
    }
    if (!text) return;
    if (pendingResolve) {
      const v = verdict(text.trim());
      const resolve = pendingResolve;
      pendingResolve = null;
      resolve(v ?? true);
      return;
    }
    if (text === '/start' || text === '/help') {
      await client.sendMessage(chatId, 'Jarv Genie is here. Tell me what you need.');
      return;
    }
    chain = chain.then(() => processMessage(text));
  };

  for (;;) {
    try {
      const updates = await client.getUpdates(offset, 30);
      for (const u of updates) {
        offset = (u.update_id ?? offset) + 1;
        await onUpdate(u);
      }
    } catch (err) {
      process.stdout.write(`[jarv-genie] telegram poll error: ${err instanceof Error ? err.message : String(err)}\n`);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}
