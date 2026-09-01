import { PRF_INPUT_LABEL } from '@yozz.app/vault-contract';

export class PasskeyPrfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PasskeyPrfError';
  }
}

/**
 * `getClientCapabilities()` is Chrome 133+ and uneven elsewhere, so its absence is not "no PRF".
 * A fast negative only; `prf.enabled` on the registration result is the authoritative answer.
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
 * Enable-only, no `eval`: MDN says evaluating a PRF at `create()` may not be supported, and an
 * authenticator returning `enabled: true` with no `results` once made enrolment delete its own
 * passkey. `evalByCredential` here makes `create()` reject with `NotSupportedError`.
 */
export const getPrfEnableInput = () => ({ prf: {} });

/** Evaluate the PRF over the versioned label. */
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

/** `enabled: false` means this authenticator cannot do PRF at all; no earlier probe knows it. */
export const isPrfEnabled = (clientExtensionResults: unknown): boolean =>
  prfOutputs(clientExtensionResults)?.enabled === true;

/** The 32 bytes from a `get()`. `enabled` is a `create()` thing and is not in MDN's authentication output. */
export const extractPrfOutput = (clientExtensionResults: unknown): Uint8Array => {
  const prf = prfOutputs(clientExtensionResults);
  if (!prf) {
    throw new PasskeyPrfError('Missing WebAuthn PRF extension results');
  }

  const rawFirst = prf.results?.first;
  if (rawFirst === undefined || rawFirst === null) {
    throw new PasskeyPrfError('The authenticator returned no PRF output');
  }

  // The spec says `BufferSource`; 1Password's extension has shipped a plain array.
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
 * A local assertion, never sent anywhere. Better Auth's `signIn.passkey` cannot serve: it cannot
 * scope `allowCredentials` to the credential just created, and it verifies to the server,
 * replacing the session. The challenge is random only so the ceremony is well-formed.
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
