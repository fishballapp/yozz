import type { ByteDuplex } from '@yozz.app/tls';
import { getApiBaseUrl } from '../vault/api-base-url';

/** Only `refused` exists today: every pre-upgrade HTTP rejection and a dead relay look the same to the browser. */
export type RelayErrorKind = 'refused';

export class RelayError extends Error {
  readonly kind: RelayErrorKind;

  constructor(kind: RelayErrorKind, message?: string) {
    super(message ?? `Relay connection ${kind}`);
    this.name = 'RelayError';
    this.kind = kind;
  }
}

export type RelayTransport = ByteDuplex & {
  /** Settles once the relay has written everything sent so far to TCP; rejects if that can no longer be known. */
  readonly flush: () => Promise<void>;
  readonly close: () => void;
};

/** Unacknowledged bytes allowed in flight, well inside the relay's 1 MiB `MAX_QUEUED_BYTES`. */
const WRITE_WINDOW_BYTES = 512 * 1024;
/** A wait for an acknowledgement that sees none for this long ends the connection. */
const ACK_STALL_MS = 60 * 1000;

/**
 * `signal` closes the WebSocket at once, opening or open: what waits on it then ends. `onProgress` is
 * told of every acknowledgement, the only sign that a long paced write is still moving.
 */
export const openRelayTransport = (
  host: string,
  port: 993 | 465,
  signal?: AbortSignal,
  onProgress?: () => void,
): Promise<RelayTransport> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new RelayError('refused', 'Cancelled before the connection was opened'));
      return;
    }
    const base = getApiBaseUrl()
      .replace(/^https:\/\//, 'wss://')
      .replace(/^http:\/\//, 'ws://');
    const url = `${base.replace(/\/$/, '')}/api/v1/relay?host=${encodeURIComponent(host)}&port=${port}`;

    const socket = new WebSocket(url);
    socket.binaryType = 'arraybuffer';

    let hasOpened = false;
    let isEnded = false;
    const chunks: Uint8Array[] = [];
    let waiter: ((chunk: Uint8Array | null) => void) | null = null;
    let sentBytes = 0;
    let ackedBytes = 0;
    const ackWaiters: PromiseWithResolvers<void>[] = [];
    let ackStall: ReturnType<typeof setTimeout> | undefined;

    const deliver = (chunk: Uint8Array | null): void => {
      const pending = waiter;
      if (pending === null) return;
      waiter = null;
      pending(chunk);
    };

    const end = (reason = 'Relay connection closed') => {
      if (isEnded) return;
      isEnded = true;
      socket.close();
      clearTimeout(ackStall);
      deliver(null);
      for (const ack of ackWaiters.splice(0)) ack.reject(new Error(reason));
    };

    const waitForAck = (): Promise<void> => {
      if (isEnded) return Promise.reject(new Error('Relay connection closed'));
      ackStall ??= setTimeout(() => end('Relay stopped acknowledging writes'), ACK_STALL_MS);
      const ack = Promise.withResolvers<void>();
      ackWaiters.push(ack);
      return ack.promise;
    };

    const onAck = (text: string) => {
      // The relay cannot have written more than was sent: this is not one of its acknowledgements.
      if (!/^\d+$/.test(text) || Number(text) > sentBytes) {
        end();
        return;
      }
      ackedBytes = Number(text);
      clearTimeout(ackStall);
      ackStall = undefined;
      for (const ack of ackWaiters.splice(0)) ack.resolve();
      onProgress?.();
    };

    const cleanupOpenListeners = () => {
      socket.removeEventListener('open', onOpen);
      socket.removeEventListener('error', onError);
      socket.removeEventListener('close', onClose);
    };

    const onOpen = () => {
      hasOpened = true;
      cleanupOpenListeners();

      socket.addEventListener('message', event => {
        // Here and not through `read`: SMTP reads nothing until it has finished writing.
        if (typeof event.data === 'string') {
          onAck(event.data);
          return;
        }
        if (!(event.data instanceof ArrayBuffer)) {
          end();
          return;
        }
        const chunk = new Uint8Array(event.data);
        if (waiter !== null) {
          deliver(chunk);
          return;
        }
        chunks.push(chunk);
      });

      socket.addEventListener('close', () => end());
      socket.addEventListener('error', () => end());

      const transport: RelayTransport = {
        read: () =>
          new Promise(res => {
            const buffered = chunks.shift();
            if (buffered !== undefined) {
              res(buffered);
              return;
            }
            if (isEnded) {
              res(null);
              return;
            }
            waiter = res;
          }),
        write: async bytes => {
          const copy = bytes.slice();
          while (sentBytes - ackedBytes >= WRITE_WINDOW_BYTES) await waitForAck();
          // `send` on a closing socket drops the bytes without a word.
          if (isEnded || socket.readyState !== WebSocket.OPEN) {
            throw new Error('Relay connection closed');
          }
          sentBytes += copy.byteLength;
          socket.send(copy.buffer);
        },
        flush: async () => {
          const target = sentBytes;
          while (ackedBytes < target) await waitForAck();
        },
        close: () => end(),
      };

      resolve(transport);
    };

    const onError = () => {
      if (!hasOpened) {
        cleanupOpenListeners();
        reject(new RelayError('refused', 'WebSocket error before connection established'));
      }
    };

    const onClose = () => {
      if (!hasOpened) {
        cleanupOpenListeners();
        reject(new RelayError('refused', 'WebSocket closed before connection established'));
      }
    };

    socket.addEventListener('open', onOpen);
    socket.addEventListener('error', onError);
    socket.addEventListener('close', onClose);
    signal?.addEventListener(
      'abort',
      () => {
        if (hasOpened) {
          end();
          return;
        }
        cleanupOpenListeners();
        socket.close();
        reject(new RelayError('refused', 'Cancelled before the connection was opened'));
      },
      { once: true },
    );
  });
