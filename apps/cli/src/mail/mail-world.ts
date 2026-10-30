import type { AddressRecord } from '@yozz.app/mail/addresses/record';
import * as Effect from 'effect/Effect';
import { makeHomes, makeWorld, writeCredentials } from '../test-world.ts';
import { type FakeMessage, makeFakeImapServer } from './fake-imap-server.ts';

// A logged-in machine with one inbound address whose IMAP server runs in memory.

export const ADDRESS = 'jason@fishball.ltd';
export const IMAP_HOST = 'imap.fishball.test';

export const inbound = (address: string, host: string): AddressRecord => ({
  address,
  smtp: { host: `smtp.${host}`, port: 465, username: address, password: 'secret' },
  imap: { host, port: 993, username: address, password: 'secret' },
});

/** Mail from `from` with `subject`, at `day` of October 2026 (8am UTC). */
export const mail = (n: number, overrides: Partial<FakeMessage> = {}): FakeMessage => ({
  from: 'billing@stripe.com',
  fromName: 'Stripe',
  to: ADDRESS,
  subject: `Invoice #${n}`,
  messageId: `<m${n}@stripe.com>`,
  date: `Thu, ${String(n).padStart(2, '0')} Oct 2026 08:00:00 +0000`,
  text: `Hi Jason, invoice ${n} is attached.`,
  ...overrides,
});

/** An RFC 5322 date `n` minutes into 2026, for a mailbox of hundreds in order. */
export const minuteOf2026 = (n: number) => new Date(Date.UTC(2026, 0, 1, 0, n)).toUTCString();

export const SECOND = 'jason@posteo.test';
export const SECOND_HOST = 'imap.posteo.test';

export const makeMailWorld = Effect.fnUntraced(function* () {
  const world = yield* makeWorld();
  const homes = yield* makeHomes;
  yield* writeCredentials(homes, JSON.stringify(world.credentials));
  yield* world.putAddress(inbound(ADDRESS, IMAP_HOST), 1);
  const server = makeFakeImapServer({ username: ADDRESS, password: 'secret' });
  const second = makeFakeImapServer({ username: SECOND, password: 'secret' });
  /** Adds a second inbound address, whose server is `second`. */
  const addSecond = () => world.putAddress(inbound(SECOND, SECOND_HOST), 1);
  /** The second address's password changes on its server: every sign-in from now on is refused. */
  const expireSecond = () =>
    world.putAddress(
      {
        ...inbound(SECOND, SECOND_HOST),
        imap: { host: SECOND_HOST, port: 993, username: SECOND, password: 'expired' },
      },
      2,
    );
  return {
    world,
    homes,
    server,
    second,
    addSecond,
    expireSecond,
    servers: { [IMAP_HOST]: server, [SECOND_HOST]: second },
  };
});
