/** A `ByteDuplex` over a real `node:net` socket: the control for the relay transport. */

import type { Socket } from 'node:net';
import type { ByteDuplex } from '../src/transport.ts';

type Waiter = (chunk: Uint8Array | null) => void;

export const socketTransport = (socket: Socket): ByteDuplex => {
  const chunks: Uint8Array[] = [];
  let isEnded = false;
  let waiter: Waiter | null = null;

  const deliver = (chunk: Uint8Array | null): void => {
    const pending = waiter;
    if (pending === null) return;
    waiter = null;
    pending(chunk);
  };

  socket.on('data', data => {
    const chunk = new Uint8Array(data);
    if (waiter !== null) {
      deliver(chunk);
      return;
    }
    chunks.push(chunk);
  });
  // A socket that errors has ended; the record layer decides whether that is a truncation.
  for (const event of ['end', 'close', 'error'] as const) {
    socket.on(event, () => {
      isEnded = true;
      deliver(null);
    });
  }

  return {
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
    write: bytes =>
      new Promise((resolve, reject) => {
        socket.write(bytes, error =>
          error === undefined || error === null ? resolve() : reject(error),
        );
      }),
  };
};

/**
 * Drain, flush, half-close. `destroy()` with unread bytes in the receive buffer sends a RST, which
 * fails the peer's next write before it reports the alert it was about to read. Does not wait
 * for the peer to close back (BoGo's runner waits for the shim to exit first) and does not time
 * out the flush (only an alert or close_notify is buffered here).
 */
export const endGracefully = (socket: Socket): Promise<void> =>
  new Promise(resolve => {
    socket.resume();
    socket.end(() => resolve());
  });
