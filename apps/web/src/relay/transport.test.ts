import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openRelayTransport, RelayError, type RelayTransport } from './transport';

type Listener = (event: { data?: unknown }) => void;

class FakeWebSocket {
  static readonly OPEN = 1;
  static instances: FakeWebSocket[] = [];
  binaryType = 'blob';
  url: string;
  listeners: Record<string, Listener[]> = {};
  sent: ArrayBuffer[] = [];
  readyState = 0; // CONNECTING

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  addEventListener(event: string, listener: Listener) {
    this.listeners[event] = this.listeners[event] ?? [];
    this.listeners[event].push(listener);
  }

  removeEventListener(event: string, listener: Listener) {
    if (this.listeners[event]) {
      this.listeners[event] = this.listeners[event].filter(l => l !== listener);
    }
  }

  send(data: ArrayBuffer) {
    if (this.readyState !== FakeWebSocket.OPEN) return; // a real one drops it without a word
    this.sent.push(data);
  }

  close() {
    this.readyState = 3; // CLOSED
    this.emit('close', {});
  }

  emit(event: string, data: unknown) {
    for (const listener of this.listeners[event] ?? []) {
      listener(data as { data?: unknown });
    }
  }

  simulateOpen() {
    this.readyState = 1; // OPEN
    this.emit('open', {});
  }

  simulateMessage(data: unknown) {
    this.emit('message', { data });
  }

  simulateError() {
    this.emit('error', {});
  }
}

describe('openRelayTransport', () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.stubGlobal('WebSocket', FakeWebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sets binaryType to arraybuffer and resolves on open', async () => {
    const promise = openRelayTransport('imap.example.com', 993);
    const ws = FakeWebSocket.instances[0];
    expect(ws).toBeDefined();
    if (!ws) return;
    expect(ws.binaryType).toBe('arraybuffer');
    expect(ws.url).toContain('host=imap.example.com');
    expect(ws.url).toContain('port=993');

    ws.simulateOpen();
    const transport = await promise;
    expect(transport).toBeDefined();
    expect(typeof transport.read).toBe('function');
    expect(typeof transport.write).toBe('function');
  });

  it('rejects with RelayError on error before open', async () => {
    const promise = openRelayTransport('imap.example.com', 993);
    const ws = FakeWebSocket.instances[0];
    expect(ws).toBeDefined();
    ws?.simulateError();

    await expect(promise).rejects.toThrow(RelayError);
  });

  it('rejects with RelayError on close before open', async () => {
    const promise = openRelayTransport('imap.example.com', 993);
    const ws = FakeWebSocket.instances[0];
    expect(ws).toBeDefined();
    ws?.close();

    await expect(promise).rejects.toThrow(RelayError);
  });

  it('queues binary frames and reads them in order', async () => {
    const promise = openRelayTransport('imap.example.com', 993);
    const ws = FakeWebSocket.instances[0];
    ws?.simulateOpen();
    const transport = await promise;

    const frame1 = new Uint8Array([1, 2, 3]).buffer;
    const frame2 = new Uint8Array([4, 5]).buffer;

    ws?.simulateMessage(frame1);
    ws?.simulateMessage(frame2);

    const chunk1 = await transport.read();
    expect(chunk1).toEqual(new Uint8Array([1, 2, 3]));

    const chunk2 = await transport.read();
    expect(chunk2).toEqual(new Uint8Array([4, 5]));
  });

  it('resolves a pending read with null on close', async () => {
    const promise = openRelayTransport('imap.example.com', 993);
    const ws = FakeWebSocket.instances[0];
    ws?.simulateOpen();
    const transport = await promise;

    const readPromise = transport.read();
    ws?.close();

    const result = await readPromise;
    expect(result).toBeNull();
  });

  it('ends the stream and resolves null when a text frame is received', async () => {
    const promise = openRelayTransport('imap.example.com', 993);
    const ws = FakeWebSocket.instances[0];
    ws?.simulateOpen();
    const transport = await promise;

    const readPromise = transport.read();
    ws?.simulateMessage('corrupt text frame');

    const result = await readPromise;
    expect(result).toBeNull();

    const nextResult = await transport.read();
    expect(nextResult).toBeNull();
  });

  it('write copies bytes before sending', async () => {
    const promise = openRelayTransport('imap.example.com', 993);
    const ws = FakeWebSocket.instances[0];
    ws?.simulateOpen();
    const transport = await promise;

    const source = new Uint8Array([10, 20, 30]);
    await transport.write(source);

    source[0] = 99;

    expect(ws?.sent.length).toBe(1);
    const sentBuffer = ws?.sent[0];
    expect(sentBuffer).toBeDefined();
    if (!sentBuffer) return;
    const sentBytes = new Uint8Array(sentBuffer);
    expect(sentBytes[0]).toBe(10);
    expect(sentBytes[1]).toBe(20);
    expect(sentBytes[2]).toBe(30);
  });

  describe('flow control', () => {
    const RECORD = new Uint8Array(16 * 1024);
    const WINDOW_RECORDS = 32; // 512 KiB

    const open = async (onProgress?: () => void) => {
      const promise = openRelayTransport('smtp.example.com', 465, undefined, onProgress);
      const ws = FakeWebSocket.instances[0];
      if (ws === undefined) throw new Error('no socket was opened');
      ws.simulateOpen();
      return { ws, transport: await promise };
    };

    const fillWindow = async (transport: RelayTransport) => {
      for (let i = 0; i < WINDOW_RECORDS; i += 1) await transport.write(RECORD);
    };

    const isSettled = async (promise: Promise<unknown>) => {
      const pending = Symbol('pending');
      const settled = await Promise.race([
        promise.catch(() => {}),
        new Promise(resolve => setTimeout(resolve, 0, pending)),
      ]);
      return settled !== pending;
    };

    it('holds a write once the window is full, until an acknowledgement frees it', async () => {
      const { ws, transport } = await open();
      await fillWindow(transport);
      const held = transport.write(RECORD);
      expect(await isSettled(held)).toBe(false);
      expect(ws.sent.length).toBe(WINDOW_RECORDS);
      ws.simulateMessage(String(RECORD.length));
      await held;
      expect(ws.sent.length).toBe(WINDOW_RECORDS + 1);
    });

    it('paces a large stream so that no more than the window is ever unacknowledged', async () => {
      const { ws, transport } = await open();
      const records = 640; // 10 MiB
      let acked = 0;
      let peak = 0;
      const sending = (async () => {
        for (let i = 0; i < records; i += 1) await transport.write(RECORD);
      })();
      while (acked < records * RECORD.length) {
        await new Promise(resolve => setTimeout(resolve, 0));
        const sent = ws.sent.length * RECORD.length;
        peak = Math.max(peak, sent - acked);
        // What the relay does: batches a backlog, and reports all of it once it has drained.
        acked = sent;
        ws.simulateMessage(String(acked));
      }
      await sending;
      expect(ws.sent.length).toBe(records);
      expect(peak).toBeLessThanOrEqual(512 * 1024);
    });

    it('takes an acknowledgement without a read, and never as a read', async () => {
      const { ws, transport } = await open();
      await transport.write(RECORD);
      const read = transport.read();
      ws.simulateMessage(String(RECORD.length));
      expect(await isSettled(read)).toBe(false);
      ws.simulateMessage(new Uint8Array([7]).buffer);
      expect(await read).toEqual(new Uint8Array([7]));
    });

    it('tells of every acknowledgement', async () => {
      const onProgress = vi.fn();
      const { ws, transport } = await open(onProgress);
      await transport.write(RECORD);
      ws.simulateMessage('16');
      ws.simulateMessage(String(RECORD.length));
      expect(onProgress).toHaveBeenCalledTimes(2);
    });

    it('flushes once everything sent so far is acknowledged, tail included', async () => {
      const { ws, transport } = await open();
      await transport.flush(); // nothing sent, nothing to wait for
      await transport.write(new Uint8Array(3));
      const flushed = transport.flush();
      ws.simulateMessage('2');
      expect(await isSettled(flushed)).toBe(false);
      ws.simulateMessage('3');
      await flushed;
    });

    it.each([
      ['the socket closes', (ws: FakeWebSocket) => ws.close()],
      ['the socket errors', (ws: FakeWebSocket) => ws.simulateError()],
      ['the caller closes', (_: FakeWebSocket, t: RelayTransport) => t.close()],
    ])('rejects every writer and flush waiting when %s', async (_label, drop) => {
      const { ws, transport } = await open();
      await fillWindow(transport);
      const waiting = [transport.write(RECORD), transport.write(RECORD), transport.flush()];
      const read = transport.read();
      drop(ws, transport);
      for (const outcome of await Promise.allSettled(waiting)) {
        expect(outcome.status).toBe('rejected');
      }
      expect(await read).toBeNull();
      expect(ws.sent.length).toBe(WINDOW_RECORDS);
    });

    it('rejects a waiting writer on abort', async () => {
      const controller = new AbortController();
      const promise = openRelayTransport('smtp.example.com', 465, controller.signal);
      const ws = FakeWebSocket.instances[0];
      ws?.simulateOpen();
      const transport = await promise;
      await fillWindow(transport);
      const held = transport.write(RECORD);
      controller.abort();
      await expect(held).rejects.toThrow('closed');
    });

    it('throws on a write once the socket has closed, or begun to', async () => {
      const closed = await open();
      closed.ws.close();
      await expect(closed.transport.write(RECORD)).rejects.toThrow('closed');

      FakeWebSocket.instances = [];
      const closing = await open();
      closing.ws.readyState = 2; // CLOSING: the close event has not fired yet
      await expect(closing.transport.write(RECORD)).rejects.toThrow('closed');
      expect(closing.ws.sent).toEqual([]);
    });

    it('rejects a flush of bytes the relay never confirmed, but not of bytes it did', async () => {
      const { ws, transport } = await open();
      await transport.write(new Uint8Array(3));
      ws.simulateMessage('3');
      ws.close();
      await transport.flush();

      FakeWebSocket.instances = [];
      const dropped = await open();
      await dropped.transport.write(new Uint8Array(3));
      dropped.ws.close();
      await expect(dropped.transport.flush()).rejects.toThrow('closed');
    });

    it('ends the stream on an acknowledgement of more than was sent', async () => {
      const { ws, transport } = await open();
      const read = transport.read();
      ws.simulateMessage('1');
      expect(await read).toBeNull();
      await expect(transport.write(RECORD)).rejects.toThrow('closed');
    });

    describe('when acknowledgements stop', () => {
      beforeEach(() => {
        vi.useFakeTimers();
      });

      afterEach(() => {
        vi.useRealTimers();
      });

      it('ends the connection after a minute of no progress, not a minute of waiting', async () => {
        const { ws, transport } = await open();
        await transport.write(new Uint8Array(10));
        const flushed = transport.flush();
        const outcome = flushed.catch((error: unknown) => error);
        await vi.advanceTimersByTimeAsync(50_000);
        ws.simulateMessage('5');
        await vi.advanceTimersByTimeAsync(50_000);
        expect(ws.readyState).toBe(FakeWebSocket.OPEN);
        await vi.advanceTimersByTimeAsync(10_000);
        expect(ws.readyState).toBe(3);
        expect(await outcome).toEqual(new Error('Relay stopped acknowledging writes'));
      });

      it('never times out a connection nothing is waiting on', async () => {
        const { ws, transport } = await open();
        await transport.write(new Uint8Array(10));
        await vi.advanceTimersByTimeAsync(10 * 60_000);
        expect(ws.readyState).toBe(FakeWebSocket.OPEN);
      });
    });
  });
});
