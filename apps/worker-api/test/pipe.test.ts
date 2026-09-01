import { describe, expect, it } from 'vitest';
import {
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
  return { ...tcp, client, closeCode };
};

describe('pipeSocket', () => {
  it('forwards a binary frame to TCP and TCP bytes back to the client', async () => {
    const { client, peer, received } = pipe();
    // Inside the Worker a binary frame arrives as a Blob.
    const fromClient = new Promise<Uint8Array>(resolve =>
      client.addEventListener('message', event => {
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
});
