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

export type RelayTransport = ByteDuplex & { readonly close: () => void };

export const openRelayTransport = (host: string, port: 993 | 465): Promise<RelayTransport> =>
  new Promise((resolve, reject) => {
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

    const deliver = (chunk: Uint8Array | null): void => {
      const pending = waiter;
      if (pending === null) return;
      waiter = null;
      pending(chunk);
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
        if (typeof event.data !== 'object' || !(event.data instanceof ArrayBuffer)) {
          isEnded = true;
          socket.close();
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

      const onEnd = () => {
        isEnded = true;
        deliver(null);
      };

      socket.addEventListener('close', onEnd);
      socket.addEventListener('error', onEnd);

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
          socket.send(copy.buffer);
        },
        close: () => {
          isEnded = true;
          socket.close();
          deliver(null);
        },
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
  });
