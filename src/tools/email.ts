import type { ToolDefinition } from '../agent/types.js';
import { sendMail, readMail } from '../email/client.js';

/**
 * Email tools. Active only when SMTP/IMAP settings are present in the secrets
 * store (see src/email/client.ts). Send is useful for web sign-ups and the
 * owner-email flows; read lets Jarv act on replies.
 */
export function emailTools(): ToolDefinition[] {
  return [
    {
      name: 'email_send',
      system: 'integration',
      description:
        'Send an email. Requires SMTP settings in the secret store (SMTP_HOST, SMTP_USER, SMTP_PASS). Use for web sign-ups, notifications, or anything that needs an outgoing message.',
      inputSchema: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'Recipient email address.' },
          subject: { type: 'string', description: 'Subject line.' },
          text: { type: 'string', description: 'Plain-text body.' },
        },
        required: ['to', 'subject', 'text'],
      },
      consequential: true,
      failClosed: true,
      handler: async (args) => {
        const to = String(args.to ?? '').trim();
        const subject = String(args.subject ?? '').trim();
        const text = String(args.text ?? '');
        if (!to || !subject) throw new Error('email_send requires to and subject');
        return sendMail({ to, subject, text });
      },
    },
    {
      name: 'email_read',
      system: 'integration',
      description:
        'Read recent messages from a mailbox (default INBOX). Requires IMAP settings in the secret store (IMAP_HOST, IMAP_USER, IMAP_PASS). Returns sender, subject, date, flags, and a snippet.',
      inputSchema: {
        type: 'object',
        properties: {
          folder: { type: 'string', description: 'Mailbox folder, e.g. INBOX (default).' },
          limit: { type: 'number', description: 'Max messages to return (default 10, max 50).' },
        },
      },
      handler: async (args) =>
        readMail({
          folder: args.folder ? String(args.folder) : undefined,
          limit: typeof args.limit === 'number' ? args.limit : undefined,
        }),
    },
  ];
}
