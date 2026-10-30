import { z } from 'zod';

export const PRF_INPUT_LABEL = 'yozz-vault-prf-v1';

/**
 * WebAuthn Level 3's recommended timeout when user verification is required or preferred (§15.1). A
 * passkey in a phone's password manager means an app switch and Face ID, which outlasts
 * SimpleWebAuthn's 60 s default. It is also the passkey plugin's challenge lifetime, so a longer
 * prompt would outlive its challenge.
 */
export const WEBAUTHN_TIMEOUT_MS = 300_000;

/** Below D1's 2 MB row limit. */
export const MAX_CIPHERTEXT_BYTES = 1_000_000;

export const BlindRecordIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/, 'Blind record ID must be base64url characters');

export const RecordTypeSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(
    /^[a-z0-9_:-]+$/,
    'Record type must contain only lowercase alphanumeric characters, underscore, colon, or hyphen',
  );

export const CiphertextSchema = z
  .string()
  .min(1)
  .max(MAX_CIPHERTEXT_BYTES, 'Ciphertext exceeds maximum permitted size')
  .regex(/^[A-Za-z0-9+/=_-]+$/, 'Ciphertext must be valid base64/base64url');

/** What a person may call a passkey; the Worker refuses a longer one and the web app never sends it. */
export const PASSKEY_NAME_MAX_LENGTH = 60;

export const UnlockModeSchema = z.enum(['password', 'passkey']);
export type UnlockMode = z.infer<typeof UnlockModeSchema>;

export const WrappedDekSchema = z
  .string()
  .min(1)
  .max(4096)
  .regex(/^[A-Za-z0-9+/=_-]+$/, 'Wrapped DEK must be valid base64/base64url');

/**
 * Names the account a vault request was made for. The session cookie belongs to the browser, so
 * another tab's sign-in can replace it under a request one tab began for its own account; a request
 * that names an account is refused (`ACCOUNT_MISMATCH`) when the session is anyone else's.
 */
export const ACCOUNT_HEADER = 'Yozz-Account';

export const ApiErrorCodeSchema = z.enum([
  'UNAUTHORIZED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'BAD_REQUEST',
  'PAYLOAD_TOO_LARGE',
  'INTERNAL_ERROR',
  'INVALID_MODE',
  'SESSION_NOT_FRESH',
  'WRONG_PASSWORD',
  'ACCOUNT_MISMATCH',
  'UPGRADE_REQUIRED',
  'RATE_LIMITED',
  'UPSTREAM_UNREACHABLE',
]);
export type ApiErrorCode = z.infer<typeof ApiErrorCodeSchema>;

export const ApiErrorResponseSchema = z
  .object({
    error: z
      .object({
        code: ApiErrorCodeSchema,
        message: z.string(),
      })
      .strict(),
  })
  .strict();
export type ApiErrorResponse = z.infer<typeof ApiErrorResponseSchema>;

export const NoModeUnlockStatusSchema = z
  .object({
    mode: z.null(),
  })
  .strict();

export const PasswordUnlockStatusSchema = z
  .object({
    mode: z.literal('password'),
    wrappedDek: WrappedDekSchema,
    updatedAt: z.number().int().nonnegative(),
  })
  .strict();

/** `passkeyId` is Better Auth's passkey ROW id, not the WebAuthn credential id. */
export const PasskeyWrapMetaSchema = z
  .object({
    passkeyId: z.string().min(1),
    createdAt: z.number().int().nonnegative(),
  })
  .strict();
export type PasskeyWrapMeta = z.infer<typeof PasskeyWrapMetaSchema>;

export const PasskeyUnlockStatusSchema = z
  .object({
    mode: z.literal('passkey'),
    passkeys: z.array(PasskeyWrapMetaSchema),
  })
  .strict();

/** GET /api/v1/vault/unlock. */
export const UnlockStatusResponseSchema = z.discriminatedUnion('mode', [
  NoModeUnlockStatusSchema,
  PasswordUnlockStatusSchema,
  PasskeyUnlockStatusSchema,
]);
export type UnlockStatusResponse = z.infer<typeof UnlockStatusResponseSchema>;

/** GET /api/v1/vault/unlock/passkey/:credentialId. */
export const PasskeyWrapResponseSchema = z
  .object({
    wrappedDek: WrappedDekSchema,
  })
  .strict();
export type PasskeyWrapResponse = z.infer<typeof PasskeyWrapResponseSchema>;

/** A one-way function of `masterKey` under its own salt; Better Auth stores it (hashed again) as the password. */
export const AuthValueSchema = z
  .string()
  .regex(/^[A-Za-z0-9+/]{43}=$/, 'authValue must be base64 of 32 bytes');

/** PUT /api/v1/vault/unlock. `isNewVault: true` INSERTs the account row (409 if one exists); `false` upserts for a rewrap. */
export const FinalizePasswordUnlockRequestSchema = z
  .object({
    mode: z.literal('password'),
    isNewVault: z.boolean(),
    wrappedDek: WrappedDekSchema,
    authValue: AuthValueSchema,
  })
  .strict();

/** PUT /api/v1/vault/unlock. `credentialId` is the base64url WebAuthn credential id, which the Worker resolves to its passkey row. */
export const FinalizePasskeyUnlockRequestSchema = z
  .object({
    mode: z.literal('passkey'),
    isNewVault: z.boolean(),
    credentialId: z.string().min(1),
    wrappedDek: WrappedDekSchema,
  })
  .strict();

/**
 * PUT /api/v1/vault/unlock/password. `currentAuthValue` proves the current password; `wrappedDek` is
 * the same DEK under the keys the new password derives, so no record changes.
 */
export const ChangePasswordRequestSchema = z
  .object({
    currentAuthValue: AuthValueSchema,
    newAuthValue: AuthValueSchema,
    wrappedDek: WrappedDekSchema,
  })
  .strict();
export type ChangePasswordRequest = z.infer<typeof ChangePasswordRequestSchema>;

export const FinalizeUnlockRequestSchema = z.discriminatedUnion('mode', [
  FinalizePasswordUnlockRequestSchema,
  FinalizePasskeyUnlockRequestSchema,
]);
export type FinalizeUnlockRequest = z.infer<typeof FinalizeUnlockRequestSchema>;

/** Stated in the clear so the store can compare-and-swap; the copy sealed inside the ciphertext stays authoritative. */
export const RevisionSchema = z.number().int().nonnegative();

/**
 * `absent`: no row at all. `revision: null`: a row written before the column existed. Omitting the
 * precondition altogether is last-write-wins.
 */
export const PutPreconditionSchema = z.discriminatedUnion('expect', [
  z.object({ expect: z.literal('absent') }).strict(),
  z.object({ expect: z.literal('revision'), revision: RevisionSchema.nullable() }).strict(),
]);
export type PutPrecondition = z.infer<typeof PutPreconditionSchema>;

export const PutRecordRequestSchema = z
  .object({
    ciphertext: CiphertextSchema,
    revision: RevisionSchema,
    precondition: PutPreconditionSchema.optional(),
  })
  .strict();
export type PutRecordRequest = z.infer<typeof PutRecordRequestSchema>;

/** DELETE /api/v1/vault/records/:type/:id. */
export const DeleteRecordQuerySchema = z
  .object({
    ifRevision: z.coerce.number().int().nonnegative().optional(),
  })
  .strict();
export type DeleteRecordQuery = z.infer<typeof DeleteRecordQuerySchema>;

export const VaultRecordEnvelopeSchema = z
  .object({
    id: BlindRecordIdSchema,
    type: RecordTypeSchema,
    ciphertext: CiphertextSchema,
    updatedAt: z.number().int().nonnegative(),
    /** Null on a row written before the column existed; the next write fills it. */
    revision: RevisionSchema.nullable(),
  })
  .strict();
export type VaultRecordEnvelope = z.infer<typeof VaultRecordEnvelopeSchema>;

/** GET /api/v1/vault/records/:type. */
export const ListRecordsQuerySchema = z
  .object({
    after: BlindRecordIdSchema.optional(),
  })
  .strict();
export type ListRecordsQuery = z.infer<typeof ListRecordsQuerySchema>;

export const ListRecordsResponseSchema = z
  .object({
    records: z.array(VaultRecordEnvelopeSchema),
    nextCursor: BlindRecordIdSchema.nullable(),
  })
  .strict();
export type ListRecordsResponse = z.infer<typeof ListRecordsResponseSchema>;

export const OkResponseSchema = z
  .object({
    ok: z.literal(true),
  })
  .strict();
export type OkResponse = z.infer<typeof OkResponseSchema>;

/** Implicit TLS only: the relay accepts nothing but 993 and 465. */
export const MailServerSchema = z
  .object({
    host: z.string().min(1).max(253),
    port: z.union([z.literal(993), z.literal(465)]),
  })
  .strict();
export type MailServer = z.infer<typeof MailServerSchema>;

/** GET /api/v1/autoconfig?domain=. At least one of `imap` / `smtp` is present; neither is a 404. */
export const MailAutoconfigSchema = z
  .object({
    imap: MailServerSchema.nullable(),
    smtp: MailServerSchema.nullable(),
    /** Whether the login name is the whole address or only the part before the `@`. */
    username: z.enum(['address', 'localpart']),
    /** The form's wording depends on it. */
    source: z.enum(['provider', 'ispdb', 'srv']),
    /** The domain the answer was found under: the asked domain, or the MX host's when that is what answered. */
    sourceDomain: z.string().min(1),
  })
  .strict();
export type MailAutoconfig = z.infer<typeof MailAutoconfigSchema>;

/**
 * A raw 32-byte X25519 public key, base64url without padding. 43 characters carry 258 bits, so the
 * last one is limited to those whose two spare bits are zero: one key has one spelling.
 */
export const X25519PublicKeySchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/, 'A public key must be 32 bytes of base64url');

export const CliKeyNameSchema = z.string().trim().min(1).max(PASSKEY_NAME_MAX_LENGTH);

export const CliKeyIdSchema = z.uuid();

const CLI_TOKEN =
  /^yozzcli_(?<keyId>[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})_[A-Za-z0-9_-]{43}$/;

/**
 * The bearer a CLI key is used with, `yozzcli_<keyId>_<secret>`: the prefix names it in a leaked
 * log, the key id finds its row, and the secret is 256 bits of base64url.
 */
export const formatCliToken = ({ keyId, secret }: { keyId: string; secret: string }): string =>
  `yozzcli_${keyId}_${secret}`;

/** Parses a bearer to the token and the key id it names. */
export const CliTokenSchema = z.string().transform((token, context) => {
  const keyId = CLI_TOKEN.exec(token)?.groups?.keyId;
  if (keyId === undefined) {
    context.addIssue({ code: 'custom', message: 'Not a CLI token' });
    return z.NEVER;
  }
  return { token, keyId };
});

/** POST /api/v1/vault/cli-keys, under a fresh session: the DEK wrapped to a CLI key. */
export const CreateCliKeyRequestSchema = z
  .object({
    name: CliKeyNameSchema,
    publicKey: X25519PublicKeySchema,
    ephemeralPublicKey: X25519PublicKeySchema,
    wrappedDek: WrappedDekSchema,
  })
  .strict();
export type CreateCliKeyRequest = z.infer<typeof CreateCliKeyRequestSchema>;

/** The token is answered once; the Worker keeps only its hash. */
export const CreateCliKeyResponseSchema = z
  .object({
    keyId: CliKeyIdSchema,
    token: z.string().regex(CLI_TOKEN, 'Not a CLI token'),
  })
  .strict();
export type CreateCliKeyResponse = z.infer<typeof CreateCliKeyResponseSchema>;

export const CliKeySummarySchema = z
  .object({
    keyId: CliKeyIdSchema,
    name: CliKeyNameSchema,
    /** Its pairing code is computed from this, so Settings shows the code the terminal showed. */
    publicKey: X25519PublicKeySchema,
    createdAt: z.number().int().nonnegative(),
    lastUsedAt: z.number().int().nonnegative().nullable(),
  })
  .strict();
export type CliKeySummary = z.infer<typeof CliKeySummarySchema>;

/** GET /api/v1/vault/cli-keys, under a session. */
export const ListCliKeysResponseSchema = z
  .object({
    keys: z.array(CliKeySummarySchema),
  })
  .strict();
export type ListCliKeysResponse = z.infer<typeof ListCliKeysResponseSchema>;

/** GET /api/v1/vault/cli-key, under the key's own bearer: what that key opens the vault with. */
export const CliKeyWrapResponseSchema = z
  .object({
    keyId: CliKeyIdSchema,
    ephemeralPublicKey: X25519PublicKeySchema,
    wrappedDek: WrappedDekSchema,
  })
  .strict();
export type CliKeyWrapResponse = z.infer<typeof CliKeyWrapResponseSchema>;

/** The nonce tying a loopback callback to one `yozz login`: 256 bits, base64url without padding. */
export const CliLoginStateSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/, 'Not a login state');

/** The approve page's query (`/cli/approve?port&state&publicKey&name`). */
export const CliApproveQuerySchema = z
  .object({
    port: z.coerce.number().int().min(1024).max(65_535),
    state: CliLoginStateSchema,
    publicKey: X25519PublicKeySchema,
    name: CliKeyNameSchema,
  })
  .strict();
export type CliApproveQuery = z.infer<typeof CliApproveQuerySchema>;

/**
 * What an approval hands the CLI: the bearer, and the account it names in `Yozz-Account` and keeps in
 * its credentials. Sealed, because the loopback URL lands in the browser's history.
 */
export const CliLoginPayloadSchema = z
  .object({
    token: z.string().regex(CLI_TOKEN, 'Not a CLI token'),
    userId: z.string().min(1),
    email: z.string().min(1),
  })
  .strict();
export type CliLoginPayload = z.infer<typeof CliLoginPayloadSchema>;

/**
 * The loopback callback's query (`http://127.0.0.1:<port>/callback?…`): approved, or denied.
 * `sealedLogin` is a `CliLoginPayload` sealed under the approval's token key with `state` as its
 * additional data, so it opens for this one login only.
 */
export const CliLoginCallbackSchema = z.union([
  z
    .object({
      state: CliLoginStateSchema,
      ephemeralPublicKey: X25519PublicKeySchema,
      sealedLogin: z
        .string()
        .max(2048)
        .regex(/^[A-Za-z0-9+/]+={0,2}$/, 'A sealed login must be base64'),
    })
    .strict(),
  z.object({ state: CliLoginStateSchema, error: z.literal('denied') }).strict(),
]);
export type CliLoginCallback = z.infer<typeof CliLoginCallbackSchema>;
