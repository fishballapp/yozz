/**
 * Resumption against RFC 8448 §3 and §4, which publish both halves of it.
 *
 * §3 ends with a `NewSessionTicket` and the `res master` it was minted from;
 * §4 opens by resuming that exact session and publishes the PSK, the truncated
 * ClientHello, the binder key and the binder itself. So the whole chain — ticket
 * to PSK to binder to the 512 octets that go on the wire — is checked against
 * the document rather than against our own arithmetic, which is the only way to
 * catch a mistake both the writer and the reader would make.
 *
 * The unit checks below it are the parts no trace covers: a document has one
 * clock and one host, and the rules that drop a session have neither.
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

/**
 * §3's server certificate, for the same reason the ticket below is read rather
 * than transcribed: the document publishes one, so the session's stored chain
 * can be a real certificate instead of a shape that merely satisfies the type.
 */
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

/**
 * §3's ticket, read with our own decoder and expanded with our own schedule.
 *
 * Transcribing the ticket's fields by hand would test the transcription. The
 * 205 published octets go through `decodeHandshakeMessage`, so a decoder that
 * mislocates the nonce derives the wrong PSK and every assertion below it
 * fails.
 */
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
 * §4's ClientHello with its binder zeroed — the state a real one is in between
 * being laid out and being bound, and the input `bindClientHello` is built for.
 * The 3 octets are the binder list's own framing: a uint16 list length of 33
 * and a uint8 entry length of 32.
 */
const zeroBinderClientHello = (prefix: Uint8Array): Uint8Array =>
  concat(prefix, Uint8Array.of(0x00, 0x21, 0x20), new Uint8Array(32));

describe('resumption against RFC 8448', () => {
  it("derives §4's pre-shared key from §3's ticket", async () => {
    const session = await sessionFromTheDocument();

    // §4's Early Secret takes the PSK as its IKM, so the document states the
    // answer twice — once as what §3 generated, once as what §4 consumed.
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

    // "The PSK binder uses the same construction as Finished and so is labeled
    // as finished here" — §4's own note on the field name.
    expect(bound.subarray(bound.length - 32)).toEqual(bytesOf(binderStep, 'finished'));
  });

  it("reproduces §4's ClientHello byte for byte, binder included", async () => {
    const trace4 = traceOf('4');
    const bound = await bindClientHello(
      await sessionFromTheDocument(),
      zeroBinderClientHello(bytesOf(stepOf(trace4, 'calculate PSK binder'), 'ClientHello prefix')),
      [],
    );

    // The record the document sends is the whole message, which the "construct"
    // step above it does NOT publish — it prints the ClientHello as it stands
    // before the binder exists.
    expect(bound).toEqual(bytesOf(stepOf(trace4, 'send handshake record'), 'payload'));
  });

  /**
   * The check this file was written to earn.
   *
   * §4 was the one trace of the five whose running transcript did not
   * reproduce, and a tripwire in `key-schedule.test.ts` asserted that it did
   * not — because the document publishes the TRUNCATED ClientHello under the
   * name `ClientHello`, and hashing that is 35 octets short. It reproduces the
   * moment the binder can be computed, which is the whole point of the rule
   * landing, so the tripwire is gone and this stands in its place.
   */
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
      // `derive secret for handshake | master "tls13 derived"` is excluded on
      // purpose: it hashes the EMPTY transcript, not the handshake so far.
      if (!/^derive secret "tls13 /.test(step.title)) continue;
      const published = step.fields.find(field => field.label === 'hash')?.bytes;
      if (published === undefined) continue;
      expect(await transcriptHash(SUITE, ...messages)).toEqual(published);
      checked.push(step.title);
    }

    // A walk that matched nothing would pass every assertion above it.
    expect(checked.length).toBe(8);
  });
});

/**
 * §4 driven through the STATE MACHINE, which is what this file could not reach
 * before, and the only place the renewal rule is observable end to end.
 *
 * Everything above proves §4 at the binder level: the ticket becomes a PSK,
 * the PSK becomes a binder, the binder reproduces the document's ClientHello.
 * None of it runs a handshake. So the fields `inheritedAuthentication` carries
 * forward were pinned as a rule and NEVER observed arriving in a minted ticket
 * — no peer this package can drive mints one on a resumed connection: Node's
 * OpenSSL issues none on the resumption, BoGo runs every resumption test at
 * `-resume-count 1`, and §4 itself publishes no `NewSessionTicket`.
 *
 * **§4 is the "Resumed 0-RTT Handshake", and this client has no 0-RTT.** That
 * sounds fatal and is not, because of WHERE the two flights diverge. The
 * server's application traffic secret runs over ClientHello..server Finished
 * (§4 derives it before the client's `EndOfEarlyData`), so this client
 * reproduces it exactly. Only the CLIENT's Finished and `res master` differ,
 * because the document's transcript carries an `EndOfEarlyData` ours never
 * sends. So the server half of §4 replays byte-exact and the client half does
 * not — and the server half is the one that seals a ticket.
 *
 * That makes the decryption below load-bearing twice over: it is the renewal
 * test's delivery mechanism AND the proof that our key schedule lands on §4's
 * published `s ap traffic` key, which nothing else in this package checks.
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
    /**
     * The SENT record's payload, not the `construct a ClientHello` step above
     * it — and this file already knew why. §4 publishes the message under that
     * name with the binder not yet computed, 35 octets short, which is the same
     * trap the running-transcript test three blocks up was written for. Feeding
     * the truncated one here produces a handshake that resumes and then fails
     * `bad_record_mac`, because every key hangs off a transcript missing the
     * binder.
     */
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
      /**
       * Both clocks are frozen an INSTANT after the document's, not at it. §3's
       * ticket is dated `new Date(0)` and lives 30 seconds, so a real clock puts
       * it decades past both its lifetime and the §4.7.1 ceiling and it is never
       * offered at all. One second in, every rule that reads a clock is
       * satisfied and none of them is disabled.
       */
      now: () => new Date(1_000),
      /**
       * Accepting, and NOT a way of skipping the re-check: `reverifyOnResume`
       * defaults on, so this runs §4 through that path too, over the chain §3's
       * Certificate message put on the session. **`revalidated` is what makes
       * that a fact rather than a claim** — a review pointed out that deleting
       * the re-check left this test green, because an accepting validator that
       * is never called looks exactly like one that is.
       */
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

    /**
     * A resumed handshake carries no Certificate, so the ONLY chain there is to
     * validate is the one §3 put on the session — and it was validated, which is
     * what `reverifyOnResume` defaulting on is supposed to mean. Deleting the
     * re-check fails here and nowhere else in this file.
     */
    expect(revalidated).toEqual([offered.peerCertificateChain.leafDer]);

    /**
     * §3's own `NewSessionTicket`, sealed under §4's PUBLISHED server key at
     * sequence 0 — the first record that server writes under its application
     * key. The document publishes no ticket on the resumed connection, so the
     * message is borrowed and the KEY is the part under test: if this client
     * derived anything but §4's `s ap traffic`, the AEAD open fails and nothing
     * below runs.
     */
    const { key, iv } = publishedServerAppKeys();
    const ticket = bytesOf(
      stepOf(traceOf('3'), 'construct a NewSessionTicket handshake message'),
      'NewSessionTicket',
    );
    await duplex.server.write(await sealAead(key, iv, 0n, 'handshake', ticket));
    /**
     * And then a `close_notify` at sequence 1, without which this test hangs.
     * A `NewSessionTicket` is not application data: `read()` consumes it, fires
     * `onSession` and goes back to waiting, because the caller asked for DATA
     * and none has arrived. That is the right behaviour and it is why the
     * session cannot be observed by a return value — the goodbye is what gives
     * `read()` something to return.
     */
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

    /**
     * **The wiring nothing else in this package can reach.** Each of the three
     * describes the CertificateVerify from §3 — the connection that actually
     * authenticated this peer — and a renewal that took any of them fresh would
     * let a chain of tickets outlive the one signature behind it. The rule is
     * tested directly in `inheritedAuthentication`; that these values reach a
     * MINTED ticket is what only this replay observes.
     */
    expect(next.authenticatedAt).toEqual(offered.authenticatedAt);
    expect(next.peerSignatureScheme).toBe(offered.peerSignatureScheme);
    expect(next.peerCertificateChain).toEqual(offered.peerCertificateChain);

    // And it really is a NEW session, not the one that was offered: same peer,
    // different secret.
    expect(next.preSharedKey).not.toEqual(offered.preSharedKey);
    expect(next.receivedAt).toEqual(new Date(1_000));
  });
});

const HOST: PeerName = { kind: 'dns', value: 'mail.example.com' };

/**
 * Two chains that are only ever compared to each other. Nothing below decodes
 * them — `inheritedAuthentication` moves a chain without reading it, and which
 * of the two comes out is the whole assertion.
 */
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
  /**
   * DNS is case-insensitive, so a caller that round-trips the hostname through
   * anything normalising must not silently lose resumption. The fold is
   * `@yozz.app/x509`'s ASCII-only one, NOT `toLowerCase()` — full Unicode folding
   * would make KELVIN SIGN match `k` and widen a security comparison.
   */
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

  /**
   * The one that matters most, because a resumed handshake sends no certificate:
   * whatever identity the issuing connection proved is the only identity this
   * session can ever stand for. `expectedPeerName` overrides `serverName`, so
   * the two can disagree — and `null` means the issuing connection checked no
   * name at all, which may never satisfy a connection that asks for one.
   */
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

  /**
   * A clock that moved backwards makes the age negative, and a negative age
   * encodes as an enormous `obfuscated_ticket_age` — which a server running
   * 0-RTT anti-replay reads as a replayed ticket rather than as a wrong clock.
   */
  it('drops one from the future', () => {
    const session = sessionAt();
    expect(isSessionOfferable(session, session.serverName, HOST, new Date(999_999))).toBe(false);
  });

  /**
   * RFC 9846 §4.7.1: a client "MUST NOT cache tickets for longer than 7 days,
   * regardless of the ticket_lifetime", and a server "MUST NOT use any value
   * greater than 604800 seconds". A server that sends more earns no alert — the
   * RFC names none — so the ceiling lands on the way in.
   */
  it('caps a lifetime the server had no business sending', async () => {
    expect((await ticketOf({ ticketLifetime: 0xffffffff }))?.lifetimeSeconds).toBe(604_800);
  });

  /**
   * A ticket with no window to be used in, and one the next ClientHello could
   * not carry. The second is the dangerous one: `opaque ticket<1..2^16-1>`
   * allows 65535, the ClientHello declares its extensions with a uint16 too, and
   * the encoder throws — on the connection AFTER the one that received it, out
   * of a session the caller has already stored.
   */
  it('is not a session at all when the ticket could never be used', async () => {
    expect(await ticketOf({ ticketLifetime: 0 })).toBeUndefined();
    expect(await ticketOf({ ticket: new Uint8Array(16_385) })).toBeUndefined();
    expect(await ticketOf({ ticket: new Uint8Array(16_384) })).toBeDefined();
  });
});

/**
 * RFC 9846 §4.7.1: renewal "can indefinitely extend the lifetime of the keying
 * material originally derived from an initial non-PSK handshake", and asks for a
 * limit. `authenticatedAt` is carried FORWARD through every renewal, so this is
 * the check that a chain of tickets cannot outlive the one signature behind it.
 */
describe('how long a resumption chain may outlive its certificate', () => {
  const WEEK = 604_800 * 1000;

  /**
   * The two clocks are deliberately far apart. A fixture where `receivedAt` and
   * `authenticatedAt` are the same instant cannot test this at all: the ticket's
   * own lifetime runs out first and answers `false` for the other reason, so
   * deleting the ceiling entirely leaves the test green. That is exactly what
   * the first version of it did.
   *
   * Here the ticket is minted fresh at the moment of each check — a renewal, six
   * days into a chain — so its own lifetime never expires and the ONLY clause
   * that can refuse is the age of the certificate behind it.
   */
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
    // The ticket is re-minted at every instant checked, so its own age is always
    // zero and cannot be the clause that answers. Only the chain's age moves.
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

  /**
   * The same rule on the way IN. A connection held open on `IDLE` past the
   * ceiling still gets renewals, and a session refused for its whole life is a
   * liability to store rather than a session.
   */
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

  // §4.3.11.1 makes it a uint32, so the sum wraps rather than widening — and a
  // sum that did not wrap would be truncated by the encoder instead, silently.
  it('wraps at 2^32 rather than overflowing the field', () => {
    const session = sessionAt({ ticketAgeAdd: 0xffffffff });
    expect(obfuscatedTicketAge(session, new Date(1_000_001))).toBe(0);
  });
});

/**
 * The renewal rule, tested where nothing else can reach it.
 *
 * A ticket minted ON a resumed connection is invisible to every peer this
 * package can drive — Node's OpenSSL mints none on a resumption, BoGo never
 * runs a third connection, RFC 8448 §4 publishes no NewSessionTicket. So the
 * one thing standing between a working authentication ceiling and a silently
 * retired one is right here.
 */
describe('what a renewed ticket inherits', () => {
  const DAY = 24 * 3600 * 1000;
  const proved = new Date(1_000_000_000);
  const later: PeerAuthentication = {
    authenticatedAt: new Date(proved.getTime() + 5 * DAY),
    peerSignatureScheme: 'ed25519',
    peerCertificateChain: FRESH_CHAIN,
  };

  it('a resumed handshake keeps the ORIGINAL instant, so the ceiling still bites', () => {
    // The whole of RFC 9846 §4.7.1's concern: take `later` here and a chain of
    // renewals is indistinguishable from a fresh handshake forever. Five days
    // in, an inherited instant is five days old; a reset one is zero.
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
    // Inheritance is only worth anything if the ceiling reads it. Eight days
    // after the signature, a session renewed on day 7 is no longer offerable —
    // which is false the moment the instant resets.
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

  /**
   * The chain is the one field a JSON round trip corrupts without losing: a
   * `Uint8Array` comes back as `{"0":48,...}`, which is typed `Uint8Array` and
   * is not one. Unchecked it reaches `validatePath`, which refuses it as a
   * malformed certificate — so a caller whose store dropped the shape would be
   * told its mail host has a bad certificate.
   */
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
