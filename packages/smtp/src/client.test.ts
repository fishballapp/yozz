import type { ByteDuplex } from '@yozz.app/tls';
import { describe, expect, it } from 'vitest';
import { createSmtpClient, dotStuff } from './client.ts';
import { createLineReader, readReply } from './reply.ts';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** What the client's next write must be and what the server says back; `expect: null` is the banner. */
type Step = { readonly expect: string | null; readonly reply: string };

const scriptedDuplex = (steps: readonly Step[]) => {
  const replies: string[] = [];
  let index = 0;
  const first = steps[0];
  if (first !== undefined && first.expect === null) {
    replies.push(first.reply);
    index = 1;
  }
  const duplex: ByteDuplex = {
    read: async () => {
      const next = replies.shift();
      return next === undefined ? null : encoder.encode(next);
    },
    write: async bytes => {
      const written = decoder.decode(bytes);
      const step = steps[index];
      index += 1;
      if (step === undefined) throw new Error(`unexpected client write: ${written}`);
      expect(written).toBe(step.expect);
      replies.push(step.reply);
    },
  };
  return { duplex };
};

describe('reply parsing', () => {
  const fromText = (text: string): ByteDuplex => {
    let left: Uint8Array | null = encoder.encode(text);
    return {
      read: async () => {
        const chunk = left;
        left = null;
        return chunk;
      },
      write: async () => {},
    };
  };

  it('joins a multi-line reply and keeps its code', async () => {
    const reply = await readReply(createLineReader(fromText('250-a\r\n250-b c\r\n250 d\r\n')));
    expect(reply).toEqual({ ok: true, value: { code: 250, lines: ['a', 'b c', 'd'] } });
  });

  it('refuses a bare LF, a non-reply line, and a code that changes', async () => {
    for (const text of ['250 ok\n', 'hello\r\n', '250-a\r\n500 b\r\n']) {
      const reply = await readReply(createLineReader(fromText(text)));
      expect(reply.ok).toBe(false);
      if (!reply.ok) expect(reply.reason.kind).toBe('protocol');
    }
  });

  it('caps a terminated line and a runaway multi-line reply', async () => {
    const long = await readReply(createLineReader(fromText(`250 ${'x'.repeat(5000)}\r\n`)));
    expect(long).toEqual({
      ok: false,
      reason: { kind: 'protocol', detail: 'reply line too long' },
    });
    const many = await readReply(createLineReader(fromText('250-x\r\n'.repeat(100))));
    expect(many.ok).toBe(false);
    if (!many.ok) expect(many.reason.kind).toBe('protocol');
  });

  it('reports a closed transport', async () => {
    const reply = await readReply(createLineReader(fromText('250-never fin')));
    expect(reply).toEqual({ ok: false, reason: { kind: 'closed' } });
  });
});

describe('dot stuffing', () => {
  it('doubles a leading dot on any line and terminates', () => {
    expect(decoder.decode(dotStuff(encoder.encode('a\r\n.b\r\n..c')))).toBe(
      'a\r\n..b\r\n...c\r\n.\r\n',
    );
    expect(decoder.decode(dotStuff(encoder.encode('x\r\n')))).toBe('x\r\n.\r\n');
  });
});

describe('client session', () => {
  it('EHLO, AUTH PLAIN with SASL-IR, send, quit', async () => {
    const { duplex } = scriptedDuplex([
      { expect: null, reply: '220 mx.example ESMTP\r\n' },
      {
        expect: 'EHLO yozz.app\r\n',
        reply: '250-mx.example\r\n250-SIZE 1000\r\n250-8BITMIME\r\n250 AUTH PLAIN LOGIN\r\n',
      },
      { expect: `AUTH PLAIN ${btoa('\0me@x.test\0pw')}\r\n`, reply: '235 ok\r\n' },
      { expect: 'MAIL FROM:<me@x.test> BODY=8BITMIME\r\n', reply: '250 ok\r\n' },
      { expect: 'RCPT TO:<you@y.test>\r\n', reply: '252 cannot VRFY, will try\r\n' },
      { expect: 'DATA\r\n', reply: '354 go\r\n' },
      { expect: 'Subject: hi\r\n\r\n..body\r\n', reply: '' },
      { expect: '.\r\n', reply: '250 queued as 1\r\n' },
      { expect: 'QUIT\r\n', reply: '221 bye\r\n' },
    ]);
    const client = createSmtpClient(duplex);
    expect((await client.greeting()).ok).toBe(true);
    const caps = await client.ehlo('yozz.app');
    expect(caps).toEqual({
      ok: true,
      value: { keywords: ['SIZE', '8BITMIME', 'AUTH'], auth: ['PLAIN', 'LOGIN'] },
    });
    expect(await client.authenticate('me@x.test', 'pw')).toEqual({ ok: true, value: undefined });
    const sent = await client.send({
      from: 'me@x.test',
      to: ['you@y.test'],
      data: encoder.encode('Subject: hi\r\n\r\n.body'),
    });
    expect(sent.ok).toBe(true);
    if (sent.ok) expect(sent.value.lines).toEqual(['queued as 1']);
    expect((await client.quit()).ok).toBe(true);
  });

  it('refuses to QUIT after a body write failed inside DATA', async () => {
    const { duplex } = scriptedDuplex([
      { expect: null, reply: '220 mx.example ESMTP\r\n' },
      { expect: 'MAIL FROM:<me@x.test> BODY=8BITMIME\r\n', reply: '250 ok\r\n' },
      { expect: 'RCPT TO:<you@y.test>\r\n', reply: '250 ok\r\n' },
      { expect: 'DATA\r\n', reply: '354 go\r\n' },
    ]);
    const failing: ByteDuplex = {
      read: duplex.read,
      write: async bytes => {
        if (decoder.decode(bytes).startsWith('Subject')) throw new Error('record too large');
        await duplex.write(bytes);
      },
    };
    const client = createSmtpClient(failing);
    expect((await client.greeting()).ok).toBe(true);
    const sent = await client.send({
      from: 'me@x.test',
      to: ['you@y.test'],
      data: encoder.encode('Subject: hi\r\n\r\nbody'),
    });
    // Before the dot, so a refusal: the server discards a message it never saw end.
    expect(sent).toMatchObject({ ok: false, reason: { kind: 'protocol' } });
    // The script has no QUIT step, so a write here would throw.
    expect(await client.quit()).toMatchObject({ ok: false, reason: { kind: 'protocol' } });
  });

  /**
   * Which side of the end of DATA a failure fell on decides whether the message may have gone out:
   * the caller hands a refused draft back to be sent again, and must not hand back one the server
   * may already be delivering.
   */
  describe('the end of DATA', () => {
    const throughData = [
      { expect: null, reply: '220 mx.example ESMTP\r\n' },
      { expect: 'MAIL FROM:<me@x.test>\r\n', reply: '250 ok\r\n' },
      { expect: 'RCPT TO:<you@y.test>\r\n', reply: '250 ok\r\n' },
      { expect: 'DATA\r\n', reply: '354 go\r\n' },
      { expect: 'Subject: hi\r\n\r\nbody\r\n', reply: '' },
    ];
    const envelope = {
      from: 'me@x.test',
      to: ['you@y.test'],
      data: encoder.encode('Subject: hi\r\n\r\nbody'),
    };
    const send = async (client: ReturnType<typeof createSmtpClient>) => {
      await client.greeting();
      return client.send(envelope);
    };

    it('is unconfirmed when the connection drops after the dot, before any answer', async () => {
      // The server took the dot and the connection ended: it may be delivering the message now.
      const { duplex } = scriptedDuplex([...throughData, { expect: '.\r\n', reply: '' }]);
      const client = createSmtpClient(duplex);
      expect(await send(client)).toEqual({
        ok: false,
        reason: {
          kind: 'unconfirmed',
          detail: 'the connection closed before the server answered',
        },
      });
      // Nothing more is written on a connection in an unknown state.
      expect(await client.quit()).toMatchObject({ ok: false, reason: { kind: 'protocol' } });
    });

    it('is unconfirmed when the answer after the dot is not a reply', async () => {
      const { duplex } = scriptedDuplex([
        ...throughData,
        { expect: '.\r\n', reply: 'garbage\r\n' },
      ]);
      expect(await send(createSmtpClient(duplex))).toMatchObject({
        ok: false,
        reason: { kind: 'unconfirmed' },
      });
    });

    it('is unconfirmed when writing the dot itself fails, which may have reached the server', async () => {
      const { duplex } = scriptedDuplex(throughData);
      const failing: ByteDuplex = {
        read: duplex.read,
        write: async bytes => {
          if (decoder.decode(bytes) === '.\r\n') throw new Error('socket closed');
          await duplex.write(bytes);
        },
      };
      expect(await send(createSmtpClient(failing))).toMatchObject({
        ok: false,
        reason: { kind: 'unconfirmed' },
      });
    });

    it('is unconfirmed when the answer to the dot is neither yes nor no', async () => {
      // A syntactically valid code RFC 5321 does not allow here says nothing about the message.
      const { duplex } = scriptedDuplex([
        ...throughData,
        { expect: '.\r\n', reply: '354 again?\r\n' },
      ]);
      expect(await send(createSmtpClient(duplex))).toMatchObject({
        ok: false,
        reason: { kind: 'unconfirmed' },
      });
    });

    it('is accepted on any 2xx answer to the dot', async () => {
      const { duplex } = scriptedDuplex([
        ...throughData,
        { expect: '.\r\n', reply: '251 queued\r\n' },
      ]);
      expect(await send(createSmtpClient(duplex))).toEqual({
        ok: true,
        value: { code: 251, lines: ['queued'] },
      });
    });

    it('writes nothing more once abandoned, through any command', async () => {
      // The scripts end at the dot, so any write after it would throw in the script.
      for (const [label, failing] of [
        ['a lost answer', scriptedDuplex([...throughData, { expect: '.\r\n', reply: '' }]).duplex],
        [
          'a body write that failed',
          (() => {
            const { duplex } = scriptedDuplex(throughData.slice(0, 4));
            return {
              read: duplex.read,
              write: async (bytes: Uint8Array) => {
                if (decoder.decode(bytes).startsWith('Subject')) throw new Error('reset');
                await duplex.write(bytes);
              },
            } satisfies ByteDuplex;
          })(),
        ],
      ] as const) {
        const client = createSmtpClient(failing);
        expect((await send(client)).ok, label).toBe(false);
        const abandoned = {
          ok: false,
          reason: { kind: 'protocol', detail: 'connection abandoned inside DATA' },
        };
        expect(await client.ehlo('yozz.app'), label).toEqual(abandoned);
        expect(await client.send(envelope), label).toEqual(abandoned);
        expect(await client.authenticate('u', 'p'), label).toMatchObject({ ok: false });
        expect(await client.quit(), label).toEqual(abandoned);
      }
    });

    it('is a refusal when the server answers the dot with an error', async () => {
      const { duplex } = scriptedDuplex([
        ...throughData,
        { expect: '.\r\n', reply: '554 5.7.1 message rejected\r\n' },
      ]);
      expect(await send(createSmtpClient(duplex))).toEqual({
        ok: false,
        reason: { kind: 'reply', code: 554, text: '5.7.1 message rejected' },
      });
    });

    it('is a refusal when the connection drops before DATA is accepted', async () => {
      const { duplex } = scriptedDuplex([
        ...throughData.slice(0, 3),
        { expect: 'DATA\r\n', reply: '' },
      ]);
      expect(await send(createSmtpClient(duplex))).toEqual({
        ok: false,
        reason: { kind: 'closed' },
      });
    });
  });

  it('falls back to AUTH LOGIN and surfaces a refused recipient', async () => {
    const { duplex } = scriptedDuplex([
      { expect: null, reply: '220 hi\r\n' },
      { expect: 'EHLO h\r\n', reply: '250-x\r\n250 AUTH LOGIN\r\n' },
      { expect: 'AUTH LOGIN\r\n', reply: '334 VXNlcm5hbWU6\r\n' },
      { expect: `${btoa('u')}\r\n`, reply: '334 UGFzc3dvcmQ6\r\n' },
      { expect: `${btoa('p')}\r\n`, reply: '235 ok\r\n' },
      { expect: 'MAIL FROM:<u@x>\r\n', reply: '250 ok\r\n' },
      { expect: 'RCPT TO:<nobody@y>\r\n', reply: '550 5.1.1 no such user\r\n' },
    ]);
    const client = createSmtpClient(duplex);
    await client.greeting();
    await client.ehlo('h');
    expect((await client.authenticate('u', 'p')).ok).toBe(true);
    const sent = await client.send({ from: 'u@x', to: ['nobody@y'], data: new Uint8Array() });
    expect(sent).toEqual({
      ok: false,
      reason: { kind: 'reply', code: 550, text: '5.1.1 no such user' },
    });
  });

  it('refuses an address that could break out of the command', async () => {
    const client = createSmtpClient(scriptedDuplex([]).duplex);
    const sent = await client.send({
      from: 'a@x',
      to: ['b@y>\r\nRCPT TO:<c@z'],
      data: new Uint8Array(),
    });
    expect(sent.ok).toBe(false);
    if (!sent.ok) expect(sent.reason.kind).toBe('protocol');
  });
});
