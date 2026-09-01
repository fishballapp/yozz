import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ByteDuplex } from '@yozz.app/tls';
import { describe, expect, it } from 'vitest';
import { bytesToBase64, stringToBytes } from './bytes.ts';
import { createImapClient } from './client.ts';
import { buildSaslPlainBytes } from './commands.ts';
import type { ImapUntagged } from './response.ts';

type MemoryDuplexPair = {
  readonly client: ByteDuplex;
  readonly server: ByteDuplex;
  readonly close: () => void;
};

type QueueEntry = { readonly kind: 'chunk'; readonly chunk: Uint8Array } | { readonly kind: 'eof' };

const createTestDuplexPair = (): MemoryDuplexPair => {
  const clientQueue: QueueEntry[] = [];
  let clientPendingRead: ((entry: QueueEntry) => void) | null = null;

  const serverQueue: QueueEntry[] = [];
  let serverPendingRead: ((entry: QueueEntry) => void) | null = null;

  const clientDuplex: ByteDuplex = {
    read: async () => {
      const entry = clientQueue.shift();
      if (entry !== undefined) return entry.kind === 'chunk' ? entry.chunk : null;
      const next = await new Promise<QueueEntry>(r => {
        clientPendingRead = r;
      });
      return next.kind === 'chunk' ? next.chunk : null;
    },
    write: async bytes => {
      const entry: QueueEntry = { kind: 'chunk', chunk: new Uint8Array(bytes) };
      if (serverPendingRead !== null) {
        const resolve = serverPendingRead;
        serverPendingRead = null;
        resolve(entry);
      } else {
        serverQueue.push(entry);
      }
    },
  };

  const serverDuplex: ByteDuplex = {
    read: async () => {
      const entry = serverQueue.shift();
      if (entry !== undefined) return entry.kind === 'chunk' ? entry.chunk : null;
      const next = await new Promise<QueueEntry>(r => {
        serverPendingRead = r;
      });
      return next.kind === 'chunk' ? next.chunk : null;
    },
    write: async bytes => {
      const entry: QueueEntry = { kind: 'chunk', chunk: new Uint8Array(bytes) };
      if (clientPendingRead !== null) {
        const resolve = clientPendingRead;
        clientPendingRead = null;
        resolve(entry);
      } else {
        clientQueue.push(entry);
      }
    },
  };

  const close = (): void => {
    const eof: QueueEntry = { kind: 'eof' };
    if (clientPendingRead !== null) {
      const r = clientPendingRead;
      clientPendingRead = null;
      r(eof);
    } else {
      clientQueue.push(eof);
    }
    if (serverPendingRead !== null) {
      const r = serverPendingRead;
      serverPendingRead = null;
      r(eof);
    } else {
      serverQueue.push(eof);
    }
  };

  return { client: clientDuplex, server: serverDuplex, close };
};

type TranscriptStep =
  | { readonly kind: 'send'; readonly raw: string }
  | { readonly kind: 'recv'; readonly raw: string };

const parseTranscript = (filename: string): TranscriptStep[] => {
  const filePath = resolve(__dirname, '../transcripts', filename);
  const content = readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  const steps: TranscriptStep[] = [];

  let i = 0;
  while (i < lines.length) {
    const rawLine = lines[i];
    if (rawLine === undefined) {
      i++;
      continue;
    }
    const line = rawLine.trimEnd();
    if (line.length === 0) {
      i++;
      continue;
    }

    if (line.startsWith('S: ') || line.startsWith('C: ')) {
      const isSend = line.startsWith('S: ');
      let raw = line.slice(3);
      i++;
      const literalContinuationLines: string[] = [];
      while (i < lines.length) {
        const nextLine = lines[i];
        if (nextLine === undefined) break;
        if (nextLine.startsWith('S: ') || nextLine.startsWith('C: ')) break;
        if (nextLine.trim().length === 0 && i === lines.length - 1) {
          i++;
          break;
        }
        literalContinuationLines.push(nextLine);
        i++;
      }
      if (literalContinuationLines.length > 0) {
        raw += `\r\n${literalContinuationLines.join('\n')}`;
      }
      steps.push({ kind: isSend ? 'send' : 'recv', raw: `${raw}\r\n` });
    } else {
      i++;
    }
  }

  return steps;
};

const runTranscriptSession = async (
  steps: readonly TranscriptStep[],
  runClient: (client: ReturnType<typeof createImapClient>) => Promise<void>,
  options?: { readonly onUntagged?: (untagged: ImapUntagged) => void },
): Promise<void> => {
  const pair = createTestDuplexPair();
  const client = createImapClient(pair.client, options);

  const serverPromise = (async () => {
    let clientBuffer = new Uint8Array(0);

    for (const step of steps) {
      if (step.kind === 'send') {
        await pair.server.write(stringToBytes(step.raw));
      } else if (step.kind === 'recv') {
        // Read until we have a full line matching expected
        const decoder = new TextDecoder('utf-8');
        while (!decoder.decode(clientBuffer).includes('\r\n')) {
          const chunk = await pair.server.read();
          if (chunk === null) break;
          const merged = new Uint8Array(clientBuffer.length + chunk.length);
          merged.set(clientBuffer, 0);
          merged.set(chunk, clientBuffer.length);
          clientBuffer = merged;
        }

        const decoded = decoder.decode(clientBuffer);
        const crlfIndex = decoded.indexOf('\r\n');
        if (crlfIndex !== -1) {
          const receivedLine = decoded.slice(0, crlfIndex + 2);
          const lineByteLen = stringToBytes(receivedLine).length;
          clientBuffer = clientBuffer.slice(lineByteLen);

          // Normalise tags (e.g. A0001 -> Axxxx) for comparison
          const normReceived = receivedLine.replace(/^A\d{4}/, 'TAG');
          const normExpected = step.raw.replace(/^A\d{4}/, 'TAG');
          expect(normReceived).toBe(normExpected);
        }
      }
    }
  })();

  await runClient(client);
  await serverPromise;
  pair.close();
};

describe('IMAP Client transcripts and state machine', () => {
  it('APPENDs as a synchronising literal and reports where the message landed', async () => {
    const steps = parseTranscript('append-literal.txt');
    await runTranscriptSession(steps, async client => {
      const res = await client.append('Sent', stringToBytes('Subject: hi'), ['\\Seen']);
      expect(res).toEqual({ ok: true, value: { uidValidity: 1, uid: 42 } });
    });
  });

  it('reports no locator when the server issues no APPENDUID', async () => {
    const steps = parseTranscript('append-no-uidplus.txt');
    await runTranscriptSession(steps, async client => {
      const res = await client.append('Drafts', stringToBytes('Subject: hi'), ['\\Draft']);
      expect(res).toEqual({ ok: true, value: null });
    });
  });

  it('refuses UID EXPUNGE without UIDPLUS rather than erasing more than it was asked', async () => {
    const steps = parseTranscript('append-no-uidplus.txt');
    await runTranscriptSession(steps, async client => {
      await client.append('Drafts', stringToBytes('Subject: hi'), ['\\Draft']);
      const res = await client.uidExpunge('42');
      expect(res.ok).toBe(false);
    });
  });

  it('finds a message by a header, which is what makes an APPEND retry safe', async () => {
    const steps = parseTranscript('uid-search-header.txt');
    await runTranscriptSession(steps, async client => {
      const res = await client.uidSearchHeader('Message-ID', '<draft-7@x.co>');
      expect(res).toEqual({ ok: true, value: [31, 33] });
    });
  });

  it('UID MOVEs messages into another mailbox', async () => {
    const steps = parseTranscript('move.txt');
    await runTranscriptSession(steps, async client => {
      const res = await client.move('10,11', 'Archive');
      expect(res.ok).toBe(true);
    });
  });

  it('UID MOVEs on an IMAP4rev2 server that does not spell out MOVE', async () => {
    const steps = parseTranscript('move-rev2.txt');
    await runTranscriptSession(steps, async client => {
      const res = await client.move('5', 'Archive');
      expect(res.ok).toBe(true);
    });
  });

  it('move refuses without the MOVE capability and sends nothing', async () => {
    const pair = createTestDuplexPair();
    let clientWrites = 0;
    const countingClient: ByteDuplex = {
      read: pair.client.read,
      write: async bytes => {
        clientWrites += 1;
        await pair.client.write(bytes);
      },
    };
    const client = createImapClient(countingClient);
    await pair.server.write(stringToBytes('* OK [CAPABILITY IMAP4rev1] Server ready.\r\n'));
    await client.greeting();

    const res = await client.move('1', 'Archive');
    expect(res).toEqual({
      ok: false,
      reason: { kind: 'no', text: 'MOVE is not supported by this server' },
    });
    expect(clientWrites).toBe(0);
    pair.close();
  });

  it('CREATEs a mailbox', async () => {
    const steps = parseTranscript('create.txt');
    await runTranscriptSession(steps, async client => {
      const res = await client.create('Archive');
      expect(res.ok).toBe(true);
    });
  });

  it('handles greeting-with-capability then AUTHENTICATE PLAIN with SASL-IR', async () => {
    const steps = parseTranscript('auth-sasl-ir.txt');
    await runTranscriptSession(steps, async client => {
      const greeting = await client.greeting();
      expect(greeting.ok).toBe(true);
      if (greeting.ok) {
        expect(greeting.value.capabilities).toContain('SASL-IR');
        expect(greeting.value.capabilities).toContain('AUTH=PLAIN');
      }

      const auth = await client.authenticate('user@example.com', 'secretpassword');
      expect(auth.ok).toBe(true);
    });
  });

  it('handles greeting-without-capability then CAPABILITY and two-step AUTHENTICATE PLAIN', async () => {
    const steps = parseTranscript('auth-plain-twostep.txt');
    await runTranscriptSession(steps, async client => {
      const greeting = await client.greeting();
      expect(greeting.ok).toBe(true);
      if (greeting.ok) {
        expect(greeting.value.capabilities).toBeNull();
      }

      const caps = await client.capability();
      expect(caps.ok).toBe(true);
      if (caps.ok) {
        expect(caps.value).toContain('AUTH=PLAIN');
      }

      const auth = await client.authenticate('user@example.com', 'secretpassword');
      expect(auth.ok).toBe(true);
    });
  });

  it('handles LOGIN fallback when AUTH=PLAIN is absent', async () => {
    const steps = parseTranscript('auth-login-fallback.txt');
    await runTranscriptSession(steps, async client => {
      const auth = await client.authenticate('user@example.com', 'secretpassword');
      expect(auth.ok).toBe(true);
    });
  });

  it('handles LIST with a literal mailbox name', async () => {
    const steps = parseTranscript('list-literal.txt');
    await runTranscriptSession(steps, async client => {
      const mailboxes = await client.list('', '*');
      expect(mailboxes.ok).toBe(true);
      if (mailboxes.ok) {
        expect(mailboxes.value).toHaveLength(3);
        expect(mailboxes.value[0]?.name).toBe('INBOX');
        expect(mailboxes.value[1]?.name).toBe('Archive/01');
        expect(mailboxes.value[2]?.name).toBe('Sent');
      }
    });
  });

  it('handles SELECT INBOX with PERMANENTFLAGS and UIDNEXT', async () => {
    const steps = parseTranscript('select-permanentflags.txt');
    await runTranscriptSession(steps, async client => {
      const select = await client.select('INBOX');
      expect(select.ok).toBe(true);
      if (select.ok) {
        expect(select.value.exists).toBe(15);
        expect(select.value.permanentFlags).toContain('\\*');
        expect(select.value.uidValidity).toBe(1692800000);
        expect(select.value.uidNext).toBe(1050);
        expect(select.value.readOnly).toBe(false);
      }
    });
  });

  it('carries References and X-GM-THRID in a summary, and refreshes flags alone', async () => {
    const steps = parseTranscript('fetch-gmail-references.txt');
    await runTranscriptSession(steps, async client => {
      await client.greeting();
      const fetchRes = await client.fetchSummaries('200:201');
      expect(fetchRes.ok).toBe(true);
      if (fetchRes.ok) {
        expect(fetchRes.value[0]?.gmailThreadId).toBe('1834682380345891234');
        expect(fetchRes.value[0]?.references).toEqual(['<root@example.com>', '<mid@example.com>']);
        expect(fetchRes.value[0]?.envelope?.inReplyTo).toBe('<mid@example.com>');
        expect(fetchRes.value[1]?.gmailThreadId).toBe('99');
        expect(fetchRes.value[1]?.references).toEqual([]);
      }
      const flagsRes = await client.fetchFlags('200:201');
      expect(flagsRes.ok).toBe(true);
      if (flagsRes.ok) {
        expect(flagsRes.value).toEqual([
          { uid: 200, flags: ['\\Seen', '\\Flagged'] },
          { uid: 201, flags: [] },
        ]);
      }
    });
  });

  it('fetches a window by sequence number, and every summary carries its seq beside its uid', async () => {
    const steps = parseTranscript('fetch-by-seq.txt');
    await runTranscriptSession(steps, async client => {
      const res = await client.fetchSummariesBySeq('1:3');
      expect(res.ok).toBe(true);
      if (res.ok) {
        // The uids are sparse (deletions), which is the whole reason the window is by sequence.
        expect(res.value.map(s => [s.seq, s.uid])).toEqual([
          [1, 100],
          [2, 104],
          [3, 109],
        ]);
        expect(res.value[0]?.envelope?.subject).toBe('Oldest');
      }
    });
  });

  it('delivers untagged * 7 EXISTS arriving mid-command to onUntagged and command result', async () => {
    const steps = parseTranscript('fetch-with-exists.txt');
    const receivedUntagged: ImapUntagged[] = [];

    await runTranscriptSession(
      steps,
      async client => {
        const fetchRes = await client.fetchSummaries('100:101');
        expect(fetchRes.ok).toBe(true);
        if (fetchRes.ok) {
          expect(fetchRes.value).toHaveLength(2);
          expect(fetchRes.value[0]?.uid).toBe(100);
          expect(fetchRes.value[0]?.envelope?.subject).toBe('Weekly Team Notes');
          expect(fetchRes.value[1]?.uid).toBe(101);
          expect(fetchRes.value[1]?.envelope?.subject).toBe('東京の大会記録');
        }

        const existsUntagged = receivedUntagged.find(u => u.kind === 'exists');
        expect(existsUntagged).toEqual({ kind: 'exists', count: 7 });
      },
      {
        onUntagged: untagged => {
          receivedUntagged.push(untagged);
        },
      },
    );
  });

  it('returns typed failure on NO reply', async () => {
    const steps = parseTranscript('reply-no.txt');
    await runTranscriptSession(steps, async client => {
      const res = await client.select('NonExistentMailbox');
      expect(res.ok).toBe(false);
      if (!res.ok && res.reason.kind === 'no') {
        expect(res.reason.text).toContain('Mailbox does not exist');
      }
    });
  });

  it('returns kind: bye on mid-command BYE', async () => {
    const steps = parseTranscript('midcommand-bye.txt');
    await runTranscriptSession(steps, async client => {
      const res = await client.noop();
      expect(res.ok).toBe(false);
      if (!res.ok && res.reason.kind === 'bye') {
        expect(res.reason.text).toContain('Server shutting down');
      }
    });
  });

  it('accepts the expected BYE followed by tagged OK during logout', async () => {
    const steps = parseTranscript('logout.txt');
    await runTranscriptSession(steps, async client => {
      const res = await client.logout();
      expect(res).toEqual({ ok: true, value: undefined });
    });
  });

  it('preserves the BYE reason when a server closes before tagged logout completion', async () => {
    const pair = createTestDuplexPair();
    const client = createImapClient(pair.client);
    const server = (async () => {
      await pair.server.write(stringToBytes('* OK [CAPABILITY IMAP4rev1] Server ready.\r\n'));
      const command = await pair.server.read();
      expect(command === null ? null : new TextDecoder().decode(command)).toBe('A0001 LOGOUT\r\n');
      await pair.server.write(stringToBytes('* BYE Server closing now.\r\n'));
      pair.close();
    })();

    await expect(client.logout()).resolves.toEqual({
      ok: false,
      reason: { kind: 'bye', text: 'Server closing now.' },
    });
    await server;
  });

  it('serialises concurrently requested commands', async () => {
    const steps = parseTranscript('concurrent-noop.txt');
    await runTranscriptSession(steps, async client => {
      const results = await Promise.all([client.noop(), client.noop()]);
      expect(results).toEqual([
        { ok: true, value: undefined },
        { ok: true, value: undefined },
      ]);
    });
  });

  it('returns kind: closed on transport EOF', async () => {
    const steps = parseTranscript('eof.txt');
    const pair = createTestDuplexPair();
    const client = createImapClient(pair.client);

    // Write greeting
    await pair.server.write(stringToBytes(steps[0]?.raw ?? ''));
    const greeting = await client.greeting();
    expect(greeting.ok).toBe(true);

    // Close server transport (EOF)
    pair.close();

    const noopRes = await client.noop();
    expect(noopRes.ok).toBe(false);
    if (!noopRes.ok) {
      expect(noopRes.reason.kind).toBe('closed');
    }
  });

  it('returns kind: protocol on malformed line and subsequent calls return closed', async () => {
    const steps = parseTranscript('malformed-protocol.txt');
    const pair = createTestDuplexPair();
    const client = createImapClient(pair.client);

    // Send greeting
    await pair.server.write(stringToBytes(steps[0]?.raw ?? ''));
    await client.greeting();

    // Server sends bare LF
    const serverPromise = (async () => {
      await pair.server.read(); // client writes NOOP
      await pair.server.write(stringToBytes('* BARE LF\n')); // malformed bare LF!
    })();

    const noopRes = await client.noop();
    expect(noopRes.ok).toBe(false);
    if (!noopRes.ok) {
      expect(noopRes.reason.kind).toBe('protocol');
    }

    // Subsequent call should fail with closed
    const laterRes = await client.noop();
    expect(laterRes.ok).toBe(false);
    if (!laterRes.ok) {
      expect(laterRes.reason.kind).toBe('closed');
    }

    await serverPromise;
    pair.close();
  });

  it('handles fetchRaw returning exact message bytes including bare LF, closing parenthesis and asterisks', async () => {
    const steps = parseTranscript('fetch-raw-literal.txt');
    await runTranscriptSession(steps, async client => {
      const res = await client.fetchRaw(42);
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.value).toEqual(stringToBytes('a\n)\n*\nb'));
      }
    });
  });

  it('handles LOGIN with non-ASCII password under LITERAL+ (one round trip)', async () => {
    const steps = parseTranscript('login-literal-plus.txt');
    await runTranscriptSession(steps, async client => {
      const res = await client.authenticate('user@example.com', 'péssword');
      expect(res.ok).toBe(true);
    });
  });

  it('handles LOGIN with non-ASCII password without LITERAL+ (continuation round trip)', async () => {
    const steps = parseTranscript('login-literal-continuation.txt');
    await runTranscriptSession(steps, async client => {
      const res = await client.authenticate('user@example.com', 'péssword');
      expect(res.ok).toBe(true);
    });
  });

  it('treats unexpected continuation + as protocol failure', async () => {
    const steps = parseTranscript('unexpected-continuation.txt');
    await runTranscriptSession(steps, async client => {
      const res = await client.noop();
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.reason.kind).toBe('protocol');
        if (res.reason.kind === 'protocol') {
          expect(res.reason.detail).toContain('Unexpected continuation');
        }
      }
    });
  });

  it('encodes SASL PLAIN in UTF-8 without btoa string errors', () => {
    const bytes = buildSaslPlainBytes('用户', 'pässwörd');
    const b64 = bytesToBase64(bytes);
    expect(b64).toBe('AOeUqOaItwBww6Rzc3fDtnJk');
  });

  it('parses a 5 MiB literal delivered in 4 KiB chunks without O(n^2) rescan', async () => {
    const pair = createTestDuplexPair();
    const client = createImapClient(pair.client);

    const FIVE_MIB = 5 * 1024 * 1024;
    const literalData = new Uint8Array(FIVE_MIB);
    for (let i = 0; i < FIVE_MIB; i++) {
      literalData[i] = i % 256;
    }

    const header = stringToBytes('* OK Server ready\r\n');
    await pair.server.write(header);
    const greet = await client.greeting();
    expect(greet.ok).toBe(true);

    const serverPromise = (async () => {
      await pair.server.read(); // FETCH

      const fetchHeader = stringToBytes(`* 1 FETCH (UID 100 BODY[] {${FIVE_MIB}}\r\n`);
      await pair.server.write(fetchHeader);

      const CHUNK_SIZE = 4096;
      for (let offset = 0; offset < FIVE_MIB; offset += CHUNK_SIZE) {
        const slice = literalData.subarray(offset, Math.min(offset + CHUNK_SIZE, FIVE_MIB));
        await pair.server.write(slice);
      }

      const fetchFooter = stringToBytes(')\r\nA0001 OK FETCH complete\r\n');
      await pair.server.write(fetchFooter);
    })();

    const rawRes = await client.fetchRaw(100);
    expect(rawRes.ok).toBe(true);
    if (rawRes.ok) {
      expect(rawRes.value.length).toBe(FIVE_MIB);
      expect(rawRes.value[0]).toBe(0);
      expect(rawRes.value[100]).toBe(100);
      expect(rawRes.value[FIVE_MIB - 1]).toBe((FIVE_MIB - 1) % 256);
    }

    await serverPromise;
    pair.close();
  });

  it('applies PERMANENTFLAGS, UIDVALIDITY, UIDNEXT from tagged SELECT completion', async () => {
    const pair = createTestDuplexPair();
    const client = createImapClient(pair.client);

    await pair.server.write(stringToBytes('* OK Ready\r\n'));
    await client.greeting();

    const serverPromise = (async () => {
      await pair.server.read(); // SELECT
      await pair.server.write(
        stringToBytes(
          '* 20 EXISTS\r\n* FLAGS (\\Seen \\Answered)\r\n* OK [PERMANENTFLAGS (\\Seen \\* \\Draft)] Permanent flags\r\n* OK [UIDNEXT 789] Next UID\r\nA0001 OK [UIDVALIDITY 123456] Completed\r\n',
        ),
      );
    })();

    const selectRes = await client.select('INBOX');
    expect(selectRes.ok).toBe(true);
    if (selectRes.ok) {
      expect(selectRes.value.exists).toBe(20);
      expect(selectRes.value.permanentFlags).toEqual(['\\Seen', '\\*', '\\Draft']);
      expect(selectRes.value.uidValidity).toBe(123456);
      expect(selectRes.value.uidNext).toBe(789);
    }

    await serverPromise;
    pair.close();
  });

  it('returns protocol failure on tagged response with unmatched tag', async () => {
    const pair = createTestDuplexPair();
    const client = createImapClient(pair.client);

    await pair.server.write(stringToBytes('* OK Ready\r\n'));
    await client.greeting();

    const serverPromise = (async () => {
      await pair.server.read(); // NOOP with tag A0001
      await pair.server.write(stringToBytes('A9999 OK Completed\r\n')); // Wrong tag!
    })();

    const noopRes = await client.noop();
    expect(noopRes.ok).toBe(false);
    if (!noopRes.ok) {
      expect(noopRes.reason.kind).toBe('protocol');
      if (noopRes.reason.kind === 'protocol') {
        expect(noopRes.reason.detail).toContain('unexpected tag');
      }
    }

    await serverPromise;
    pair.close();
  });

  it('IDLE delivers untagged EXISTS/FETCH, and a queued NOOP runs only after done()', async () => {
    const steps = parseTranscript('idle-exists-done.txt');
    const receivedUntagged: ImapUntagged[] = [];
    let releaseDone: (() => void) | undefined;
    const sawUntagged = new Promise<void>(resolve => {
      releaseDone = resolve;
    });

    await runTranscriptSession(
      steps,
      async client => {
        await client.greeting();
        expect(client.hasCapability('IDLE')).toBe(true);
        const idle = client.idle();
        const noopPromise = client.noop();
        await sawUntagged;
        const idleRes = await idle.done();
        expect(idleRes).toEqual({ ok: true, value: undefined });
        expect(await noopPromise).toEqual({ ok: true, value: undefined });
        expect(receivedUntagged).toEqual([
          { kind: 'exists', count: 5 },
          { kind: 'fetch', seq: 3, items: [{ kind: 'flags', flags: ['\\Seen'] }] },
        ]);
      },
      {
        onUntagged: untagged => {
          receivedUntagged.push(untagged);
          if (receivedUntagged.length >= 2) releaseDone?.();
        },
      },
    );
  });

  it('IDLE BAD leaves the client usable for a following NOOP', async () => {
    const steps = parseTranscript('idle-unsupported.txt');
    await runTranscriptSession(steps, async client => {
      const idle = client.idle();
      const ended = await idle.ended;
      expect(ended.ok).toBe(false);
      if (!ended.ok) {
        expect(ended.reason).toEqual({ kind: 'bad', text: 'Unknown command' });
      }
      expect(await client.noop()).toEqual({ ok: true, value: undefined });
    });
  });

  it('IDLE BYE resolves ended with bye and closes the client', async () => {
    const steps = parseTranscript('idle-bye.txt');
    await runTranscriptSession(steps, async client => {
      const idle = client.idle();
      const ended = await idle.ended;
      expect(ended.ok).toBe(false);
      if (!ended.ok) {
        expect(ended.reason).toEqual({ kind: 'bye', text: 'Timeout' });
      }
      const later = await client.noop();
      expect(later.ok).toBe(false);
      if (!later.ok) expect(later.reason.kind).toBe('closed');
    });
  });
});
