import { createInterface } from 'node:readline/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChatBackend } from './backend.js';
import { record, speak, stopSpeaking, transcribe, splitSentences } from '../voice/index.js';

export interface VoiceSessionOptions {
  voice?: string;
  tts?: boolean;
  model?: string;
  maxSeconds?: number;
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

    const wav = path.join(mkdtempSync(path.join(os.tmpdir(), 'jarv-vc-')), 'in.wav');
    try {
      process.stdout.write('  listening… ');
      await record(wav, { maxSeconds: opts.maxSeconds });
      const text = await transcribe(wav, opts);
      rmSync(path.dirname(wav), { recursive: true, force: true });
      process.stdout.write('\n');
      if (!text) {
        process.stdout.write('  (nothing heard)\n');
        continue;
      }
      process.stdout.write(`  you: ${text}\n`);

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

      if (speaking && reply) {
        stopSpeaking();
        await speak(reply, { voice: opts.voice, tts: true });
      }
    } catch (err) {
      stopSpeaking();
      process.stdout.write(`\n  error: ${err instanceof Error ? err.message : String(err)}\n`);
    } finally {
      rmSync(path.dirname(wav), { recursive: true, force: true });
    }
  }
}

export { splitSentences };
