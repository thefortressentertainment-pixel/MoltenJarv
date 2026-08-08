import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentContext } from './index.js';
import { localBackend, type ChatBackend, type ChatReply } from './backend.js';
import { runWakeSession, runVoiceSession } from './voice.js';
import type { VoiceSessionOptions } from './voice.js';
import { record, transcribe } from '../voice/index.js';

/**
 * `jarv-genie listen` — the constraint-free voice loop (JARVIS blueprint §B2).
 *
 * Matching movie J.A.R.V.I.S., Jarv should hear you without a button. `voice
 * --wake` already provides a wake-word-gated loop ("you talk, no hands"). This
 * adds the two JARVIS qualities on top:
 *
 *   1. **Spoken-instruction durability** — each request you speak is persisted
 *      into durable memory (source 'voice') so Jarv recollects what you told it
 *      out loud later (§C4 life-memory seed).
 *   2. **Event-gated privacy** — nothing is captured unless the wake phrase
 *      triggers it; raw audio is never logged, only the transcript is stored.
 *
 * `listen` runs the wake-word loop (or push-to-talk without --wake). `--once`
 * records one utterance, stores it, answers, and exits (for automation).
 */

const EXIT_STORE = ['stop', 'goodbye', 'bye', 'sleep', 'go to sleep', 'good night'];

/** Add a spoken instruction to durable memory, skipping exit/no-op phrases.
 *  Exported for tests. */
export async function persistInstruction(ctx: AgentContext, message: string, store: boolean): Promise<void> {
  if (!store) return;
  const lower = message.trim().toLowerCase();
  if (EXIT_STORE.some((w) => lower === w || lower.startsWith(w + ' '))) return;
  try {
    await ctx.memory.addFact(message.trim(), 'voice');
  } catch {
    // memory save failure is non-fatal to the conversation
  }
}

/** A local backend that persists each spoken instruction before answering. */
function persistingBackend(ctx: AgentContext, store: boolean): ChatBackend {
  const base = localBackend(ctx);
  const backend: ChatBackend = {
    ...base,
    async chat(message: string): Promise<ChatReply> {
      await persistInstruction(ctx, message, store);
      return base.chat(message);
    },
  };
  if (base.chatStream) {
    backend.chatStream = async (message: string, onDelta: (d: string) => void): Promise<ChatReply> => {
      await persistInstruction(ctx, message, store);
      return base.chatStream!(message, onDelta);
    };
  }
  return backend;
}

export interface ListenOptions {
  /** Use the wake-word loop (hands-free). Default true. */
  wake?: boolean;
  /** Wake phrases for --wake. Default: "hey jarv", etc. */
  wakePhrases?: string[];
  /** Persist spoken instructions into durable memory. Default true. */
  store?: boolean;
  /** Record one utterance, store it, answer, and exit (for automation). */
  once?: boolean;
  /** TTS on/off. Default true. */
  tts?: boolean;
  voice?: string;
  quiet?: boolean;
}

/**
 * Run the listen loop. Default: wake-word session with instruction persistence.
 * `--once` records a single utterance synchronously, stores it, answers, exits.
 */
export async function runListenCommand(ctx: AgentContext, opts: ListenOptions): Promise<void> {
  const store = opts.store ?? true;
  const backend = persistingBackend(ctx, store);
  const voiceOpts: VoiceSessionOptions = {
    wake: opts.wake ?? true,
    wakePhrases: opts.wakePhrases,
    tts: opts.tts ?? true,
    voice: opts.voice,
    quiet: opts.quiet,
  };

  if (opts.once) {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'jarv-listen-'));
    const wav = path.join(dir, 'in.wav');
    try {
      process.stdout.write('listening… say your request, then pause\n');
      await record(wav, { maxSeconds: 30 });
      process.stdout.write('transcribing…\n');
      const text = await transcribe(wav, {});
      if (!text) {
        process.stdout.write('(nothing heard)\n');
        return;
      }
      await persistInstruction(ctx, text, store);
      process.stdout.write(`you: ${text}\n`);
      if (backend.chatStream) {
        await backend.chatStream(text, (d) => process.stdout.write(d));
      } else {
        const r = await backend.chat(text);
        process.stdout.write(r.text);
      }
      process.stdout.write('\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    return;
  }

  // Wake loop (hands-free) OR push-to-talk loop, both with persistence.
  if (opts.wake) {
    await runWakeSession(backend, voiceOpts);
  } else {
    await runVoiceSession(backend, voiceOpts);
  }
}
