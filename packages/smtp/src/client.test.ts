import { describe, expect, it } from 'vitest';
import { createSmtpClient, dotStuff } from './client.ts';
import { createLineReader, readReply } from './reply.ts';
import type { ByteDuplex } from './transport.ts';

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

  it('terminates an empty message and one that is only a dot', () => {
    expect(decoder.decode(dotStuff(new Uint8Array()))).toBe('.\r\n');
    expect(decoder.decode(dotStuff(encoder.encode('.')))).toBe('..\r\n.\r\n');
    expect(decoder.decode(dotStuff(encoder.encode('.\r\n.\r\n')))).toBe('..\r\n..\r\n.\r\n');
  });

  it('leaves a dot inside a line, and a bare CR or LF line start, alone', () => {
    expect(decoder.decode(dotStuff(encoder.encode('a.b\r\nc\r.d\n.e')))).toBe(
      'a.b\r\nc\r.d\n..e\r\n.\r\n',
    );
  });

  it('stuffs a 36 MB message byte for byte', () => {
    // Lines of 75 characters, a third of them starting with a dot.
    const line = (dotted: boolean) => `${dotted ? '.' : 'x'}${'y'.repeat(73)}\r\n`;
    const lines = Array.from({ length: 480_000 }, (_, index) => line(index % 3 === 0));
    const data = encoder.encode(lines.join(''));
    expect(data.length).toBeGreaterThan(36_000_000);
    const stuffed = dotStuff(data);
    expect(stuffed.length).toBe(data.length + 160_000 + 3);
    expect(decoder.decode(stuffed.subarray(0, 80))).toBe(
      `..${'y'.repeat(73)}\r\nx${'y'.repeat(2)}`,
    );
    expect(decoder.decode(stuffed.subarray(-(76 + 3)))).toBe(`${line(false)}.\r\n`);
    // Unstuffing gives the message back.
    const unstuffed = decoder.decode(stuffed.subarray(0, -3)).replaceAll('\r\n..', '\r\n.');
    expect(unstuffed.replace(/^\.\./, '.')).toBe(lines.join(''));
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
      { expect: 'MAIL FROM:<me@x.test> SIZE=20 BODY=8BITMIME\r\n', reply: '250 ok\r\n' },
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
      value: {
        keywords: ['SIZE', '8BITMIME', 'AUTH'],
        auth: ['PLAIN', 'LOGIN'],
        maxMessageBytes: 1000,
      },
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

    /** A relay's `write` resolves with the bytes still on their way; `flush` says whether they went. */
    describe('over a transport that flushes', () => {
      const flushing = (
        steps: readonly Step[],
        flush: () => Promise<void>,
        writes: string[] = [],
      ): ByteDuplex => {
        const { duplex } = scriptedDuplex(steps);
        return {
          read: duplex.read,
          write: async bytes => {
            writes.push(decoder.decode(bytes));
            await duplex.write(bytes);
          },
          flush,
        };
      };

      it('writes the dot only once the message has gone', async () => {
        const events: string[] = [];
        const duplex = flushing(
          [...throughData, { expect: '.\r\n', reply: '250 queued\r\n' }],
          async () => {
            events.push('flushed');
          },
          events,
        );
        expect((await send(createSmtpClient(duplex))).ok).toBe(true);
        expect(events.slice(-3)).toEqual(['Subject: hi\r\n\r\nbody\r\n', 'flushed', '.\r\n']);
      });

      it('is a refusal when the message was dropped, and the dot never goes', async () => {
        const writes: string[] = [];
        const client = createSmtpClient(
          flushing(
            throughData,
            async () => {
              throw new Error('Relay connection closed');
            },
            writes,
          ),
        );
        expect(await send(client)).toMatchObject({
          ok: false,
          reason: { kind: 'protocol', detail: expect.stringContaining('Relay connection closed') },
        });
        expect(writes).not.toContain('.\r\n');
        expect(await client.quit()).toEqual({
          ok: false,
          reason: { kind: 'protocol', detail: 'connection abandoned inside DATA' },
        });
      });

      it('is unconfirmed when the connection drops after the dot', async () => {
        const client = createSmtpClient(
          flushing([...throughData, { expect: '.\r\n', reply: '' }], async () => {}),
        );
        expect(await send(client)).toMatchObject({ ok: false, reason: { kind: 'unconfirmed' } });
      });

      it('is unconfirmed when the message has gone and writing the dot fails', async () => {
        const { duplex } = scriptedDuplex(throughData);
        const client = createSmtpClient({
          read: duplex.read,
          write: async bytes => {
            if (decoder.decode(bytes) === '.\r\n') throw new Error('Relay connection closed');
            await duplex.write(bytes);
          },
          flush: async () => {},
        });
        expect(await send(client)).toMatchObject({ ok: false, reason: { kind: 'unconfirmed' } });
      });
    });

    it('needs no flush over a plain socket', async () => {
      const { duplex } = scriptedDuplex([
        ...throughData,
        { expect: '.\r\n', reply: '250 queued\r\n' },
      ]);
      expect('flush' in duplex).toBe(false);
      expect(await send(createSmtpClient(duplex))).toEqual({
        ok: true,
        value: { code: 250, lines: ['queued'] },
      });
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

  describe('SIZE', () => {
    const ehlo = async (keywordLines: string) => {
      const { duplex } = scriptedDuplex([
        { expect: null, reply: '220 mx.example ESMTP\r\n' },
        { expect: 'EHLO h\r\n', reply: `250-mx.example\r\n${keywordLines}` },
      ]);
      const client = createSmtpClient(duplex);
      await client.greeting();
      return client.ehlo('h');
    };

    it('keeps the value SIZE declares', async () => {
      expect(await ehlo('250 SIZE 35882577\r\n')).toMatchObject({
        ok: true,
        value: { keywords: ['SIZE'], maxMessageBytes: 35_882_577 },
      });
    });

    it('reads SIZE alone, SIZE 0, an unreadable value and no SIZE as no limit', async () => {
      for (const lines of [
        '250 SIZE\r\n',
        '250 SIZE 0\r\n',
        '250 SIZE lots\r\n',
        '250 SIZE -5\r\n',
        '250 8BITMIME\r\n',
      ]) {
        expect(await ehlo(lines)).toMatchObject({ ok: true, value: { maxMessageBytes: null } });
      }
    });

    const limited = (data: Uint8Array, rest: readonly Step[]) => {
      const { duplex } = scriptedDuplex([
        { expect: null, reply: '220 mx.example ESMTP\r\n' },
        { expect: 'EHLO h\r\n', reply: '250-mx.example\r\n250 SIZE 20\r\n' },
        ...rest,
      ]);
      const client = createSmtpClient(duplex);
      return {
        client,
        send: async () => {
          await client.greeting();
          await client.ehlo('h');
          return client.send({ from: 'me@x.test', to: ['you@y.test'], data });
        },
      };
    };

    it('refuses a message over the limit before writing anything, and leaves the connection usable', async () => {
      // The script ends at QUIT: a MAIL FROM, or any byte of the message, would throw.
      const { client, send } = limited(new Uint8Array(21), [
        { expect: 'QUIT\r\n', reply: '221 bye\r\n' },
      ]);
      expect(await send()).toEqual({ ok: false, reason: { kind: 'too-large', limitBytes: 20 } });
      expect((await client.quit()).ok).toBe(true);
    });

    it('counts the message before dot-stuffing, and takes one exactly at the limit', async () => {
      // 20 bytes that stuff to 21, and no terminator counted.
      const data = encoder.encode('.aaaaaaaaaaaaaaaaaaa');
      expect(data.length).toBe(20);
      const { send } = limited(data, [
        { expect: 'MAIL FROM:<me@x.test> SIZE=20\r\n', reply: '250 ok\r\n' },
        { expect: 'RCPT TO:<you@y.test>\r\n', reply: '250 ok\r\n' },
        { expect: 'DATA\r\n', reply: '354 go\r\n' },
        { expect: '..aaaaaaaaaaaaaaaaaaa\r\n', reply: '' },
        { expect: '.\r\n', reply: '250 queued\r\n' },
      ]);
      expect((await send()).ok).toBe(true);
    });

    it('states SIZE on MAIL FROM when the server advertises it with no limit, and shows its refusal', async () => {
      const { duplex } = scriptedDuplex([
        { expect: null, reply: '220 mx.example ESMTP\r\n' },
        { expect: 'EHLO h\r\n', reply: '250-mx.example\r\n250 SIZE\r\n' },
        { expect: 'MAIL FROM:<me@x.test> SIZE=5000\r\n', reply: '552 5.3.4 message too big\r\n' },
      ]);
      const client = createSmtpClient(duplex);
      await client.greeting();
      await client.ehlo('h');
      expect(
        await client.send({ from: 'me@x.test', to: ['you@y.test'], data: new Uint8Array(5000) }),
      ).toEqual({
        ok: false,
        reason: { kind: 'reply', code: 552, text: '5.3.4 message too big' },
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
