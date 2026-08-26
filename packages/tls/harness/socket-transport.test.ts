/**
 * The one property `endGracefully` exists for: a peer that is still writing when
 * we close must not have its write fail.
 *
 * **What this file measured, and it corrected the first explanation written for
 * it.** The tempting story is that the RST also discards the alert from the
 * peer's receive queue. Under `destroy()` here the peer still received the
 * client's parting bytes — it had already consumed them — so the alert is not
 * what is reliably lost. What is lost is the peer's WRITE, and a peer that
 * reports a failed write never gets as far as reporting the alert it was about
 * to read. That is precisely BoGo's symptom: `write: broken pipe` where
 * `remote error: bad record MAC` was expected.
 *
 * This is a REGRESSION test with a name on it. The shim used `socket.destroy()`
 * and BoGo's `AppDataBeforeTLS13KeyChange` failed on a two-vCPU CI runner while
 * passing on every laptop — the server keeps writing its flight after the
 * record we refuse, and a RST fails that write. The race is what made it
 * invisible locally, so the check below removes the race: it leaves data
 * deliberately unread, which is the condition that turns a close into a RST,
 * and then asks the peer to write.
 *
 * The control is the second case. A test that only proved the fix works would
 * still pass if `endGracefully` quietly became `destroy()` again on some future
 * platform, so `destroy` is asserted to FAIL the peer's write here.
 */
import { type AddressInfo, connect, createServer, type Server, type Socket } from 'node:net';
import { afterEach, expect, test } from 'vitest';
import { endGracefully } from './socket-transport.ts';

const UNREAD = Uint8Array.from([1, 2, 3, 4]);
/** What the client says on its way out — the alert, in the real shape. */
const LAST_WORD = Uint8Array.from([0x15, 0x03, 0x03]);

/**
 * A wall-clock beat, and it is not laziness. The condition under test is bytes
 * sitting UNREAD in the client's receive buffer, and the obvious alternative —
 * waiting for the client's `data` event — destroys it: a `data` listener puts
 * the stream in flowing mode, which reads the kernel buffer into JS and leaves
 * nothing to force a RST. Arrival on loopback is what is being waited for, and
 * 50ms is three orders over it.
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
  /**
   * Whether the peer could still read the client's parting bytes. Asserted on
   * the graceful side only: it is a property worth holding, not a control —
   * `destroy()` was measured delivering them too.
   */
  readonly heardLastWord: boolean;
};

/**
 * What the peer can still do once the client has closed on it.
 *
 * The client never reads, so `UNREAD` is still sitting in its receive buffer
 * when it closes — which is exactly when the kernel picks RST over FIN. It
 * writes `LAST_WORD` first so the read half of the claim is measured rather
 * than assumed.
 */
const peerWriteAfterClose = async (
  close: (socket: Socket) => Promise<void>,
): Promise<Aftermath> => {
  // `allowHalfOpen` models the peer we actually have. Node's default is to
  // auto-end its own side the moment it receives a FIN, which would fail the
  // peer's next write for a Node reason rather than a TCP one — BoGo's peer is
  // Go, and Go keeps writing.
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

  // TWO writes, because one is not enough to see a RST. The first `write` after
  // the reset can still be accepted into the send buffer and report success —
  // the error surfaces on the socket a moment later, and it is the next write
  // that fails. Reporting the first write alone called a reset connection
  // healthy.
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
