import assert from 'node:assert';
import net from 'node:net';
import { test } from 'node:test';
import { sendMail, readMail } from '../src/email/client.js';
import { emailTools } from '../src/tools/email.js';

interface SmtpCapture {
  mailFrom: string;
  rcptTo: string;
  data: string;
}

function startSmtpServer(): Promise<{ port: number; close: () => Promise<void>; capture: () => SmtpCapture }> {
  const capture: SmtpCapture = { mailFrom: '', rcptTo: '', data: '' };
  let collectingLast = false;
  const server = net.createServer((socket) => {
    let buf = '';
    let dataBuf = '';
    socket.write('220 localhost ready\r\n');
    socket.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      const lines = buf.split('\r\n');
      buf = lines.pop() ?? '';
      for (const l of lines) {
        if (collectingLast) {
          if (l.trim() === '.') {
            collectingLast = false;
            capture.data = dataBuf;
            dataBuf = '';
            socket.write('250 2.0.0 queued\r\n');
          } else {
            dataBuf += l + '\n';
          }
          continue;
        }
        const up = l.trim().toUpperCase();
        if (up.startsWith('EHLO')) socket.write('250-localhost\r\n250-AUTH PLAIN\r\n250 OK\r\n');
        else if (up.startsWith('AUTH')) socket.write('235 2.7.0 authenticated\r\n');
        else if (up.startsWith('MAIL FROM')) {
          capture.mailFrom = l.trim().replace(/.*FROM:</i, '').replace(/>.*$/, '');
          socket.write('250 2.1.0 ok\r\n');
        } else if (up.startsWith('RCPT TO')) {
          capture.rcptTo = l.trim().replace(/.*TO:</i, '').replace(/>.*$/, '');
          socket.write('250 2.1.5 ok\r\n');
        } else if (up === 'DATA') {
          collectingLast = true;
          socket.write('354 end with <CRLF>.<CRLF>\r\n');
        } else if (up === 'QUIT') {
          socket.write('221 bye\r\n');
          socket.end();
        } else socket.write('250 ok\r\n');
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as net.AddressInfo;
      resolve({
        port: addr.port,
        close: () => new Promise<void>((r) => server.close(() => r())),
        capture: () => capture,
      });
    });
  });
}

test('sendMail delivers over SMTP and respects subject/to/body', async () => {
  const srv = await startSmtpServer();
  try {
    const get = (name: string) => {
      if (name === 'SMTP_HOST') return '127.0.0.1';
      if (name === 'SMTP_PORT') return String(srv.port);
      if (name === 'SMTP_USER') return 'jarv@example.test';
      if (name === 'SMTP_PASS') return 'secret';
      return undefined;
    };
    const res = await sendMail({ to: 'you@example.test', subject: 'Subject Line', text: 'Hello body' }, get);
    assert.ok(res.messageId);
    const c = srv.capture();
    assert.strictEqual(c.mailFrom, 'jarv@example.test');
    assert.strictEqual(c.rcptTo, 'you@example.test');
    assert.match(c.data, /Subject: Subject Line/);
    assert.match(c.data, /Hello body/);
  } finally {
    await srv.close();
  }
});

test('sendMail throws a helpful error when SMTP is unconfigured', async () => {
  await assert.rejects(sendMail({ to: 'a@b.c', subject: 's', text: 't' }, () => undefined), /SMTP not configured/);
});

test('readMail throws a helpful error when IMAP is unconfigured', async () => {
  await assert.rejects(readMail({}, () => undefined), /IMAP not configured/);
});

test('emailTools expose send and read', () => {
  const names = emailTools().map((t) => t.name);
  assert.ok(names.includes('email_send'));
  assert.ok(names.includes('email_read'));
});

test('email_send validates required fields', async () => {
  const tool = emailTools().find((t) => t.name === 'email_send')!;
  await assert.rejects(tool.handler({ subject: 's', text: 't' }, {} as never), /to and subject/);
  await assert.rejects(tool.handler({ to: 'a@b.c' }, {} as never), /to and subject/);
});
