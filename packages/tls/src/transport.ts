export type ByteDuplex = {
  readonly read: () => Promise<Uint8Array | null>;
  readonly write: (bytes: Uint8Array) => Promise<void>;
};

export type MemoryDuplexPair = {
  readonly client: ByteDuplex;
  readonly server: ByteDuplex;
  readonly close: () => void;
};

type QueueEntry = { readonly kind: 'chunk'; readonly chunk: Uint8Array } | { readonly kind: 'eof' };

class PipeEndpoint implements ByteDuplex {
  private readonly queue: QueueEntry[] = [];
  private pendingRead: ((entry: QueueEntry) => void) | null = null;
  private other: PipeEndpoint | null = null;

  setOther(other: PipeEndpoint): void {
    this.other = other;
  }

  read = async (): Promise<Uint8Array | null> => {
    const entry = this.queue.shift();
    if (entry !== undefined) {
      return entry.kind === 'chunk' ? entry.chunk : null;
    }

    const next = await new Promise<QueueEntry>(resolve => {
      this.pendingRead = resolve;
    });

    return next.kind === 'chunk' ? next.chunk : null;
  };

  write = async (bytes: Uint8Array): Promise<void> => {
    if (this.other === null) throw new Error('Pipe not connected');
    this.other.receive({ kind: 'chunk', chunk: new Uint8Array(bytes) });
  };

  receive = (entry: QueueEntry): void => {
    if (this.pendingRead !== null) {
      const resolve = this.pendingRead;
      this.pendingRead = null;
      resolve(entry);
    } else {
      this.queue.push(entry);
    }
  };

  close = (): void => {
    if (this.other !== null) {
      this.other.receive({ kind: 'eof' });
    }
  };
}

export const createMemoryDuplex = (): MemoryDuplexPair => {
  const clientEndpoint = new PipeEndpoint();
  const serverEndpoint = new PipeEndpoint();

  clientEndpoint.setOther(serverEndpoint);
  serverEndpoint.setOther(clientEndpoint);

  return {
    client: clientEndpoint,
    server: serverEndpoint,
    close: () => {
      clientEndpoint.close();
      serverEndpoint.close();
    },
  };
};
