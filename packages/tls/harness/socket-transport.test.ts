/**
 * A peer still writing when we close must not have its write fail. Under `destroy()` the peer
 * still received our parting bytes; what a RST breaks is the peer's write, which is BoGo's
 * `write: broken pipe` where `bad record MAC` was expected. The `destroy` case is the control.
 */
import { type AddressInfo, connect, createServer, type Server, type Socket } from 'node:net';
import { afterEach, expect, test } from 'vitest';
import { endGracefully } from './socket-transport.ts';

const UNREAD = Uint8Array.from([1, 2, 3, 4]);
/** The alert, in the real shape. */
const LAST_WORD = Uint8Array.from([0x15, 0x03, 0x03]);

/**
 * Waiting on the client's `data` event would put the stream in flowing mode and empty the kernel
 * buffer, which is the condition under test. 50ms is three orders over loopback arrival.
 */
const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 50));

const addressOf = (server: Server): AddressInfo => {
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error(`expected a TCP address, got ${JSON.stringify(address)}`);
  }
  return address;
};

let open: Server | undefined;
afterEach(() => open?.close());

type Aftermath = {
  /** The error code the peer's write failed with, or `'landed'`. */
  readonly write: string;
  /** Asserted on the graceful side only; `destroy()` was measured delivering them too. */
  readonly heardLastWord: boolean;
};

/** The client never reads, so `UNREAD` sits in its receive buffer when it closes. */
const peerWriteAfterClose = async (
  close: (socket: Socket) => Promise<void>,
): Promise<Aftermath> => {
  // Node auto-ends its side on a FIN by default; BoGo's peer is Go, and Go keeps writing.
  const server = createServer({ allowHalfOpen: true });
  open = server;
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = addressOf(server);

  const accepted = new Promise<Socket>(resolve => server.once('connection', resolve));
  const client = await new Promise<Socket>(resolve => {
    const socket = connect({ port, host: '127.0.0.1' }, () => resolve(socket));
  });
  const peer = await accepted;

  peer.write(UNREAD);
  await settle();

  const heard: number[] = [];
  peer.on('data', chunk => heard.push(...chunk));
  client.write(LAST_WORD);
  await close(client);
  await settle();

  // The first write after a reset can still land in the send buffer and report success.
  const errors: string[] = [];
  peer.on('error', (error: NodeJS.ErrnoException) => errors.push(error.code ?? error.message));
  peer.write(UNREAD);
  await settle();
  peer.write(UNREAD);
  await settle();
  const failure = errors[0] ?? 'landed';
  const heardLastWord = heard.length >= LAST_WORD.length;

  peer.destroy();
  client.destroy();
  return { write: failure, heardLastWord };
};

test('ending gracefully leaves the peer able to write, and to read our last word', async () => {
  const after = await peerWriteAfterClose(endGracefully);
  expect(after.write).toBe('landed');
  expect(after.heardLastWord).toBe(true);
});

test("destroy() is what breaks the peer's write — the behaviour endGracefully replaced", async () => {
  const after = await peerWriteAfterClose(async socket => {
    socket.destroy();
  });
  expect(after.write).not.toBe('landed');
  expect(['EPIPE', 'ECONNRESET']).toContain(after.write);
});
