/**
 * The browser half of M8, as the browser sees it: our TLS 1.3 client running on
 * whatever WebCrypto the engine happens to ship, over a WebSocket to a byte
 * pipe, against a real mail server.
 *
 * Nothing here is Node. `@yozz.app/tls` and `@yozz.app/x509` import no `node:` module,
 * which is what makes this page possible at all — and `ROOT_BUNDLE` is the
 * whole reason it has to exist: a browser has no `node:tls` root store, so the
 * anchors compiled into the bundle are the ONLY thing that can validate a
 * chain here.
 *
 * `run.ts` drives it. It is exposed on `window` rather than run on load so the
 * driver decides when, and gets the results as a return value instead of
 * scraping the DOM.
 */
import { compileAnchors, ROOT_BUNDLE, YOZZ_VALIDATOR } from '@yozz.app/x509';
import { startTls } from '../../src/handshake.ts';
import type { ByteDuplex } from '../../src/transport.ts';
import { describeFailure, errorText } from '../describe.ts';
import { IMAP_PORT, isReadyGreeting } from '../hosts.ts';

export type HostResult = {
  readonly host: string;
  readonly ok: boolean;
  /** The negotiated group and the scheme the server signed with, or the failure. */
  readonly detail: string;
  readonly greeting: string;
  /**
   * The host's SPKI pin, as THIS engine derived it. The runner compares it
   * across the three, which is the one thing about pinning only this harness can
   * check: a pin learned in one browser and refused in another would alarm a
   * user who changed nothing, and `crypto.subtle.digest` plus `btoa` are engine
   * code the same way P-384 import and RSA-PSS are.
   */
  readonly pin: string | null;
};

/**
 * A `ByteDuplex` over a browser WebSocket. This is the RELAY half of the seam
 * [`socket-transport.ts`](../socket-transport.ts) names — the one the shipped
 * client will actually use, with the direct socket as its control.
 *
 * **`binaryType` is set before anything is read, and that line is the whole
 * trap.** The default is `"blob"`, and the conversion every naive queue reaches
 * for — `new Uint8Array(blob)` — returns ZERO bytes without throwing. The relay
 * spike lost a stage to it from the Worker side, and subtls' own
 * `WebSocketReadQueue` still does the unguarded conversion.
 */
type BridgeTransport = ByteDuplex & {
  /** What the bridge said in band, if it said anything. See below. */
  readonly diagnostic: () => string | null;
};

const webSocketTransport = (socket: WebSocket): BridgeTransport => {
  const chunks: Uint8Array[] = [];
  let isEnded = false;
  let diagnostic: string | null = null;
  let waiter: ((chunk: Uint8Array | null) => void) | null = null;

  const deliver = (chunk: Uint8Array | null): void => {
    const pending = waiter;
    if (pending === null) return;
    waiter = null;
    pending(chunk);
  };

  socket.binaryType = 'arraybuffer';
  socket.addEventListener('message', event => {
    /**
     * A bridge that writes a diagnostic string in band is a bridge that
     * corrupts the stream, so the bytes never reach the record layer. **It is
     * recorded and ends the stream rather than thrown**: a throw inside a
     * listener is not on `handshake`'s stack, so it escapes as a `pageerror`
     * while `startTls` stays parked on `read()` forever — which hangs the whole
     * batch and blames every host it never reached. The spike Worker really
     * does send `[bridge] WRITE FAILED: …` as text.
     */
    if (typeof event.data !== 'object' || !(event.data instanceof ArrayBuffer)) {
      diagnostic = String(event.data);
      isEnded = true;
      deliver(null);
      return;
    }
    const chunk = new Uint8Array(event.data);
    if (waiter !== null) {
      deliver(chunk);
      return;
    }
    chunks.push(chunk);
  });
  for (const event of ['close', 'error'] as const) {
    socket.addEventListener(event, () => {
      isEnded = true;
      deliver(null);
    });
  }

  return {
    diagnostic: () => diagnostic,
    read: () =>
      new Promise(resolve => {
        const buffered = chunks.shift();
        if (buffered !== undefined) {
          resolve(buffered);
          return;
        }
        if (isEnded) {
          resolve(null);
          return;
        }
        waiter = resolve;
      }),
    write: async bytes => {
      // Copy: `bytes` may be a view onto the record layer's own buffer, and
      // `send` is asynchronous with respect to whatever writes into it next.
      socket.send(bytes.slice().buffer);
    },
  };
};

const openBridge = (url: string): Promise<WebSocket> =>
  new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.addEventListener('open', () => resolve(socket));
    socket.addEventListener('error', () => reject(new Error('bridge refused the connection')));
  });

const anchors = compileAnchors(ROOT_BUNDLE);

const failed = (host: string, detail: string): HostResult => ({
  host,
  ok: false,
  detail,
  greeting: '',
  pin: null,
});

const handshake = async (
  endpoint: string,
  host: string,
  isRelay?: boolean,
): Promise<HostResult> => {
  // The bridge is opened INSIDE the try. A dead bridge is one host's failure to
  // report, not a reason to abandon the other eight — the negative control
  // opened it outside, and one refused connection took the whole batch with it.
  let socket: WebSocket | undefined;
  try {
    const url = isRelay
      ? `${endpoint}?host=${host}&port=${IMAP_PORT}`
      : `${endpoint}&target=${host}:${IMAP_PORT}`;
    socket = await openBridge(url);
    const transport = webSocketTransport(socket);
    const result = await startTls({
      transport,
      serverName: host,
      trustAnchors: anchors.source,
      validationTime: new Date(),
      validator: YOZZ_VALIDATOR,
    });
    const said = transport.diagnostic();
    if (said !== null) return failed(host, `bridge said: ${said}`);
    if (!result.ok) return failed(host, describeFailure(result.reason));

    /**
     * The greeting FAILS the host, rather than printing beside a pass. M8 is
     * defined as handshake and greeting, and only the second proves the
     * connection works rather than merely completed — so a regression that
     * completes a handshake and then cannot decrypt the first record has to
     * exit non-zero.
     */
    const greeting = await result.connection.read();
    await result.connection.close();
    if (!greeting.ok)
      return failed(host, `handshake ok, read failed: ${describeFailure(greeting.reason)}`);
    if (greeting.kind !== 'data') return failed(host, 'handshake ok, closed without a greeting');
    const line = new TextDecoder().decode(greeting.bytes).split('\r\n')[0] ?? '';
    if (!isReadyGreeting(line)) {
      return failed(host, `handshake ok, not an IMAP greeting: ${line.slice(0, 60)}`);
    }

    return {
      host,
      ok: true,
      detail: `${result.negotiatedGroup} / ${result.peerSignatureScheme}`,
      greeting: line,
      pin: result.peerPublicKeyPin,
    };
  } catch (error) {
    return failed(host, errorText(error));
  } finally {
    socket?.close();
  }
};

declare global {
  interface Window {
    yozzHandshake: (
      endpoint: string,
      hosts: readonly string[],
      isRelay?: boolean,
    ) => Promise<readonly HostResult[]>;
  }
}

/**
 * Serial, not parallel. Nine concurrent handshakes would measure the bridge's
 * multiplexing as much as the engine's crypto, and a failure would be ambiguous
 * between the two.
 */
window.yozzHandshake = async (endpoint, hosts, isRelay) => {
  const results: HostResult[] = [];
  for (const host of hosts) results.push(await handshake(endpoint, host, isRelay));
  return results;
};
