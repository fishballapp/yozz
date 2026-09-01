#!/usr/bin/env node
/**
 * One process per BoGo test. The runner listens; the shim connects to loopback as a TCP client
 * even for client tests, writes the shim id as a 64-bit little-endian integer, then speaks TLS.
 *
 * Exit 0 passes (anything on stderr fails it), 89 is "skipped", anything else fails with
 * stderr matched against the runner's expected error.
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

/** BoGo's default leaf carries the single-label SAN `test`; tests that care pass `-host-name`. */
const DEFAULT_SERVER_NAME = 'test';

type Options = {
  readonly port: number;
  readonly shimId: bigint;
  readonly ipv6: boolean;
  readonly serverName: string;
  readonly trustAnchors: TrustAnchorSource;
  /** `-verify-peer`: a refused certificate is fatal. It never selects `YOZZ_VALIDATOR`; see `verificationFor`. */
  readonly verifiesPeer: boolean;
  /** `-verify-fail`: the application refuses whatever the peer sent. */
  readonly verifyFails: boolean;
  /** `-reverify-on-resume`. BoGo pins both answers, so it is passed explicitly on every connection. */
  readonly reverifiesOnResume: boolean;
  /** `-expect-verify-result`: a bool in BoGo; the outcome must be the one the other flags implied. */
  readonly expectVerifyResult: boolean;
  /** `-export-keying-material <n>`: octets to export and write to the peer; zero means not asked. */
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
  /** `-expect-peer-signature-algorithm`: asserted on every connection, resumed ones included, out of the session. */
  readonly expectPeerSignatureScheme: number | null;
};

/** The runner's own default for `-shim-initial-write`, which no test overrides. */
const SHIM_INITIAL_WRITE = 'hello';

/** Decodes the chain (BoGo sends corrupt ones) but never validates it; see DECISIONS.md, "The BoGo shim never runs YOZZ_VALIDATOR". */
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

/** One line per invocation for `run.ts`: the runner's JSON records a skip without a reason. */
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
 * `-verify-peer` decides whether a refusal is fatal, not who validates; soft fail lives here, not
 * in the client. See DECISIONS.md, "The BoGo shim never runs YOZZ_VALIDATOR".
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
 * `-on-initial-X` / `-on-resume-X` scope a flag to one connection; an unprefixed flag sets both
 * (`ParseConfig`, `ssl/test/test_config.cc`). A token starting with `-` is a flag, anything else
 * the previous flag's value; a value that ever starts with `-` reaches the parser as an unknown
 * flag and declines.
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

// Typed `never` explicitly so a call narrows.
const decline: (reason: string) => never = reason => {
  log('declined', reason);
  process.stderr.write(`unimplemented: ${reason}\n`);
  process.exit(UNIMPLEMENTED_EXIT);
};

const anchorsFromPem = (path: string): TrustAnchorSource => {
  // `-trust-cert ''` is what the runner passes for a credential with no root.
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

/** Flags this shim understands. Anything else exits 89 rather than being ignored. */
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
      case '-verify-fail':
        verifyFails = true;
        break;
      case '-reverify-on-resume':
        reverifiesOnResume = true;
        break;
      case '-expect-verify-result':
        expectVerifyResult = true;
        break;
      /** Both BoringSSL verify APIs reach the same decision; we send `certificate_unknown` for either (`RFC_DIVERGENCES`). */
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
      /** RFC 9846 §7.5 hashes the context, so absent and empty are the same; the runner's `exportKeyingMaterialTLS13` never reads `useContext`. */
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
      /** Repeated once per group. An unimplemented group declines by name so `run.ts` attributes the skip to the curve. */
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
      /** Repeated once per scheme; declines by algorithm, like `-curves`. */
      case '-verify-prefs': {
        const id = Number(value(++i, flag));
        // RFC 9846 §4.3.3 / §4.5.2: RSA-PKCS1 and SHA-1 are not CertificateVerify schemes, so they are
        // dropped rather than declined. See DECISIONS.md, "An undefined `-verify-prefs` scheme is dropped".
        if (LEGACY_SCHEMES[id] !== undefined) break;
        const scheme = signatureSchemeFromCode(id);
        if (scheme === undefined) decline(`signature scheme ${UNIMPLEMENTED_SCHEMES[id] ?? id}`);
        verifyPrefs.push(scheme);
        break;
      }
      case '-expect-peer-signature-algorithm':
        expectPeerSignatureScheme = Number(value(++i, flag));
        break;
      /** Connections after the first, each a fresh TCP connection offering the last ticket. */
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
      /** A TLS 1.2 question; BoringSSL's shim skips it at 1.3, where the ticket assertion below covers it. */
      case '-expect-ticket-renewal':
        break;

      /** How BoringSSL's shim drives its API; invisible on the wire, and every call here is async already. */
      case '-async':
      case '-implicit-handshake':
        break;
      // A fuzzer artifact; `run.ts` reads the test name, protocol and side from the prefix.
      case '-write-settings':
        i++;
        break;
      /** `-on-retry-` configures the 0-RTT retry handshake, which a client that never offers early data never performs. */
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

/** `ErrorMap` in `shim-config.json` matches these strings, so the wording is a contract. */
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
      // `chain` goes last: the runner matches `ErrorMap` entries as substrings, and BoringSSL's
      // `:CERTIFICATE_VERIFY_FAILED:` covers both chains.
      return `yozz: certificate ${failure.reason.code} ${failure.alert.description} chain=${failure.chain}`;
  }
};

/** The runner sends a message and expects every byte back inverted. */
const invert = (bytes: Uint8Array): Uint8Array => bytes.map(byte => byte ^ 0xff);

/** One connection. A resumption run is several per process, so the caller threads the session through. */
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
    /** The minting connection's verdict; a resumed handshake carries no Certificate. */
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
      /** Frozen for the connection: BoGo compares the reported ticket age to `-resumption-delay` exactly. */
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
    // With `-reverify-on-resume` the validator ran on this connection, and reaching here means it said yes.
    const refused =
      isResumed && !options.reverifiesOnResume ? inheritedRefusal : verification.refused();
    onVerification(refused);
    /**
     * A full handshake where `validatePath` never ran took the certificate on trust, and nothing else
     * here would notice. Skipped on resumption, which carries no Certificate.
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
    /** BoringSSL's `expect_resume = is_resume && !expect_session_miss`. */
    if (isResumed !== (isResume && !options.expectsSessionMiss)) {
      return fail(`yozz: session was${isResumed ? '' : ' not'} resumed`);
    }
    if (
      options.expectHelloRetryRequest !== null &&
      isHelloRetryRequested !== options.expectHelloRetryRequest
    ) {
      return fail(`yozz: HelloRetryRequest was${isHelloRetryRequested ? '' : ' not'} sent`);
    }
    /** The peer derived the same octets and compares. */
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
        // A peer that simply goes away ends the conversation; only `-check-close-notify` makes that a complaint.
        if (read.reason.kind === 'truncated' && !options.checkCloseNotify) break;
        return fail(describe(read.reason));
      }
      if (read.kind === 'closed') break;

      const written = await connection.write(invert(read.bytes));
      if (!written.ok) return fail(describe(written.reason));
    }

    // Our close_notify goes out either way; `-check-close-notify` decides whether the peer owes one back.
    const closed = await connection.close();
    if (!closed.ok && options.checkCloseNotify) return fail(describe(closed.reason));

    if (options.checkCloseNotify) {
      const shutdown = await connection.read();
      if (!shutdown.ok) return fail(describe(shutdown.reason));
      if (shutdown.kind !== 'closed') return fail('yozz: data after our close_notify');
    }

    /** BoringSSL's shim asserts the same: a ticket must arrive unless the test says otherwise. `-shim-shuts-down` never reads. */
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
    // Asked once before any test; the split-handshake variants are all server tests.
    process.stdout.write('No\n');
    return 0;
  }

  /** One config per connection role. Run-level flags are unprefixed, so `initial` is read for them. */
  const initial = parseArgs(argv, 'initial');
  const onResume = parseArgs(argv, 'resume');
  let session: TlsSession | undefined;
  let refusal = false;
  /** Mock clock: BoGo checks the ticket age against `-resumption-delay` exactly. Starts from real time because 1970 expires every chain BoGo issues. */
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

/** A thrown error is a shim bug, not a TLS failure, and is reported apart. */
process.exit(
  await main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    return fail(`yozz: shim-error ${message.replace(/\s+/g, ' ')}`);
  }),
);
