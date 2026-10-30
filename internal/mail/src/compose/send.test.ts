import { describe, expect, it } from 'vitest';
import { buildOutgoing, envelopeRecipients } from './send.ts';

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
    const message = new TextDecoder().decode(built.value);
    expect(message).toContain('Thanks, **paid**.');
    expect(message).toContain('Content-Type: text/html');
    expect(message).toContain('<!DOCTYPE html><html>');
    expect(message).toContain('<strong>paid</strong>');
  });
});
