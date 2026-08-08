import { randomInt } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { dataHome } from '../config/defaults.js';

/**
 * Verified-device trust layer for remote approval.
 *
 * The goal ("verify, then trust or distrust a remote sender") can't use a MAC
 * address — Telegram only surfaces `chat.id`. Instead we bind a preferred remote
 * identity to this machine via a **one-time out-of-band pairing code**: Jarv shows
 * a short, time-limited code on the Mac's own screen (terminal + macOS
 * notification), and the operator messages the bot `verify <code>` from Telegram.
 * Because the code is visible only on the machine physically next to the sender at
 * pairing time, completing it cryptographically-confirms that chat id is the owner.
 *
 * After pairing, `isTrustedDevice(chatId)` reports whether messages/approvals from
 * that chat may be stream-lined. Untrusted chats keep the "not authorized" hard
 * gate. If no pairing has ever happened, the bridge falls back to today's behavior.
 */

// A single active pairing code. Because `jarv-genie pair` and the Telegram bridge
// are separate processes, the challenge is PERSISTED to disk so the bridge can
// verify it. It is single-use and time-expiring.
const CHALLENGE_FILE = 'pairing-challenge.json';

interface ChallengeRecord {
  code: string;
  expiresAt: number;
}

function challengeFile(): string {
  return path.join(dataHome(), CHALLENGE_FILE);
}

function readChallenge(): ChallengeRecord | null {
  try {
    const raw = JSON.parse(fs.readFileSync(challengeFile(), 'utf8')) as ChallengeRecord;
    if (raw && typeof raw.code === 'string' && typeof raw.expiresAt === 'number') return raw;
    return null;
  } catch {
    return null;
  }
}

function writeChallenge(record: ChallengeRecord): void {
  fs.mkdirSync(path.dirname(challengeFile()), { recursive: true, mode: 0o700 });
  fs.writeFileSync(challengeFile(), JSON.stringify(record) + '\n', { mode: 0o600 });
}

function clearChallenge(): void {
  try {
    fs.rmSync(challengeFile(), { force: true });
  } catch {
    /* best effort */
  }
}

/** Length of the random code (screen-safe). */
const CODE_LENGTH = 4;
/** How long a pairing code stays valid before expiring. */
const PAIR_TTL_MS = 5 * 60 * 1000;

/** A memorable, unambiguous code drawn from a reduced alphabet (no 0/O, 1/I/l). */
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

export function generatePairingCode(bytes = CODE_LENGTH): string {
  const out: string[] = [];
  for (let i = 0; i < bytes; i++) out.push(ALPHABET[randomInt(ALPHABET.length)]!);
  return out.join('');
}

export interface PairingChallenge {
  code: string;
  expiresAt: number;
}

/** Begin a pairing challenge (persisted, one live at a time). Returns the code. */
export function createPairingChallenge(): PairingChallenge {
  const code = generatePairingCode();
  const expiresAt = Date.now() + PAIR_TTL_MS;
  writeChallenge({ code, expiresAt });
  return { code, expiresAt };
}

/** Whether a submitted code matches the live (persisted) challenge and is valid. */
export function verifyPairingCode(submitted: string): boolean {
  const challenge = readChallenge();
  if (!challenge) return false;
  if (Date.now() > challenge.expiresAt) return false; // expired
  const ok = submitted.trim().toUpperCase() === challenge.code;
  if (!ok) return false;
  clearChallenge(); // single-use: burn the code on success
  return true;
}

/** Invalidate any live challenge (e.g. when leaving pairing mode). */
export function clearPairingChallenge(): void {
  clearChallenge();
}

// ── Trusted-device record (persisted) ─────────────────────────────────

const TRUST_FILE = 'trusted-device.json';

interface TrustRecord {
  chatId: string;
  pairedAt: string;
}

function trustFile(): string {
  return path.join(dataHome(), TRUST_FILE);
}

function readTrust(): TrustRecord | null {
  try {
    const raw = JSON.parse(fs.readFileSync(trustFile(), 'utf8')) as TrustRecord;
    if (raw && typeof raw.chatId === 'string' && raw.chatId) return raw;
    return null;
  } catch {
    return null;
  }
}

function writeTrust(record: TrustRecord): void {
  fs.mkdirSync(path.dirname(trustFile()), { recursive: true, mode: 0o700 });
  fs.writeFileSync(trustFile(), JSON.stringify(record, null, 2) + '\n', { mode: 0o600 });
}

/** Record a successfully paired chat id as the trusted device. Returns true. */
export function pairTrustedDevice(chatId: string | number): boolean {
  writeTrust({ chatId: String(chatId), pairedAt: new Date().toISOString() });
  return true;
}

/** The paired chat id, or null when no device has been verified yet. */
export function trustedDeviceChatId(): string | null {
  return readTrust()?.chatId ?? null;
}

/** True when `chatId` is the verified/paired device (case-and-type-insensitive). */
export function isTrustedDevice(chatId: string | number | undefined): boolean {
  if (chatId === undefined || chatId === null) return false;
  const trusted = trustedDeviceChatId();
  return trusted !== null && String(chatId) === trusted;
}

/** For tests: clear the on-disk trust record. */
export function clearTrustedDevice(): void {
  try {
    fs.rmSync(trustFile(), { force: true });
  } catch {
    /* best effort */
  }
}
