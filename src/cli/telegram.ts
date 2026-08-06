import { spawn } from 'node:child_process';
import { getSecretStore } from '../config/secrets.js';
import { setApprovalHandler, setAutoApprove, isAutoApproving } from '../approvals.js';
import { tryAcquireBusy, releaseBusy, sense, regulate } from '../resource.js';
import { TelegramClient, type TgUpdate } from '../telegram/client.js';
import { TaskRunner } from '../agent/taskrunner.js';
import type { AgentContext } from './index.js';
/**
 * Telegram bridge: run `jarv-genie telegram`. Polls the bot for messages from
 * the authorized user, runs them through the agent, and replies. Consequential
 * tool calls are gated: the agent pauses and sends an approval request to
 * Telegram, waiting for an explicit yes/no before acting. While the bridge is
 * up it keeps the Mac awake (caffeinate) so Jarv is always reachable.
 *
 * Setup (only the token is required):
 *   jarv-genie key set TELEGRAM_BOT_TOKEN <token from @BotFather>
 *   jarv-genie telegram
 * Then just message your bot: the first sender is claimed as the owner.
 */

const APPROVAL_RE = /^(yes|y|approve|approved|ok|okay|go ahead|sure|confirm)\b/i;
const DENY_RE = /^(no|n|deny|denied|cancel|don'?t|stop)\b/i;
const AUTO_APPROVE_RE = /^(yes all|yes to all|allow all|approve all|y all|go ahead all)\b/i;
// An approval the owner never answers must not hold the busy-lock (and starve
// the scheduled agent) forever. Auto-deny after this window so the task
// resolves and the lock is released. Long enough for a careful reader; still
// shorter than the 30-min busy-lock TTL.
const APPROVAL_TIMEOUT_MS = 25 * 60 * 1000;

function verdict(text: string): boolean | null {
  if (APPROVAL_RE.test(text)) return true;
  if (DENY_RE.test(text)) return false;
  return null;
}

/** Telegram caps a message at 4096 chars — split longer text into chunks. */
export function chunkText(text: string, max = 4000): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max);
    if (cut < max * 0.5) cut = rest.lastIndexOf(' ', max);
    if (cut < max * 0.5) cut = max;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  if (rest) out.push(rest);
  return out;
}

function usage(): string {
  return (
    'Telegram bridge needs a bot token:\n' +
    '  1. In Telegram, message @BotFather and send /newbot\n' +
    '  2. Pick a name and username; it replies with a token\n' +
    '  3. Store it:\n' +
    '       jarv-genie key set TELEGRAM_BOT_TOKEN <token>\n' +
    '  4. Run: jarv-genie telegram\n' +
    'Then message your bot — the first sender becomes the owner.'
  );
}

/** Keep the Mac awake while the bridge runs (prevent idle + system sleep). */
function keepAwake(): void {
  if (process.platform !== 'darwin') return;
  try {
    const child = spawn('caffeinate', ['-i', '-s', '-w', String(process.pid)], {
      stdio: 'ignore',
      detached: true,
    });
    child.unref();
    process.stdout.write('[jarv-genie] keeping the Mac awake (caffeinate) while the bridge runs\n');
  } catch {
    // caffeinate may be unavailable; not fatal
  }
}

export async function runTelegram(ctx: AgentContext): Promise<void> {
  const secrets = getSecretStore();
  const token = secrets.get('TELEGRAM_BOT_TOKEN');
  if (!token) {
    process.stdout.write(usage() + '\n');
    return;
  }

  let chatId = secrets.get('TELEGRAM_CHAT_ID');
  keepAwake();
  // Clear any busy-lock left over from a previous process (e.g. a reboot), so
  // the heartbeat isn't blocked by a stale lock.
  releaseBusy();

  const runner = new TaskRunner({
    router: ctx.router,
    tools: ctx.tools,
    memory: ctx.memory,
    config: ctx.config,
    sessionId: 'chat',
  });
  const client = new TelegramClient(token);
  const me = await client.getMe();
  process.stdout.write(`[jarv-genie] telegram online as @${me.username ?? me.id}\n`);
  if (!chatId) {
    process.stdout.write('[jarv-genie] no chat id set — message your bot to claim ownership\n');
  }

  let offset = 0;
  let pendingResolve: ((ok: boolean) => void) | null = null;
  // When the owner replies "yes all", approve every remaining consequential
  // tool call for the current task without asking again. Reset per task.
  setAutoApprove(false);

  setApprovalHandler((question: string) => {
    if (!chatId) return Promise.resolve(false);
    const ownerId = chatId;
    if (isAutoApproving()) return Promise.resolve(true);
    process.stdout.write(`[jarv-genie] telegram approval requested: ${question.slice(0, 120)}\n`);
    const body = `🔒 Jarv wants approval for:\n\n${question}\n\nReply **yes** to allow, **no** to deny. Or **yes all** to allow every remaining step of this task without asking again.`;
    return (async () => {
      for (const part of chunkText(body)) {
        await client.sendMessage(ownerId, part);
      }
    })().then(
      () =>
        new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => {
            pendingResolve = null;
            client.sendMessage(ownerId, '⏰ No answer in time — assuming **no** for now. Re-ask and I\'ll retry.').catch(() => {});
            resolve(false);
          }, APPROVAL_TIMEOUT_MS);
          pendingResolve = (ok) => {
            clearTimeout(timer);
            resolve(ok);
          };
        }),
    );
  });

  // Serialize message processing so agent runs don't interleave, but keep
  // polling so approval replies resolve the pending gate.
  let chain: Promise<void> = Promise.resolve();

  const processMessage = async (text: string): Promise<void> => {
    process.stdout.write(`[jarv-genie] telegram <- ${text.slice(0, 120)}\n`);
    setAutoApprove(false);
    const acquired = tryAcquireBusy();
    if (!acquired) {
      // Another process (e.g. the scheduled heartbeat) is mid-task. The
      // busy-lock serializes cross-process work — don't pile on.
      await client.sendMessage(chatId!, '🫀 Slightly overloaded right now — give me a minute, then try again.');
      return;
    }
    try {
      // Autonomic nervous system: sense vitals, then regulate (clean/compact/
      // block) before the cortex does any work. Note: we already hold the busy
      // lock, so vitals.busy will read true for our own lock — only memory and
      // context matter here.
      const vitals = await sense();
      const guard = await regulate(vitals);
      if (guard === 'blocked') {
        await client.sendMessage(chatId!, '⚠️ Memory is critically low right now — hold on, give me a minute, then try again.');
        return;
      }
      if (guard === 'cleaned') process.stdout.write('[jarv-genie] autonomic: freed memory before task\n');
      if (guard === 'compacted') process.stdout.write('[jarv-genie] autonomic: compacted session before task\n');
      const result = await runner.run(text);
      process.stdout.write(`[jarv-genie] telegram -> ${(result.text || '(no response)').slice(0, 160)}\n`);
      for (const part of chunkText(result.text || '(no response)')) {
        await client.sendMessage(chatId!, part);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stdout.write(`[jarv-genie] telegram ERROR: ${message}\n`);
      for (const part of chunkText(`⚠️ ${message}`)) {
        await client.sendMessage(chatId!, part);
      }
    } finally {
      if (acquired) releaseBusy();
    }
  };

  const onUpdate = async (u: TgUpdate): Promise<void> => {
    const from = u.message?.chat?.id;
    const text = u.message?.text;
    if (from === undefined) return;
    if (String(from) !== String(chatId)) {
      if (!chatId) {
        chatId = String(from);
        secrets.set('TELEGRAM_CHAT_ID', chatId);
        process.stdout.write(`[jarv-genie] claimed owner chat id ${chatId}\n`);
        await client.sendMessage(from, '✅ You are now the owner of this bot. Jarv Genie is online — tell me what you need.');
      } else {
        await client.sendMessage(from, 'not authorized');
        return;
      }
    }
    if (!text) return;
    if (pendingResolve) {
      const v = verdict(text.trim());
      const resolve = pendingResolve;
      pendingResolve = null;
      if (AUTO_APPROVE_RE.test(text.trim())) {
        setAutoApprove(true);
        await client.sendMessage(from, '👍 Got it — approving this and every remaining step of the task.');
      }
      resolve(v ?? true);
      return;
    }
    if (text === '/start' || text === '/help') {
      await client.sendMessage(chatId!, 'Jarv Genie is here. Tell me what you need.');
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
