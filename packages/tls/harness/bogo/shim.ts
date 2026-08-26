#!/usr/bin/env node
/**
 * The BoGo shim: one process per test, wrapping `startTls` over a real socket.
 *
 * The runner launches this with `-port` and `-shim-id`, and the shim connects
 * back to loopback as a TCP *client* — the runner is the server end even when
 * the test is a client test. The first bytes on the wire are the shim id as a
 * 64-bit little-endian integer; everything after that is the TLS connection.
 *
 * Three exits, and the runner reads each differently:
 *
 * - **0** — the test passed. Anything on stderr fails a passing test, so this
 *   file is silent when it succeeds.
 * - **89** — "I can't do that". The runner records the test as skipped, which is
 *   the honest answer to a flag we do not implement. `run.ts` counts every one
 *   by the flag that caused it, because a skip nobody counts is how a green
 *   board comes to mean nothing.
 * - **anything else** — the test failed, and stderr carries the reason the
 *   runner matches against its expected error.
 */

import { X509Certificate } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import {
  DerError,
  decodeCertificate,
  type TrustAnchorSource,
  type Validator,
} from '@yozz.app/x509';
import {
  NAMED_GROUPS,
  type NamedGroup,
  namedGroupFromCode,
  SIGNATURE_SCHEMES,
  type SignatureScheme,
  SUPPORTED_GROUPS,
  SUPPORTED_SIGNATURE_SCHEMES,
  signatureSchemeFromCode,
  startTls,
  type TlsFailure,
  type TlsSession,
} from '../../src/index.ts';
import { endGracefully, socketTransport } from '../socket-transport.ts';
import { LEGACY_SCHEMES, UNIMPLEMENTED_CURVES, UNIMPLEMENTED_SCHEMES } from './scope.ts';

const UNIMPLEMENTED_EXIT = 89;

/**
 * BoGo's default leaf carries the single-label DNS SAN `test`, and our client
 * has no un-named mode: it validates the name it was asked for. Tests that care
 * about the name pass `-host-name`.
 */
const DEFAULT_SERVER_NAME = 'test';

type Options = {
  readonly port: number;
  readonly shimId: bigint;
  readonly ipv6: boolean;
  readonly serverName: string;
  readonly trustAnchors: TrustAnchorSource;
  /**
   * `-verify-peer`: a refused certificate is FATAL. It does not decide who
   * verifies — see `verificationFor` for why this shim's answer is never
   * `YOZZ_VALIDATOR`.
   */
  readonly verifiesPeer: boolean;
  /** `-verify-fail`: the application refuses whatever the peer sent. */
  readonly verifyFails: boolean;
  /**
   * `-reverify-on-resume`: validate the session's stored chain again on the
   * resumed connection.
   *
   * BoGo pins BOTH answers, so this cannot be unconditional and cannot be
   * absent. `CertificateVerificationDoesNotFailOnResume` requires that a
   * default client does NOT re-check; `FailsOnResume` and `PassesOnResume`
   * require that it does when asked. `startTls` defaults the other way — see
   * `reverifyOnResume` there for why — so this is passed explicitly on every
   * connection rather than left off.
   */
  readonly reverifiesOnResume: boolean;
  /**
   * `-expect-verify-result`: assert the verification outcome after the
   * handshake. A BOOL in BoGo, not a code — `bssl_shim.cc` compares
   * `SSL_get_verify_result` to `X509_V_ERR_APPLICATION_VERIFICATION` when
   * `-verify-fail` is set and to `X509_V_OK` otherwise, so the flag means
   * "the outcome must be the one the other flags implied".
   */
  readonly expectVerifyResult: boolean;
  /**
   * `-export-keying-material <n>`: export n octets under `-export-label` and
   * `-export-context` and write them to the peer, which recomputes them and
   * compares. Zero means the test does not ask.
   */
  readonly exportKeyingMaterialLength: number;
  readonly exportLabel: string;
  readonly exportContext: string;
  /** `-shim-writes-first`: speak before being spoken to. */
  readonly writesFirst: boolean;
  /** `-shim-shuts-down`: hang up after the handshake without reading. */
  readonly shutsDown: boolean;
  /** `-check-close-notify`: an EOF without a close_notify is a failure. */
  readonly checkCloseNotify: boolean;
  /** `-curves`: what `supported_groups` offers, in the order the runner gave them. */
  readonly supportedGroups: readonly NamedGroup[];
  /** `-expect-curve-id`: the group the key exchange has to have landed on. */
  readonly expectCurveId: number | null;
  /** `-resume-count`: how many connections FOLLOW the first, each offering the last ticket. */
  readonly resumeCount: number;
  /** `-resumption-delay`: seconds the mock clock advances between connections. */
  readonly resumptionDelaySeconds: number;
  /** `-expect-session-miss`: a resumption connection that must NOT resume. */
  readonly expectsSessionMiss: boolean;
  /** `-expect-no-session`: no ticket may arrive at all. */
  readonly expectsNoSession: boolean;
  /** `-expect-hrr` / `-expect-no-hrr`, or null when the test does not say. */
  readonly expectHelloRetryRequest: boolean | null;
  /** `-verify-prefs`: what `signature_algorithms` offers, in the runner's order. */
  readonly signatureSchemes: readonly SignatureScheme[];
  /**
   * `-expect-peer-signature-algorithm`: the scheme the server's CertificateVerify
   * had to carry, asserted on EVERY connection of the run. The resumed ones send
   * no CertificateVerify, and checking them is the whole point of the test
   * setting `resumeSession` — BoringSSL reports the scheme there too, out of the
   * session, and a client that forgot it would answer 0.
   */
  readonly expectPeerSignatureScheme: number | null;
};

/** The runner's own default for `-shim-initial-write`, which no test overrides. */
const SHIM_INITIAL_WRITE = 'hello';

/**
 * What this shim does instead of validating a path — on EVERY connection, which
 * is the part worth stating plainly: `YOZZ_VALIDATOR` is not reachable from
 * here at all, and `-verify-peer` does not summon it.
 *
 * This is not a convenience. BoGo's certificate factory
 * (`ssl/test/runner/certs.go`) hand-builds its leaves with an EMPTY subject and
 * a NON-CRITICAL `subjectAltName`, which RFC 5280 §4.2.1.6 forbids — the SAN
 * carries the whole identity there, so it has to be critical. `YOZZ_VALIDATOR`
 * is right to refuse them, and refuses EVERY certificate the runner offers, so
 * a validating shim cannot run a single BoGo test. Path validation is
 * x509-limbo's gate; this one is for the state machine. The two BoGo tests that
 * do turn on a path decision are excluded by name, under
 * `needs-path-validation` in `scope.ts`.
 *
 * The decode stays real, because BoGo sends deliberately corrupt certificates
 * and a shim that never parsed them would pass those tests by accident. So does
 * `CertificateVerify`: the SPKI handed back is the peer's own.
 */
const UNVERIFIED: Validator = {
  name: 'bogo-unverified',
  validatePath: async request => {
    try {
      const peer = decodeCertificate(request.peerCertificateDer);
      return {
        ok: true,
        path: {
          leafSubjectPublicKeyInfoDer: peer.subjectPublicKeyInfo.der,
          intermediates: request.untrustedIntermediateDer,
          trustAnchorId: 'unverified',
        },
      };
    } catch (error) {
      if (error instanceof DerError) {
        return {
          ok: false,
          reason: { code: 'malformed-certificate', certificate: { source: 'peer' } },
        };
      }
      throw error;
    }
  },
};

/**
 * One line per invocation, for `run.ts` to aggregate.
 *
 * The runner's JSON records a skip with no reason attached, so a skip is only
 * attributable if the shim writes down why. The whole argv goes with it: that
 * is where the test's name, protocol and side live, in the `-write-settings`
 * path the runner hands us. Off unless the harness asks for it.
 */
const log = (decision: string, reason: string | null): void => {
  const path = process.env.YOZZ_BOGO_LOG;
  if (path === undefined) return;
  appendFileSync(path, `${JSON.stringify({ decision, reason, argv: process.argv.slice(2) })}\n`);
};

const fail = (reason: string): number => {
  log('failed', reason);
  process.stderr.write(`${reason}\n`);
  return 1;
};

/**
 * The validator for one connection, and a handle on what it decided.
 *
 * Two things are deliberately NOT `YOZZ_VALIDATOR`, and both would look like
 * bugs without this note.
 *
 * **`-verify-peer` does not select the real validator.** It cannot: BoGo's
 * leaves are refused by `YOZZ_VALIDATOR` for the reason `UNVERIFIED` gives
 * above, so wiring it here turns every test that must SUCCEED into a failure.
 * It was wired here, and never fired, because until `-expect-verify-result`
 * landed no in-scope test reached it without `-verify-fail` overriding it
 * first. What `-verify-peer` really selects is whether a refusal is fatal.
 *
 * **Soft fail is modelled in the shim, not in the client.** Without
 * `-verify-peer` BoringSSL still runs its verify callback and records the
 * failure without aborting (`SSL_VERIFY_NONE`), which is what
 * `CertificateVerificationSoftFail` tests. This client has no such mode and
 * must not grow one — a mail client that continues past a refused certificate
 * is the bug the whole package exists to prevent. So the refusal is recorded
 * here and the unverified path returned, which leaves the connection where
 * BoringSSL's ends up.
 */
const verificationFor = (
  options: Options,
): {
  readonly validator: Validator;
  readonly ran: () => boolean;
  readonly refused: () => boolean;
} => {
  let ran = false;
  let refused = false;
  return {
    validator: {
      name: options.verifyFails ? 'bogo-verify-fail' : UNVERIFIED.name,
      validatePath: async request => {
        ran = true;
        if (!options.verifyFails) return UNVERIFIED.validatePath(request);
        refused = true;
        return options.verifiesPeer
          ? { ok: false, reason: { code: 'rejected-by-policy' } }
          : UNVERIFIED.validatePath(request);
      },
    },
    ran: () => ran,
    refused: () => refused,
  };
};

/**
 * BoGo can scope a flag to ONE connection of a resumption run: `-on-initial-X`
 * and `-on-resume-X` set X on that connection's config only, and an unprefixed
 * flag sets it on both (`ParseConfig` in `ssl/test/test_config.cc`, which keeps
 * three configs — the third is the 0-RTT retry, declined below). So argv is
 * filtered once per role and parsed once per role, and the parser never learns
 * that connections differ.
 *
 * Splitting argv means deciding which tokens are values, and only the parser
 * really knows. This uses the rule `run.ts` uses — a token starting with `-` is
 * a flag, anything else belongs to the flag before it — which holds for every
 * value BoGo passes in scope: ports, curve ids, scheme ids, file paths, host
 * names. Should one ever start with `-`, the flag it belongs to arrives at the
 * parser as an unknown flag and the shim DECLINES, so it surfaces as a skip
 * rather than as a setting quietly dropped.
 */
type ConnectionRole = 'initial' | 'resume';

const argvForRole = (argv: readonly string[], role: ConnectionRole): readonly string[] => {
  const scoped: string[] = [];
  let applies = true;
  for (const token of argv) {
    if (!token.startsWith('-')) {
      if (applies) scoped.push(token);
      continue;
    }
    const prefix = /^-on-(initial|resume)-/.exec(token);
    applies = prefix === null || prefix[1] === role;
    if (applies) scoped.push(prefix === null ? token : `-${token.slice(prefix[0].length)}`);
  }
  return scoped;
};

// Explicitly typed rather than inferred, so a call to it NARROWS: `decline`
// after an `undefined` check has to convince the compiler the check held.
const decline: (reason: string) => never = reason => {
  log('declined', reason);
  process.stderr.write(`unimplemented: ${reason}\n`);
  process.exit(UNIMPLEMENTED_EXIT);
};

const anchorsFromPem = (path: string): TrustAnchorSource => {
  // `-trust-cert ''` is what the runner passes for a credential with no root,
  // which is how the garbage-certificate tests arrive. An empty store is the
  // honest reading of it.
  const pem = path === '' ? '' : readFileSync(path, 'utf8');
  const anchors = [
    ...pem.matchAll(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g),
  ].map(([block], index) => ({
    id: `${path}#${index}`,
    certificateDer: new Uint8Array(new X509Certificate(block).raw),
    // BoGo issues its own roots and carries no distrust metadata.
    serverDistrustAfter: null,
  }));
  return { findCandidates: () => anchors };
};

/**
 * Flags this shim understands. Everything else — the whole of DTLS, QUIC, the
 * server side, client auth, 0-RTT and resumption included — exits 89 rather
 * than being silently ignored, because a flag ignored is a test that passes
 * without doing what it was asked.
 */
const parseArgs = (wholeArgv: readonly string[], role: ConnectionRole): Options => {
  const argv = argvForRole(wholeArgv, role);
  let port: number | null = null;
  let shimId = 0n;
  let ipv6 = false;
  let serverName = DEFAULT_SERVER_NAME;
  let trustAnchors: TrustAnchorSource = { findCandidates: () => [] };
  let verifiesPeer = false;
  let verifyFails = false;
  let reverifiesOnResume = false;
  let expectVerifyResult = false;
  let exportKeyingMaterialLength = 0;
  let exportLabel = '';
  let exportContext = '';
  let writesFirst = false;
  let shutsDown = false;
  let checkCloseNotify = false;
  const curves: NamedGroup[] = [];
  let expectCurveId: number | null = null;
  let resumeCount = 0;
  let resumptionDelaySeconds = 0;
  let expectsSessionMiss = false;
  let expectsNoSession = false;
  let expectHelloRetryRequest: boolean | null = null;
  const verifyPrefs: SignatureScheme[] = [];
  let expectPeerSignatureScheme: number | null = null;

  const value = (index: number, flag: string): string => {
    const next = argv[index];
    if (next === undefined) throw new Error(`${flag} wants a value`);
    return next;
  };

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === undefined) continue;
    switch (flag) {
      case '-port':
        port = Number(value(++i, flag));
        break;
      case '-shim-id':
        shimId = BigInt(value(++i, flag));
        break;
      case '-ipv6':
        ipv6 = true;
        break;
      case '-host-name':
        serverName = value(++i, flag);
        break;
      case '-trust-cert':
        trustAnchors = anchorsFromPem(value(++i, flag));
        break;
      case '-verify-peer':
        verifiesPeer = true;
        break;
      /** The runner asking for a refusal it can predict. */
      case '-verify-fail':
        verifyFails = true;
        break;
      case '-reverify-on-resume':
        reverifiesOnResume = true;
        break;
      case '-expect-verify-result':
        expectVerifyResult = true;
        break;
      /**
       * BoringSSL's two verification APIs — `SSL_CTX_set_cert_verify_callback`
       * and `SSL_set_custom_verify` — reaching the same decision by different
       * routes. This shim has one route, a `Validator`, so the flag selects
       * nothing here.
       *
       * It is NOT nothing to the runner, which expects a different alert from
       * each: `handshake_failure` from the legacy callback and
       * `certificate_unknown` from the custom one (`verifyFailLocalError` in
       * `state_machine_tests.go`). We send `certificate_unknown` for both,
       * which is what the custom half asks for and what RFC 9846 §4.5.1 asks
       * of everyone — the legacy half is an entry in `RFC_DIVERGENCES`.
       */
      case '-use-custom-verify-callback':
        break;
      case '-export-keying-material':
        exportKeyingMaterialLength = Number(value(++i, flag));
        break;
      case '-export-label':
        exportLabel = value(++i, flag);
        break;
      case '-export-context':
        exportContext = value(++i, flag);
        break;
      /**
       * TLS 1.2's exporter distinguished "no context" from "an empty context";
       * TLS 1.3's does not. RFC 9846 §7.5 takes a `context_value` and hashes
       * it, so an absent one IS the empty one — and the runner agrees, since
       * `exportKeyingMaterialTLS13` in `conn.go` never reads `useContext`.
       * Accepted and ignored, which is why `ExportKeyingMaterial-NoContext` and
       * `-EmptyContext` expect identical output.
       */
      case '-use-export-context':
        break;
      case '-shim-writes-first':
        writesFirst = true;
        break;
      case '-shim-shuts-down':
        shutsDown = true;
        break;
      case '-check-close-notify':
        checkCloseNotify = true;
        break;
      /**
       * Repeated once per group, most preferred first. A group we do not
       * implement declines by NAME, so `run.ts` attributes the test to the
       * missing curve rather than to this flag.
       */
      case '-curves': {
        const id = Number(value(++i, flag));
        const group = namedGroupFromCode(id);
        if (group === undefined) decline(`curve ${UNIMPLEMENTED_CURVES[id] ?? id}`);
        curves.push(group);
        break;
      }
      case '-expect-curve-id':
        expectCurveId = Number(value(++i, flag));
        break;
      /**
       * The client's verify preferences, repeated once per scheme, most
       * preferred first — `-curves`' sibling, and declined the same way, by the
       * ALGORITHM we cannot verify rather than by the flag.
       */
      case '-verify-prefs': {
        const id = Number(value(++i, flag));
        /**
         * A scheme TLS 1.3 does not define for CertificateVerify is DROPPED,
         * not declined, and the difference is worth six tests.
         *
         * `-verify-prefs` configures what a CertificateVerify may be signed
         * with, which is exactly what `signatureSchemes` holds — and RFC 9846
         * §4.3.3 says the RSA-PKCS1 values "are not defined for use in signed
         * TLS handshake messages", §4.5.2 the same for SHA-1. So the flag names
         * a value this option can never hold, and "offer nothing for it" is not
         * a shortcut, it is the only answer the RFC leaves.
         *
         * The tests that pass one AGREE: `shouldFail` is set for exactly these
         * at TLS 1.3 (`signature_algorithm_tests.go`), the runner signs with the
         * scheme anyway under `IgnorePeerSignatureAlgorithmPreferences`, and the
         * client owes `illegal_parameter`. Declining made six tests SKIP and
         * asserted that behaviour in prose; dropping MEASURES it. If the list
         * ends up empty the default six are offered, which is what a client with
         * no expressible preference sends.
         *
         * **Which rule they measure was checked, not assumed.** It is the
         * unimplemented-scheme arm of the §4.5.2 check in `handshake.ts` — a
         * CertificateVerify naming a scheme this client cannot verify at all —
         * and NOT the unoffered-but-implementable arm beside it. Deleting the
         * second leaves all six green (`VerifyPreferences-Enforced` is what
         * catches that one); waving the first through fails all six, plus
         * eleven more. Two arms, two gates, and the first draft of this note
         * credited them to the wrong one.
         */
        if (LEGACY_SCHEMES[id] !== undefined) break;
        const scheme = signatureSchemeFromCode(id);
        if (scheme === undefined) decline(`signature scheme ${UNIMPLEMENTED_SCHEMES[id] ?? id}`);
        verifyPrefs.push(scheme);
        break;
      }
      case '-expect-peer-signature-algorithm':
        expectPeerSignatureScheme = Number(value(++i, flag));
        break;
      /**
       * How many connections FOLLOW the first. Each is a fresh TCP connection to
       * the same port with the same shim id, offering the ticket the previous
       * one left behind (`doExchanges` in `ssl/test/runner/runner.go`).
       */
      case '-resume-count':
        resumeCount = Number(value(++i, flag));
        break;
      case '-resumption-delay':
        resumptionDelaySeconds = Number(value(++i, flag));
        break;
      case '-expect-session-miss':
        expectsSessionMiss = true;
        break;
      case '-expect-no-session':
        expectsNoSession = true;
        break;
      case '-expect-hrr':
        expectHelloRetryRequest = true;
        break;
      case '-expect-no-hrr':
        expectHelloRetryRequest = false;
        break;
      /**
       * In TLS 1.2 this asks whether the server minted a SECOND ticket on the
       * resumed connection. TLS 1.3 mints one every time — BoringSSL's own shim
       * gates the check on `GetProtocolVersion(ssl) < TLS1_3_VERSION` and skips
       * it — so the ticket-arrived assertion below already covers what it asks.
       */
      case '-expect-ticket-renewal':
        break;

      /**
       * Both describe how BoringSSL's own shim drives its API — non-blocking
       * callbacks, and a handshake left to the first read or write instead of
       * being asked for. Neither is visible on the wire, and this client has no
       * other mode: every call here is already async, and `startTls` is the
       * handshake. Accepted and ignored is the honest answer; declining would
       * skip 21 tests over a difference that does not exist for us.
       */
      case '-async':
      case '-implicit-handshake':
        break;
      // A transcript-run artifact for BoringSSL's own fuzzers. `run.ts` reads
      // the test's name, protocol and side out of the prefix; the shim has no
      // settings file to write.
      case '-write-settings':
        i++;
        break;
      /**
       * `-on-initial-` and `-on-resume-` are gone by now, stripped by
       * `argvForRole`. `-on-retry-` is not: it configures the 0-RTT retry
       * handshake, and a client that never offers early data never performs
       * one, so there is no connection here for it to configure. Declining
       * says that; ignoring it would be a setting silently dropped.
       */
      default:
        if (/^-on-retry-/.test(flag)) {
          decline('per-connection flag scoping (-on-retry, the 0-RTT retry handshake)');
        }
        decline(`flag ${flag}`);
    }
  }

  if (port === null) throw new Error('-port is required');
  return {
    port,
    shimId,
    ipv6,
    serverName,
    trustAnchors,
    exportKeyingMaterialLength,
    exportLabel,
    exportContext,
    verifiesPeer,
    verifyFails,
    reverifiesOnResume,
    expectVerifyResult,
    writesFirst,
    shutsDown,
    checkCloseNotify,
    supportedGroups: curves.length > 0 ? curves : SUPPORTED_GROUPS,
    signatureSchemes: verifyPrefs.length > 0 ? verifyPrefs : SUPPORTED_SIGNATURE_SCHEMES,
    expectCurveId,
    expectPeerSignatureScheme,
    resumeCount,
    resumptionDelaySeconds,
    expectsSessionMiss,
    expectsNoSession,
    expectHelloRetryRequest,
  };
};

const openSocket = ({ port, ipv6, shimId }: Options): Promise<Socket> =>
  new Promise((resolve, reject) => {
    const socket = connect({ port, host: ipv6 ? '::1' : '127.0.0.1' }, () => {
      const header = Buffer.alloc(8);
      header.writeBigUInt64LE(shimId);
      socket.write(header);
      resolve(socket);
    });
    socket.on('error', reject);
  });

/**
 * The failure the runner reads off stderr, and the whole of our error
 * vocabulary. `ErrorMap` in `shim-config.json` maps BoGo's canonical error
 * names onto these strings, so the wording is a contract: change it and the map
 * has to move with it.
 */
const describe = (failure: TlsFailure): string => {
  switch (failure.kind) {
    case 'alert-sent':
      return `yozz: alert-sent ${failure.alert.description}`;
    case 'alert-received':
      return `yozz: alert-received ${failure.alert.description}`;
    case 'alert-received-unknown':
      return `yozz: alert-received-unknown ${failure.code}`;
    case 'truncated':
      return 'yozz: truncated';
    case 'certificate':
      /**
       * `chain` goes LAST on purpose. The runner matches `ErrorMap` entries as
       * SUBSTRINGS (`translateExpectedError` in `runner.go`), and the two
       * certificate entries in `shim-config.json` name a code and an alert —
       * which is right, because `:CERTIFICATE_VERIFY_FAILED:` is BoringSSL's
       * answer for BOTH chains. Putting the field in the middle broke 20 tests
       * at once; on the end it is diagnosis the map is deliberately blind to.
       */
      return `yozz: certificate ${failure.reason.code} ${failure.alert.description} chain=${failure.chain}`;
  }
};

/** The runner sends a message and expects every byte back inverted. */
const invert = (bytes: Uint8Array): Uint8Array => bytes.map(byte => byte ^ 0xff);

/**
 * One connection, from the socket to the close_notify.
 *
 * A resumption run is several of these in one process — the runner accepts a
 * fresh TCP connection per exchange, each one prefixed with the same shim id —
 * so the session is threaded through by the caller rather than kept here.
 */
const runConnection = async (
  options: Options,
  {
    isResume,
    now,
    session,
    onSession,
    inheritedRefusal,
    onVerification,
  }: {
    readonly isResume: boolean;
    readonly now: Date;
    readonly session: TlsSession | undefined;
    readonly onSession: (session: TlsSession) => void;
    /**
     * What the connection that minted this session concluded about the peer.
     * A resumed handshake carries no Certificate, so nothing verifies and the
     * result is the earlier one — which is what `SSL_get_verify_result` answers
     * on a resumed BoringSSL connection, and why `-reverify-on-resume` has to
     * be asked for.
     */
    readonly inheritedRefusal: boolean;
    readonly onVerification: (refused: boolean) => void;
  },
): Promise<number> => {
  const socket = await openSocket(options);
  const verification = verificationFor(options);
  let hasNewSession = false;
  try {
    const handshake = await startTls({
      transport: socketTransport(socket),
      serverName: options.serverName,
      trustAnchors: options.trustAnchors,
      validationTime: now,
      /**
       * Frozen for the whole connection, and advanced only between connections.
       * BoGo compares the ticket age we report to `-resumption-delay` for EXACT
       * equality, so any real time passing inside the exchange fails the test.
       */
      now: () => now,
      validator: verification.validator,
      supportedGroups: options.supportedGroups,
      signatureSchemes: options.signatureSchemes,
      session,
      reverifyOnResume: options.reverifiesOnResume,
      onSession: next => {
        hasNewSession = true;
        onSession(next);
      },
    });
    if (!handshake.ok) return fail(describe(handshake.reason));

    const { connection, negotiatedGroup, isResumed, isHelloRetryRequested, peerSignatureScheme } =
      handshake;
    /**
     * A resumed connection inherits the earlier verdict only when nothing
     * re-checked. With `-reverify-on-resume` the validator ran on THIS
     * connection, so its answer is the current one — and since a refusal there
     * aborts the handshake, reaching this line at all means it said yes.
     */
    const refused =
      isResumed && !options.reverifiesOnResume ? inheritedRefusal : verification.refused();
    onVerification(refused);
    /**
     * `SSL_get_verify_result` answers because verification HAPPENED, so the
     * flag asserts both halves: that something verified the peer, and that it
     * concluded what the other flags implied.
     *
     * The second half alone is tautological here — the validator below sets
     * `refused` exactly when `-verify-fail` asked it to, so the two cannot
     * disagree — and deleting it moved nothing on the board. The first half is
     * the one with teeth: a full handshake where `validatePath` was never
     * reached means the client took the peer's certificate on trust, and
     * nothing else in this suite would notice. It is skipped on a resumed
     * handshake, which carries no Certificate and inherits the earlier verdict
     * — unless `-reverify-on-resume` asked for the stored chain to be checked
     * again, and no test in scope pairs that flag with this one.
     */
    if (options.expectVerifyResult) {
      if (!isResumed && !verification.ran()) {
        return fail('yozz: handshake completed without verifying the peer certificate');
      }
      if (refused !== options.verifyFails) {
        return fail(`yozz: verification refused=${refused}, wanted refused=${options.verifyFails}`);
      }
    }
    if (options.expectCurveId !== null && NAMED_GROUPS[negotiatedGroup] !== options.expectCurveId) {
      return fail(
        `yozz: negotiated curve ${NAMED_GROUPS[negotiatedGroup]}, wanted ${options.expectCurveId}`,
      );
    }
    const peerSignatureCode = SIGNATURE_SCHEMES[peerSignatureScheme];
    if (
      options.expectPeerSignatureScheme !== null &&
      peerSignatureCode !== options.expectPeerSignatureScheme
    ) {
      return fail(
        `yozz: peer signature algorithm ${peerSignatureCode}, wanted ${options.expectPeerSignatureScheme}`,
      );
    }
    /**
     * `expect_resume = is_resume && !config->expect_session_miss` — BoringSSL's
     * own shim, and the assertion that makes a resumption run mean anything. A
     * client that quietly did a full handshake every time would otherwise pass
     * every one of these tests.
     */
    if (isResumed !== (isResume && !options.expectsSessionMiss)) {
      return fail(`yozz: session was${isResumed ? '' : ' not'} resumed`);
    }
    if (
      options.expectHelloRetryRequest !== null &&
      isHelloRetryRequested !== options.expectHelloRetryRequest
    ) {
      return fail(`yozz: HelloRetryRequest was${isHelloRetryRequested ? '' : ' not'} sent`);
    }
    /**
     * Written to the peer, which derived the same octets from its own schedule
     * and compares them byte for byte — so this is the runner checking our
     * exporter, not us checking ourselves.
     */
    if (options.exportKeyingMaterialLength > 0) {
      const exported = await connection.exportKeyingMaterial(
        options.exportLabel,
        new TextEncoder().encode(options.exportContext),
        options.exportKeyingMaterialLength,
      );
      const sent = await connection.write(exported);
      if (!sent.ok) return fail(describe(sent.reason));
    }
    if (options.writesFirst) {
      const opening = await connection.write(new TextEncoder().encode(SHIM_INITIAL_WRITE));
      if (!opening.ok) return fail(describe(opening.reason));
    }

    while (!options.shutsDown) {
      const read = await connection.read();
      if (!read.ok) {
        // "Stop on either clean or unclean shutdown" — a peer that simply goes
        // away ends the conversation, and only `-check-close-notify` makes the
        // missing close_notify itself the complaint.
        if (read.reason.kind === 'truncated' && !options.checkCloseNotify) break;
        return fail(describe(read.reason));
      }
      if (read.kind === 'closed') break;

      const written = await connection.write(invert(read.bytes));
      if (!written.ok) return fail(describe(written.reason));
    }

    /**
     * Our close_notify goes out either way. Whether the PEER owes one back is
     * `-check-close-notify`'s question, and only then does a connection that
     * simply ends become a complaint — a peer that drops the socket as we write
     * is the ordinary unclean shutdown every mail server eventually does.
     */
    const closed = await connection.close();
    if (!closed.ok && options.checkCloseNotify) return fail(describe(closed.reason));

    if (options.checkCloseNotify) {
      const shutdown = await connection.read();
      if (!shutdown.ok) return fail(describe(shutdown.reason));
      if (shutdown.kind !== 'closed') return fail('yozz: data after our close_notify');
    }

    /**
     * A TLS 1.3 client must come away with a ticket unless the test says
     * otherwise — the same assertion BoringSSL's shim makes, and the only thing
     * proving `psk_key_exchange_modes` went out and the ticket that answered it
     * was understood. `-shim-shuts-down` never reads, so nothing arrives.
     */
    if (!options.shutsDown && hasNewSession === options.expectsNoSession) {
      return fail(`yozz: a session was${hasNewSession ? '' : ' not'} established`);
    }

    return 0;
  } finally {
    await endGracefully(socket);
  }
};

const main = async (): Promise<number> => {
  const argv = process.argv.slice(2);
  if (argv.includes('-is-handshaker-supported')) {
    // Asked once, before any test, to decide whether to generate the split
    // handshaker variants. They are all server tests.
    process.stdout.write('No\n');
    return 0;
  }

  /**
   * One config per connection role, because BoGo scopes flags to one connection
   * of a resumption run. Everything the RUN needs rather than a connection —
   * the port, `-resume-count`, the delay — is unprefixed, so both configs carry
   * the same value and `initial` is the one read for it.
   */
  const initial = parseArgs(argv, 'initial');
  const onResume = parseArgs(argv, 'resume');
  let session: TlsSession | undefined;
  let refusal = false;
  /**
   * A mock clock, which is what makes `-resumption-delay` testable: BoGo checks
   * the reported ticket age for EXACT equality with the delay it asked for
   * (`ExpectTicketAge` in `handshake_server.go`), so real time elapsing between
   * two connections would fail it by however long the exchange took. BoringSSL's
   * own shim freezes at `{1234, 1234}` and advances only here; ours starts from
   * the real clock instead, because the same value dates our certificate
   * validation and 1970 expires every chain BoGo issues.
   */
  let now = new Date();

  for (let exchange = 0; exchange <= initial.resumeCount; exchange += 1) {
    const isResume = exchange > 0;
    const code = await runConnection(isResume ? onResume : initial, {
      isResume,
      now,
      session,
      onSession: next => {
        session = next;
      },
      inheritedRefusal: refusal,
      onVerification: next => {
        refusal = next;
      },
    });
    if (code !== 0) return code;
    now = new Date(now.getTime() + initial.resumptionDelaySeconds * 1000);
  }

  log('passed', null);
  return 0;
};

/**
 * A thrown error is not a TLS failure, and reporting it as one would let a bug
 * in this file read as a finding. It gets its own signature so the report can
 * count it apart from anything the client decided.
 */
process.exit(
  await main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    return fail(`yozz: shim-error ${message.replace(/\s+/g, ' ')}`);
  }),
);
