import { pipe } from '../mail/fake-imap-server.ts';
import type { ByteDuplex, MailSocket } from '../mail/servers.ts';

// An SMTP submission server in memory, for tests: greeting, EHLO, AUTH PLAIN, MAIL, RCPT, DATA and
// QUIT, over a byte pipe, so `@yozz.app/smtp` speaks to it as to a real one. What it answers to the
// end of DATA is scripted.

/** At the end of DATA: take the message, refuse it, or take it and drop the connection unanswered. */
export type DataAnswer = 'accept' | 'refuse' | 'drop';

export type Delivered = {
  readonly from: string;
  readonly to: readonly string[];
  /** The message as the server read it, dot-stuffing undone. */
  readonly data: string;
};

export type FakeSmtpServer = {
  /** Every message the server took, a dropped one included: it went out. */
  readonly delivered: Delivered[];
  /** Every command the server received. */
  readonly commands: string[];
  /** What the server answers to the end of the next DATA. */
  answer: DataAnswer;
  readonly open: () => MailSocket;
};

const encoder = new TextEncoder();

export const makeFakeSmtpServer = ({
  username,
  password,
}: {
  readonly username: string;
  readonly password: string;
}): FakeSmtpServer => {
  const server: FakeSmtpServer = {
    delivered: [],
    commands: [],
    answer: 'accept',
    open: () => {
      const { client, server: end, close } = pipe();
      void session(end, close);
      return { duplex: client, setQuietLimit: () => {}, destroy: close };
    },
  };

  const session = async (io: ByteDuplex, close: () => void) => {
    let buffer = '';
    const send = (text: string) => io.write(encoder.encode(text));
    const readLine = async (): Promise<string | null> => {
      for (;;) {
        const end = buffer.indexOf('\r\n');
        if (end !== -1) {
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          return line;
        }
        const chunk = await io.read();
        if (chunk === null) return null;
        buffer += new TextDecoder().decode(chunk);
      }
    };

    await send('220 smtp.fake ESMTP ready\r\n');
    let from = '';
    let to: string[] = [];
    for (;;) {
      const line = await readLine();
      if (line === null) return;
      server.commands.push(line);
      const verb = line.split(' ')[0]?.toUpperCase();
      if (verb === 'EHLO') {
        await send('250-smtp.fake\r\n250 AUTH PLAIN LOGIN\r\n');
      } else if (verb === 'AUTH') {
        const [, user, pass] = new TextDecoder()
          .decode(Uint8Array.fromBase64(line.split(' ')[2] ?? ''))
          .split('\u0000');
        await send(
          user === username && pass === password
            ? '235 Authenticated\r\n'
            : '535 Authentication failed\r\n',
        );
      } else if (verb === 'MAIL') {
        from = /<([^>]*)>/u.exec(line)?.[1] ?? '';
        to = [];
        await send('250 OK\r\n');
      } else if (verb === 'RCPT') {
        to.push(/<([^>]*)>/u.exec(line)?.[1] ?? '');
        await send('250 OK\r\n');
      } else if (verb === 'DATA') {
        await send('354 End data with <CR><LF>.<CR><LF>\r\n');
        const lines: string[] = [];
        for (;;) {
          const next = await readLine();
          if (next === null) return;
          if (next === '.') break;
          lines.push(next.startsWith('..') ? next.slice(1) : next);
        }
        if (server.answer === 'refuse') {
          await send('554 Message rejected\r\n');
          continue;
        }
        server.delivered.push({ from, to, data: lines.join('\r\n') });
        if (server.answer === 'drop') {
          close();
          return;
        }
        await send('250 OK queued\r\n');
      } else if (verb === 'QUIT') {
        await send('221 Bye\r\n');
        close();
        return;
      } else {
        await send('500 Unknown command\r\n');
      }
    }
  };

  return server;
};
