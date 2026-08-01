import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
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

export interface StreamOptions extends VoiceOptions {
  /** How often (ms) to run a partial transcription while recording. Default 1500. */
  liveEveryMs?: number;
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

const PIPER_VENV = (): string => path.join(os.homedir(), '.jarv-genie', 'piper-venv');
const VOICES_DIR = (): string => path.join(os.homedir(), '.jarv-genie', 'voices');

/** Piper (neural TTS) installed into ~/.jarv-genie/piper-venv via installPiper(). */
export function hasPiper(): boolean {
  return fs.existsSync(path.join(PIPER_VENV(), 'bin', 'piper'));
}

export function locatePiperVoice(): string | null {
  try {
    const model = fs.readdirSync(VOICES_DIR()).find((n) => n.endsWith('.onnx'));
    return model ? path.join(VOICES_DIR(), model) : null;
  } catch {
    return null;
  }
}

/**
 * Install Piper neural TTS into a private venv and download an English voice
 * model. Opt-in (`jarv-genie voice --setup-piper`); voice keeps using macOS
 * `say` until this succeeds.
 */
export async function installPiper(): Promise<string> {
  const venv = PIPER_VENV();
  const python = process.env.JARV_GENIE_PYTHON ?? 'python3';
  await runOrThrow(python, ['-m', 'venv', venv]);
  await runOrThrow(path.join(venv, 'bin', 'pip'), ['install', '-q', 'piper-tts']);
  fs.mkdirSync(VOICES_DIR(), { recursive: true });
  const model = path.join(VOICES_DIR(), 'en_US-amy-medium.onnx');
  if (!fs.existsSync(model)) {
    const base = 'https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/en/en_US/amy/medium/';
    await downloadFile(base + 'en_US-amy-medium.onnx', model);
    await downloadFile(base + 'en_US-amy-medium.onnx.json', model + '.json');
  }
  return model;
}

async function downloadFile(url: string, dest: string): Promise<void> {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

/** Speak text aloud. Prefers Piper (neural, fast) when installed; falls back to macOS `say`. */
export async function speak(text: string, opts: VoiceOptions = {}): Promise<void> {
  if (!hasTts()) return;
  const cleaned = text.replace(/\s+/g, ' ').trim();
  if (!cleaned) return;
  const model = locatePiperVoice();
  if (hasPiper() && model && opts.tts !== false) {
    await speakPiper(cleaned, model);
    return;
  }
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

async function runOrThrow(cmd: string, args: string[], opts: { input?: string } = {}): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const proc = spawn(cmd, args, opts.input ? { stdio: ['pipe', 'inherit', 'inherit'] } : { stdio: 'inherit' });
    if (opts.input && proc.stdin) {
      proc.stdin.write(opts.input);
      proc.stdin.end();
    }
    proc.on('error', (err) => reject(new Error(`${cmd} unavailable: ${err.message}`)));
    proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited with code ${code}`))));
  });
}

async function speakPiper(text: string, model: string): Promise<void> {
  const outWav = path.join(os.tmpdir(), `jarv-piper-${process.pid}-${Date.now()}.wav`);
  try {
    await runOrThrow(path.join(PIPER_VENV(), 'bin', 'piper'), ['--model', model, '--output_file', outWav], { input: text });
    await new Promise<void>((resolve) => {
      const proc = spawn('afplay', [outWav]);
      currentSay = proc;
      proc.on('close', () => resolve());
      proc.on('error', () => resolve());
    });
    currentSay = null;
  } finally {
    try {
      fs.unlinkSync(outWav);
    } catch {
      // already gone
    }
  }
}

/** Write a 16-bit mono 16kHz WAV file from raw PCM bytes. */
export function writeWav(file: string, pcm: Buffer): void {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16000, 24);
  header.writeUInt32LE(32000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  fs.writeFileSync(file, Buffer.concat([header, pcm]));
}

/**
 * Record mic audio straight to raw PCM on stdout while echoing live partial
 * transcriptions (streaming STT). Stops on silence or max duration, then writes
 * the complete utterance to `wavFile`.
 */
export async function streamRecord(wavFile: string, opts: StreamOptions = {}, onPartial: (partial: string) => void): Promise<void> {
  const maxS = opts.maxSeconds ?? 20;
  const silenceS = opts.silence ?? 2.0;
  const liveEvery = opts.liveEveryMs ?? 1500;
  const model = locateWhisperModel(opts.model);
  const canPartial = hasWhisperCli() && model !== null;
  const chunks: Buffer[] = [];
  let lastPartialAt = 0;

  await new Promise<void>((resolve, reject) => {
    const proc = spawn('rec', [
      '-r', '16000', '-c', '1', '-e', 'signed-integer', '-b', '16', '-t', 'raw', '-',
      'silence', '1', '0.5', '1%', '1', String(silenceS), '1%',
      'trim', '0', String(maxS),
    ]);
    proc.stdout.on('data', (d: Buffer) => {
      chunks.push(d);
      if (!canPartial) return;
      const now = Date.now();
      if (now - lastPartialAt >= liveEvery) {
        lastPartialAt = now;
        void transcribePartial(chunks, model as string, onPartial);
      }
    });
    proc.on('error', (err) => reject(new Error(`rec unavailable: ${err.message}`)));
    proc.on('close', (code) => {
      if (code === 0) {
        writeWav(wavFile, Buffer.concat(chunks));
        resolve();
      } else {
        reject(new Error(`rec exited with code ${code}`));
      }
    });
  });
}

async function transcribePartial(chunks: Buffer[], model: string, onPartial: (partial: string) => void): Promise<void> {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'jarv-live-'));
  try {
    const f = path.join(dir, 'p.wav');
    writeWav(f, Buffer.concat(chunks));
    const out = spawnSync('whisper-cli', ['-m', model, '-f', f, '-np', '-nt', '-t', '4'], {
      encoding: 'utf8',
      timeout: 15_000,
    });
    const text = (out.stdout ?? '').trim();
    if (text) onPartial(text);
  } catch {
    // live partials are best-effort; the final pass still happens
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export const voiceStatus = {
  implemented: true,
  pipeline: 'mic (sox rec) → whisper.cpp → agent → TTS (Piper neural when installed, else macOS say; barge-in, sentence streaming)',
  tts: hasPiper()
    ? `Piper neural (${locatePiperVoice() ?? 'model missing'})`
    : `macOS say (${sayVoices().length} voices available) — run \`jarv-genie voice --setup-piper\` for neural TTS`,
  stt: hasWhisperCli() ? `whisper.cpp (model: ${locateWhisperModel() ?? 'not downloaded yet'})` : 'whisper.cpp not installed (brew install whisper-cpp)',
  wakeWord: 'supported via `jarv-genie voice --wake` (transcript keyword match, fully local)',
  streamingStt: 'supported via `jarv-genie voice --live` (rolling whisper partials while speaking)',
} as const;
