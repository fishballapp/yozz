import type { ImapClient, ImapMailbox } from '@yozz.app/imap';
import { describe, expect, it } from 'vitest';
import { resolveFolders } from './folder-names.ts';

const listing = (...mailboxes: readonly (readonly [string, ...string[]])[]) =>
  ({
    list: async () => ({
      ok: true,
      value: mailboxes.map(
        ([name, ...attributes]): ImapMailbox => ({ name, delimiter: '/', attributes }),
      ),
    }),
  }) as unknown as ImapClient;

const junkOf = async (client: ImapClient) => {
  const folders = await resolveFolders(client);
  if (!folders.ok) throw new Error('LIST failed');
  return folders.value.junk;
};

describe('resolveFolders: Junk', () => {
  it('is the folder LIST marks \\Junk, whatever it is called', async () => {
    expect(await junkOf(listing(['INBOX'], ['Junk'], ['Unwanted', '\\Junk']))).toBe('Unwanted');
    expect(await junkOf(listing(['INBOX'], ['[Gmail]/Spam', '\\HasNoChildren', '\\Junk']))).toBe(
      '[Gmail]/Spam',
    );
  });

  it('takes the first of two marked \\Junk, as older Forward Email mailboxes list', async () => {
    expect(await junkOf(listing(['INBOX'], ['Spam', '\\Junk'], ['Junk', '\\Junk']))).toBe('Spam');
  });

  it.each(['Junk', 'spam', 'Junk Email', 'Junk E-mail', 'Bulk Mail', 'Bulk', '[Gmail]/Spam'])(
    'falls back to the usual name %s on a server without SPECIAL-USE',
    async name => {
      expect(await junkOf(listing(['INBOX'], ['Sent'], [name]))).toBe(name);
    },
  );

  it('is absent when nothing is marked or named like it', async () => {
    expect(await junkOf(listing(['INBOX'], ['Sent', '\\Sent'], ['Junkyard']))).toBeUndefined();
  });
});
