export interface WakeMatch {
  phrase: string;
  command: string;
}

export const DEFAULT_WAKE_PHRASES = ['hey jarv', 'hey jarvis', 'okay jarv', 'hello jarv'] as const;

/** Whisper often mangles the wake word; map each phrase to common renderings. */
const SYNONYMS: Record<string, string[]> = {
  'hey jarv': ['hey jarv', 'hey jar', 'hey jarvie', 'hey jarvis', 'he jarv'],
  'hey jarvis': ['hey jarvis', 'hey jarv', 'hey jar', 'hey jarvie'],
  'okay jarv': ['okay jarv', 'ok jarv', 'okay jar', 'okay jarvis', 'ok jar'],
  'hello jarv': ['hello jarv', 'hi jarv', 'hey there jarv', 'hello jarvis'],
};

interface Candidate {
  key: string;
  display: string;
}

/** Expand configured phrases plus their whisper-proof synonyms. */
export function expandWakePhrases(phrases: string[] = [...DEFAULT_WAKE_PHRASES]): Candidate[] {
  const seen = new Set<string>();
  const out: Candidate[] = [];
  for (const p of phrases) {
    const display = p.trim();
    const key = display.toLowerCase();
    const keys = SYNONYMS[key] ? SYNONYMS[key] : [key];
    for (const k of keys) {
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ key: k, display });
    }
  }
  return out;
}

/**
 * Detect a wake phrase anywhere in a transcript and return the rest as the
 * command. Handles the phrase at the start, end, or middle of the utterance.
 * Returns null when no wake phrase is present.
 */
export function matchWakePhrase(text: string, phrases: string[] = [...DEFAULT_WAKE_PHRASES]): WakeMatch | null {
  const candidates = expandWakePhrases(phrases);
  const lower = text.toLowerCase();
  let best: { idx: number; key: string; display: string; command: string } | null = null;
  for (const c of candidates) {
    const idx = lower.indexOf(c.key);
    if (idx < 0) continue;
    const before = text.slice(0, idx).replace(/[\s,.;:!?'"()\-]+$/, '');
    const after = text.slice(idx + c.key.length).replace(/^[\s,.;:!?'"()\-]+/, '');
    const command = [before, after].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
    if (!best || idx < best.idx || (idx === best.idx && c.key.length > best.key.length)) {
      best = { idx, key: c.key, display: c.display, command };
    }
  }
  return best ? { phrase: best.display, command: best.command } : null;
}
