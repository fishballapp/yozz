import { describe, expect, it } from 'vitest';
import type { AddressRecord } from '../addresses/record.ts';
import type { RunTask } from '../connection.ts';
import { stubImapClient } from '../testing/fake-imap-client.ts';
import type { FileReference } from './draft-record.ts';
import {
  assembleMessage,
  buildOutgoing,
  claimOf,
  envelopeRecipients,
  isUnconfirmedSubmission,
  storeSentCopy,
} from './send.ts';
import { sentRecordFrom } from './sent-vault.ts';

/**
 * The envelope is where Bcc exists. Nothing in the message bytes names a blind recipient, so if
 * this list drops one the mail is simply never delivered to them and nothing anywhere says so.
 */
describe('envelopeRecipients', () => {
  it('delivers to To, then Cc, then Bcc', () => {
    expect(
      envelopeRecipients({
        to: ['kate@example.com'],
        cc: ['sam@example.com', 'kim@example.com'],
        bcc: ['legal@example.com'],
      }),
    ).toEqual(['kate@example.com', 'sam@example.com', 'kim@example.com', 'legal@example.com']);
  });

  it('names an address once however it was cased and wherever it repeats', () => {
    expect(
      envelopeRecipients({
        to: ['Kate@Example.com'],
        cc: ['kate@example.com', 'sam@example.com'],
        bcc: ['SAM@EXAMPLE.COM'],
      }),
      // The first spelling wins: it is the one the headers show.
    ).toEqual(['Kate@Example.com', 'sam@example.com']);
  });

  it('is the To list alone when there are no copies', () => {
    expect(envelopeRecipients({ to: ['kate@example.com'], cc: [], bcc: [] })).toEqual([
      'kate@example.com',
    ]);
  });
});

const IDENTITY: AddressRecord = {
  address: 'jason@fishball.ltd',
  smtp: { host: 'smtp.fishball.ltd', port: 465, username: 'jason', password: 'secret' },
};

const draftFields = {
  from: IDENTITY.address,
  to: 'kate@example.com',
  cc: '',
  bcc: '',
  subject: 'Notes',
  body: 'Hello',
};

const receipt: FileReference = {
  id: 'file-1',
  name: 'receipt.pdf',
  size: 3,
  mimeType: 'application/pdf',
  kind: 'pdf',
};

describe('claimOf', () => {
  it('freezes the message without its files, naming where each goes', () => {
    const claim = claimOf(IDENTITY, 'key', { ...draftFields, attachments: [receipt] }, 7);
    if (!claim.ok) throw new Error('refused');
    const { message, state, claimedAt, target } = claim.value;
    expect({ state, claimedAt, target }).toEqual({
      state: 'submitting',
      claimedAt: 7,
      target: 'vault',
    });
    expect(message?.splices).toEqual([{ at: expect.any(Number), fileId: 'file-1' }]);
    const head = new TextDecoder().decode(Uint8Array.fromBase64(message?.head ?? ''));
    expect(head).toContain('filename="receipt.pdf"');
    expect(head).not.toContain('AQID');
  });

  it('refuses text too long for the record, before anything is written', () => {
    const claim = claimOf(IDENTITY, 'key', { ...draftFields, body: 'x '.repeat(200_000) }, 7);
    expect(claim).toEqual({
      ok: false,
      error: {
        kind: 'error',
        detail: 'This message’s text is too long to send. Shorten it or trim the quoted thread.',
      },
    });
  });

  it('never refuses for the size of the files, which are not in the record', () => {
    const big = { ...receipt, size: 24 * 1024 * 1024 };
    expect(claimOf(IDENTITY, 'key', { ...draftFields, attachments: [big] }, 7).ok).toBe(true);
  });

  it('refuses attachments over 25 MiB in all', () => {
    const big = { ...receipt, size: 25 * 1024 * 1024 + 1 };
    expect(claimOf(IDENTITY, 'key', { ...draftFields, attachments: [big] }, 7).ok).toBe(false);
  });
});

describe('assembleMessage', () => {
  const frozen = (attachments: readonly FileReference[]) => {
    const claim = claimOf(IDENTITY, 'key', { ...draftFields, attachments: [...attachments] }, 7);
    if (!claim.ok || claim.value.message === undefined) throw new Error('refused');
    return claim.value.message;
  };
  const second = { ...receipt, id: 'file-2', name: 'notes.txt' };

  it('rebuilds the same bytes every time, whichever device reads the files', async () => {
    const message = frozen([receipt, second]);
    const read = async (fileId: string) =>
      fileId === 'file-1' ? new Uint8Array([1, 2, 3]) : new Uint8Array([4, 5, 6]);
    const first = await assembleMessage(message, read, () => '');
    const again = await assembleMessage(message, read, () => '');
    if (!first.ok || !again.ok) throw new Error('not assembled');
    expect(first.value).toEqual(again.value);
    const raw = new TextDecoder().decode(first.value);
    expect(raw.indexOf('AQID')).toBeLessThan(raw.indexOf('BAUG'));
    expect(raw).toContain(
      'filename="receipt.pdf"\r\nContent-Transfer-Encoding: base64\r\n\r\nAQID\r\n',
    );
  });

  it('says which file could not be read', async () => {
    const assembled = await assembleMessage(
      frozen([receipt]),
      async () => null,
      () => 'receipt.pdf',
    );
    expect(assembled).toEqual({
      ok: false,
      error: {
        kind: 'error',
        detail: 'Couldn’t download receipt.pdf',
      },
    });
  });
});

describe('sentRecordFrom', () => {
  it('finds the Date header in the head, however long the recipients made it', () => {
    const to = Array.from({ length: 300 }, (_, index) => `person-${index}@example.com`).join(', ');
    const claim = claimOf(IDENTITY, 'key', { ...draftFields, to }, 7);
    if (!claim.ok || claim.value.message === undefined) throw new Error('refused');
    const record = sentRecordFrom(
      { ...draftFields, to, contentVersion: 1 },
      claim.value.messageId,
      claim.value.message,
      9,
    );
    expect(record.date).toMatch(
      /^[A-Z][a-z]{2}, \d+ [A-Z][a-z]{2} \d{4} \d\d:\d\d:\d\d [+-]\d{4}$/,
    );
  });

  it('never reads a Date out of the body', () => {
    const record = sentRecordFrom(
      { ...draftFields, contentVersion: 1 },
      '<m@x>',
      {
        head: new TextEncoder().encode('From: a@x\r\n\r\nDate: not a header\r\n').toBase64(),
        splices: [],
      },
      9,
    );
    expect(record.date).toBe('');
  });

  it('keeps the message and the files it names', () => {
    const message = { head: '', splices: [{ at: 0, fileId: 'file-1' }] };
    const record = sentRecordFrom(
      { ...draftFields, contentVersion: 1, attachments: [receipt] },
      '<m@x>',
      message,
      9,
    );
    expect(record).toMatchObject({ message, attachments: [receipt] });
  });
});

/** Every client builds the composer's message: the markdown as text, its rendering as a whole HTML document. */
describe('buildOutgoing', () => {
  it('sends the markdown beside its rendered HTML', () => {
    const built = buildOutgoing(
      {
        address: 'jason@fishball.ltd',
        smtp: { host: 'smtp.fishball.ltd', port: 465, username: 'jason', password: 'secret' },
      },
      {
        to: ['kate@example.com'],
        cc: [],
        bcc: [],
        subject: 'Notes',
        text: 'Thanks, **paid**.',
        messageId: '<1@fishball.ltd>',
        attachments: [],
      },
    );
    if (!built.ok) throw new Error('not built');
    expect(built.value.splices).toEqual([]);
    const message = new TextDecoder().decode(built.value.head);
    expect(message).toContain('Thanks, **paid**.');
    expect(message).toContain('Content-Type: text/html');
    expect(message).toContain('<!DOCTYPE html><html>');
    expect(message).toContain('<strong>paid</strong>');
  });
});

describe('isUnconfirmedSubmission', () => {
  it('is true only for a lost answer to the end of the message', () => {
    expect(
      isUnconfirmedSubmission({ kind: 'smtp', reason: { kind: 'unconfirmed', detail: 'closed' } }),
    ).toBe(true);
    expect(
      isUnconfirmedSubmission({ kind: 'smtp', reason: { kind: 'too-large', limitBytes: 20 } }),
    ).toBe(false);
  });
});

describe('storeSentCopy', () => {
  const closed = { ok: false, reason: { kind: 'closed' } } as const;
  const BYTES = new TextEncoder().encode('message');

  /** Both clients' rule: a task that may be re-run gets one more go after a lost connection. */
  const world = (over: Parameters<typeof stubImapClient>[0]) => {
    const calls = { append: 0 };
    const client = {
      ...stubImapClient({
        list: async () => ({
          ok: true,
          value: [{ name: 'Sent', delimiter: '/', attributes: ['\\Sent'] }],
        }),
        append: async () => {
          calls.append += 1;
          return { ok: true, value: { uidValidity: 1, uid: 7 } };
        },
        ...over,
      }),
      ensureSelected: async () => closed,
    };
    const run: RunTask = async task => {
      const first = await task.run(client);
      return !first.ok && first.error.kind === 'imap' && task.retry ? task.run(client) : first;
    };
    return { run, calls };
  };

  it('appends when the mailbox has no copy, and reports where it landed', async () => {
    const { run, calls } = world({});
    expect(await storeSentCopy(run, BYTES, '<m@x>')).toEqual({
      ok: true,
      value: { uidValidity: 1, uid: 7 },
    });
    expect(calls.append).toBe(1);
  });

  it('finds its own earlier copy instead of appending', async () => {
    const { run, calls } = world({ uidSearch: async () => ({ ok: true, value: [3, 9] }) });
    expect(await storeSentCopy(run, BYTES, '<m@x>')).toEqual({
      ok: true,
      value: { uidValidity: 1, uid: 9 },
    });
    expect(calls.append).toBe(0);
  });

  it('uploads once when its connection is lost mid-APPEND: the server may still store it', async () => {
    const calls = { append: 0 };
    const { run } = world({
      append: async () => {
        calls.append += 1;
        return closed;
      },
    });
    expect(await storeSentCopy(run, BYTES, '<m@x>')).toEqual({
      ok: false,
      error: { kind: 'imap', reason: { kind: 'closed' } },
    });
    expect(calls.append).toBe(1);
  });

  it('searches again when the search lost its connection, rather than appending blind', async () => {
    let searches = 0;
    const { run, calls } = world({
      uidSearch: async () => {
        searches += 1;
        return searches === 1 ? closed : { ok: true, value: [4] };
      },
    });
    expect(await storeSentCopy(run, BYTES, '<m@x>')).toMatchObject({ ok: true });
    expect(searches).toBe(2);
    expect(calls.append).toBe(0);
  });

  it('still stores the copy on a server that refuses the search', async () => {
    const { run, calls } = world({
      uidSearch: async () => ({ ok: false, reason: { kind: 'no', text: 'not indexed' } }),
    });
    expect(await storeSentCopy(run, BYTES, '<m@x>')).toMatchObject({ ok: true });
    expect(calls.append).toBe(1);
  });
});
