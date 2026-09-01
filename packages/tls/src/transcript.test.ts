import { describe, expect, it } from 'vitest';
import { RFC_8448_TRACES, type Rfc8448Step } from '../vectors/rfc8448.ts';
import { isVerifyDataValid, verifyData } from './key-schedule.ts';
import { Transcript } from './transcript.ts';

const SUITE = 'TLS_AES_128_GCM_SHA256' as const;

const RUNNING_TRANSCRIPT = /^derive secret "tls13 /;

const bytesOf = (step: Rfc8448Step, label: string): Uint8Array | undefined =>
  step.fields.find(field => field.label === label)?.bytes;

describe('Stage 5: Transcript and RFC 9846 §4.1 HRR against RFC 8448', () => {
  for (const traceSection of ['3', '6', '7']) {
    const trace = RFC_8448_TRACES.find(t => t.section === traceSection);
    expect(trace).toBeDefined();

    it(`§${traceSection}. ${trace!.title}`, async () => {
      const transcript = new Transcript(SUITE);
      let hashes = 0;
      let macs = 0;

      for (const step of trace!.steps) {
        if (/^construct an? .+ handshake message/.test(step.title)) {
          for (const field of step.fields) {
            transcript.add(field.bytes);
          }
          continue;
        }

        if (step.fields.length === 0) continue;

        if (RUNNING_TRANSCRIPT.test(step.title)) {
          const publishedHash = bytesOf(step, 'hash');
          if (publishedHash !== undefined) {
            const computed = await transcript.hash();
            expect(computed).toEqual(publishedHash);
            hashes += 1;
          }
        }

        if (step.title.startsWith('calculate finished')) {
          const key = bytesOf(step, 'expanded');
          const published = bytesOf(step, 'finished');
          if (key !== undefined && published !== undefined) {
            const currentHash = await transcript.hash();
            expect(await verifyData(SUITE, key, currentHash)).toEqual(published);
            expect(await isVerifyDataValid(SUITE, key, currentHash, published)).toBe(true);
            macs += 1;
          }
        }
      }

      expect({ hashes, macs }).toEqual({ hashes: 6, macs: 2 });
    });
  }

  it('§5. HelloRetryRequest with §4.1 message_hash reconstruction', async () => {
    const trace5 = RFC_8448_TRACES.find(t => t.section === '5');
    expect(trace5).toBeDefined();

    const transcript = new Transcript(SUITE);
    let hashes = 0;
    let macs = 0;
    let hasSeenHrr = false;

    for (const step of trace5!.steps) {
      if (/^construct an? .+ handshake message/.test(step.title)) {
        for (const field of step.fields) {
          if (field.label === 'ServerHello' && !hasSeenHrr) {
            // §5's first ServerHello is the HRR: ClientHello1 is replaced by message_hash.
            await transcript.replaceClientHello1WithMessageHash();
            hasSeenHrr = true;
          }
          transcript.add(field.bytes);
        }
        continue;
      }

      if (step.fields.length === 0) continue;

      if (RUNNING_TRANSCRIPT.test(step.title)) {
        const publishedHash = bytesOf(step, 'hash');
        if (publishedHash !== undefined) {
          const computed = await transcript.hash();
          expect(computed).toEqual(publishedHash);
          hashes += 1;
        }
      }

      if (step.title.startsWith('calculate finished')) {
        const key = bytesOf(step, 'expanded');
        const published = bytesOf(step, 'finished');
        if (key !== undefined && published !== undefined) {
          const currentHash = await transcript.hash();
          expect(await verifyData(SUITE, key, currentHash)).toEqual(published);
          expect(await isVerifyDataValid(SUITE, key, currentHash, published)).toBe(true);
          macs += 1;
        }
      }
    }

    expect({ hashes, macs }).toEqual({ hashes: 6, macs: 2 });
  });

  it('CCS never enters the transcript (verified on §7)', async () => {
    const trace7 = RFC_8448_TRACES.find(t => t.section === '7');
    expect(trace7).toBeDefined();

    const transcript = new Transcript(SUITE);
    let hashes = 0;

    for (const step of trace7!.steps) {
      if (step.title.includes('ChangeCipherSpec') || step.title.includes('change_cipher_spec')) {
        continue;
      }

      if (/^construct an? .+ handshake message/.test(step.title)) {
        for (const field of step.fields) {
          transcript.add(field.bytes);
        }
        continue;
      }

      if (step.fields.length === 0) continue;

      if (RUNNING_TRANSCRIPT.test(step.title)) {
        const publishedHash = bytesOf(step, 'hash');
        if (publishedHash !== undefined) {
          const computed = await transcript.hash();
          expect(computed).toEqual(publishedHash);
          hashes += 1;
        }
      }
    }

    expect(hashes).toBe(6);
  });
});
