import { type DraftRecord, parseDraftRecord } from '@yozz.app/mail/compose/draft-record';
import * as Effect from 'effect/Effect';
import { ADDRESS, IMAP_HOST, makeMailWorld } from '../mail/mail-world.ts';
import { runCli } from '../test-world.ts';
import { makeFakeSmtpServer } from './fake-smtp-server.ts';

// A logged-in machine with one inbound address whose IMAP and SMTP servers run in memory, and a
// send-only address to add.

export const SEND_ONLY = 'noreply@fishball.ltd';
const SEND_ONLY_SMTP = 'smtp.send-only.test';

export const makeComposeWorld = Effect.fnUntraced(function* () {
  const mailWorld = yield* makeMailWorld();
  const { world, homes } = mailWorld;
  const smtp = makeFakeSmtpServer({ username: ADDRESS, password: 'secret' });
  const sendOnlySmtp = makeFakeSmtpServer({ username: SEND_ONLY, password: 'secret' });
  const servers = {
    ...mailWorld.servers,
    [`smtp.${IMAP_HOST}`]: smtp,
    [SEND_ONLY_SMTP]: sendOnlySmtp,
  };
  return {
    ...mailWorld,
    smtp,
    sendOnlySmtp,
    servers,
    /** An address with no mailbox: its Sent copy is a vault record. */
    addSendOnly: () =>
      world.putAddress(
        {
          address: SEND_ONLY,
          smtp: { host: SEND_ONLY_SMTP, port: 465, username: SEND_ONLY, password: 'secret' },
        },
        1,
      ),
    run: (args: readonly string[], { stdin }: { readonly stdin?: string } = {}) =>
      runCli(args, {
        fetch: world.fetch,
        homes,
        servers,
        ...(stdin === undefined ? {} : { stdin }),
      }),
    /** Every draft record the Worker holds, opened, by key. */
    drafts: Effect.map(world.readRecords('draft'), rows =>
      Object.fromEntries(rows.map(row => [row.naturalKey, parseDraftRecord(row.plaintext)])),
    ),
    /** Rewrites a draft as another device would, one revision on; answers its new draftId. */
    rewriteDraft: Effect.fnUntraced(function* (
      key: string,
      change: (record: DraftRecord) => DraftRecord,
    ) {
      const row = (yield* world.readRecords('draft')).find(({ naturalKey }) => naturalKey === key);
      const record = row === undefined ? null : parseDraftRecord(row.plaintext);
      if (row === undefined || record === null) throw new Error(`no draft ${key}`);
      const next = { ...change(record), contentVersion: record.contentVersion + 1 };
      yield* world.putRecord({
        type: 'draft',
        naturalKey: key,
        revision: row.revision + 1,
        plaintext: JSON.stringify(next),
      });
      return `${key}@${next.contentVersion}`;
    }),
  };
});
