/**
 * Resumption against RFC 8448 §3 and §4: §3 publishes the ticket and `res master`, §4 the PSK,
 * the truncated ClientHello, the binder key and the binder. The unit checks below cover what no
 * trace can: a document has one clock and one host.
 */

import type { PeerName } from '@yozz.app/x509';
import { describe, expect, it } from 'vitest';
import { RFC_8448_TRACES, type Rfc8448Step, type Rfc8448Trace } from '../vectors/rfc8448.ts';
import { encodeAlert } from './alert.ts';
import { concat } from './bytes.ts';
import { decodeHandshakeMessage } from './handshake-messages.ts';
import { type CipherSuite, transcriptHash } from './key-schedule.ts';
import { sealAead } from './record.ts';
import { startTlsForReplay } from './replay.ts';
import {
  bindClientHello,
  inheritedAuthentication,
  isSessionOfferable,
  obfuscatedTicketAge,
  type PeerAuthentication,
  type PeerCertificateChain,
  sessionFromTicket,
  type TlsSession,
} from './session.ts';
import { createMemoryDuplex } from './transport.ts';

const SUITE: CipherSuite = 'TLS_AES_128_GCM_SHA256';

const traceOf = (section: string): Rfc8448Trace => {
  const trace = RFC_8448_TRACES.find(candidate => candidate.section === section);
  if (trace === undefined) throw new Error(`RFC 8448 has no §${section}`);
  return trace;
};

const stepOf = (trace: Rfc8448Trace, startsWith: string): Rfc8448Step => {
  const step = trace.steps.find(
    candidate => candidate.title.startsWith(startsWith) && candidate.fields.length > 0,
  );
  if (step === undefined) throw new Error(`§${trace.section} publishes no "${startsWith}"`);
  return step;
};

const bytesOf = (step: Rfc8448Step, label: string): Uint8Array => {
  const bytes = step.fields.find(field => field.label === label)?.bytes;
  if (bytes === undefined) throw new Error(`"${step.title}" publishes no ${label}`);
  return bytes;
};

/** §3's server certificate, so the stored chain is a real one. */
const chainFromTheDocument = (trace3: Rfc8448Trace): PeerCertificateChain => {
  const certificateBytes = bytesOf(
    stepOf(trace3, 'construct a Certificate handshake message'),
    'Certificate',
  );
  const decoded = decodeHandshakeMessage(certificateBytes);
  if (!decoded.ok || decoded.value.kind !== 'certificate') {
    throw new Error("§3's Certificate does not decode");
  }
  const [leaf, ...intermediates] = decoded.value.certificateList;
  if (leaf === undefined) throw new Error("§3's Certificate carries no leaf");
  return { leafDer: leaf.certData, intermediateDer: intermediates.map(entry => entry.certData) };
};

/** §3's ticket through `decodeHandshakeMessage`; a decoder that mislocates the nonce fails everything below. */
const sessionFromTheDocument = async (): Promise<TlsSession> => {
  const trace3 = traceOf('3');
  const ticketBytes = bytesOf(
    stepOf(trace3, 'construct a NewSessionTicket handshake message'),
    'NewSessionTicket',
  );
  const decoded = decodeHandshakeMessage(ticketBytes);
  if (!decoded.ok || decoded.value.kind !== 'new_session_ticket') {
    throw new Error("§3's NewSessionTicket does not decode");
  }
  const session = await sessionFromTicket({
    serverName: 'server',
    expectedPeerName: { kind: 'dns', value: 'server' },
    authenticatedAt: new Date(0),
    peerSignatureScheme: 'rsa_pss_rsae_sha256',
    peerCertificateChain: chainFromTheDocument(trace3),
    suite: SUITE,
    resumptionSecret: bytesOf(stepOf(trace3, 'derive secret "tls13 res master"'), 'expanded'),
    receivedAt: new Date(0),
    ticket: decoded.value.ticket,
    ticketNonce: decoded.value.ticketNonce,
    ticketAgeAdd: decoded.value.ticketAgeAdd,
    ticketLifetime: decoded.value.ticketLifetime,
  });
  if (session === undefined) throw new Error("§3's ticket is not usable");
  return session;
};

/**
 * §4's ClientHello with its binder zeroed, the input `bindClientHello` takes. The 3 octets are
 * the binder list's framing: a uint16 list length of 33 and a uint8 entry length of 32.
 */
const zeroBinderClientHello = (prefix: Uint8Array): Uint8Array =>
  concat(prefix, Uint8Array.of(0x00, 0x21, 0x20), new Uint8Array(32));

describe('resumption against RFC 8448', () => {
  it("derives §4's pre-shared key from §3's ticket", async () => {
    const session = await sessionFromTheDocument();

    // The document states the PSK twice: what §3 generated and what §4 consumed.
    expect(session.preSharedKey).toEqual(
      bytesOf(stepOf(traceOf('4'), 'extract secret "early"'), 'IKM'),
    );
    expect(session.ticketAgeAdd).toBe(0xfad6aac5);
    expect(session.lifetimeSeconds).toBe(30);
  });

  it("computes §4's binder over the truncated ClientHello", async () => {
    const binderStep = stepOf(traceOf('4'), 'calculate PSK binder');
    const bound = await bindClientHello(
      await sessionFromTheDocument(),
      zeroBinderClientHello(bytesOf(binderStep, 'ClientHello prefix')),
      [],
    );

    // "The PSK binder uses the same construction as Finished and so is labeled as finished here" (§4).
    expect(bound.subarray(bound.length - 32)).toEqual(bytesOf(binderStep, 'finished'));
  });

  it("reproduces §4's ClientHello byte for byte, binder included", async () => {
    const trace4 = traceOf('4');
    const bound = await bindClientHello(
      await sessionFromTheDocument(),
      zeroBinderClientHello(bytesOf(stepOf(trace4, 'calculate PSK binder'), 'ClientHello prefix')),
      [],
    );

    // The "construct" step prints the ClientHello before the binder exists; the record sent is the whole message.
    expect(bound).toEqual(bytesOf(stepOf(trace4, 'send handshake record'), 'payload'));
  });

  /** §4 publishes the truncated ClientHello under the name `ClientHello`, 35 octets short of what the transcript hashes. */
  it('reproduces every running transcript hash §4 publishes', async () => {
    const trace4 = traceOf('4');
    const clientHello = await bindClientHello(
      await sessionFromTheDocument(),
      zeroBinderClientHello(bytesOf(stepOf(trace4, 'calculate PSK binder'), 'ClientHello prefix')),
      [],
    );

    const messages: Uint8Array[] = [];
    const checked: string[] = [];
    for (const step of trace4.steps) {
      if (/^construct an? .+ handshake message/.test(step.title)) {
        messages.push(
          ...step.fields.map(field => (field.label === 'ClientHello' ? clientHello : field.bytes)),
        );
        continue;
      }
      // `derive secret for handshake | master "tls13 derived"` hashes the empty transcript.
      if (!/^derive secret "tls13 /.test(step.title)) continue;
      const published = step.fields.find(field => field.label === 'hash')?.bytes;
      if (published === undefined) continue;
      expect(await transcriptHash(SUITE, ...messages)).toEqual(published);
      checked.push(step.title);
    }

    // A walk that matched nothing would pass every assertion above.
    expect(checked.length).toBe(8);
  });
});

/**
 * §4 through the state machine. §4 is the 0-RTT trace, but the server's application traffic
 * secret runs over ClientHello..server Finished, so the server half replays byte-exact; only
 * the client's Finished and `res master` differ (the document's transcript carries an
 * `EndOfEarlyData`). See DECISIONS.md, "The authentication ceiling is inherited through renewals".
 */
describe('§4 resumed through the state machine, and the ticket it renews', () => {
  const trace4 = () => traceOf('4');

  const publishedServerAppKeys = () => {
    const step = trace4().steps.find(
      candidate =>
        candidate.actor === 'server' &&
        candidate.title.includes('derive write traffic keys for application data'),
    );
    if (step === undefined) throw new Error('§4 publishes no server application write keys');
    return { key: bytesOf(step, 'key expanded'), iv: bytesOf(step, 'iv expanded') };
  };

  /** ServerHello, then the record carrying EncryptedExtensions and Finished. */
  const serverFlightRecords = (): readonly Uint8Array[] =>
    trace4()
      .steps.filter(
        step =>
          step.actor === 'server' && step.title.includes('send') && step.title.includes('record'),
      )
      .flatMap(step => {
        const record = step.fields.find(field => field.label === 'complete record')?.bytes;
        return record === undefined ? [] : [record];
      })
      .slice(0, 2);

  const resume = async () => {
    const offered = await sessionFromTheDocument();
    const trace = trace4();
    // The sent record's payload, not the "construct" step: the latter is 35 octets short of the binder.
    const clientHello = bytesOf(
      trace.steps.find(
        step => step.actor === 'client' && step.title.startsWith('send handshake record'),
      ) ?? stepOf(trace, 'send handshake record'),
      'payload',
    );
    const ephemeral = bytesOf(stepOf(trace, 'create an ephemeral x25519 key pair'), 'private key');

    const duplex = createMemoryDuplex();
    const renewed: TlsSession[] = [];
    const revalidated: Uint8Array[] = [];
    const handshake = startTlsForReplay({
      transport: duplex.client,
      serverName: 'server',
      trustAnchors: { findCandidates: () => [] },
      validationTime: new Date(0),
      // An instant after the document's clock: §3's ticket is dated `new Date(0)` and lives 30 seconds.
      now: () => new Date(1_000),
      // `reverifyOnResume` defaults on, so §4 runs through the re-check too; `revalidated` proves it ran.
      validator: {
        name: 'accept-the-document',
        validatePath: async request => {
          revalidated.push(request.peerCertificateDer);
          return {
            ok: true,
            path: {
              leafSubjectPublicKeyInfoDer: request.peerCertificateDer,
              intermediates: request.untrustedIntermediateDer,
              trustAnchorId: 'rfc8448',
            },
          };
        },
      },
      session: offered,
      onSession: next => {
        renewed.push(next);
      },
      replay: {
        clientHelloMessages: [clientHello],
        clientEphemeralPrivateKeys: [ephemeral],
      },
    });

    for (const record of serverFlightRecords()) await duplex.server.write(record);
    const result = await handshake;
    return { offered, result, renewed, revalidated, duplex };
  };

  it("reproduces §4's server application traffic key, proven by decrypting under it", async () => {
    const { offered, result, renewed, revalidated, duplex } = await resume();
    if (!result.ok)
      throw new Error(`the §4 replay did not complete: ${JSON.stringify(result.reason)}`);
    expect(result.isResumed).toBe(true);

    // The only chain there is to validate is the one §3 put on the session.
    expect(revalidated).toEqual([offered.peerCertificateChain.leafDer]);

    /**
     * §3's `NewSessionTicket` sealed under §4's published server application key at sequence 0.
     * The key is what is under test: anything but §4's `s ap traffic` fails the AEAD open.
     */
    const { key, iv } = publishedServerAppKeys();
    const ticket = bytesOf(
      stepOf(traceOf('3'), 'construct a NewSessionTicket handshake message'),
      'NewSessionTicket',
    );
    await duplex.server.write(await sealAead(key, iv, 0n, 'handshake', ticket));
    // `read()` consumes the ticket and keeps waiting for data, so the close_notify gives it something to return.
    await duplex.server.write(
      await sealAead(
        key,
        iv,
        1n,
        'alert',
        encodeAlert({ level: 'warning', description: 'close_notify' }),
      ),
    );

    const read = await result.connection.read();
    duplex.close();

    expect(read).toEqual({ ok: true, kind: 'closed' });
    expect(renewed.length).toBe(1);
    const next = renewed[0];
    if (next === undefined) throw new Error('the renewed ticket produced no session');

    /** That the inherited fields reach a minted ticket is what only this replay observes. */
    expect(next.authenticatedAt).toEqual(offered.authenticatedAt);
    expect(next.peerSignatureScheme).toBe(offered.peerSignatureScheme);
    expect(next.peerCertificateChain).toEqual(offered.peerCertificateChain);

    // A new session, not the one offered: same peer, different secret.
    expect(next.preSharedKey).not.toEqual(offered.preSharedKey);
    expect(next.receivedAt).toEqual(new Date(1_000));
  });
});

const HOST: PeerName = { kind: 'dns', value: 'mail.example.com' };

/** Only ever compared to each other; `inheritedAuthentication` moves a chain without reading it. */
const STORED_CHAIN: PeerCertificateChain = {
  leafDer: Uint8Array.of(0x30, 0x01),
  intermediateDer: [Uint8Array.of(0x30, 0x02)],
};
const FRESH_CHAIN: PeerCertificateChain = {
  leafDer: Uint8Array.of(0x30, 0x03),
  intermediateDer: [],
};

const sessionAt = (overrides: Partial<TlsSession> = {}): TlsSession => ({
  serverName: 'mail.example.com',
  expectedPeerName: HOST,
  authenticatedAt: new Date(1_000_000),
  peerSignatureScheme: 'rsa_pss_rsae_sha256',
  peerCertificateChain: STORED_CHAIN,
  suite: SUITE,
  ticket: Uint8Array.of(1, 2, 3),
  preSharedKey: new Uint8Array(32),
  ticketAgeAdd: 0,
  receivedAt: new Date(1_000_000),
  lifetimeSeconds: 60,
  ...overrides,
});

const ticketOf = (
  overrides: Partial<{
    ticket: Uint8Array;
    ticketLifetime: number;
    authenticatedAt: Date;
    receivedAt: Date;
  }> = {},
): Promise<TlsSession | undefined> =>
  sessionFromTicket({
    serverName: 'mail.example.com',
    expectedPeerName: HOST,
    authenticatedAt: new Date(0),
    peerSignatureScheme: 'rsa_pss_rsae_sha256',
    peerCertificateChain: STORED_CHAIN,
    suite: SUITE,
    resumptionSecret: new Uint8Array(32),
    receivedAt: new Date(0),
    ticket: Uint8Array.of(9),
    ticketNonce: new Uint8Array(0),
    ticketAgeAdd: 0,
    ticketLifetime: 60,
    ...overrides,
  });

describe('when a stored session may still be offered', () => {
  /** DNS is case-insensitive; the fold is x509's ASCII-only one, not `toLowerCase()`. */
  it('matches a host that differs only in ASCII case, and nothing wider', () => {
    const session = sessionAt();
    const now = new Date(1_000_000);
    expect(isSessionOfferable(session, 'MAIL.Example.COM', HOST, now)).toBe(true);
    expect(
      isSessionOfferable(
        session,
        'mail.example.com',
        { kind: 'dns', value: 'MAIL.EXAMPLE.COM' },
        now,
      ),
    ).toBe(true);
    // U+212A KELVIN SIGN lowercases to `k` under full Unicode folding.
    expect(
      isSessionOfferable(
        sessionAt({ serverName: 'kail.example.com' }),
        '\u212Aail.example.com',
        HOST,
        now,
      ),
    ).toBe(false);
  });

  it('drops one issued by a different host', () => {
    expect(isSessionOfferable(sessionAt(), 'imap.example.net', HOST, new Date(1_000_000))).toBe(
      false,
    );
    expect(isSessionOfferable(sessionAt(), 'mail.example.com', HOST, new Date(1_000_000))).toBe(
      true,
    );
  });

  /** `expectedPeerName` overrides `serverName`; `null` means the issuing connection checked no name. */
  it('drops one whose validated identity is not the one being asked for', () => {
    const session = sessionAt();
    const other: PeerName = { kind: 'dns', value: 'evil.example.com' };
    const now = new Date(1_000_000);

    expect(isSessionOfferable(session, session.serverName, other, now)).toBe(false);
    expect(isSessionOfferable(session, session.serverName, null, now)).toBe(false);
    expect(
      isSessionOfferable(sessionAt({ expectedPeerName: null }), session.serverName, HOST, now),
    ).toBe(false);
    expect(
      isSessionOfferable(sessionAt({ expectedPeerName: null }), session.serverName, null, now),
    ).toBe(true);
    // An IP and a DNS name that read the same are still different identities.
    expect(
      isSessionOfferable(session, session.serverName, { kind: 'ip', value: HOST.value }, now),
    ).toBe(false);
  });

  it('drops one past its lifetime, to the second', () => {
    const session = sessionAt();
    expect(isSessionOfferable(session, session.serverName, HOST, new Date(1_059_999))).toBe(true);
    expect(isSessionOfferable(session, session.serverName, HOST, new Date(1_060_000))).toBe(false);
  });

  /** A negative age encodes as an enormous `obfuscated_ticket_age`, which reads as a replay. */
  it('drops one from the future', () => {
    const session = sessionAt();
    expect(isSessionOfferable(session, session.serverName, HOST, new Date(999_999))).toBe(false);
  });

  /** RFC 9846 §4.7.1: 7 days regardless of `ticket_lifetime`; no alert is named, so the ceiling lands on the way in. */
  it('caps a lifetime the server had no business sending', async () => {
    expect((await ticketOf({ ticketLifetime: 0xffffffff }))?.lifetimeSeconds).toBe(604_800);
  });

  /** `opaque ticket<1..2^16-1>` allows 65535, and the ClientHello's extension block is a uint16 too. */
  it('is not a session at all when the ticket could never be used', async () => {
    expect(await ticketOf({ ticketLifetime: 0 })).toBeUndefined();
    expect(await ticketOf({ ticket: new Uint8Array(16_385) })).toBeUndefined();
    expect(await ticketOf({ ticket: new Uint8Array(16_384) })).toBeDefined();
  });
});

/** RFC 9846 §4.7.1: `authenticatedAt` is carried forward through every renewal. */
describe('how long a resumption chain may outlive its certificate', () => {
  const WEEK = 604_800 * 1000;

  // The ticket is minted fresh at each check so only the chain's age can refuse; with the two
  // clocks at one instant, the ticket's own lifetime answers first and the ceiling is never read.
  const renewedAt = (authenticatedDaysAgo: number, now: Date): TlsSession =>
    sessionAt({
      authenticatedAt: new Date(now.getTime() - authenticatedDaysAgo * 24 * 3600 * 1000),
      receivedAt: now,
      lifetimeSeconds: 600,
    });

  it('lets a freshly renewed ticket resume while the chain is inside the week', () => {
    const now = new Date(1_000_000_000);
    expect(isSessionOfferable(renewedAt(6, now), 'mail.example.com', HOST, now)).toBe(true);
  });

  it('refuses a freshly renewed ticket once the chain is past the week', () => {
    const now = new Date(1_000_000_000);
    expect(isSessionOfferable(renewedAt(8, now), 'mail.example.com', HOST, now)).toBe(false);
  });

  it('is exact to the millisecond', () => {
    const authenticatedAt = new Date(1_000_000_000);
    const at = (offset: number) => {
      const now = new Date(authenticatedAt.getTime() + offset);
      return isSessionOfferable(
        sessionAt({ authenticatedAt, receivedAt: now, lifetimeSeconds: 600 }),
        'mail.example.com',
        HOST,
        now,
      );
    };
    expect(at(WEEK - 1)).toBe(true);
    expect(at(WEEK)).toBe(false);
  });

  /** The same rule on the way in: a connection held on `IDLE` past the ceiling still gets renewals. */
  it('does not mint a session already past the ceiling', async () => {
    expect(
      await ticketOf({ authenticatedAt: new Date(0), receivedAt: new Date(WEEK) }),
    ).toBeUndefined();
    expect(
      await ticketOf({ authenticatedAt: new Date(0), receivedAt: new Date(WEEK - 1) }),
    ).toBeDefined();
  });
});

describe('the age reported on the wire', () => {
  it("is the real age in milliseconds plus the server's offset", () => {
    const session = sessionAt({ ticketAgeAdd: 1234 });
    expect(obfuscatedTicketAge(session, new Date(1_010_000))).toBe(10_000 + 1234);
  });

  // §4.3.11.1 makes it a uint32, so the sum wraps; unwrapped, the encoder would truncate it.
  it('wraps at 2^32 rather than overflowing the field', () => {
    const session = sessionAt({ ticketAgeAdd: 0xffffffff });
    expect(obfuscatedTicketAge(session, new Date(1_000_001))).toBe(0);
  });
});

/** No peer this package can drive mints a ticket on a resumed connection, so the rule is tested here. */
describe('what a renewed ticket inherits', () => {
  const DAY = 24 * 3600 * 1000;
  const proved = new Date(1_000_000_000);
  const later: PeerAuthentication = {
    authenticatedAt: new Date(proved.getTime() + 5 * DAY),
    peerSignatureScheme: 'ed25519',
    peerCertificateChain: FRESH_CHAIN,
  };

  it('a resumed handshake keeps the ORIGINAL instant, so the ceiling still bites', () => {
    // Take `later` here and a chain of renewals never ages.
    const resumed = sessionAt({
      authenticatedAt: proved,
      peerSignatureScheme: 'ecdsa_secp384r1_sha384',
    });

    expect(inheritedAuthentication(resumed, later)).toEqual({
      authenticatedAt: proved,
      peerSignatureScheme: 'ecdsa_secp384r1_sha384',
      peerCertificateChain: STORED_CHAIN,
    });
  });

  it('carries the inherited instant far enough to actually expire', () => {
    // Eight days after the signature, a session renewed on day 7 is no longer offerable.
    const resumed = sessionAt({ authenticatedAt: proved, receivedAt: new Date(proved.getTime()) });
    const renewed = inheritedAuthentication(resumed, later);
    const eightDaysOn = new Date(proved.getTime() + 8 * DAY);

    expect(
      isSessionOfferable(
        sessionAt({
          authenticatedAt: renewed.authenticatedAt,
          receivedAt: new Date(proved.getTime() + 7 * DAY),
          lifetimeSeconds: 600_000,
        }),
        'mail.example.com',
        HOST,
        eightDaysOn,
      ),
    ).toBe(false);
  });

  it('a full handshake takes both from the signature it just verified', () => {
    expect(inheritedAuthentication(undefined, later)).toEqual(later);
  });

  it('throws rather than inventing either when a rehydrated session lost one', () => {
    expect(() => inheritedAuthentication(undefined, undefined)).toThrow(
      /authenticated the peer neither/,
    );
  });

  /** A JSON round trip turns a `Uint8Array` into `{"0":48,...}`, still typed `Uint8Array`. */
  it.each([
    ['dropped the field', undefined],
    ['revived the leaf as a plain object', { leafDer: { 0: 0x30 }, intermediateDer: [] }],
    [
      'revived an intermediate as a plain array',
      { leafDer: Uint8Array.of(0x30), intermediateDer: [[0x30]] },
    ],
  ])('throws when a rehydrated session %s', (_case, chain) => {
    const resumed = {
      ...sessionAt(),
      peerCertificateChain: chain,
    } as unknown as TlsSession;

    expect(() => inheritedAuthentication(resumed, later)).toThrow(/no usable peer certificate/);
  });
});
