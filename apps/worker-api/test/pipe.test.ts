import { describe, expect, it, vi } from 'vitest';
import {
  ACK_BATCH_BYTES,
  MAX_QUEUED_BYTES,
  pipeSocket,
  WS_CLOSE_NORMAL,
  WS_CLOSE_TOO_LARGE,
  WS_CLOSE_UNSUPPORTED,
} from '../src/relay/pipe.ts';

/** What the relay writes lands in `received`; what the "mail server" says goes in through `peer`. */
const fakeSocket = () => {
  const toTcp = new TransformStream<Uint8Array, Uint8Array>();
  const fromTcp = new TransformStream<Uint8Array, Uint8Array>();
  let closed = false;
  const socket = {
    readable: fromTcp.readable,
    writable: toTcp.writable,
    closed: Promise.resolve(),
    opened: Promise.resolve({}),
    close: async () => {
      closed = true;
    },
  } as unknown as Socket;
  return {
    socket,
    peer: fromTcp.writable.getWriter(),
    received: toTcp.readable.getReader(),
    isClosed: () => closed,
  };
};

const TARGET = { hostname: 'imap.example.com', port: 993 };
const ctx = { waitUntil: () => {} };

const pipe = () => {
  const tcp = fakeSocket();
  const pair = new WebSocketPair();
  pair[1].accept();
  pipeSocket(pair[1], tcp.socket, TARGET, ctx);
  const client = pair[0];
  client.accept();
  const closeCode = new Promise<number>(resolve =>
    client.addEventListener('close', event => resolve(event.code)),
  );
  const acks: number[] = [];
  client.addEventListener('message', event => {
    if (typeof event.data === 'string') acks.push(Number(event.data));
  });
  return { ...tcp, client, closeCode, acks };
};

const settle = () => new Promise(resolve => setTimeout(resolve, 20));

describe('pipeSocket', () => {
  it('forwards a binary frame to TCP and TCP bytes back to the client', async () => {
    const { client, peer, received } = pipe();
    // Inside the Worker a binary frame arrives as a Blob.
    const fromClient = new Promise<Uint8Array>(resolve =>
      client.addEventListener('message', event => {
        if (typeof event.data === 'string') return;
        void (event.data as Blob).arrayBuffer().then(buffer => resolve(new Uint8Array(buffer)));
      }),
    );
    client.send(new Uint8Array([1, 2, 3]));
    expect((await received.read()).value).toEqual(new Uint8Array([1, 2, 3]));
    await peer.write(new Uint8Array([9]));
    expect(await fromClient).toEqual(new Uint8Array([9]));
  });

  it('closes the client with 1000 once the TCP peer sends FIN', async () => {
    const { peer, closeCode, isClosed } = pipe();
    await peer.close();
    expect(await closeCode).toBe(WS_CLOSE_NORMAL);
    expect(isClosed()).toBe(true);
  });

  it('FINs the TCP write side after the client closes, without aborting it', async () => {
    const { client, received } = pipe();
    client.send(new Uint8Array([7]));
    client.close(1000);
    expect((await received.read()).value).toEqual(new Uint8Array([7]));
    // A clean close reads as `done`; an abort would reject this read.
    expect((await received.read()).done).toBe(true);
  });

  it('refuses a string frame with 1003', async () => {
    const { client, closeCode } = pipe();
    client.send('hello');
    expect(await closeCode).toBe(WS_CLOSE_UNSUPPORTED);
  });

  it('refuses a frame that would overflow the queue with 1009', async () => {
    const { client, closeCode } = pipe();
    client.send(new Uint8Array(MAX_QUEUED_BYTES + 1));
    expect(await closeCode).toBe(WS_CLOSE_TOO_LARGE);
  });

  describe('acknowledgements', () => {
    it('reports a small tail, and only once TCP has taken it', async () => {
      const { client, received, acks } = pipe();
      client.send(new Uint8Array(3));
      await settle();
      expect(acks).toEqual([]);
      await received.read();
      await settle();
      expect(acks).toEqual([3]);
    });

    it('counts cumulatively, and batches while the queue has a backlog', async () => {
      const { client, received, acks } = pipe();
      const frames = 40;
      const size = 16 * 1024;
      for (let i = 0; i < frames; i += 1) client.send(new Uint8Array(size));
      await settle();
      for (let i = 0; i < frames; i += 1) await received.read();
      await settle();
      expect(acks.at(-1)).toBe(frames * size);
      expect(acks.length).toBeLessThanOrEqual((frames * size) / ACK_BATCH_BYTES + 1);
      expect(acks).toEqual(acks.toSorted((a, b) => a - b));
    });

    it('carries a stream far past the queue ceiling when the sender keeps to its window', async () => {
      const { client, received, acks, closeCode } = pipe();
      const size = 16 * 1024;
      const frames = 640; // 10 MiB, ten times the ceiling
      const window = 512 * 1024;
      let isClosed = false;
      void closeCode.then(() => {
        isClosed = true;
      });
      const sender = (async () => {
        for (let i = 0; i < frames; i += 1) {
          while ((i + 1) * size - (acks.at(-1) ?? 0) > window) await settle();
          client.send(new Uint8Array(size).fill(i % 251));
        }
      })();
      for (let i = 0; i < frames; i += 1) {
        const { value } = await received.read();
        expect(value?.[0]).toBe(i % 251);
      }
      await sender;
      await settle();
      expect(acks.at(-1)).toBe(frames * size);
      expect(isClosed).toBe(false);
    }, 60_000);

    /** A pipe whose relay side sends through `send`, as the runtime's own would answer it. */
    const pipeSendingThrough = (send: () => void) => {
      const tcp = fakeSocket();
      const pair = new WebSocketPair();
      pair[1].accept();
      pair[0].accept();
      pair[1].send = send;
      pipeSocket(pair[1], tcp.socket, TARGET, ctx);
      return { ...tcp, client: pair[0] };
    };

    it('sends none into a closed socket, and still drains to the FIN', async () => {
      const send = vi.fn();
      const { client, received } = pipeSendingThrough(send);
      client.send(new Uint8Array(1));
      client.send(new Uint8Array(1));
      client.close(1000);
      await settle(); // the relay has seen the close, with both writes still queued
      await received.read();
      await received.read();
      expect((await received.read()).done).toBe(true);
      expect(send).not.toHaveBeenCalled();
    });

    it('survives a send that throws, without taking it for a TCP failure', async () => {
      const { client, received } = pipeSendingThrough(() => {
        throw new TypeError('send() after close');
      });
      client.send(new Uint8Array(1));
      expect((await received.read()).value).toEqual(new Uint8Array(1));
      await settle();
      client.send(new Uint8Array(2));
      expect((await received.read()).value).toEqual(new Uint8Array(2));
    });
  });
});
