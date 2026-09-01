/**
 * Every intermediate secret in RFC 8448, byte for byte. The traces are replayed structurally:
 * a step's field set says which derivation it is, so a published step this file does not
 * exercise is a failure rather than an absence.
 */

import { hkdfSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { RFC_8448_TRACES, type Rfc8448Step, type Rfc8448Trace } from '../vectors/rfc8448.ts';
import * as keySchedule from './key-schedule.ts';
import {
  CIPHER_SUITES,
  type CipherSuite,
  deriveSecret,
  earlySecret,
  exportKeyingMaterial,
  finishedKey,
  handshakeSecret,
  hkdfExpandLabel,
  hkdfExtract,
  isVerifyDataValid,
  masterSecret,
  trafficKeys,
  transcriptHash,
  verifyData,
} from './key-schedule.ts';

/** Every trace negotiates 0x1301; `TLS_AES_256_GCM_SHA384` is proven by `interop.test.ts`. */
const SUITE: CipherSuite = 'TLS_AES_128_GCM_SHA256';

/** The steps that owe this file a check. Anything else in a trace is protocol. */
const KEY_SCHEDULE_STEP =
  /^(extract secret|derive secret|derive (read|write) traffic keys|calculate finished|calculate PSK binder|generate resumption secret)/;

/** `derive secret for handshake "tls13 derived"` -> `derived`. */
const QUOTED_LABEL = /"tls13 ([^"]+)"/;

/** A PSK binder's key is a `finished` key (RFC 9846 §4.3.11.2), which the trace leaves implicit. */
const labelOf = (title: string): string | undefined =>
  QUOTED_LABEL.exec(title)?.[1] ??
  (title.startsWith('calculate PSK binder') ? 'finished' : undefined);

const bytesOf = (step: Rfc8448Step, label: string): Uint8Array | undefined =>
  step.fields.find(field => field.label === label)?.bytes;

type Check = { readonly what: string; readonly run: () => Promise<void> };

const checksFor = (step: Rfc8448Step): readonly Check[] => {
  const salt = bytesOf(step, 'salt');
  const ikm = bytesOf(step, 'IKM');
  const secret = bytesOf(step, 'secret');
  if (salt !== undefined && ikm !== undefined && secret !== undefined) {
    return [
      {
        what: 'HKDF-Extract',
        run: async () => expect(await hkdfExtract(SUITE, salt, ikm)).toEqual(secret),
      },
    ];
  }

  const prk = bytesOf(step, 'PRK');
  if (prk === undefined) return [];

  const keyExpanded = bytesOf(step, 'key expanded');
  const ivExpanded = bytesOf(step, 'iv expanded');
  if (keyExpanded !== undefined && ivExpanded !== undefined) {
    return [
      {
        what: 'traffic key + iv',
        run: async () =>
          expect(await trafficKeys(SUITE, prk)).toEqual({ key: keyExpanded, iv: ivExpanded }),
      },
    ];
  }

  // `hash` is the Expand-Label context; in `generate resumption secret` the same field carries the ticket nonce (§4.7.1).
  const context = bytesOf(step, 'hash');
  const expanded = bytesOf(step, 'expanded');
  const label = labelOf(step.title);
  if (context === undefined || expanded === undefined || label === undefined) return [];

  const binderHash = bytesOf(step, 'binder hash');
  const finished = bytesOf(step, 'finished');

  return [
    {
      what: `Expand-Label "${label}"`,
      run: async () => {
        expect(
          await hkdfExpandLabel(SUITE, prk, label, context, CIPHER_SUITES[SUITE].hashLength),
        ).toEqual(expanded);
        // `Derive-Secret` hashes its own messages, so it is driven from the steps whose context is the
        // empty transcript's hash; the others are covered from the messages themselves, below.
        if (label === 'derived') {
          expect(await deriveSecret(SUITE, prk, label)).toEqual(expanded);
        }
      },
    },
    ...(label === 'finished'
      ? [
          {
            what: 'finishedKey',
            run: async () => expect(await finishedKey(SUITE, prk)).toEqual(expanded),
          },
        ]
      : []),
    // Only the PSK binder publishes a finished key beside its transcript.
    ...(binderHash !== undefined && finished !== undefined
      ? [
          {
            what: 'verify_data',
            run: async () =>
              expect(await verifyData(SUITE, expanded, binderHash)).toEqual(finished),
          },
          {
            what: 'verify_data accepted',
            run: async () =>
              expect(await isVerifyDataValid(SUITE, expanded, binderHash, finished)).toBe(true),
          },
          {
            what: 'verify_data refused after one flipped bit',
            run: async () => {
              const tampered = Uint8Array.from(finished, (byte, index) =>
                index === 0 ? byte ^ 0x01 : byte,
              );
              expect(await isVerifyDataValid(SUITE, expanded, binderHash, tampered)).toBe(false);
            },
          },
        ]
      : []),
  ];
};

describe('the key schedule against RFC 8448', () => {
  for (const trace of RFC_8448_TRACES) {
    describe(`§${trace.section}. ${trace.title}`, () => {
      for (const [index, step] of trace.steps.entries()) {
        for (const check of checksFor(step)) {
          it(`${index} {${step.actor}} ${step.title} — ${check.what}`, check.run);
        }
      }
    });
  }

  it('leaves no key-schedule step in the document untested', () => {
    expect(
      RFC_8448_TRACES.flatMap(trace =>
        trace.steps
          .filter(
            step =>
              step.fields.length > 0 &&
              KEY_SCHEDULE_STEP.test(step.title) &&
              checksFor(step).length === 0,
          )
          .map(step => `§${trace.section} {${step.actor}} ${step.title}`),
      ),
    ).toEqual([]);
  });

  // Catches the parser silently dropping steps, which would make the guard above vacuous.
  it('runs every derivation the document publishes', () => {
    expect(RFC_8448_TRACES.map(trace => trace.section)).toEqual(['3', '4', '5', '6', '7']);
    expect(
      RFC_8448_TRACES.reduce(
        (total, trace) =>
          total + trace.steps.reduce((subtotal, step) => subtotal + checksFor(step).length, 0),
        0,
      ),
    ).toBe(109);
  });

  it('is a SHA-256 document throughout', () => {
    expect([
      ...new Set(
        RFC_8448_TRACES.flatMap(trace =>
          trace.steps.flatMap(step =>
            step.fields
              .filter(field => field.label === 'PRK' || field.label === 'secret')
              .map(field => field.bytes.length),
          ),
        ),
      ),
    ]).toEqual([CIPHER_SUITES[SUITE].hashLength]);
  });
});

/** The one step of its name that publishes fields; the rest say `(same as …)`. */
const extractStep = (trace: Rfc8448Trace, secret: string): Rfc8448Step => {
  const step = trace.steps.find(
    candidate =>
      candidate.title.startsWith(`extract secret "${secret}"`) && candidate.fields.length > 0,
  );
  if (step === undefined) throw new Error(`§${trace.section} publishes no "${secret}" extract`);
  return step;
};

const requiredBytes = (step: Rfc8448Step, label: string): Uint8Array => {
  const bytes = bytesOf(step, label);
  if (bytes === undefined) throw new Error(`"${step.title}" publishes no ${label}`);
  return bytes;
};

/**
 * The ladder itself: the `derived` label between stages, the empty transcript, salt against IKM,
 * the zero IKM. Swapping `handshakeSecret`'s two arguments once kept every vector check green.
 */
describe('the secret ladder, end to end', () => {
  for (const trace of RFC_8448_TRACES) {
    it(`§${trace.section}. ${trace.title}`, async () => {
      const early = extractStep(trace, 'early');
      const handshake = extractStep(trace, 'handshake');
      const master = extractStep(trace, 'master');

      // §4 resumes, so its Early Secret takes a real PSK; the others take the all-zero IKM.
      const ikm = requiredBytes(early, 'IKM');
      const psk = ikm.some(byte => byte !== 0) ? ikm : undefined;

      const earlyDerived = await earlySecret(SUITE, psk);
      expect(earlyDerived).toEqual(requiredBytes(early, 'secret'));

      const handshakeDerived = await handshakeSecret(
        SUITE,
        earlyDerived,
        requiredBytes(handshake, 'IKM'),
      );
      expect(handshakeDerived).toEqual(requiredBytes(handshake, 'secret'));

      // Each stage's salt is the previous secret through `derived`.
      expect(await masterSecret(SUITE, handshakeDerived)).toEqual(requiredBytes(master, 'secret'));
    });
  }

  it('hashes an empty transcript the way the traces derive over one', async () => {
    const [trace] = RFC_8448_TRACES;
    if (trace === undefined) throw new Error('no traces');
    const derived = trace.steps.find(step => step.title.includes('"tls13 derived"'));
    if (derived === undefined) throw new Error('no derived step');
    expect(await transcriptHash(SUITE)).toEqual(requiredBytes(derived, 'hash'));
  });

  /** An export nobody exercises fails here rather than shipping unproven. */
  // Coercion would hand back plausible key material of the wrong size.
  it('fails closed on a length or label that is not one', async () => {
    const secret = new Uint8Array(32);
    await expect(hkdfExpandLabel(SUITE, secret, 'key', new Uint8Array(0), 16.5)).rejects.toThrow();
    await expect(
      hkdfExpandLabel(SUITE, secret, 'key', new Uint8Array(0), Number.NaN),
    ).rejects.toThrow();
    await expect(hkdfExpandLabel(SUITE, secret, '', new Uint8Array(0), 16)).rejects.toThrow();
  });

  /** RFC 9846 §7.5, and the only caller that reaches `hkdfExpand`'s multi-block loop. BoGo proves the output (`ExportKeyingMaterial-TLS-TLS13`, 1024 octets). */
  describe('the exporter', () => {
    const SECRET = new Uint8Array(32).fill(7);
    const CONTEXT = new TextEncoder().encode('context');

    it('honours a length either side of one hash block', async () => {
      for (const length of [1, 32, 33, 1024]) {
        const exported = await exportKeyingMaterial(SUITE, SECRET, 'label', CONTEXT, length);
        expect(exported.length).toBe(length);
      }
    });

    /**
     * `node:crypto`'s HKDF does Extract then Expand, so both sides expand the same PRK and the
     * same `HkdfLabel` info; only the RFC 5869 §2.3 block loop differs. The struct is rebuilt here
     * rather than imported. A short export is not a prefix of a long one: `HkdfLabel` carries
     * `uint16 length`.
     */
    it('expands past one block the way node:crypto does', async () => {
      const label = new TextEncoder().encode('tls13 exporter');
      const contextHash = new Uint8Array(
        await crypto.subtle.digest('SHA-256', new TextEncoder().encode('context')),
      );
      const ikm = new Uint8Array(32).fill(3);
      const salt = new Uint8Array(32).fill(9);
      const prk = await hkdfExtract(SUITE, salt, ikm);

      for (const length of [1024, 33]) {
        const info = Uint8Array.from([
          length >> 8,
          length & 0xff,
          label.length,
          ...label,
          contextHash.length,
          ...contextHash,
        ]);
        expect(await hkdfExpandLabel(SUITE, prk, 'exporter', contextHash, length)).toEqual(
          new Uint8Array(hkdfSync('sha256', ikm, salt, info, length)),
        );
      }
    });

    it('separates by label and by context', async () => {
      const base = await exportKeyingMaterial(SUITE, SECRET, 'label', CONTEXT, 32);
      const otherLabel = await exportKeyingMaterial(SUITE, SECRET, 'labeI', CONTEXT, 32);
      const otherContext = await exportKeyingMaterial(
        SUITE,
        SECRET,
        'label',
        new Uint8Array(0),
        32,
      );
      expect(otherLabel).not.toEqual(base);
      expect(otherContext).not.toEqual(base);
    });

    /** `opaque label<7..255> = "tls13 " + Label` (§7.1); the prefix alone is six, so the empty label cannot be encoded (`RFC_DIVERGENCES`). */
    it('refuses an empty label rather than deriving from an unencodable struct', async () => {
      await expect(exportKeyingMaterial(SUITE, SECRET, '', CONTEXT, 32)).rejects.toThrow(
        /7\.\.255/,
      );
    });

    it('refuses a length HKDF cannot produce', async () => {
      await expect(
        exportKeyingMaterial(SUITE, SECRET, 'label', CONTEXT, 255 * 32 + 1),
      ).rejects.toThrow();
    });
  });

  it('exercises every value the module exports', () => {
    expect(Object.keys(keySchedule).toSorted()).toEqual(
      [
        'CIPHER_SUITES',
        'deriveSecret',
        'earlySecret',
        'exportKeyingMaterial',
        'finishedKey',
        'handshakeSecret',
        'hkdfExpandLabel',
        'hkdfExtract',
        'isVerifyDataValid',
        'masterSecret',
        'trafficKeys',
        'transcriptHash',
        'verifyData',
      ].toSorted(),
    );
  });
});

/** §4 publishes the truncated ClientHello under the name `ClientHello`; the running transcript is reproduced in `session.test.ts`. */
