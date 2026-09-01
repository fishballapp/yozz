import { z } from 'zod';

export const PRF_INPUT_LABEL = 'yozz-vault-prf-v1';

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

export const UnlockModeSchema = z.enum(['password', 'passkey']);
export type UnlockMode = z.infer<typeof UnlockModeSchema>;

export const WrappedDekSchema = z
  .string()
  .min(1)
  .max(4096)
  .regex(/^[A-Za-z0-9+/=_-]+$/, 'Wrapped DEK must be valid base64/base64url');

export const ApiErrorCodeSchema = z.enum([
  'UNAUTHORIZED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'BAD_REQUEST',
  'PAYLOAD_TOO_LARGE',
  'INTERNAL_ERROR',
  'INVALID_MODE',
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
