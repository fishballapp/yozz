/**
 * A `ByteDuplex` over a real `node:net` socket.
 *
 * This is the second of the two transports the seam exists for — the relay
 * socket in the browser, and this one in tests. It is a permanent rig rather
 * than a debugging trick: a direct socket is the control that proved the bridge
 * innocent twice during the relay spike, and it is what lets the client meet a
 * real TLS server with nothing of ours in between.
 */

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
  // A socket that errors is a socket that ended. The record layer decides
  // whether that is a clean close or a truncation, which is its job and not
  // this file's.
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
 * Close so the peer can still finish writing, and can still READ what we wrote.
 *
 * `destroy()` is the wrong tool and BoGo caught it. Closing a socket that still
 * has unread bytes in its receive buffer makes the kernel send a RST rather
 * than a FIN, and a RST fails the peer's very next write with `broken pipe`. A
 * peer that reports a failed write never gets as far as reporting the alert it
 * was about to read, so a correct refusal reads as a broken connection.
 *
 * **Not "the RST discards the alert"**, which is the tempting version and is
 * not what the test measured: under `destroy()` the peer still received the
 * bytes it had already consumed. The write is the half that reliably breaks.
 *
 * `AppDataBeforeTLS13KeyChange` is exactly that shape: the server keeps writing
 * its flight after the record we refuse. It passed on a laptop and failed on a
 * two-vCPU runner, where the flight was still going out when we closed — which
 * is the signature of a race rather than of a disagreement.
 *
 * So: drain what is still arriving, flush what we wrote, and half-close. The
 * peer keeps a writable socket and reads our alert in order, ahead of the FIN.
 *
 * **It does NOT wait for the peer to close back**, which was the first attempt
 * and cost 37 seconds of a 15-second board: BoGo's runner waits for the shim to
 * EXIT before closing its side, so 214 of 296 connections sat out the full
 * grace. Waiting on a peer that is waiting on you is not patience.
 *
 * No timeout on the flush either. Everything still buffered at this point is an
 * alert or a close_notify — a handful of bytes, orders under any send buffer —
 * so `end` cannot block on a peer that has stopped reading.
 */
export const endGracefully = (socket: Socket): Promise<void> =>
  new Promise(resolve => {
    socket.resume();
    socket.end(() => resolve());
  });
