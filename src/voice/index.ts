import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, resolveApiKey, type EndpointConfig } from '../config/index.js';

export interface VoiceOptions {
  /** TTS voice name (macOS `say` voice). */
  voice?: string;
  /** Play responses aloud. Default true. */
  tts?: boolean;
  /** Whisper model file path. Default: auto-located in ~/.cache/whisper. */
  model?: string;
  /** Max recording length in seconds. Default 20. */
  maxSeconds?: number;
  /** Silence (seconds) after which recording auto-stops. Default 2. */
  silence?: number;
}

let currentSay: ReturnType<typeof spawn> | null = null;

/** macOS ships `say`; TTS is skipped gracefully on other platforms. */
export function hasTts(): boolean {
  return process.platform === 'darwin';
}

export function sayVoices(): string[] {
  if (!hasTts()) return [];
  try {
    const out = spawnSync('say', ['-v', '?'], { encoding: 'utf8' }).stdout ?? '';
    return out
      .split('\n')
      .map((l) => l.split(/\s{2,}/)[0])
      .filter((n): n is string => Boolean(n));
  } catch {
    return [];
  }
}

export function hasWhisperCli(): boolean {
  try {
    spawnSync('whisper-cli', ['--help'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export function locateWhisperModel(override?: string): string | null {
  if (override && fs.existsSync(override)) return override;
  if (process.env.JARV_GENIE_WHISPER_MODEL && fs.existsSync(process.env.JARV_GENIE_WHISPER_MODEL)) {
    return process.env.JARV_GENIE_WHISPER_MODEL;
  }
  const dirs = [
    path.join(os.homedir(), '.cache', 'whisper'),
    path.join(os.homedir(), 'Library', 'Caches', 'whisper'),
    path.join(os.homedir(), 'whisper.cpp', 'models'),
  ];
  for (const dir of dirs) {
    try {
      const match = fs.readdirSync(dir).find((f) => f.startsWith('ggml-') && f.endsWith('.bin'));
      if (match) return path.join(dir, match);
    } catch {
      // not present
    }
  }
  return null;
}

/** Speak text aloud (macOS). Speaks sentence-by-sentence so barge-in can stop mid-way. */
export async function speak(text: string, opts: VoiceOptions = {}): Promise<void> {
  if (!hasTts()) return;
  const cleaned = text.replace(/\s+/g, ' ').trim();
  if (!cleaned) return;
  const sentences = splitSentences(cleaned);
  for (const s of sentences) {
    await new Promise<void>((resolve) => {
      const args: string[] = [];
      if (opts.voice) args.push('-v', opts.voice);
      args.push(s);
      const proc = spawn('say', args);
      currentSay = proc;
      proc.on('close', () => resolve());
      proc.on('error', () => resolve());
    });
  }
  currentSay = null;
}

/** Stop anything currently being spoken (barge-in). */
export function stopSpeaking(): void {
  if (currentSay) {
    try {
      currentSay.kill();
    } catch {
      // already gone
    }
    currentSay = null;
  }
}

export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Record mic audio to a WAV file. Auto-stops after silence or the max duration. */
export async function record(wavFile: string, opts: VoiceOptions = {}): Promise<void> {
  const maxS = opts.maxSeconds ?? 20;
  const silenceS = opts.silence ?? 2.0;
  await runOrThrow('rec', [
    '-r', '16000', '-c', '1', '-e', 'signed-integer', '-b', '16',
    wavFile,
    'silence', '1', '0.5', '1%', '1', String(silenceS), '1%',
    'trim', '0', String(maxS),
  ]);
}

/** Transcribe a WAV file to text. Local whisper.cpp first, OpenAI API as fallback. */
export async function transcribe(wavFile: string, opts: VoiceOptions = {}): Promise<string> {
  const model = locateWhisperModel(opts.model);
  if (hasWhisperCli() && model) {
    const outBase = wavFile.replace(/\.wav$/, '');
    try {
      await runOrThrow('whisper-cli', ['-m', model, '-f', wavFile, '-otxt', '-of', outBase, '-np']);
      const text = fs.readFileSync(outBase + '.txt', 'utf8').trim();
      if (text) return text;
    } catch {
      // fall through to the cloud transcription
    }
  }
  return transcribeViaOpenAI(wavFile);
}

async function transcribeViaOpenAI(wavFile: string): Promise<string> {
  const cfg = loadConfig();
  const endpoint: EndpointConfig | null = cfg.providers.fallback;
  const key = endpoint ? resolveApiKey(endpoint) : undefined;
  if (!key) {
    throw new Error(
      'no local whisper model and no transcription key: run `jarv-genie key set OPENAI_API_KEY`, ' +
        'or install whisper.cpp and a model (see README, voice section)',
    );
  }
  const form = new FormData();
  form.append('file', new Blob([fs.readFileSync(wavFile)]), 'audio.wav');
  form.append('model', 'whisper-1');
  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}` },
    body: form,
  });
  const data = (await res.json()) as { text?: string; error?: { message?: string } };
  if (!res.ok) throw new Error(data.error?.message ?? `transcription failed: HTTP ${res.status}`);
  return (data.text ?? '').trim();
}

async function runOrThrow(cmd: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: 'inherit' });
    proc.on('error', (err) => reject(new Error(`${cmd} unavailable: ${err.message}`)));
    proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited with code ${code}`))));
  });
}

export const voiceStatus = {
  implemented: true,
  pipeline: 'mic (sox rec) → whisper.cpp → agent → macOS say TTS (barge-in, sentence streaming)',
  tts: hasTts() ? `macOS say (${sayVoices().length} voices available)` : 'unavailable on this platform',
  stt: hasWhisperCli() ? `whisper.cpp (model: ${locateWhisperModel() ?? 'not downloaded yet'})` : 'whisper.cpp not installed (brew install whisper-cpp)',
} as const;
