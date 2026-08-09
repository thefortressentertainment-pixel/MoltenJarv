import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getSecretStore } from '../config/secrets.js';
import { getTokenStore } from '../hub/auth.js';
import { TelegramClient, type TgUpdate } from '../telegram/client.js';

/**
 * "Blender Branch" — a dedicated Telegram bot whose EVERY message is routed to the
 * hub's isolated Blender runner (`POST /api/blender`) and answered with a rendered
 * PNG still (via `POST /api/blender/render`). It is deliberately MINIMAL:
 *  - NO `buildAgent()`, NO full 84-tool TaskRunner, NO memory/RAG/calendar/email.
 *  - It only long-polls Telegram and POSTs to the always-on hub (127.0.0.1:3001).
 * So a mid-refine prompt can NEVER revert to the general agent and bounce the RAM.
 *
 * Configure with:
 *   jarv-genie key set BLENDER_BOT_TOKEN <bot token from @BotFather>
 *   jarv-genie key set BLENDER_CHAT_ID   <your chat id>
 * It reuses the hub bearer token (~/.jarv-genie/auth.json) to call the hub.
 */

const HUB = 'http://127.0.0.1:3001';

function usage(): string {
  return (
    'Blender branch telegram bot\n' +
    'Configure: jarv-genie key set BLENDER_BOT_TOKEN <token>  (from @BotFather)\n' +
    '           jarv-genie key set BLENDER_CHAT_ID <chat id>\n' +
    'Run:       jarv-genie blender-bot\n'
  );
}

/** Sentinels / prompts the model shouldn't see; keep the reply terse. */
function replyPrefix(stepsUsed: number): string {
  return `🧊 Blender build (${stepsUsed} steps)\n`;
}

/** Call the hub's /api/blender (isolated runner). Returns {text} or throws. */
async function runBuild(message: string, maxSteps: number, token: string): Promise<{ text: string; steps: number }> {
  const res = await fetch(`${HUB}/api/blender`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, maxSteps }),
    signal: AbortSignal.timeout(300_000),
  });
  const body = (await res.json().catch(() => ({}))) as { text?: string; error?: string; steps?: number };
  if (!res.ok) throw new Error((body && body.error) || `hub build HTTP ${res.status}`);
  return { text: body.text ?? '(no reply)', steps: Number(body.steps ?? 0) };
}

/** Render a viewport PNG still via the hub. Returns the local file path. */
async function renderStill(token: string): Promise<string> {
  const res = await fetch(`${HUB}/api/blender/render`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(120_000),
  });
  const body = (await res.json().catch(() => ({}))) as { ok?: boolean; path?: string; error?: string };
  if (!res.ok || !body.ok) throw new Error((body && body.error) || 'render failed');
  if (!body.path || !fs.existsSync(body.path)) throw new Error('render produced no file');
  return body.path;
}

/**
 * If a Telegram message carries a photo, download it to a local temp path and
 * return that absolute path so the runner's deterministic reference-vision
 * (referenceHintFor) can analyze it. Returns null when there's no photo.
 */
export async function photoToPath(client: TelegramClient, update: TgUpdate): Promise<string | null> {
  const photo = update.message?.photo;
  if (!photo || photo.length === 0) return null;
  const best = photo.reduce((a, b) => ((b?.file_size ?? 0) > (a?.file_size ?? 0) ? b : a));
  if (!best?.file_id) return null;
  const meta = await client.getFile(best.file_id);
  if (!meta?.file_path) return null;
  const ext = path.extname(meta.file_path) || '.jpg';
  const dest = path.join(os.tmpdir(), `jarv_bot_ref_${Date.now()}${ext}`);
  await client.downloadFile(meta.file_path, dest);
  return dest;
}

/** Export for tests: decide how a message becomes a runner prompt + step budget. */
export function buildPrompt(message: string, photoPath: string | null): string {
  const text = (message ?? '').trim();
  if (photoPath) {
    return `${text}\nmake it look like this picture ${photoPath}`.trim();
  }
  return text;
}

async function handleUpdate(client: TelegramClient, token: string, update: TgUpdate): Promise<void> {
  const chatId = update.message?.chat?.id;
  const msgText = update.message?.text ?? '';
  if (chatId === undefined || chatId === null) return;

  // Busy guard: refuse simultaneous prompts (a build is already in flight).
  if (busy) {
    await client.sendMessage(chatId, '⏳ Already building — wait for the current build to finish.').catch(() => {});
    return;
  }

  let photoPath: string | null = null;
  try {
    photoPath = await photoToPath(client, update);
  } catch (err) {
    await client.sendMessage(chatId, `⚠️ Couldn't read the attached photo: ${err instanceof Error ? err.message : String(err)}`).catch(() => {});
    return;
  }

  const prompt = buildPrompt(msgText, photoPath);
  if (!prompt) {
    await client.sendMessage(chatId, 'Send a build prompt (optionally with a reference photo).').catch(() => {});
    return;
  }

  busy = true;
  try {
    const maxSteps = /(?:\.(png|jpe?g|jpeg|webp)|make it look like this|reference|photo)/i.test(prompt) ? 24 : 18;
    await client.sendMessage(chatId, '🧊 Building…').catch(() => {});
    const { text, steps } = await runBuild(prompt, maxSteps, token);
    // Render the still and send it (best-effort; if render fails, still send text).
    let rendered = false;
    try {
      const still = await renderStill(token);
      await client.sendPhoto(chatId, still, replyPrefix(steps).substring(0, 20));
      rendered = true;
    } catch {
      /* text-only fallback below */
    }
    const caption = rendered
      ? ''
      : `${replyPrefix(steps)}\n(no render yet)`;
    await client.sendMessage(chatId, (caption ? caption + '\n' : '') + text.slice(0, 3500)).catch(() => {});
  } catch (err) {
    await client.sendMessage(chatId, `⚠️ ${err instanceof Error ? err.message : String(err)}`).catch(() => {});
  } finally {
    busy = false;
    if (photoPath) fs.unlink(photoPath, () => {});
  }
}

let busy = false;

export async function runBlenderBot(): Promise<void> {
  const secrets = getSecretStore();
  const token = secrets.get('BLENDER_BOT_TOKEN');
  if (!token) {
    process.stdout.write(usage() + '\n');
    return;
  }
  // A Telegram bot token is `<NUMBER>:<key>` (e.g. "1234567890:AA..."). The Jarv
  // hub token ("jarv-...") and the DeepSeek key are NOT bot tokens — give a clear
  // message instead of a confusing `getMe: Not Found`.
  if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(token)) {
    process.stdout.write(
      '[jarv-genie] BLENDER_BOT_TOKEN does not look like a Telegram bot token.\n' +
      'The @BotFather token format is: 1234567890:AAH_XXXX... (a number, then ":").\n' +
      'Fix it with:  jarv-genie key set BLENDER_BOT_TOKEN\n' +
      '(do NOT paste the hub token "jarv-..." or an API key.)\n',
    );
    return;
  }
  const chatId = secrets.get('BLENDER_CHAT_ID');
  const hubToken = getTokenStore().get();
  const client = new TelegramClient(token);
  const me = await client.getMe();
  process.stdout.write(`[jarv-genie] blender branch online as @${me.username ?? me.id} (hub ${HUB})\n`);
  if (!chatId) {
    process.stdout.write('[jarv-genie] no BLENDER_CHAT_ID set — message your bot to claim it\n');
  }

  let offset = 0;
  for (;;) {
    let updates: TgUpdate[] = [];
    try {
      updates = await client.getUpdates(offset);
    } catch (err) {
      process.stdout.write(`[jarv-genie] getUpdates error: ${err instanceof Error ? err.message : String(err)}\n`);
      await new Promise((r) => setTimeout(r, 3000));
      continue;
    }
    for (const u of updates) {
      offset = (u.update_id ?? 0) + 1;
      const cid = u.message?.chat?.id;
      // If a specific chat id is configured, only serve that chat (isolation). When
      // unset, serve whoever messages the bot so the owner can claim it via pair-set.
      if (chatId && cid !== undefined && String(cid) !== String(chatId)) continue;
      try {
        process.stdout.write(`[jarv-genie] update ${u.update_id} from chat ${String(cid ?? '?')} text="${String(u.message?.text ?? '').slice(0, 40)}"\n`);
        await handleUpdate(client, hubToken, u);
      } catch (err) {
        process.stdout.write(`[jarv-genie] handling error: ${err instanceof Error ? err.message : String(err)}\n`);
      }
    }
  }
}
