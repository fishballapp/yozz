/**
 * The control. `openssl verify` is a mature path validator we can drive from
 * Node, so pointing the harness at it first answers "is my harness right?"
 * before there is any validator of ours to blame.
 *
 * It deliberately consumes the same `PathValidationRequest` our own validator
 * will, converting back to PEM on the way out — that is what exercises the
 * contract, which is the other half of what M1 is for.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { PathValidationResult, Validator } from '../src/validator.ts';
import { pemFromDer } from './pem.ts';

const run = promisify(execFile);

/**
 * `openssl verify` falls back to the Common Name when a leaf has no
 * subjectAltName, and the CLI cannot be told not to. RFC 9525 — the profile we
 * declared — forbids that fallback, and x509-limbo tests it 972 times: every
 * bettertls leaf without a SAN expects rejection.
 *
 * ponytail: a byte scan for the SAN OID (2.5.29.17), not a parser. This is the
 * control adapter, and @yozz.app/x509 is the thing that gets a real decoder.
 */
const SAN_EXTENSION_OID = Uint8Array.of(0x55, 0x1d, 0x11);

const hasSubjectAltName = (der: Uint8Array): boolean => {
  for (let index = 0; index + 2 < der.length; index++) {
    if (
      der[index] === SAN_EXTENSION_OID[0] &&
      der[index + 1] === SAN_EXTENSION_OID[1] &&
      der[index + 2] === SAN_EXTENSION_OID[2]
    ) {
      return true;
    }
  }
  return false;
};

/** Maps OpenSSL's message onto our failure codes. Unmapped rejections stay visible. */
const failureFor = (stderr: string): PathValidationResult => {
  const has = (needle: string): boolean => stderr.includes(needle);
  if (has('certificate has expired')) {
    return { ok: false, reason: { code: 'certificate-expired', certificate: { source: 'peer' } } };
  }
  if (has('certificate is not yet valid')) {
    return {
      ok: false,
      reason: { code: 'certificate-not-yet-valid', certificate: { source: 'peer' } },
    };
  }
  if (has('Hostname mismatch') || has('IP address mismatch')) {
    return { ok: false, reason: { code: 'name-mismatch' } };
  }
  if (has('excluded subtree') || has('permitted subtree') || has('name constraints')) {
    return {
      ok: false,
      reason: { code: 'name-constraints-violation', certificate: { source: 'peer' } },
    };
  }
  if (has('path length constraint exceeded')) {
    return { ok: false, reason: { code: 'maximum-chain-depth-exceeded' } };
  }
  if (has('not a CA') || has('invalid CA certificate') || has('basic constraint')) {
    return {
      ok: false,
      reason: { code: 'basic-constraints-violation', certificate: { source: 'peer' } },
    };
  }
  if (has('key usage') || has('Key Usage')) {
    return { ok: false, reason: { code: 'key-usage-violation', certificate: { source: 'peer' } } };
  }
  if (has('purpose')) {
    return {
      ok: false,
      reason: { code: 'extended-key-usage-violation', certificate: { source: 'peer' } },
    };
  }
  if (has('signature failure') || has('signature algorithm')) {
    return { ok: false, reason: { code: 'invalid-signature', certificate: { source: 'peer' } } };
  }
  return { ok: false, reason: { code: 'no-path-to-trust-anchor' } };
};

/**
 * `openssl verify` wants every anchor in one file, but the contract's lookup is
 * by issuer name and this adapter has no decoder to produce one. The harness's
 * source is unindexed and answers any query with the case's whole root set,
 * which the contract allows: over-approximating is sound because the validator
 * verifies each candidate anyway.
 */
const ANY_ISSUER = { issuerNameDer: new Uint8Array(), authorityKeyIdentifier: null };

export const OPENSSL_VALIDATOR: Validator = {
  name: 'openssl',
  validatePath: async request => {
    if (request.expectedPeerName !== null && !hasSubjectAltName(request.peerCertificateDer)) {
      return { ok: false, reason: { code: 'name-mismatch' } };
    }

    const dir = await mkdtemp(join(tmpdir(), 'limbo-'));
    try {
      const leaf = join(dir, 'leaf.pem');
      const roots = join(dir, 'roots.pem');
      await writeFile(leaf, pemFromDer(request.peerCertificateDer));
      const anchors = request.trustAnchors.findCandidates(ANY_ISSUER);
      await writeFile(roots, anchors.map(anchor => pemFromDer(anchor.certificateDer)).join(''));

      // -x509_strict enforces the RFC 5280 requirements the CLI is lax about by
      // default (AKI/SKI presence, critical basicConstraints on a CA).
      // -auth_level 2 forbids the weak keys WebPKI forbids — P-192, small RSA.
      // Without both, the control accepts things our declared profile must not.
      // -trusted rather than -CAfile: -CAfile ADDS to the host's default store, so
      // a machine with extra CAs installed would quietly false-accept. -trusted
      // implies -no-CAfile -no-CApath -no-CAstore, which is the isolation a control
      // has to have.
      const args = ['verify', '-trusted', roots, '-x509_strict', '-auth_level', '2'];
      if (request.untrustedIntermediateDer.length > 0) {
        const inter = join(dir, 'inter.pem');
        await writeFile(inter, request.untrustedIntermediateDer.map(pemFromDer).join(''));
        args.push('-untrusted', inter);
      }
      args.push('-attime', String(Math.floor(request.validationTime.getTime() / 1000)));
      const name = request.expectedPeerName;
      if (name !== null) {
        args.push(name.kind === 'ip' ? '-verify_ip' : '-verify_hostname', name.value);
      }
      args.push(leaf);

      try {
        const { stdout, stderr } = await run('openssl', args, { timeout: 10_000 });
        // openssl exits 0 and still prints "error ..." for some rejections.
        const output = `${stdout}${stderr}`;
        if (output.includes('error') && !output.includes(': OK')) return failureFor(output);
        // The CLI reports a verdict, not a path: which anchor it selected and the
        // leaf's SPKI are both unavailable. Named rather than guessed at — the
        // first candidate is not the chosen one, and the harness compares only
        // `ok`. `@yozz.app/x509` at M4 is what fills these in.
        return {
          ok: true,
          path: {
            leafSubjectPublicKeyInfoDer: new Uint8Array(),
            intermediates: request.untrustedIntermediateDer,
            trustAnchorId: 'openssl-does-not-report-one',
          },
        };
      } catch (error) {
        // A crash, a timeout or a missing binary must NEVER be scored as a
        // legitimate rejection. 8838 of the cases expect rejection, so a control
        // that turns every failure into `ok: false` reports 8838/8838 and reads as
        // a harsh-but-working validator while running nothing at all. That is the
        // exact failure this harness exists to prevent, so it throws instead.
        if (error instanceof Error && 'killed' in error && error.killed === true) {
          throw new Error(`openssl timed out after 10s: ${args.join(' ')}`);
        }
        if (error instanceof Error && 'code' in error && typeof error.code === 'string') {
          throw new Error(`openssl could not be run (${error.code}): ${args.join(' ')}`);
        }
        const stderr = error instanceof Error && 'stderr' in error ? String(error.stderr) : '';
        const stdout = error instanceof Error && 'stdout' in error ? String(error.stdout) : '';
        const output = `${stdout}${stderr}`;
        // A real verify failure always says so. Silence means something else broke.
        if (!output.includes('error')) {
          throw new Error(`openssl failed without a verify error: ${JSON.stringify(output)}`);
        }
        return failureFor(output);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
};
