/**
 * M8's Node half: the nine stage-3 mail servers, through THIS client.
 *
 *     pnpm -F @yozz.app/tls live            # all nine
 *     pnpm -F @yozz.app/tls live posteo.de  # just the hosts named
 *
 * Run by hand, never in CI and never from `pnpm test` — it needs the network,
 * and a gate that fails when someone else's mail server is down is a gate that
 * gets muted. What keeps it honest instead is that it is COMMITTED and exits
 * non-zero: the numbers it prints are reproducible by anyone, rather than a
 * paste from a one-off script nobody else has.
 *
 * The chain is validated against `ROOT_BUNDLE` alone — the bundle we ship, not
 * `node:tls`'s store — so this is where the compiled anchors carry real
 * traffic. And our own ClientHello chooses the chain, which is the only way to
 * find out whether what we ADVERTISE and what we can VERIFY agree: handing a
 * chain pulled off the wire by `node:tls` to the validator exercises the
 * validator and never the advertisement, which is exactly how the
 * `signature_algorithms_cert` defect survived to M7.
 */
import { connect, type Socket } from 'node:net';
import { compileAnchors, ROOT_BUNDLE, YOZZ_VALIDATOR } from '@yozz.app/x509';
import { startTls, type TlsConnection } from '../src/handshake.ts';
import { describeFailure, errorText } from './describe.ts';
import { HOSTS, IMAP_PORT, isReadyGreeting } from './hosts.ts';
import { endGracefully, socketTransport } from './socket-transport.ts';

const CONNECT_TIMEOUT_MS = 15_000;

const openSocket = (host: string): Promise<Socket> =>
  new Promise((resolve, reject) => {
    const socket = connect({ host, port: IMAP_PORT }, () => resolve(socket));
    socket.on('error', reject);
    socket.setTimeout(CONNECT_TIMEOUT_MS, () => {
      socket.destroy();
      reject(new Error(`no answer in ${CONNECT_TIMEOUT_MS}ms`));
    });
  });

/**
 * The IMAP greeting, which every server sends unprompted and which precedes
 * authentication — so nine servers need no nine accounts.
 *
 * A `line` only when the server actually greeted us. Everything else is a
 * failed host, not a footnote: see `isReadyGreeting`.
 */
type Greeting =
  | { readonly ok: true; readonly line: string }
  | { readonly ok: false; readonly why: string };

const readGreeting = async (connection: TlsConnection): Promise<Greeting> => {
  const result = await connection.read();
  if (!result.ok) return { ok: false, why: `read failed: ${describeFailure(result.reason)}` };
  if (result.kind === 'closed') return { ok: false, why: 'closed without a greeting' };
  const line = new TextDecoder().decode(result.bytes).split('\r\n')[0] ?? '';
  return isReadyGreeting(line)
    ? { ok: true, line }
    : { ok: false, why: `not an IMAP greeting: ${line.slice(0, 60)}` };
};

const anchors = compileAnchors(ROOT_BUNDLE);
const requested = process.argv.slice(2);
const targets = requested.length === 0 ? HOSTS : requested;

let failures = 0;

for (const host of targets) {
  let socket: Socket | undefined;
  try {
    socket = await openSocket(host);
    const transport = socketTransport(socket);

    /**
     * The record layer's first write IS the ClientHello record, so its length
     * less the 5-byte header is the message RFC 7685 pads. Every real mail
     * hostname measured lands under the 256..511 range padding engages on,
     * which is why BoGo's `ClientHelloPadding` is what proves a peer accepts
     * the padded version — no live host here will ever exercise it.
     */
    let clientHello: Uint8Array | undefined;

    const result = await startTls({
      transport: {
        read: transport.read,
        write: async bytes => {
          clientHello ??= bytes;
          await transport.write(bytes);
        },
      },
      serverName: host,
      trustAnchors: anchors.source,
      validationTime: new Date(),
      validator: YOZZ_VALIDATOR,
    });

    if (!result.ok) {
      failures += 1;
      console.log(`FAIL  ${host.padEnd(22)} ${describeFailure(result.reason)}`);
      continue;
    }

    const greeting = await readGreeting(result.connection);
    await result.connection.close();
    if (!greeting.ok) {
      failures += 1;
      console.log(`FAIL  ${host.padEnd(22)} handshake ok, ${greeting.why}`);
      continue;
    }

    const hello = clientHello === undefined ? '?' : `${clientHello.length - 5}B`;
    const retry = result.isHelloRetryRequested ? ' (HelloRetryRequest)' : '';
    console.log(
      `ok    ${host.padEnd(22)} hello=${hello.padEnd(5)} ${result.negotiatedGroup} / ${result.peerSignatureScheme}${retry}`,
    );
    console.log(`      ${greeting.line.slice(0, 74)}`);
    // First use, against the real thing. Nothing here stores it — the point is
    // that a pin is derivable from a live mail leaf, and that re-running this
    // prints the same one until the host actually rotates its key.
    console.log(`      pin=${result.peerPublicKeyPin ?? '(none)'}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL  ${host.padEnd(22)} ${errorText(error)}`);
  } finally {
    if (socket !== undefined) await endGracefully(socket);
  }
}

console.log(`\n${targets.length - failures}/${targets.length} hosts`);
process.exit(failures === 0 ? 0 : 1);
