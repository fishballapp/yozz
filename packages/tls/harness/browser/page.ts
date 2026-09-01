/**
 * The TLS client on the engine's own WebCrypto, over a WebSocket byte pipe, against a real mail
 * server. `ROOT_BUNDLE` is the only trust store a browser has. Exposed on `window` so `run.ts`
 * decides when to run and gets the results as a return value.
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
  /** This engine's SPKI pin; the runner compares it across engines. */
  readonly pin: string | null;
};

/**
 * A `ByteDuplex` over a browser WebSocket. `binaryType` must be set before anything is read:
 * the default is `"blob"`, and `new Uint8Array(blob)` returns zero bytes without throwing.
 */
type BridgeTransport = ByteDuplex & {
  /** A diagnostic string the bridge wrote in band, if any. */
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
    // An in-band text frame corrupts the stream, so it ends the stream instead of being thrown:
    // a throw inside a listener escapes as a `pageerror` while `startTls` stays parked on `read()`.
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
      // `bytes` may be a view onto the record layer's own buffer, and `send` is asynchronous.
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
  // Opened inside the try so a dead bridge fails one host, not the batch.
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

    // The greeting fails the host: only it proves application data decrypts.
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

/** Serial: concurrent handshakes would measure the bridge's multiplexing as much as the engine. */
window.yozzHandshake = async (endpoint, hosts, isRelay) => {
  const results: HostResult[] = [];
  for (const host of hosts) results.push(await handshake(endpoint, host, isRelay));
  return results;
};
