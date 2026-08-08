import { spawn } from 'node:child_process';
import { getSecretStore } from '../config/secrets.js';
import { setApprovalHandler, setAutoApprove, isAutoApproving } from '../approvals.js';
import {
  acquireTaskLease,
  tryAcquireBusy,
  releaseBusy,
  sense,
  regulate,
  TASK_LEASE_HEARTBEAT_MS,
  type AcquiredLease,
} from '../resource.js';
import { TelegramClient, type TgUpdate } from '../telegram/client.js';
import {
  isTrustedDevice,
  verifyPairingCode,
  pairTrustedDevice,
  clearPairingChallenge,
} from '../telegram/trust.js';
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

const IMAGE_MIME = /^image\/(png|jpe?g|gif|webp)$/i;
const IMAGE_EXT = /\.(png|jpe?g|gif|webp)$/i;

/**
 * Detect an image in a Telegram update (photo or image document), download it
 * to a temp file, and return an instruction for the agent to identify it with
 * the vision tool. Returns null when the message has no usable image.
 */
async function captureAttachment(client: TelegramClient, u: TgUpdate): Promise<string | null> {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');

  let fileId: string | undefined;
  let ext = '.jpg';

  // Photos arrive as an array of resolutions; take the largest.
  const photo = u.message?.photo;
  if (photo && photo.length > 0) {
    const best = photo.reduce((a, b) => ((b?.file_size ?? 0) > (a?.file_size ?? 0) ? b : a));
    fileId = best?.file_id;
    ext = '.jpg';
  } else if (u.message?.document) {
    const mime = u.message.document.mime_type ?? '';
    const fname = u.message.document.file_name ?? '';
    if (IMAGE_MIME.test(mime) || IMAGE_EXT.test(fname)) {
      fileId = u.message.document.file_id;
      const m = fname.match(IMAGE_EXT);
      ext = m ? m[0] : '.jpg';
    }
  }

  if (!fileId) return null;

  const { file_path } = await client.getFile(fileId);
  const dest = path.join(os.tmpdir(), `jarv-incoming${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`);
  await client.downloadFile(file_path, dest);

  // Compose the instruction, preserving any caption text as the question.
  const caption = (u.message?.caption ?? '').trim();
  const question = caption ? `The user asked: "${caption}"` : 'Identify what is in this image';
  return `[Image attached] ${question}. Use vision_identify with imagePath="${dest}".${caption ? '' : ' If the user included instructions, answer them too.'}`;
}

/**
 * Hard ceiling on a single task run. The agent loop should normally finish in
 * well under this even for multi-step work; if it doesn't (a hung model call,
 * a vision inference that never settles, a tool that blocks forever), we abort
 * the wait and reply rather than let the bridge wedge — the lease is released
 * no matter what, so the bot stays responsive.
 */
const TASK_RUN_TIMEOUT_MS = 6 * 60 * 1000;

/**
 * `Promise.race` against a hard timeout. On expiry the caller is told the task
 * was aborted so it can release the lease and reply instead of hanging. The
 * underlying work is left to settle in the background and may still log; the
 * bridge never blocks on it again.
 */
async function withHardTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} exceeded ${Math.round(ms / 1000)}s and was aborted — hmm, something hung on my end. Try again or rephrase.`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
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

/**
 * Send long text in chunks (Telegram caps ~4096 chars) and return every
 * sent message's descriptor so callers can identify the last one (e.g. the
 * approval prompt, which a "reply to" can then target).
 */
async function chunkToMessages(
  client: TelegramClient,
  chatId: number | string,
  text: string,
): Promise<Array<{ result: { message_id: number } }>> {
  const parts = chunkText(text);
  const sent: Array<{ result: { message_id: number } }> = [];
  for (const part of parts) {
    try {
      sent.push({ result: await client.sendMessage(chatId, part) });
    } catch {
      // A delivery failure shouldn't abort the whole reply; skip the chunk.
    }
  }
  return sent;
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
  // The message_id of the pending approval, so a "reply to that message" is
  // unmistakably a verdict, whereas an unrelated message is a new task.
  let pendingApprovalMsgId: number | null = null;
  // Shared busy-lease: the active task holds it while working; the approval
  // wait releases it (so a new message can run) and re-acquires on resolve.
  let taskLease: AcquiredLease | null = null;
  // Heartbeat interval while a task is actively working.
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  const stopHeartbeat = (): void => {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  };

  const startHeartbeat = (lease: AcquiredLease): void => {
    stopHeartbeat();
    heartbeatTimer = setInterval(() => {
      try {
        lease.heartbeat();
      } catch {
        /* the lease may have been released; ignore */
      }
    }, TASK_LEASE_HEARTBEAT_MS);
  };

  const releaseTaskLease = (): void => {
    stopHeartbeat();
    if (taskLease) {
      taskLease.release();
      taskLease = null;
    }
  };

  // When the owner replies "yes all", approve every remaining consequential
  // tool call for the current task without asking again. Reset per task.
  setAutoApprove(false);

  setApprovalHandler((question: string, kind) => {
    if (!chatId) return Promise.resolve(false);
    const ownerId = chatId;
    if (isAutoApproving()) return Promise.resolve(true);

    // Streamlined path: a VERIFIED (paired) device trusts everything except
    // fail-closed/external actions (email send, shutdown, posts). For a trusted
    // device, a normal consequential ask auto-approves — "I told you to do it,
    // so do it." Only fail-closed tools still go to the human for confirmation.
    if (isTrustedDevice(ownerId) && !kind?.failClosed) {
      process.stdout.write(`[jarv-genie] trusted device — auto-approving ${question.slice(0, 80)}\n`);
      return Promise.resolve(true);
    }

    // Untrusted-but-confirmed owner (paired or owner chat) asking a fail-closed /
    // external action still requires a live yes. A never-paired owner chat for a
    // non-fail-closed ask falls back to the legacy prompt.
    process.stdout.write(`[jarv-genie] telegram approval requested: ${question.slice(0, 120)}\n`);
    const body = `🔒 Jarv wants approval for:\n\n${question}\n${kind?.failClosed ? '\nThis action is fail-closed (irreversible/off-machine) and always requires explicit approval.' : ''}\n\nReply **yes** to allow, **no** to deny. Or **yes all** to allow every remaining step of this task without asking again.`;
    return (async () => {
      // Hold onto the approval message id so a reply-to-targeted message can
      // be matched as a verdict even if the owner also sends other messages.
      const sent = await chunkToMessages(client, ownerId, body);
      pendingApprovalMsgId = sent.at(-1)?.result?.message_id ?? null;
      // While waiting on a human, release the busy-lease so the bot isn't
      // wedged for the whole approval window: a new message can run, and the
      // watchdog never mistakes an idle approval wait for a hung task.
      releaseTaskLease();
      return new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => {
          pendingResolve = null;
          pendingApprovalMsgId = null;
          client.sendMessage(ownerId, '⏰ No answer in time — assuming **no** for now. Re-ask and I\'ll retry.').catch(() => {});
          resolve(false);
        }, APPROVAL_TIMEOUT_MS);
        pendingResolve = (ok) => {
          clearTimeout(timer);
          pendingApprovalMsgId = null;
          resolve(ok);
        };
      });
    })().then((ok) => {
      // Re-acquire an exempt lease before resuming the approved work, so the
      // resumed task isn't starved by a newer message that grabbed the lock.
      taskLease = acquireTaskLease({ exempt: true, maxIdleMs: APPROVAL_TIMEOUT_MS });
      startHeartbeat(taskLease);
      return ok;
    });
  });

  // Serialize message processing so agent runs don't interleave, but keep
  // polling so approval replies resolve the pending gate.
  let chain: Promise<void> = Promise.resolve();

  const processMessage = async (text: string): Promise<void> => {
    process.stdout.write(`[jarv-genie] telegram <- ${text.slice(0, 120)}\n`);
    setAutoApprove(false);
    // The active task holds a watcher-managed lease: it heartbeats while
    // working and auto-reclaims from dead or stale owners. A consent-gate wait
    // releases it (see the approval handler), so a new message can run here.
    const lease = acquireTaskLease();
    if (!lease.held) {
      // Another process (e.g. the scheduled heartbeat) is mid-task. The lease
      // serializes cross-process work — don't pile on.
      await client.sendMessage(chatId!, '🫀 Slightly overloaded right now — give me a minute, then try again.');
      return;
    }
    if (lease.reclaimed) process.stdout.write('[jarv-genie] lease watchdog: reclaimed a stale/hung busy-lock\n');
    taskLease = lease;
    startHeartbeat(lease);
    try {
      const vitals = await sense();
      const guard = await regulate(vitals);
      if (guard === 'blocked') {
        await client.sendMessage(chatId!, '⚠️ Memory is critically low right now — hold on, give me a minute, then try again.');
        return;
      }
      if (guard === 'cleaned') process.stdout.write('[jarv-genie] autonomic: freed memory before task\n');
      if (guard === 'compacted') process.stdout.write('[jarv-genie] autonomic: compacted session before task\n');
      const result = await withHardTimeout(runner.run(text), TASK_RUN_TIMEOUT_MS, 'Task run');
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
      releaseTaskLease();
    }
  };

  const onUpdate = async (u: TgUpdate): Promise<void> => {
    const from = u.message?.chat?.id;
    const text = u.message?.text;
    if (from === undefined) return;

    // Pairing handshake: complete a live `verify <code>` from any sender. Only
    // someone physically at the Mac knows the code, so whoever submits it becomes
    // both the owner and the verified ("trusted") device.
    const verifyMatch = text?.match(/^verify\s+(.+)$/i);
    if (verifyMatch) {
      const submitted = verifyMatch[1]!.trim();
      if (verifyPairingCode(submitted)) {
        chatId = String(from);
        secrets.set('TELEGRAM_CHAT_ID', chatId);
        pairTrustedDevice(from);
        process.stdout.write(`[jarv-genie] paired trusted device chat ${chatId}\n`);
        await client.sendMessage(from, '✅ Device verified and paired. From now on I\'ll trust commands from here — irreversible/off-machine actions will still ask first. Tell me what you need.');
      } else {
        await client.sendMessage(from, '❌ That pairing code is invalid or expired. Generate a new one with `jarv-genie pair`.');
      }
      return;
    }

    if (String(from) !== String(chatId)) {
      if (!chatId) {
        await client.sendMessage(from, '🔐 This bot isn\'t paired yet. On the Jarv machine run `jarv-genie pair` to get a code, then send me: `verify <code>`.');
      } else {
        await client.sendMessage(from, 'not authorized');
      }
      return;
    }

    // Handle image attachments (photos or image documents). Download the largest
    // photo / file to disk, then hand the agent an instruction to identify it.
    let caption = (text ?? '').trim();
    const imgPrompt = await captureAttachment(client, u).catch((err) => {
      process.stdout.write(`[jarv-genie] attachment download error: ${err instanceof Error ? err.message : String(err)}\n`);
      return `⚠️ I couldn't download the attached image (${err instanceof Error ? err.message : String(err)}). Try sending it again.`;
    });
    if (imgPrompt) caption = imgPrompt;

    if (!caption) return;

    // Reply-to context: when the owner hits "reply" on a specific prior message,
    // keep that frame as ambient context for this exchange. Cheap substring, one
    // division — no extra model call.
    const replyTo = u.message?.reply_to_message;
    if (replyTo?.text || replyTo?.caption) {
      const replied = (replyTo.text ?? replyTo.caption ?? '').trim();
      if (replied && !caption.startsWith('[Image attached]')) {
        caption = `(Replying to your message: "${replied.slice(0, 500)}") ${caption}`;
      }
    }

    if (pendingResolve) {
      const t = (text ?? '').trim();
      // Conflict resolution: an unrelated message while an approval is pending
      // is a NEW task, not a verdict. Only a clear yes/no (that isn't replying
      // to some other message) or a reply to the approval prompt resolves it.
      const isTargeted = replyTo != null && pendingApprovalMsgId != null && replyTo.message_id === pendingApprovalMsgId;
      const plainVerdict = verdict(t) !== null || AUTO_APPROVE_RE.test(t);
      const looksLikeVerdict = isTargeted || (plainVerdict && !replyTo);
      if (!looksLikeVerdict) {
        // Not a verdict — run it as a new task and keep the approval pending.
        process.stdout.write(`[jarv-genie] telegram conflict: {@${me.username}} pending approval, running new message as a task\n`);
        chain = chain.then(() => processMessage(caption));
        return;
      }
      const v = verdict(t);
      const resolve = pendingResolve;
      pendingResolve = null;
      if (AUTO_APPROVE_RE.test(t)) {
        setAutoApprove(true);
        await client.sendMessage(from, '👍 Got it — approving this and every remaining step of the task.');
      }
      resolve(v ?? true);
      return;
    }
    if (caption === '/start' || caption === '/help') {
      await client.sendMessage(chatId!, 'Jarv Genie is here. Tell me what you need.');
      return;
    }
    chain = chain.then(() => processMessage(caption));
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
