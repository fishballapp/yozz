import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openRelayTransport, RelayError } from './transport';

type Listener = (event: { data?: unknown }) => void;

class FakeWebSocket {
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
});
