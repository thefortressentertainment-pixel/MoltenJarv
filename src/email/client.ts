import nodemailer from 'nodemailer';
import type MailTransport from 'nodemailer/lib/smtp-transport/index.js';
import type MailMessage from 'nodemailer/lib/mailer/index.js';
import { ImapFlow } from 'imapflow';
import { getSecretStore } from '../config/secrets.js';

/**
 * Provider-agnostic email via SMTP (send) and IMAP (read). All settings come
 * from the secrets store so credentials never touch the config file:
 *   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS
 *   IMAP_HOST, IMAP_PORT, IMAP_USER, IMAP_PASS
 *   EMAIL_FROM (optional From address used when sending)
 * Configure once with: jarv-genie key set <NAME> <value>
 */

export interface EmailSendOptions {
  to: string;
  subject: string;
  text: string;
  from?: string;
}

export interface EmailMessage {
  seq: number;
  uid: string | number;
  from: string | null;
  subject: string | null;
  date: Date | null;
  flags: string[];
  snippet: string | null;
}

export interface EmailReadOptions {
  folder?: string;
  limit?: number;
}

type Getter = (name: string) => string | undefined;

function secretOrEnv(get: Getter, name: string): string | undefined {
  return getSecretStore().get(name) ?? get(name) ?? undefined;
}

export function createSmtpTransport(get: Getter = (n) => process.env[n]): ReturnType<typeof nodemailer.createTransport> | null {
  const host = secretOrEnv(get, 'SMTP_HOST');
  const user = secretOrEnv(get, 'SMTP_USER');
  if (!host || !user) return null;
  return nodemailer.createTransport({
    host,
    port: Number(secretOrEnv(get, 'SMTP_PORT') ?? '587'),
    secure: secretOrEnv(get, 'SMTP_SECURE') === 'true',
    auth: { user, pass: secretOrEnv(get, 'SMTP_PASS') ?? '' },
  } satisfies MailTransport.Options);
}

export async function sendMail(
  opts: EmailSendOptions,
  get: Getter = (n) => process.env[n],
): Promise<{ messageId: string }> {
  const transport = createSmtpTransport(get);
  if (!transport) {
    throw new Error('SMTP not configured: set SMTP_HOST, SMTP_USER, SMTP_PASS (and SMTP_PORT) via: jarv-genie key set <NAME> <value>');
  }
  const from = opts.from ?? secretOrEnv(get, 'EMAIL_FROM') ?? (secretOrEnv(get, 'SMTP_USER') ?? '');
  const info = await transport.sendMail({
    from,
    to: opts.to,
    subject: opts.subject,
    text: opts.text,
  } satisfies MailMessage.Options);
  return { messageId: info.messageId ?? '' };
}

export async function openImap(get: Getter = (n) => process.env[n]): Promise<{ client: ImapFlow; close: () => Promise<void> } | null> {
  const host = secretOrEnv(get, 'IMAP_HOST');
  const user = secretOrEnv(get, 'IMAP_USER');
  if (!host || !user) return null;
  const client = new ImapFlow({
    host,
    port: Number(secretOrEnv(get, 'IMAP_PORT') ?? '993'),
    secure: secretOrEnv(get, 'IMAP_SECURE') !== 'false',
    auth: { user, pass: secretOrEnv(get, 'IMAP_PASS') ?? '' },
    logger: false,
  });
  await client.connect();
  return { client, close: () => client.logout() };
}

export async function readMail(opts: EmailReadOptions = {}, get: Getter = (n) => process.env[n]): Promise<EmailMessage[]> {
  const folder = opts.folder ?? 'INBOX';
  const limit = Math.max(1, Math.min(50, Math.trunc(opts.limit ?? 10)));
  const imap = await openImap(get);
  if (!imap) {
    throw new Error('IMAP not configured: set IMAP_HOST, IMAP_USER, IMAP_PASS (and IMAP_PORT) via: jarv-genie key set <NAME> <value>');
  }
  try {
    const lock = await imap.client.getMailboxLock(folder);
    try {
      const messages: EmailMessage[] = [];
      const out: EmailMessage[] = [];
      for await (const msg of imap.client.fetch(`1:*`, { envelope: true, flags: true, source: true }, { uid: true })) {
        messages.push({
          seq: msg.seq,
          uid: msg.uid,
          from: formatFrom(msg.envelope?.from),
          subject: msg.envelope?.subject ?? null,
          date: msg.envelope?.date ?? null,
          flags: msg.flags ? [...msg.flags] : [],
          snippet: snippetText(extractText(msg.source)),
        });
      }
      for (const m of messages.slice(-limit).reverse()) out.push(m);
      return out;
    } finally {
      lock.release();
    }
  } finally {
    await imap.close();
  }
}

function formatFrom(from: { name?: string; address?: string }[] | undefined): string | null {
  if (!from || from.length === 0) return null;
  const name = (from[0]?.name ?? '').trim();
  const address = (from[0]?.address ?? '').trim();
  if (name && address) return `${name} <${address}>`;
  return address || name || null;
}

function extractText(source: unknown): string {
  if (Buffer.isBuffer(source)) return source.toString('utf8');
  if (typeof source === 'string') return source;
  return String(source ?? '');
}

function snippetText(text: string): string {
  const cleaned = text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return cleaned.slice(0, 200) + (cleaned.length > 200 ? '…' : '');
}
