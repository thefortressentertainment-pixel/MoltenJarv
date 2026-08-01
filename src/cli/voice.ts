import { createInterface } from 'node:readline/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChatBackend } from './backend.js';
import { record, speak, stopSpeaking, streamRecord, transcribe, splitSentences } from '../voice/index.js';
import { matchWakePhrase, DEFAULT_WAKE_PHRASES } from '../voice/wake.js';

export interface VoiceSessionOptions {
  voice?: string;
  tts?: boolean;
  model?: string;
  maxSeconds?: number;
  /** Live partial transcription while speaking. */
  live?: boolean;
  /** Hands-free wake-word mode instead of push-to-talk. */
  wake?: boolean;
  /** Phrases that trigger the wake session. Default: "hey jarv", etc. */
  wakePhrases?: string[];
  /** Suppress per-utterance chatter in wake mode. */
  quiet?: boolean;
  /** Install Piper neural TTS into ~/.jarv-genie and exit. */
  setupPiper?: boolean;
}

const EXIT_PHRASES = ['stop', 'goodbye', 'bye', 'sleep', 'go to sleep', 'good night'];

async function recordUtterance(
  opts: VoiceSessionOptions,
  onPartial: (p: string) => void,
): Promise<{ wav: string; dir: string }> {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'jarv-vc-'));
  const wav = path.join(dir, 'in.wav');
  if (opts.live) {
    await streamRecord(wav, opts, onPartial);
  } else {
    await record(wav, opts);
  }
  return { wav, dir };
}

function clearPartial(partialLen: number): void {
  if (partialLen > 0) {
    process.stdout.write('\r' + ' '.repeat(partialLen) + '\r');
  }
}

async function answerAndSpeak(backend: ChatBackend, text: string, opts: VoiceSessionOptions): Promise<void> {
  let reply: string;
  if (backend.chatStream) {
    process.stdout.write('  jarv: ');
    const result = await backend.chatStream(text, (d) => process.stdout.write(d));
    process.stdout.write('\n');
    reply = result.text;
  } else {
    const result = await backend.chat(text);
    process.stdout.write(`  jarv: ${result.text}\n`);
    reply = result.text;
  }
  if ((opts.tts ?? true) && reply) {
    stopSpeaking();
    await speak(reply, { voice: opts.voice, tts: true });
  }
}

/**
 * Interactive voice session: press Enter to record, Jarv Genie transcribes,
 * answers, and speaks. Ctrl+C exits. `!` toggles speaking mid-session.
 */
export async function runVoiceSession(backend: ChatBackend, opts: VoiceSessionOptions): Promise<void> {
  const tts = opts.tts ?? true;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  rl.on('SIGINT', () => {
    stopSpeaking();
    process.stdout.write('\nbye\n');
    process.exit(0);
  });

  process.stdout.write(
    `Jarv Genie voice mode (${backend.kind})\n` +
      `  press Enter to start recording — it stops after a pause\n` +
      `  commands: /new  /quit  ! (toggle speaking)\n` +
      (opts.live ? '  live captions: on (you see what is being heard as you speak)\n' : '') +
      `  ctrl-c to exit\n`,
  );

  let speaking = tts;
  for (;;) {
    const line = (await rl.question('🎙> ')).trim();
    if (line === '/quit' || line === '/exit') {
      process.stdout.write('bye\n');
      process.exit(0);
    }
    if (line === '/new') {
      await backend.reset();
      process.stdout.write('Session reset.\n');
      continue;
    }
    if (line === '!') {
      speaking = !speaking;
      process.stdout.write(`Speaking ${speaking ? 'on' : 'off'}\n`);
      continue;
    }

    let partialLen = 0;
    const onPartial = (p: string) => {
      clearPartial(partialLen);
      const msg = `  (${p})`;
      process.stdout.write(msg);
      partialLen = msg.length;
    };
    const { wav, dir } = await recordUtterance(opts, onPartial);
    try {
      process.stdout.write('  listening… ');
      const text = await transcribe(wav, opts);
      clearPartial(partialLen);
      process.stdout.write('\n');
      if (!text) {
        process.stdout.write('  (nothing heard)\n');
        continue;
      }
      process.stdout.write(`  you: ${text}\n`);
      await answerAndSpeak(backend, text, { ...opts, tts: speaking });
    } catch (err) {
      stopSpeaking();
      clearPartial(partialLen);
      process.stdout.write(`\n  error: ${err instanceof Error ? err.message : String(err)}\n`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

/**
 * Hands-free voice session: it keeps listening and only answers when the wake
 * phrase ("hey jarv") is heard. Say the wake word alone and it prompts for the
 * request; "stop" / "goodbye" puts it back to sleep.
 */
export async function runWakeSession(backend: ChatBackend, opts: VoiceSessionOptions): Promise<void> {
  const tts = opts.tts ?? true;
  const phrases = opts.wakePhrases && opts.wakePhrases.length ? opts.wakePhrases : [...DEFAULT_WAKE_PHRASES];
  const quiet = opts.quiet ?? false;

  process.stdout.write(
    `Jarv Genie wake mode (${backend.kind}) — hands-free\n` +
      `  wake phrases: ${phrases.join(' | ')}\n` +
      `  say "stop" or "goodbye" to go back to sleep\n` +
      `  ctrl-c to exit\n`,
  );

  const ask = async (): Promise<string> => {
    let partialLen = 0;
    const onPartial = (p: string) => {
      clearPartial(partialLen);
      const msg = `  (${p})`;
      process.stdout.write(msg);
      partialLen = msg.length;
    };
    const { wav, dir } = await recordUtterance(opts, onPartial);
    try {
      process.stdout.write('\n');
      const text = await transcribe(wav, opts);
      clearPartial(partialLen);
      return text;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  for (;;) {
    try {
      if (!quiet) process.stdout.write('\n  listening… ');
      let text = await ask();
      if (!text) continue;

      const matched = matchWakePhrase(text, phrases);
      let command = matched?.command ?? '';
      if (!command && matched) {
        process.stdout.write('  jarv: yes?\n');
        const follow = await ask();
        if (follow) command = follow;
      }
      if (!command) {
        if (!quiet) process.stdout.write(`  (waiting for ${phrases.join(' or ')})\n`);
        continue;
      }

      const lower = command.toLowerCase();
      if (EXIT_PHRASES.some((w) => lower === w || lower.startsWith(w + ' '))) {
        if (tts) await speak('Going to sleep.', { voice: opts.voice });
        process.stdout.write('  jarv: going to sleep\n');
        continue;
      }

      process.stdout.write(`  you: ${command}\n`);
      await answerAndSpeak(backend, command, opts);
    } catch (err) {
      stopSpeaking();
      process.stdout.write(`\n  error: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }
}

export { splitSentences };
