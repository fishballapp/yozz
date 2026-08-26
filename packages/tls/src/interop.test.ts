/**
 * The client against a real TLS 1.3 server, on a real socket, across every group
 * and suite it offers.
 *
 * Everything else in this package replays RFC 8448, which is a SHA-256 / X25519
 * document. So `TLS_AES_256_GCM_SHA384` and P-384, the pair `posteo.de`
 * requires, have no published bytes to check against and are proven only here.
 *
 * Two things close with this file that no scripted peer could close. The client
 * offers a key share for X25519 only, so the P-256 and P-384 rows force a real
 * HelloRetryRequest from a peer that did not come out of the traces. And the
 * chain is issued at test time, so `YOZZ_VALIDATOR` does the validating instead
 * of a test double.
 */

import { connect } from 'node:net';
import { YOZZ_VALIDATOR } from '@yozz.app/x509';
import { describe, expect, it, vi } from 'vitest';
import {
  type CurveName,
  issueLocalLeaf,
  LOCAL_SERVER_NAME,
  type SuiteName,
  startLocalServer,
} from '../harness/local-server.ts';
import { socketTransport } from '../harness/socket-transport.ts';
import { startTls } from './handshake.ts';
import { pinnedValidator } from './pinning.ts';
import type { TlsSession } from './session.ts';

const MATRIX: readonly { readonly suite: SuiteName; readonly curve: CurveName }[] = [
  { suite: 'TLS_AES_128_GCM_SHA256', curve: 'X25519' },
  { suite: 'TLS_AES_128_GCM_SHA256', curve: 'P-256' },
  { suite: 'TLS_AES_128_GCM_SHA256', curve: 'P-384' },
  { suite: 'TLS_AES_256_GCM_SHA384', curve: 'X25519' },
  { suite: 'TLS_AES_256_GCM_SHA384', curve: 'P-256' },
  { suite: 'TLS_AES_256_GCM_SHA384', curve: 'P-384' },
];

const openSocket = (port: number) =>
  new Promise<ReturnType<typeof connect>>((resolve, reject) => {
    const socket = connect({ port, host: '127.0.0.1' }, () => resolve(socket));
    socket.on('error', reject);
  });

/**
 * The client's own alerts, read by something that is not the client.
 *
 * After ServerHello a TLS 1.3 alert has to travel as an inner alert inside an
 * AEAD record. Nothing in the scripted-peer tests notices when it goes out in
 * cleartext instead, because none of them decrypt what the client wrote. OpenSSL
 * does, and says which alert it got.
 */
describe('a fatal alert reaches a real peer', () => {
  it('sends unknown_ca, protected, when it trusts no root', async () => {
    const server = await startLocalServer({
      suite: 'TLS_AES_128_GCM_SHA256',
      curve: 'X25519',
    });
    const socket = await openSocket(server.port);
    const transport = socketTransport(socket);
    const written: Uint8Array[] = [];
    try {
      const result = await startTls({
        transport: {
          read: transport.read,
          write: async bytes => {
            written.push(bytes);
            await transport.write(bytes);
          },
        },
        serverName: LOCAL_SERVER_NAME,
        trustAnchors: { findCandidates: () => [] },
        validationTime: new Date(),
        validator: YOZZ_VALIDATOR,
      });

      expect(result).toMatchObject({
        ok: false,
        // `peer-sent`, and it is the control for the `session-stored` assertion
        // below: the same failure kind, the other chain.
        reason: { kind: 'certificate', chain: 'peer-sent', alert: { description: 'unknown_ca' } },
      });

      await vi.waitFor(() => expect(server.alertsReceived.length).toBeGreaterThan(0));
      expect(server.alertsReceived.join(' ')).toContain('alert number 48');

      // OpenSSL accepts a cleartext alert here, so what the peer reports cannot
      // tell the two apart. What the client WROTE can: after ServerHello the
      // alert must leave as an AEAD record, outer type 0x17, never a bare 0x15.
      const last = written.at(-1);
      if (last === undefined) throw new Error('the client wrote nothing');
      expect(last[0]).toBe(0x17);
    } finally {
      socket.destroy();
      await server.stop();
    }
  });
});

describe('a real TLS 1.3 server, every group and suite', () => {
  for (const { suite, curve } of MATRIX) {
    it(`${suite} over ${curve}`, async () => {
      const server = await startLocalServer({ suite, curve });
      const socket = await openSocket(server.port);
      try {
        const result = await startTls({
          transport: socketTransport(socket),
          serverName: LOCAL_SERVER_NAME,
          trustAnchors: server.trustAnchors,
          validationTime: new Date(),
          validator: YOZZ_VALIDATOR,
        });

        expect(result).toMatchObject({ ok: true });
        if (!result.ok) return;

        // The server echoes, so a round trip proves the application keys on both
        // sides agree. A handshake that "completed" with mismatched keys would
        // pass every assertion above this one.
        const sent = new TextEncoder().encode('a1 CAPABILITY\r\n');
        expect(await result.connection.write(sent)).toEqual({ ok: true });
        expect(await result.connection.read()).toEqual({ ok: true, kind: 'data', bytes: sent });

        // A write above one record's 2^14 plaintext (a mail body) goes out as several records;
        // the echo comes back in whatever pieces the server chose, so it is reassembled.
        const big = new Uint8Array(40_000).map((_, index) => index % 251);
        expect(await result.connection.write(big)).toEqual({ ok: true });
        const echoed: number[] = [];
        while (echoed.length < big.length) {
          const chunk = await result.connection.read();
          expect(chunk).toMatchObject({ ok: true, kind: 'data' });
          if (!chunk.ok || chunk.kind !== 'data') return;
          echoed.push(...chunk.bytes);
        }
        expect(Uint8Array.from(echoed)).toEqual(big);
        expect(await result.connection.close()).toEqual({ ok: true });
      } finally {
        socket.destroy();
        await server.stop();
      }
    });
  }
});

/**
 * Resumption against OpenSSL, which is the only peer that can prove it.
 *
 * RFC 8448 §4 proves the binder against the document's own bytes and BoGo proves
 * the state machine against BoringSSL's Go server — both worth having, and
 * neither is OpenSSL. This one hands a ticket OpenSSL minted back to OpenSSL and
 * asks it to accept our binder over it.
 *
 * Both suites run, because the binder is a MAC under the ticket's own hash and
 * every other source of truth here is SHA-256: RFC 8448 is a SHA-256 document
 * end to end, and BoGo's resumption tests negotiate `TLS_AES_128_GCM_SHA256`.
 * SHA-384 resumption has no other evidence anywhere.
 */
describe('resumption against a real TLS 1.3 server', () => {
  for (const suite of ['TLS_AES_128_GCM_SHA256', 'TLS_AES_256_GCM_SHA384'] as const) {
    it(`resumes under ${suite}`, async () => {
      const server = await startLocalServer({ suite, curve: 'X25519' });
      const sessions: TlsSession[] = [];

      const connectOnce = async (session: TlsSession | undefined) => {
        const socket = await openSocket(server.port);
        try {
          const result = await startTls({
            transport: socketTransport(socket),
            serverName: LOCAL_SERVER_NAME,
            trustAnchors: server.trustAnchors,
            validationTime: new Date(),
            validator: YOZZ_VALIDATOR,
            session,
            onSession: next => {
              sessions.push(next);
            },
          });
          expect(result).toMatchObject({ ok: true });
          if (!result.ok) throw new Error('handshake failed');

          // The echo is what proves the two sides agree on keys derived through
          // the PSK. A resumption that "succeeded" with a mismatched schedule
          // would satisfy `isResumed` and nothing else.
          const sent = new TextEncoder().encode('a1 CAPABILITY\r\n');
          expect(await result.connection.write(sent)).toEqual({ ok: true });
          expect(await result.connection.read()).toEqual({ ok: true, kind: 'data', bytes: sent });
          expect(await result.connection.close()).toEqual({ ok: true });
          return result;
        } finally {
          socket.destroy();
        }
      };

      try {
        const first = await connectOnce(undefined);
        expect(first.isResumed).toBe(false);

        // The ticket arrives after the handshake, so it is `read()` that
        // produced this, not `startTls`.
        const offered = sessions[0];
        if (offered === undefined) throw new Error('the server issued no ticket');
        expect(offered.suite).toBe(suite);
        expect(offered.serverName).toBe(LOCAL_SERVER_NAME);

        const second = await connectOnce(offered);
        expect(second.isResumed).toBe(true);

        /**
         * A resumed handshake verifies no signature, so the scheme it reports
         * came out of the session it offered. Pinned to what the server's key
         * can actually sign — `issueCertificate` mints an ECDSA P-256 leaf — so
         * a report that agreed only with itself would fail here.
         *
         * **What this does NOT reach: the ticket minted ON the resumed
         * connection.** Node's OpenSSL issues two tickets on the full handshake
         * and none on the resumption (measured, and an extra round trip does not
         * shake one loose), BoGo runs every resumption test at `-resume-count 1`
         * so there is never a third connection to offer one back on, and RFC
         * 8448 §4 publishes no NewSessionTicket. So nothing anywhere observes
         * what `sessionFromTicket` carries forward on a renewal — see the note
         * at that call site.
         */
        expect(first.peerSignatureScheme).toBe('ecdsa_secp256r1_sha256');
        expect(second.peerSignatureScheme).toBe(first.peerSignatureScheme);
      } finally {
        await server.stop();
      }
    });
  }
});

/**
 * The certificate check a resumed handshake would otherwise skip.
 *
 * A resumption carries no Certificate and no CertificateVerify, so the only
 * chain there is to check is the one the session stored — and the only thing
 * that has moved since is the clock. That is what makes this pair worth
 * running against a real server rather than a scripted one: the chain is
 * issued at test time and validated by `YOZZ_VALIDATOR`, so the refusal comes
 * from a certificate genuinely expiring rather than from a test double
 * deciding to say no.
 *
 * It also pins the separation `startTls` draws between its two clocks. Only
 * `validationTime` moves; `now` stays put, so the ticket is still well inside
 * its lifetime and the session is offered. A client that validated against the
 * running clock, or aged tickets against the validation time, fails one of
 * these two.
 */
describe('a resumed handshake re-checks the stored chain', () => {
  const YEAR = 365 * 24 * 3600 * 1000;

  const resumeAfterTheLeafExpires = async (reverifyOnResume: boolean | undefined) => {
    const server = await startLocalServer({ suite: 'TLS_AES_128_GCM_SHA256', curve: 'X25519' });
    const issuedAt = new Date();
    const sessions: TlsSession[] = [];

    const connectOnce = async (session: TlsSession | undefined, validationTime: Date) => {
      const socket = await openSocket(server.port);
      try {
        const result = await startTls({
          transport: socketTransport(socket),
          serverName: LOCAL_SERVER_NAME,
          trustAnchors: server.trustAnchors,
          validationTime,
          // Frozen at the real instant, so moving `validationTime` below does
          // not also age the ticket out from under the test.
          now: () => issuedAt,
          validator: YOZZ_VALIDATOR,
          session,
          reverifyOnResume,
          onSession: next => {
            sessions.push(next);
          },
        });
        if (result.ok) {
          // The echo, for the same reason the resumption test above wants one:
          // `isResumed` alone does not prove the two sides agree on keys.
          const sent = new TextEncoder().encode('a1 NOOP\r\n');
          expect(await result.connection.write(sent)).toEqual({ ok: true });
          expect(await result.connection.read()).toEqual({ ok: true, kind: 'data', bytes: sent });
          expect(await result.connection.close()).toEqual({ ok: true });
        }
        return result;
      } finally {
        socket.destroy();
      }
    };

    try {
      const first = await connectOnce(undefined, issuedAt);
      expect(first.ok).toBe(true);
      const offered = sessions[0];
      if (offered === undefined) throw new Error('the server issued no ticket');

      // `issueCertificate` gives its leaves a year either side, so two years on
      // the stored chain has expired and nothing else about it has changed.
      return await connectOnce(offered, new Date(issuedAt.getTime() + 2 * YEAR));
    } finally {
      await server.stop();
    }
  };

  it('refuses the resumption when the stored leaf has expired', async () => {
    expect(await resumeAfterTheLeafExpires(undefined)).toMatchObject({
      ok: false,
      reason: {
        kind: 'certificate',
        reason: { code: 'certificate-expired' },
        alert: { description: 'certificate_expired' },
        /**
         * The field the caller acts on, and the reason it exists: this exact
         * `ValidationFailure` on a peer-sent chain means the host is presenting
         * something we refuse, and here it means the host has almost certainly
         * ROTATED and the session is stale. Evict and reconnect works for one
         * and not the other, so a caller that could not tell them apart could
         * not do either.
         */
        chain: 'session-stored',
      },
    });
  });

  /**
   * The positive control, and it earns its place twice over: it proves the
   * refusal above comes from the re-check rather than from anything else this
   * setup does, and it is the behaviour BoGo pins as BoringSSL's default —
   * `CertificateVerificationDoesNotFailOnResume`, 24 tests of it.
   */
  it('resumes the same expired chain when the re-check is off', async () => {
    /**
     * `peerPublicKeyPin` is `null` here, and it is the ONLY configuration that
     * produces one: this connection validated no chain, so the stored leaf's key
     * is something it never established. Reporting it anyway would hand a caller
     * a pin to store from a connection that proved nothing about the key —
     * which is the same lie the learn/check split exists to prevent, arriving
     * through the resumption path instead of through the validator.
     */
    expect(await resumeAfterTheLeafExpires(false)).toMatchObject({
      ok: true,
      isResumed: true,
      peerPublicKeyPin: null,
    });
  });

  /** The other arm of the same contract: the default re-check DOES report one. */
  it('reports a pin when the resumption re-checks its chain', async () => {
    const server = await startLocalServer({ suite: 'TLS_AES_128_GCM_SHA256', curve: 'X25519' });
    const sessions: TlsSession[] = [];

    const connectOnce = async (session: TlsSession | undefined) => {
      const socket = await openSocket(server.port);
      try {
        const result = await startTls({
          transport: socketTransport(socket),
          serverName: LOCAL_SERVER_NAME,
          trustAnchors: server.trustAnchors,
          validationTime: new Date(),
          validator: YOZZ_VALIDATOR,
          session,
          onSession: next => {
            sessions.push(next);
          },
        });
        if (result.ok) {
          const sent = new TextEncoder().encode('a1 NOOP\r\n');
          expect(await result.connection.write(sent)).toEqual({ ok: true });
          expect(await result.connection.read()).toEqual({ ok: true, kind: 'data', bytes: sent });
          expect(await result.connection.close()).toEqual({ ok: true });
        }
        return result;
      } finally {
        socket.destroy();
      }
    };

    try {
      const first = await connectOnce(undefined);
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      const offered = sessions[0];
      if (offered === undefined) throw new Error('the server issued no ticket');

      const resumed = await connectOnce(offered);
      expect(resumed).toMatchObject({ ok: true, isResumed: true });
      // The stored leaf IS the leaf the first connection authenticated, so the
      // two pins must agree — and a `null` here would be the field going quiet
      // on the path that does re-check.
      if (resumed.ok) expect(resumed.peerPublicKeyPin).toBe(first.peerPublicKeyPin);
    } finally {
      await server.stop();
    }
  });
});

/**
 * M9's gate, and it is deliberately two halves of one test rig.
 *
 * A pin that alarms on everything passes a rotation test perfectly and protects
 * nothing, because a user who sees it every eight weeks stops reading it. A pin
 * that alarms on nothing passes a renewal test perfectly and protects nothing
 * either. So the same server is stood up three times over one root — the
 * original leaf, a REISSUE of it under the same key, and a fresh key — and only
 * the third may be refused.
 *
 * The client is `YOZZ_VALIDATOR` under `pinnedValidator` throughout, so all
 * three chains validate on their own merits and the pin is the only thing that
 * can separate them.
 */
describe('trust on first use, pinned to the leaf public key', () => {
  const SUITE = 'TLS_AES_128_GCM_SHA256' as const;
  const CURVE = 'X25519' as const;

  const connect = async (
    server: Awaited<ReturnType<typeof startLocalServer>>,
    pin: string | undefined,
  ) => {
    const socket = await openSocket(server.port);
    try {
      const result = await startTls({
        transport: socketTransport(socket),
        serverName: LOCAL_SERVER_NAME,
        trustAnchors: server.trustAnchors,
        validationTime: new Date(),
        validator:
          pin === undefined ? YOZZ_VALIDATOR : pinnedValidator({ validator: YOZZ_VALIDATOR, pin }),
      });
      if (result.ok) {
        // The echo again: a pin decision is only meaningful on a connection that
        // then works, and this is what proves the keys agree either side of it.
        const sent = new TextEncoder().encode('a1 NOOP\r\n');
        expect(await result.connection.write(sent)).toEqual({ ok: true });
        expect(await result.connection.read()).toEqual({ ok: true, kind: 'data', bytes: sent });
        expect(await result.connection.close()).toEqual({ ok: true });
      }
      return result;
    } finally {
      socket.destroy();
    }
  };

  /**
   * First use, on a server with no pin configured, is where a pin comes from —
   * and it comes from the RESULT, which only exists because the handshake
   * completed. A validator cannot hand one back: at the moment it runs, all the
   * peer has proven is that it can send certificates, which are public.
   */
  it('learns a pin only from a completed handshake', async () => {
    const server = await startLocalServer({ suite: SUITE, curve: CURVE });
    try {
      const result = await connect(server, undefined);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.peerPublicKeyPin).toEqual(expect.any(String));
    } finally {
      await server.stop();
    }
  });

  it('is silent through a reissue that keeps the key', async () => {
    const first = await startLocalServer({ suite: SUITE, curve: CURVE });
    const learned = await connect(first, undefined);
    expect(learned.ok).toBe(true);
    if (!learned.ok) return;
    const pin = learned.peerPublicKeyPin;
    if (pin === null) throw new Error('a full handshake reported no pin');
    await first.stop();

    // A renewal: same root, same key, a new certificate. Everything a CA changes
    // on a reissue changes here — serial, validity, signature — and the key does not.
    const renewed = await issueLocalLeaf(first.chain.root, first.chain.leaf.keyPair);
    expect(Buffer.from(renewed.der).equals(Buffer.from(first.chain.leaf.der))).toBe(false);

    const second = await startLocalServer({
      suite: SUITE,
      curve: CURVE,
      chain: { root: first.chain.root, leaf: renewed },
    });
    try {
      const result = await connect(second, pin);
      expect(result).toMatchObject({ ok: true });
      // Not merely accepted — the pin the caller would store back is the same
      // one, so a renewal never rewrites the store either.
      if (result.ok) expect(result.peerPublicKeyPin).toBe(pin);
    } finally {
      await second.stop();
    }
  });

  it('refuses a chain that validates under a key it has not seen', async () => {
    const first = await startLocalServer({ suite: SUITE, curve: CURVE });
    const learned = await connect(first, undefined);
    expect(learned.ok).toBe(true);
    if (!learned.ok) return;
    const pin = learned.peerPublicKeyPin;
    if (pin === null) throw new Error('a full handshake reported no pin');
    await first.stop();

    // The rogue-CA shape, reduced to what the client can actually see: a chain
    // to a root it trusts, for a host it has met, carrying a key it has not.
    const rotated = await issueLocalLeaf(first.chain.root);
    const second = await startLocalServer({
      suite: SUITE,
      curve: CURVE,
      chain: { root: first.chain.root, leaf: rotated },
    });
    try {
      expect(await connect(second, pin)).toMatchObject({
        ok: false,
        reason: {
          kind: 'certificate',
          reason: { code: 'rejected-by-policy' },
          /**
           * NOT `unknown_ca`, which is what a refusal borrowing a chain code
           * would have sent. The CA is one we ship and the chain is sound; §6.2's
           * "some other (unspecified) issue ... rendering it unacceptable" is the
           * only honest thing to tell this peer.
           */
          alert: { description: 'certificate_unknown' },
          chain: 'peer-sent',
        },
      });

      // And the peer really received it, read by something that is not the client.
      await vi.waitFor(() => expect(second.alertsReceived.length).toBeGreaterThan(0));
      expect(second.alertsReceived.join(' ')).toContain('alert number 46');
    } finally {
      await second.stop();
    }
  });

  /**
   * The resumed path reaches the pin through the same `validatePeerChain` the
   * full handshake does, so a pin that only guarded the peer-sent chain would
   * leave a stored one unchecked for as long as its tickets keep renewing.
   */
  it('checks the stored chain on a resumption too', async () => {
    const server = await startLocalServer({ suite: SUITE, curve: CURVE });
    const sessions: TlsSession[] = [];

    const connectWith = async (session: TlsSession | undefined, pin: string | undefined) => {
      const socket = await openSocket(server.port);
      try {
        const result = await startTls({
          transport: socketTransport(socket),
          serverName: LOCAL_SERVER_NAME,
          trustAnchors: server.trustAnchors,
          validationTime: new Date(),
          validator:
            pin === undefined
              ? YOZZ_VALIDATOR
              : pinnedValidator({ validator: YOZZ_VALIDATOR, pin }),
          session,
          onSession: next => {
            sessions.push(next);
          },
        });
        if (result.ok) {
          // A ticket arrives AFTER the handshake, so `onSession` fires from
          // `read()` and never from `startTls`. Without this round trip there is
          // no session to resume with and this test proves nothing.
          const sent = new TextEncoder().encode('a1 NOOP\r\n');
          expect(await result.connection.write(sent)).toEqual({ ok: true });
          expect(await result.connection.read()).toEqual({ ok: true, kind: 'data', bytes: sent });
          expect(await result.connection.close()).toEqual({ ok: true });
        }
        return result;
      } finally {
        socket.destroy();
      }
    };

    try {
      const first = await connectWith(undefined, undefined);
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      const pin = first.peerPublicKeyPin;
      if (pin === null) throw new Error('a full handshake reported no pin');

      const offered = sessions[0];
      if (offered === undefined) throw new Error('the server issued no ticket');

      // Resuming under the pin it was issued under: accepted, and the pin the
      // re-check reports is the stored leaf's, which is the same key.
      const resumed = await connectWith(offered, pin);
      expect(resumed).toMatchObject({ ok: true, isResumed: true });
      if (resumed.ok) expect(resumed.peerPublicKeyPin).toBe(pin);

      // The same session under a pin the stored leaf cannot satisfy. Nothing on
      // the wire differs; the refusal comes from the chain the session carries.
      // An UNUSED ticket, because a ticket offered twice is a tracking cookie and
      // the rule against it is not one a test gets to bend. It is the SIBLING of
      // the one above — Node's OpenSSL issues two tickets on the full handshake
      // and none on the resumption — so this is a second resumption of the first
      // connection, not a resumption of a resumption.
      const unusedTicket = sessions[1];
      if (unusedTicket === undefined) throw new Error('the full handshake issued only one ticket');
      expect(
        await connectWith(unusedTicket, 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='),
      ).toMatchObject({
        ok: false,
        reason: {
          kind: 'certificate',
          reason: { code: 'rejected-by-policy' },
          alert: { description: 'certificate_unknown' },
          chain: 'session-stored',
        },
      });
    } finally {
      await server.stop();
    }
  });
});
