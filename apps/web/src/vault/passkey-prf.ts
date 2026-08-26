import { PRF_INPUT_LABEL } from '@yozz.app/vault-contract';

export class PasskeyPrfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PasskeyPrfError';
  }
}

/**
 * What a browser probe can tell us, which is less than it looks.
 *
 * `getClientCapabilities()` is Chrome 133+ and uneven in Firefox and Safari, so
 * treating its ABSENCE as "no PRF" refuses passkey mode on browsers where PRF
 * works. It is a fast NEGATIVE only. The authoritative answer is `prf.enabled`
 * on the registration result, which is per-authenticator and not knowable until
 * the ceremony runs.
 */
export type PrfCapability = 'supported' | 'unsupported' | 'unknown';

export const checkPasskeyPrfCapability = async (): Promise<PrfCapability> => {
  if (typeof window === 'undefined' || typeof window.PublicKeyCredential === 'undefined') {
    return 'unsupported';
  }

  const getClientCapabilities = (
    window.PublicKeyCredential as unknown as {
      getClientCapabilities?: () => Promise<Record<string, boolean>>;
    }
  ).getClientCapabilities;

  if (typeof getClientCapabilities !== 'function') {
    return 'unknown';
  }

  try {
    const capabilities = await getClientCapabilities();
    const prf = capabilities['extension:prf'];
    return prf === true ? 'supported' : prf === false ? 'unsupported' : 'unknown';
  } catch {
    return 'unknown';
  }
};

/**
 * REGISTRATION input: enable-only, no `eval`.
 *
 * A `create()` does not reliably produce PRF output — MDN: "evaluating a PRF
 * when creating a credential may not be supported, and this would be reported
 * in the output". What registration is for is telling the authenticator to
 * generate and associate the credential's internal PRF key. Asking to evaluate
 * here and depending on the answer is the defect this shape replaces: on an
 * authenticator that returns `enabled: true` with no `results`, enrolment threw
 * and deleted the passkey it had just created.
 *
 * `evalByCredential` must never appear here — MDN: `create()` rejects with
 * `NotSupportedError` if it is present.
 */
export const getPrfEnableInput = () => ({ prf: {} });

/** AUTHENTICATION input: evaluate the PRF over the versioned label. */
export const getPrfEvalInput = () => ({
  prf: { eval: { first: new TextEncoder().encode(PRF_INPUT_LABEL) } },
});

const prfOutputs = (
  clientExtensionResults: unknown,
): { enabled?: boolean; results?: { first?: unknown } } | undefined => {
  if (!clientExtensionResults || typeof clientExtensionResults !== 'object') return undefined;
  return (clientExtensionResults as { prf?: { enabled?: boolean; results?: { first?: unknown } } })
    .prf;
};

/**
 * Did `create()` associate a PRF key with this credential? `enabled: false`
 * means this authenticator cannot do PRF at all, which is the honest place to
 * refuse — the capability is per-authenticator and no earlier probe knows it.
 */
export const isPrfEnabled = (clientExtensionResults: unknown): boolean =>
  prfOutputs(clientExtensionResults)?.enabled === true;

/**
 * The 32 bytes from a `get()`.
 *
 * **`enabled` is deliberately NOT required here.** MDN's authentication output
 * is `{ prf: { results: { first } } }` with no `enabled` flag — that flag is a
 * `create()` thing. Requiring it rejected every real assertion while the unit
 * tests, which handed in objects carrying both fields, stayed green on a shape
 * that does not occur.
 */
export const extractPrfOutput = (clientExtensionResults: unknown): Uint8Array => {
  const prf = prfOutputs(clientExtensionResults);
  if (!prf) {
    throw new PasskeyPrfError('Missing WebAuthn PRF extension results');
  }

  const rawFirst = prf.results?.first;
  if (rawFirst === undefined || rawFirst === null) {
    throw new PasskeyPrfError('The authenticator returned no PRF output');
  }

  /**
   * `Array` is here because implementations disagree: the spec says
   * `BufferSource`, and 1Password's extension has shipped a plain array.
   * Accepting it costs one branch; rejecting it is an outage for those users.
   */
  const bytes =
    rawFirst instanceof ArrayBuffer
      ? new Uint8Array(rawFirst)
      : ArrayBuffer.isView(rawFirst)
        ? new Uint8Array(rawFirst.buffer, rawFirst.byteOffset, rawFirst.byteLength)
        : Array.isArray(rawFirst)
          ? Uint8Array.from(rawFirst)
          : null;

  if (!bytes || bytes.length !== 32) {
    throw new PasskeyPrfError(
      `Invalid PRF output length: expected 32 bytes, got ${bytes ? bytes.length : 0}`,
    );
  }

  return bytes;
};

/**
 * Evaluate the PRF for ONE credential, with a local assertion that is never
 * sent anywhere.
 *
 * PRF output is only produced by an authentication ceremony, so enrolment needs
 * a `get()` after its `create()`. Better Auth's `signIn.passkey` cannot serve
 * here for two reasons: it sends no parameters to
 * `/passkey/generate-authenticate-options`, so it cannot scope
 * `allowCredentials` to the credential just created — on an account that
 * already has passkeys the user could satisfy it with a different one, and the
 * DEK would be wrapped under the wrong authenticator — and it verifies to the
 * server, replacing the session we are enrolling under.
 *
 * Nothing is authenticated here. The assertion is discarded and only the PRF
 * output is kept, so the challenge does not need to come from the server; it is
 * random purely so the ceremony is well-formed. This is the ordinary shape for
 * key derivation from a passkey.
 */
export const evaluatePrfForCredential = async (credentialId: string): Promise<Uint8Array> => {
  const credential = await navigator.credentials.get({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      allowCredentials: [
        { id: Uint8Array.fromBase64(credentialId, { alphabet: 'base64url' }), type: 'public-key' },
      ],
      userVerification: 'required',
      extensions: getPrfEvalInput() as AuthenticationExtensionsClientInputs,
    },
  });

  if (!credential) {
    throw new PasskeyPrfError('The PRF assertion was dismissed');
  }

  return extractPrfOutput((credential as PublicKeyCredential).getClientExtensionResults());
};
