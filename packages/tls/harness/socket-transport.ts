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

/** How long the peer has to stop writing before we take it as done. */
const LINGER_QUIET_MS = 250;
/** The longest a close waits for that, whatever the peer does. */
const LINGER_MAX_MS = 2_000;

/**
 * Drain, flush, half-close, then linger. A socket closed with unread bytes in its receive buffer
 * answers the peer with a RST, and so does one closed while the peer is still writing, which is
 * what exiting the process does: either fails the peer's next write before it reads the alert we
 * sent (BoGo: `write: broken pipe` where `remote error: bad record MAC` was expected). So after
 * our FIN the socket goes on draining until the peer closes back or has been quiet for
 * LINGER_QUIET_MS, the lingering close web servers do. It cannot simply wait for the peer's close:
 * BoGo's runner waits for the shim to exit before it closes. The flush is not timed out, since
 * only an alert or close_notify is buffered here.
 */
export const endGracefully = async (socket: Socket): Promise<void> => {
  if (socket.destroyed) return;
  const { promise: isDone, resolve } = Promise.withResolvers<void>();
  const cap = setTimeout(resolve, LINGER_MAX_MS);
  let quiet: ReturnType<typeof setTimeout> | undefined;
  const restartQuiet = () => {
    clearTimeout(quiet);
    quiet = setTimeout(resolve, LINGER_QUIET_MS);
  };
  socket.on('data', restartQuiet);
  for (const event of ['end', 'close', 'error'] as const) socket.once(event, () => resolve());
  socket.resume();
  socket.end(restartQuiet);
  try {
    await isDone;
  } finally {
    clearTimeout(cap);
    clearTimeout(quiet);
    socket.off('data', restartQuiet);
  }
};
