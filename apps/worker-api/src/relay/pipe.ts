export const WS_CLOSE_NORMAL = 1000;
export const WS_CLOSE_UNSUPPORTED = 1003;
export const WS_CLOSE_TOO_LARGE = 1009;
export const WS_CLOSE_INTERNAL_ERROR = 1011;

export const MAX_QUEUED_BYTES = 1024 * 1024;

type RelayTargetInfo = { readonly hostname: string; readonly port: number };

/** A binary frame arrives as a `Blob` on the server half, and `new Uint8Array(blob)` is silently zero bytes. */
const toBytes = async (data: unknown): Promise<Uint8Array | null> => {
  if (data instanceof Blob) return new Uint8Array(await data.arrayBuffer());
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  return null;
};

export const pipeSocket = (
  server: WebSocket,
  socket: Socket,
  target: RelayTargetInfo,
  ctx: { waitUntil(p: Promise<unknown>): void },
): void => {
  const reader = socket.readable.getReader();
  const writer = socket.writable.getWriter();

  let isWsClosed = false;
  let isWriterEnded = false;
  let queuedBytes = 0;
  let writeChain: Promise<void> = Promise.resolve();

  const log = (reason: string, error?: unknown) => {
    // biome-ignore lint/suspicious/noConsole: the relay's only diagnostics channel
    console.error(
      JSON.stringify({
        event: 'relay',
        hostname: target.hostname,
        port: target.port,
        reason,
        ...(error === undefined
          ? {}
          : { error: error instanceof Error ? error.message : String(error) }),
      }),
    );
  };

  const closeWs = (code: number, reason: string) => {
    if (isWsClosed) return;
    isWsClosed = true;
    try {
      server.close(code, reason);
    } catch {
      // already closed by the peer
    }
  };

  /** FIN, once everything queued has been written. */
  const endWriter = () => {
    if (isWriterEnded) return;
    isWriterEnded = true;
    writeChain = writeChain
      .then(() => writer.close())
      .catch(() => {
        // the socket is already gone; the read loop reports it
      });
  };

  const abort = (code: number, reason: string) => {
    log(reason);
    closeWs(code, reason);
    isWriterEnded = true;
    void writer.abort(new Error(reason)).catch(() => {});
    void socket.close().catch(() => {});
  };

  server.addEventListener('message', event => {
    if (isWsClosed || isWriterEnded) return;
    if (typeof event.data === 'string') {
      abort(WS_CLOSE_UNSUPPORTED, 'string frame on a binary relay');
      return;
    }
    const size =
      event.data instanceof Blob ? event.data.size : (event.data as ArrayBufferLike).byteLength;
    if (typeof size !== 'number') {
      abort(WS_CLOSE_UNSUPPORTED, 'unsupported frame type');
      return;
    }
    if (queuedBytes + size > MAX_QUEUED_BYTES) {
      abort(WS_CLOSE_TOO_LARGE, 'WS->TCP queue exceeded MAX_QUEUED_BYTES');
      return;
    }
    queuedBytes += size;
    const frame = event.data;
    writeChain = writeChain
      .then(async () => {
        const bytes = await toBytes(frame);
        if (bytes === null) throw new Error('unsupported frame type');
        await writer.write(bytes);
      })
      .catch(error => {
        if (isWriterEnded) return;
        log('TCP write failed', error);
        abort(WS_CLOSE_INTERNAL_ERROR, 'TCP write failed');
      })
      .finally(() => {
        queuedBytes -= size;
      });
  });

  // FIN our write side and let the read loop drain: closing with bytes unread sends a RST.
  const onWsEnd = () => {
    isWsClosed = true;
    endWriter();
  };
  server.addEventListener('close', onWsEnd);
  server.addEventListener('error', onWsEnd);

  const pump = async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        // `server.send` has no backpressure signal; the ceiling is the runtime's outbound buffer.
        if (!isWsClosed) server.send(value);
      }
      endWriter();
      await writeChain;
      closeWs(WS_CLOSE_NORMAL, 'peer closed');
    } catch (error) {
      log('TCP read failed', error);
      closeWs(WS_CLOSE_INTERNAL_ERROR, 'TCP read failed');
    } finally {
      await socket.close().catch(() => {});
    }
  };

  ctx.waitUntil(pump());
};
