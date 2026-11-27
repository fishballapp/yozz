import { createCipheriv, createDecipheriv } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { RFC_8448_TRACES, type Rfc8448Step, type Rfc8448Trace } from '../vectors/rfc8448.ts';
import { concat } from './bytes.ts';
import { trafficKeys } from './key-schedule.ts';
import {
  type AeadRecordEvent,
  buildNonce,
  MAX_RECORD_PLAINTEXT,
  type OpenRecordResult,
  openAead,
  openPlain,
  openTls12Aead,
  RecordReader,
  sealAead,
  sealPlain,
  sealTls12Aead,
  setAeadObserver,
} from './record.ts';
import type { ContentType } from './wire.ts';

type RecordStepInfo = {
  readonly traceSection: string;
  readonly traceTitle: string;
  readonly stepIndex: number;
  readonly actor: 'client' | 'server';
  readonly title: string;
  readonly type: ContentType;
  readonly isEncrypted: boolean;
  readonly payload: Uint8Array;
  readonly completeRecord: Uint8Array;
  readonly key?: Uint8Array;
  readonly iv?: Uint8Array;
  readonly seq: bigint;
  readonly legacyVersion?: number;
};

const inferContentType = (title: string): ContentType => {
  const lower = title.toLowerCase();
  if (lower.includes('changecipherspec') || lower.includes('change_cipher_spec')) {
    return 'change_cipher_spec';
  }
  if (lower.includes('alert')) return 'alert';
  if (lower.includes('application_data') || lower.includes('early application data')) {
    return 'application_data';
  }
  return 'handshake';
};

const bytesOf = (step: Rfc8448Step, label: string): Uint8Array | undefined =>
  step.fields.find(field => field.label === label)?.bytes;

const collectRecordSteps = (trace: Rfc8448Trace): readonly RecordStepInfo[] => {
  const result: RecordStepInfo[] = [];

  type TrafficKeyPair = { key: Uint8Array; iv: Uint8Array };

  let serverHandshakeReadKeys: TrafficKeyPair | undefined;
  let serverAppReadKeys: TrafficKeyPair | undefined;
  let clientHandshakeReadKeys: TrafficKeyPair | undefined;
  let clientAppReadKeys: TrafficKeyPair | undefined;

  type ActorState = {
    key: Uint8Array | undefined;
    iv: Uint8Array | undefined;
    seq: bigint;
  };

  const states: Record<'client' | 'server', ActorState> = {
    client: { key: undefined, iv: undefined, seq: 0n },
    server: { key: undefined, iv: undefined, seq: 0n },
  };

  for (const [stepIndex, step] of trace.steps.entries()) {
    if (step.title.startsWith('derive read traffic keys for handshake data')) {
      const key = bytesOf(step, 'key expanded');
      const iv = bytesOf(step, 'iv expanded');
      if (key !== undefined && iv !== undefined) {
        if (step.actor === 'server') {
          serverHandshakeReadKeys = { key, iv };
        } else {
          clientHandshakeReadKeys = { key, iv };
        }
      }
      continue;
    }

    if (step.title.startsWith('derive read traffic keys for application data')) {
      const key = bytesOf(step, 'key expanded');
      const iv = bytesOf(step, 'iv expanded');
      if (key !== undefined && iv !== undefined) {
        if (step.actor === 'server') {
          serverAppReadKeys = { key, iv };
        } else {
          clientAppReadKeys = { key, iv };
        }
      }
      continue;
    }

    if (step.title.startsWith('derive write traffic keys')) {
      let key = bytesOf(step, 'key expanded');
      let iv = bytesOf(step, 'iv expanded');

      if (key === undefined || iv === undefined) {
        if (step.title.includes('handshake data')) {
          const ref = step.actor === 'client' ? serverHandshakeReadKeys : clientHandshakeReadKeys;
          key = ref?.key;
          iv = ref?.iv;
        } else if (step.title.includes('application data')) {
          const ref = step.actor === 'client' ? serverAppReadKeys : clientAppReadKeys;
          key = ref?.key;
          iv = ref?.iv;
        }
      }

      if (key !== undefined && iv !== undefined) {
        states[step.actor] = { key, iv, seq: 0n };
      }
      continue;
    }

    if (step.title.includes('send') && step.title.includes('record')) {
      const payload = bytesOf(step, 'payload');
      const completeRecord = bytesOf(step, 'complete record');
      if (payload === undefined || completeRecord === undefined) continue;

      const type = inferContentType(step.title);
      const isEncrypted = completeRecord[0] === 0x17;
      const state = states[step.actor];

      const legacyVersion =
        !isEncrypted && completeRecord.length >= 3
          ? (completeRecord[1]! << 8) | completeRecord[2]!
          : undefined;

      result.push({
        traceSection: trace.section,
        traceTitle: trace.title,
        stepIndex,
        actor: step.actor,
        title: step.title,
        type,
        isEncrypted,
        payload,
        completeRecord,
        key: state.key,
        iv: state.iv,
        seq: state.seq,
        legacyVersion,
      });

      if (isEncrypted) {
        state.seq += 1n;
      }
    }
  }

  return result;
};

describe('Stage 2: Record layer against RFC 8448', () => {
  const allRecordSteps = RFC_8448_TRACES.flatMap(collectRecordSteps);

  it('collects exactly 41 send record pairs across all 5 traces', () => {
    expect(allRecordSteps.length).toBe(41);
  });

  for (const item of allRecordSteps) {
    const name = `§${item.traceSection} [${item.stepIndex}] {${item.actor}} ${item.title} (seq=${item.seq})`;

    it(`open: ${name}`, async () => {
      let openResult: OpenRecordResult;
      if (item.isEncrypted) {
        expect(item.key).toBeDefined();
        expect(item.iv).toBeDefined();
        openResult = await openAead(item.key!, item.iv!, item.seq, item.completeRecord);
      } else {
        openResult = openPlain(item.completeRecord);
      }

      expect(openResult).toEqual({
        ok: true,
        type: item.type,
        payload: item.payload,
      });
    });

    it(`seal: ${name}`, async () => {
      let sealed: Uint8Array;
      if (item.isEncrypted) {
        expect(item.key).toBeDefined();
        expect(item.iv).toBeDefined();
        sealed = await sealAead(item.key!, item.iv!, item.seq, item.type, item.payload, 0);
      } else {
        sealed = sealPlain(item.type, item.payload, item.legacyVersion);
      }

      expect(sealed).toEqual(item.completeRecord);
    });
  }

  describe('parameterized checks and invariants', () => {
    it('roundtrips under TLS_AES_256_GCM_SHA384 (AES-256-GCM)', async () => {
      const secret = new Uint8Array(48);
      secret.fill(0x42);
      const keys = await trafficKeys('TLS_AES_256_GCM_SHA384', secret);
      expect(keys.key.length).toBe(32);
      expect(keys.iv.length).toBe(12);

      const payload = new Uint8Array(50);
      payload.fill(0xaa);

      const sealed = await sealAead(keys.key, keys.iv, 0n, 'application_data', payload, 0);
      expect(sealed.length).toBe(5 + 50 + 1 + 16);

      const opened = await openAead(keys.key, keys.iv, 0n, sealed);
      expect(opened).toEqual({
        ok: true,
        type: 'application_data',
        payload,
      });
    });

    it('roundtrips with various padding zero lengths (0, 1, 15)', async () => {
      const key = new Uint8Array(16);
      key.fill(0x11);
      const iv = new Uint8Array(12);
      iv.fill(0x22);
      const payload = new TextEncoder().encode('Hello, world!');

      for (const padding of [0, 1, 15]) {
        const sealed = await sealAead(key, iv, 1n, 'application_data', payload, padding);
        expect(sealed.length).toBe(5 + payload.length + 1 + padding + 16);

        const opened = await openAead(key, iv, 1n, sealed);
        expect(opened).toEqual({
          ok: true,
          type: 'application_data',
          payload,
        });
      }
    });

    it('refuses oversized payloads with record_overflow', async () => {
      const key = new Uint8Array(16);
      const iv = new Uint8Array(12);
      const oversizedPayload = new Uint8Array(16384 + 1);

      expect(() => sealPlain('handshake', oversizedPayload)).toThrow('record_overflow');
      await expect(sealAead(key, iv, 0n, 'handshake', oversizedPayload)).rejects.toThrow(
        'record_overflow',
      );
    });

    it('refuses ciphertext length field > 2^14+256 before AEAD', async () => {
      const key = new Uint8Array(16);
      const iv = new Uint8Array(12);
      // Header with length 16384 + 257 = 16641 = 0x4101
      const header = Uint8Array.of(0x17, 0x03, 0x03, 0x41, 0x01);
      const dummyRecord = new Uint8Array(5 + 16641);
      dummyRecord.set(header);

      const result = await openAead(key, iv, 0n, dummyRecord);
      expect(result).toEqual({
        ok: false,
        description: 'record_overflow',
      });
    });

    // `sealAead` will not build these, so the inner plaintext is encrypted directly.
    const sealRawInner = async (
      key: Uint8Array,
      iv: Uint8Array,
      seq: bigint,
      inner: Uint8Array,
    ): Promise<Uint8Array> => {
      const cryptoKey = await crypto.subtle.importKey(
        'raw',
        new Uint8Array(key),
        { name: 'AES-GCM' },
        false,
        ['encrypt'],
      );
      const length = inner.length + 16;
      const header = Uint8Array.of(0x17, 0x03, 0x03, (length >> 8) & 0xff, length & 0xff);
      const ciphertext = new Uint8Array(
        await crypto.subtle.encrypt(
          {
            name: 'AES-GCM',
            iv: new Uint8Array(buildNonce(iv, seq)),
            additionalData: new Uint8Array(header),
            tagLength: 128,
          },
          cryptoKey,
          new Uint8Array(inner),
        ),
      );
      return concat(header, ciphertext);
    };

    const key = new Uint8Array(16);
    const iv = new Uint8Array(12);

    it('2^14 of content plus one byte of padding -> record_overflow', async () => {
      // 2^14 content plus the type byte is the whole allowance (RFC 9846 §5.2); padding does not buy more.
      const atTheCap = concat(new Uint8Array(16384), Uint8Array.of(23));
      expect(await openAead(key, iv, 0n, await sealRawInner(key, iv, 0n, atTheCap))).toMatchObject({
        ok: true,
        type: 'application_data',
      });

      const oneOver = concat(atTheCap, Uint8Array.of(0));
      expect(await openAead(key, iv, 1n, await sealRawInner(key, iv, 1n, oneOver))).toEqual({
        ok: false,
        description: 'record_overflow',
      });
    });

    it('a ciphertext too short to hold a tag -> bad_record_mac', async () => {
      // §5.2: any record the AEAD cannot open is `bad_record_mac`.
      const tooShort = Uint8Array.of(0x17, 0x03, 0x03, 0x00, 0x10, ...new Uint8Array(16));
      expect(await openAead(key, iv, 0n, tooShort)).toEqual({
        ok: false,
        description: 'bad_record_mac',
      });
    });

    it('legacy_record_version is ignored, as §5.1 requires', async () => {
      // §5.1: "This field is deprecated and MUST be ignored for all purposes."
      const record = sealPlain('alert', Uint8Array.of(2, 40));
      const ssl3Framed = new Uint8Array(record);
      ssl3Framed[1] = 0x03;
      ssl3Framed[2] = 0x00;

      expect(openPlain(ssl3Framed)).toEqual({
        ok: true,
        type: 'alert',
        payload: Uint8Array.of(2, 40),
      });

      const reader = new RecordReader();
      reader.feed(ssl3Framed);
      expect(await reader.readRecord()).toEqual({ ok: true, kind: 'record', record: ssl3Framed });
    });

    it('a record that is padding all the way down -> unexpected_message', async () => {
      // §5.4: no non-zero octet means no content type.
      const record = await sealRawInner(key, iv, 0n, new Uint8Array(32));
      expect(await openAead(key, iv, 0n, record)).toEqual({
        ok: false,
        description: 'unexpected_message',
      });
    });

    it('an inner content type we do not recognise -> unexpected_message', async () => {
      const record = await sealRawInner(key, iv, 0n, Uint8Array.of(1, 2, 3, 0xff));
      expect(await openAead(key, iv, 0n, record)).toEqual({
        ok: false,
        description: 'unexpected_message',
      });
    });

    it('returns bad_record_mac or decode_error for every flipped byte in §3 client Finished and alert', async () => {
      const trace3 = RFC_8448_TRACES.find(t => t.section === '3');
      expect(trace3).toBeDefined();
      const steps = collectRecordSteps(trace3!);

      const clientFinished = steps.find(
        s => s.actor === 'client' && s.isEncrypted && s.completeRecord.length === 58,
      );
      expect(clientFinished).toBeDefined();
      expect(clientFinished!.completeRecord.length).toBe(58);

      for (let i = 0; i < clientFinished!.completeRecord.length; i += 1) {
        const tampered = new Uint8Array(clientFinished!.completeRecord);
        tampered[i]! ^= 0x01;
        const res = await openAead(
          clientFinished!.key!,
          clientFinished!.iv!,
          clientFinished!.seq,
          tampered,
        );
        expect(res.ok).toBe(false);
        if (!res.ok) {
          expect(['bad_record_mac', 'decode_error', 'record_overflow']).toContain(res.description);
        }
      }

      const clientAlert = steps.find(
        s => s.actor === 'client' && s.isEncrypted && s.completeRecord.length === 24,
      );
      expect(clientAlert).toBeDefined();
      expect(clientAlert!.completeRecord.length).toBe(24);

      for (let i = 0; i < clientAlert!.completeRecord.length; i += 1) {
        const tampered = new Uint8Array(clientAlert!.completeRecord);
        tampered[i]! ^= 0x01;
        const res = await openAead(clientAlert!.key!, clientAlert!.iv!, clientAlert!.seq, tampered);
        expect(res.ok).toBe(false);
        if (!res.ok) {
          expect(['bad_record_mac', 'decode_error', 'record_overflow']).toContain(res.description);
        }
      }
    });

    it('RecordReader buffers chunks and splits records correctly', async () => {
      const chunks = [
        Uint8Array.of(0x16, 0x03, 0x01),
        Uint8Array.of(0x00, 0x04, 0xaa, 0xbb),
        Uint8Array.of(0xcc, 0xdd, 0x14, 0x03),
        Uint8Array.of(0x03, 0x00, 0x01, 0x01),
      ];
      let chunkIndex = 0;
      const reader = new RecordReader(async () => {
        if (chunkIndex < chunks.length) {
          const chunk = chunks[chunkIndex]!;
          chunkIndex += 1;
          return chunk;
        }
        return null;
      });

      const rec1 = await reader.readRecord();
      expect(rec1).toEqual({
        ok: true,
        kind: 'record',
        record: Uint8Array.of(0x16, 0x03, 0x01, 0x00, 0x04, 0xaa, 0xbb, 0xcc, 0xdd),
      });

      const rec2 = await reader.readRecord();
      expect(rec2).toEqual({
        ok: true,
        kind: 'record',
        record: Uint8Array.of(0x14, 0x03, 0x03, 0x00, 0x01, 0x01),
      });

      const rec3 = await reader.readRecord();
      expect(rec3).toEqual({
        ok: true,
        kind: 'eof',
      });
    });
  });
});

/** RFC 5246 §6.2.3.3 and RFC 5288 §3, restated over `node:crypto` so the reference shares no code with the subject. */
const referenceTls12Record = (
  key: Uint8Array,
  implicitIv: Uint8Array,
  seq: bigint,
  typeCode: number,
  payload: Uint8Array,
): Uint8Array => {
  const explicitNonce = Buffer.alloc(8);
  explicitNonce.writeBigUInt64BE(seq);
  const aad = Buffer.alloc(13);
  aad.writeBigUInt64BE(seq, 0);
  aad.writeUInt8(typeCode, 8);
  aad.writeUInt16BE(0x0303, 9);
  aad.writeUInt16BE(payload.length, 11);
  const cipher = createCipheriv(
    key.length === 16 ? 'aes-128-gcm' : 'aes-256-gcm',
    key,
    Buffer.concat([implicitIv, explicitNonce]),
  );
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(payload), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(5);
  header.writeUInt8(typeCode, 0);
  header.writeUInt16BE(0x0303, 1);
  header.writeUInt16BE(8 + ciphertext.length, 3);
  return Uint8Array.from(Buffer.concat([header, explicitNonce, ciphertext]));
};

describe('TLS 1.2 AES-GCM records', () => {
  for (const keyLength of [16, 32] as const) {
    const cipherName = keyLength === 16 ? 'aes-128-gcm' : 'aes-256-gcm';
    const key = crypto.getRandomValues(new Uint8Array(keyLength));
    const implicitIv = crypto.getRandomValues(new Uint8Array(4));

    describe(cipherName, () => {
      for (const length of [0, 1, 1000, MAX_RECORD_PLAINTEXT]) {
        it(`seals ${length} octets byte-for-byte as node:crypto does, and opens them`, async () => {
          const payload = crypto.getRandomValues(new Uint8Array(length));
          const seq = 0x0102030405060708n;
          const sealed = await sealTls12Aead(key, implicitIv, seq, 'application_data', payload);
          expect(sealed).toEqual(referenceTls12Record(key, implicitIv, seq, 0x17, payload));
          expect(sealed.length).toBe(5 + 8 + length + 16);
          expect(await openTls12Aead(key, implicitIv, seq, sealed)).toEqual({
            ok: true,
            type: 'application_data',
            payload,
          });
        });
      }

      it('opens a record sealed by node:crypto, for every content type', async () => {
        for (const [type, code] of [
          ['change_cipher_spec', 0x14],
          ['alert', 0x15],
          ['handshake', 0x16],
          ['application_data', 0x17],
        ] as const) {
          const payload = crypto.getRandomValues(new Uint8Array(37));
          const record = referenceTls12Record(key, implicitIv, 9n, code, payload);
          expect(await openTls12Aead(key, implicitIv, 9n, record)).toEqual({
            ok: true,
            type,
            payload,
          });
        }
      });

      it('decrypts with node:crypto what it seals', async () => {
        const payload = new TextEncoder().encode('a1 LOGIN user pass');
        const record = await sealTls12Aead(key, implicitIv, 3, 'application_data', payload);
        const decipher = createDecipheriv(
          cipherName,
          key,
          Buffer.concat([implicitIv, record.subarray(5, 13)]),
        );
        const aad = Buffer.alloc(13);
        aad.writeBigUInt64BE(3n, 0);
        aad.writeUInt8(0x17, 8);
        aad.writeUInt16BE(0x0303, 9);
        aad.writeUInt16BE(payload.length, 11);
        decipher.setAAD(aad);
        decipher.setAuthTag(record.subarray(-16));
        expect(
          Uint8Array.from(
            Buffer.concat([decipher.update(record.subarray(13, -16)), decipher.final()]),
          ),
        ).toEqual(payload);
      });
    });
  }

  const key = crypto.getRandomValues(new Uint8Array(16));
  const implicitIv = crypto.getRandomValues(new Uint8Array(4));
  const seal = (seq: bigint | number, payload: Uint8Array) =>
    sealTls12Aead(key, implicitIv, seq, 'handshake', payload);

  it('frames the record as type, 0x0303, length, then the sequence number as explicit nonce', async () => {
    const sealed = await seal(258, new Uint8Array(10));
    expect([...sealed.subarray(0, 5)]).toEqual([0x16, 0x03, 0x03, 0x00, 8 + 10 + 16]);
    expect([...sealed.subarray(5, 13)]).toEqual([0, 0, 0, 0, 0, 0, 1, 2]);
  });

  it('accepts a CryptoKey as well as raw bytes', async () => {
    const cryptoKey = await crypto.subtle.importKey('raw', key, 'AES-GCM', false, [
      'encrypt',
      'decrypt',
    ]);
    const payload = Uint8Array.of(1, 2, 3);
    const sealed = await sealTls12Aead(cryptoKey, implicitIv, 1n, 'alert', payload);
    expect(sealed).toEqual(await sealTls12Aead(key, implicitIv, 1n, 'alert', payload));
    expect(await openTls12Aead(cryptoKey, implicitIv, 1n, sealed)).toEqual({
      ok: true,
      type: 'alert',
      payload,
    });
  });

  it('refuses to seal more than 2^14 octets', async () => {
    await expect(seal(0, new Uint8Array(MAX_RECORD_PLAINTEXT + 1))).rejects.toThrow(
      'record_overflow',
    );
  });

  it('throws on an implicit IV that is not 4 octets, a caller bug', async () => {
    for (const iv of [new Uint8Array(0), new Uint8Array(12)]) {
      await expect(sealTls12Aead(key, iv, 0, 'handshake', new Uint8Array(1))).rejects.toThrow();
      await expect(openTls12Aead(key, iv, 0, await seal(0, new Uint8Array(1)))).rejects.toThrow();
    }
  });

  const open = (record: Uint8Array, seq: bigint | number = 0): Promise<OpenRecordResult> =>
    openTls12Aead(key, implicitIv, seq, record);

  const header = (type: number, version: number, length: number): Uint8Array =>
    Uint8Array.of(type, version >> 8, version & 0xff, length >> 8, length & 0xff);

  it('refuses a ciphertext longer than 2^14 plus the 24-octet AES-GCM expansion', async () => {
    const length = MAX_RECORD_PLAINTEXT + 24 + 1;
    expect(await open(concat(header(0x17, 0x0303, length), new Uint8Array(length)))).toEqual({
      ok: false,
      description: 'record_overflow',
    });
  });

  it('reads a ciphertext shorter than a nonce and a tag as bad_record_mac', async () => {
    for (const length of [0, 8, 23]) {
      expect(await open(concat(header(0x17, 0x0303, length), new Uint8Array(length)))).toEqual({
        ok: false,
        description: 'bad_record_mac',
      });
    }
  });

  it('refuses a malformed header with decode_error', async () => {
    const sealed = await seal(0, new Uint8Array(5));
    const withVersion = (version: number) => {
      const copy = new Uint8Array(sealed);
      copy[1] = version >> 8;
      copy[2] = version & 0xff;
      return copy;
    };
    const withType = new Uint8Array(sealed);
    withType[0] = 0x18;

    for (const record of [
      sealed.subarray(0, 4),
      withVersion(0x0301),
      withVersion(0x0304),
      withType,
      sealed.subarray(0, -1),
      concat(sealed, Uint8Array.of(0)),
    ]) {
      expect(await open(record)).toEqual({ ok: false, description: 'decode_error' });
    }
  });

  it('refuses a tampered explicit nonce, ciphertext, tag or content type with bad_record_mac', async () => {
    const sealed = await seal(7, crypto.getRandomValues(new Uint8Array(32)));
    // The type byte (handshake to alert, still a known type), the nonce, the ciphertext, the tag.
    for (const index of [0, 5, 12, 13, 30, sealed.length - 16, sealed.length - 1]) {
      const tampered = new Uint8Array(sealed);
      tampered[index]! ^= index === 0 ? 0x03 : 0x01;
      expect(await open(tampered, 7)).toEqual({ ok: false, description: 'bad_record_mac' });
    }
  });

  it('binds the sequence number through the additional data, not only the explicit nonce', async () => {
    const sealed = await seal(7, new Uint8Array(16));
    expect(await open(sealed, 6)).toEqual({ ok: false, description: 'bad_record_mac' });
    expect(await open(sealed, 8)).toEqual({ ok: false, description: 'bad_record_mac' });
    expect((await open(sealed, 7)).ok).toBe(true);
  });

  it('reports each seal and open to the AEAD observer with the 12-octet nonce', async () => {
    const events: AeadRecordEvent[] = [];
    setAeadObserver(event => events.push(event));
    try {
      const sealed = await seal(5n, Uint8Array.of(1));
      await open(sealed, 5n);
    } finally {
      setAeadObserver(null);
    }
    const nonce = concat(implicitIv, Uint8Array.of(0, 0, 0, 0, 0, 0, 0, 5));
    expect(events).toEqual([
      { direction: 'seal', key, nonce, seq: 5n, type: 'handshake' },
      { direction: 'open', key, nonce, seq: 5n, type: 'handshake' },
    ]);
  });
});
