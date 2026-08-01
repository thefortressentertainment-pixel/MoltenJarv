/**
 * Voice interface — planned for v2 (see docs/ROADMAP.md).
 *
 * Target pipeline: wake word → VAD → STT → agent → TTS, fully local-first.
 *   - Wake word: openwakeword / Picovoice Porcupine (on-device)
 *   - VAD: Silero VAD
 *   - STT: faster-whisper / Whisper.cpp
 *   - TTS: Kokoro / Piper (streaming, barge-in)
 *
 * This module currently declares the contract only; no audio code ships yet.
 */
export interface VoicePipeline {
  wake(): Promise<void>;
  speak(text: string): Promise<void>;
  stop(): Promise<void>;
}

export const voiceStatus = {
  implemented: false,
  planned: 'wake word → VAD → streaming STT → agent → streaming TTS with barge-in (local-first)',
} as const;
