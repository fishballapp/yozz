import { describe, expect, it } from 'vitest';
import { RFC_8448_TRACES, type Rfc8448Step, type Rfc8448Trace } from '../vectors/rfc8448.ts';
import { deriveSharedSecret, generateKeyShare, importPrivateShare } from './key-share.ts';
import type { NamedGroup } from './wire.ts';

type EphemeralKeyStep = {
  readonly traceSection: string;
  readonly traceTitle: string;
  readonly actor: 'client' | 'server';
  readonly title: string;
  readonly group: NamedGroup;
  readonly privateKey: Uint8Array;
  readonly publicKey: Uint8Array;
};

const bytesOf = (step: Rfc8448Step, label: string): Uint8Array | undefined =>
  step.fields.find(field => field.label === label)?.bytes;

const collectEphemeralKeySteps = (trace: Rfc8448Trace): readonly EphemeralKeyStep[] => {
  const result: EphemeralKeyStep[] = [];
  for (const step of trace.steps) {
    if (step.title.startsWith('create an ephemeral')) {
      const lower = step.title.toLowerCase();
      const group: NamedGroup =
        lower.includes('secp256r1') || lower.includes('p-256')
          ? 'secp256r1'
          : lower.includes('secp384r1') || lower.includes('p-384')
            ? 'secp384r1'
            : 'x25519';
      const privateKey = bytesOf(step, 'private key');
      const publicKey = bytesOf(step, 'public key');
      if (privateKey !== undefined && publicKey !== undefined) {
        result.push({
          traceSection: trace.section,
          traceTitle: trace.title,
          actor: step.actor,
          title: step.title,
          group,
          privateKey,
          publicKey,
        });
      }
    }
  }
  return result;
};

describe('Stage 4: Key share & ECDH against RFC 8448', () => {
  const allEphemeralSteps = RFC_8448_TRACES.flatMap(collectEphemeralKeySteps);

  it('collects all 11 ephemeral key pair steps across the traces', () => {
    expect(allEphemeralSteps.length).toBe(11);
  });

  for (const step of allEphemeralSteps) {
    it(`§${step.traceSection} {${step.actor}} ${step.title}: public key derivation`, async () => {
      const share = await importPrivateShare(step.group, step.privateKey);
      expect(share.publicKey).toEqual(step.publicKey);
    });
  }

  describe('ECDHE shared secret derivation against handshake IKM', () => {
    for (const trace of RFC_8448_TRACES) {
      it(`§${trace.section}. ${trace.title} shared secret matches handshake IKM`, async () => {
        const hsExtract = trace.steps.find(
          s => s.title.startsWith('extract secret "handshake"') && bytesOf(s, 'IKM') !== undefined,
        );
        expect(hsExtract).toBeDefined();
        const expectedIkm = bytesOf(hsExtract!, 'IKM')!;

        const ephemSteps = collectEphemeralKeySteps(trace);
        // For §5 the effective keys are the second client key (P-256) and the server P-256 key.
        const clientKeyStep =
          trace.section === '5'
            ? ephemSteps.filter(s => s.actor === 'client' && s.group === 'secp256r1')[0]!
            : ephemSteps.find(s => s.actor === 'client')!;

        const serverKeyStep =
          trace.section === '5'
            ? ephemSteps.find(s => s.actor === 'server' && s.group === 'secp256r1')!
            : ephemSteps.find(s => s.actor === 'server')!;

        expect(clientKeyStep).toBeDefined();
        expect(serverKeyStep).toBeDefined();

        const clientShare = await importPrivateShare(clientKeyStep.group, clientKeyStep.privateKey);
        const clientDerivedSecret = await deriveSharedSecret(
          clientKeyStep.group,
          clientShare.privateKey,
          serverKeyStep.publicKey,
        );
        expect(clientDerivedSecret).toEqual(expectedIkm);

        const serverShare = await importPrivateShare(serverKeyStep.group, serverKeyStep.privateKey);
        const serverDerivedSecret = await deriveSharedSecret(
          serverKeyStep.group,
          serverShare.privateKey,
          clientKeyStep.publicKey,
        );
        expect(serverDerivedSecret).toEqual(expectedIkm);
      });
    }
  });

  describe('P-384 key exchange self-consistency', () => {
    it('generates two shares and computes matching shared secret', async () => {
      const alice = await generateKeyShare('secp384r1');
      const bob = await generateKeyShare('secp384r1');

      expect(alice.publicKey.length).toBe(97); // 1 + 48 + 48
      expect(alice.publicKey[0]).toBe(0x04);
      expect(bob.publicKey.length).toBe(97);
      expect(bob.publicKey[0]).toBe(0x04);

      const aliceSecret = await deriveSharedSecret('secp384r1', alice.privateKey, bob.publicKey);
      const bobSecret = await deriveSharedSecret('secp384r1', bob.privateKey, alice.publicKey);

      expect(aliceSecret.length).toBe(48);
      expect(bobSecret.length).toBe(48);
      expect(aliceSecret).toEqual(bobSecret);
    });
  });
});
