import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { TelegramClient } from './client.js';
import { transcribe } from '../voice/index.js';

const execFileAsync = promisify(execFile);

/**
 * Telegram voice/audio → text. Downloads a Telegram `voice` (OPUS) or `audio`
 * file, converts it to 16 kHz mono PCM WAV (ffmpeg, with afconvert/sox paths),
 * and feeds it through Jarv's existing `transcribe()` (local whisper.cpp first,
 * OpenAI whisper-1 fallback). The resulting text becomes a normal message — Jarv
 * then "works out the rest based on its skills" (open app, use tools, etc.).
 */

/** True when a message is a usable voice note or audio file. */
export function audioFileId(
  m: {
    voice?: { file_id: string; mime_type?: string; file_size?: number };
    audio?: { file_id: string; mime_type?: string; file_size?: number };
    document?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number };
  },
): { fileId: string; ext: string } | null {
  if (m.voice?.file_id) return { fileId: m.voice.file_id, ext: '.ogg' };
  if (m.audio?.file_id) return { fileId: m.audio.file_id, ext: '.m4a' };
  // A document whose mime is audio (e.g. mp3/wav/m4a) is also transcriptable.
  const doc = m.document;
  if (doc?.file_id && doc.mime_type?.startsWith('audio/')) return { fileId: doc.file_id, ext: extFromName(doc.file_name) };
  return null;
}

function extFromName(name: string | undefined): string {
  if (!name) return '.mp3';
  const ext = path.extname(name).toLowerCase();
  return ext && /\.(mp3|m4a|wav|ogg|opus|aac|flac|webm)$/.test(ext) ? ext : '.mp3';
}

async function convertToWav(src: string, dest: string): Promise<void> {
  // Prefer ffmpeg (handles OPUS/AAC/webm robustly).
  try {
    await execFileAsync('ffmpeg', ['-y', '-i', src, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', dest], { timeout: 60_000 });
    return;
  } catch {
    /* try next */
  }
  try {
    await execFileAsync('afconvert', [src, '-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', dest], { timeout: 60_000 });
    return;
  } catch {
    /* try next */
  }
  // sox as a last resort.
  await execFileAsync('sox', [src, '-r', '16000', '-c', '1', dest], { timeout: 60_000 });
}

/**
 * Download a Telegram audio/voice message and transcribe it to text.
 * Returns { text, via } where `via` is the file/transcribe note, or throws a
 * descriptive error when no STT backend is available.
 */
export async function transcribeTelegramAudio(
  client: TelegramClient,
  fileId: string,
  ext: string,
): Promise<{ text: string; via: string }> {
  const { file_path } = await client.getFile(fileId);
  const tmp = os.tmpdir();
  const base = path.join(tmp, `jarv-tg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const raw = `${base}${ext}`;
  const wav = `${base}.wav`;

  try {
    await client.downloadFile(file_path, raw);
    await convertToWav(raw, wav);
    const text = await transcribe(wav);
    const trimmed = text.trim();
    if (!trimmed) throw new Error('transcription returned no text');
    return { text: trimmed, via: `voice (${ext}) → local whisper` };
  } finally {
    for (const f of [raw, wav]) {
      try {
        fs.unlinkSync(f);
      } catch {
        /* best effort */
      }
    }
  }
}
