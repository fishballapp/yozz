/**
 * `@yozz.app/vault-contract` — strict wire schemas and transport types for the
 * zero-access vault server and client record store.
 *
 * This package holds ONLY public metadata and ciphertext schemas. It strictly
 * excludes all secret material (DEK, masterKey, encKey, authValue, device secrets,
 * PRF outputs, passwords, plaintexts, natural keys) and client-internal state
 * (revision marks, sealed revision numbers).
 */

import { z } from 'zod';

/** Public PRF input label for passkey authentication and registration. */
export const PRF_INPUT_LABEL = 'yozz-vault-prf-v1';

/** Maximum permitted length of a ciphertext string (below D1's 2MB row limit). */
export const MAX_CIPHERTEXT_BYTES = 1_000_000;

/** Blind record ID schema (base64url representation of HMAC). */
export const BlindRecordIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/, 'Blind record ID must be base64url characters');

/** Public record type schema. */
export const RecordTypeSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(
    /^[a-z0-9_:-]+$/,
    'Record type must contain only lowercase alphanumeric characters, underscore, colon, or hyphen',
  );

/** Ciphertext schema: base64-encoded encrypted payload up to MAX_CIPHERTEXT_BYTES. */
export const CiphertextSchema = z
  .string()
  .min(1)
  .max(MAX_CIPHERTEXT_BYTES, 'Ciphertext exceeds maximum permitted size')
  .regex(/^[A-Za-z0-9+/=_-]+$/, 'Ciphertext must be valid base64/base64url');

/** Supported unlock modes. */
export const UnlockModeSchema = z.enum(['password', 'passkey']);
export type UnlockMode = z.infer<typeof UnlockModeSchema>;

/** Password wrapped DEK schema. */
export const WrappedDekSchema = z
  .string()
  .min(1)
  .max(4096)
  .regex(/^[A-Za-z0-9+/=_-]+$/, 'Wrapped DEK must be valid base64/base64url');

/** Stable API error codes. */
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

/** Structured API error response schema. */
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

/** Status when no vault unlock mode has been enrolled. */
export const NoModeUnlockStatusSchema = z
  .object({
    mode: z.null(),
  })
  .strict();

/** Status when vault is in password mode. */
export const PasswordUnlockStatusSchema = z
  .object({
    mode: z.literal('password'),
    wrappedDek: WrappedDekSchema,
    updatedAt: z.number().int().nonnegative(),
  })
  .strict();

/**
 * Metadata for an enrolled passkey wrap. `passkeyId` is Better Auth's passkey
 * ROW id — the one `POST /api/auth/passkey/delete-passkey` addresses — not the
 * WebAuthn credential id. Everything that starts from an authenticator
 * response uses the credential id instead (`credentialId` below).
 */
export const PasskeyWrapMetaSchema = z
  .object({
    passkeyId: z.string().min(1),
    createdAt: z.number().int().nonnegative(),
  })
  .strict();
export type PasskeyWrapMeta = z.infer<typeof PasskeyWrapMetaSchema>;

/** Status when vault is in passkey mode. */
export const PasskeyUnlockStatusSchema = z
  .object({
    mode: z.literal('passkey'),
    passkeys: z.array(PasskeyWrapMetaSchema),
  })
  .strict();

/** Union of all unlock status responses for GET /api/v1/vault/unlock. */
export const UnlockStatusResponseSchema = z.discriminatedUnion('mode', [
  NoModeUnlockStatusSchema,
  PasswordUnlockStatusSchema,
  PasskeyUnlockStatusSchema,
]);
export type UnlockStatusResponse = z.infer<typeof UnlockStatusResponseSchema>;

/** Response for GET /api/v1/vault/unlock/passkey/:credentialId. */
export const PasskeyWrapResponseSchema = z
  .object({
    wrappedDek: WrappedDekSchema,
  })
  .strict();
export type PasskeyWrapResponse = z.infer<typeof PasskeyWrapResponseSchema>;

/** Request body for password unlock finalisation (PUT /api/v1/vault/unlock). */
/**
 * `authValue` — the ONLY secret-derived value in this contract, and it is here
 * on purpose. It is what Better Auth stores (hashed again on arrival) as the
 * password, and ARCHITECTURE.md's key schedule marks it "sent to the server".
 * It is a one-way function of `masterKey` under a different salt, so holding it
 * recovers neither `masterKey` nor `encKey`.
 *
 * It travels with the finalisation rather than through a separate call because
 * Better Auth's `setPassword` is `createAuthEndpoint.serverOnly` — it has no
 * HTTP path at all, so a browser cannot reach it. The Worker calls it
 * internally with the session, which is also what makes credential ownership
 * STRUCTURAL: the route that finalises password mode is the same route that
 * creates the credential, for the session's own user, so there is no ownership
 * to check separately and no window in which the two can disagree.
 */
export const AuthValueSchema = z
  .string()
  .regex(/^[A-Za-z0-9+/]{43}=$/, 'authValue must be base64 of 32 bytes');

/**
 * `isNewVault` is the client saying "I just minted this DEK". The Worker then
 * INSERTs the account row instead of upserting it, so two tabs that both saw
 * no vault cannot both finalise — the second is refused with 409 and its DEK
 * never wraps anything. A rewrap (mode switch, added authenticator) sends
 * `false` and upserts.
 */
export const FinalizePasswordUnlockRequestSchema = z
  .object({
    mode: z.literal('password'),
    isNewVault: z.boolean(),
    wrappedDek: WrappedDekSchema,
    authValue: AuthValueSchema,
  })
  .strict();

/**
 * Request body for passkey unlock finalisation (PUT /api/v1/vault/unlock).
 * `credentialId` is the base64url WebAuthn credential id from the ceremony
 * that just ran; the Worker resolves it to the passkey row it belongs to.
 */
export const FinalizePasskeyUnlockRequestSchema = z
  .object({
    mode: z.literal('passkey'),
    isNewVault: z.boolean(),
    credentialId: z.string().min(1),
    wrappedDek: WrappedDekSchema,
  })
  .strict();

/** Discriminated union for PUT /api/v1/vault/unlock. */
export const FinalizeUnlockRequestSchema = z.discriminatedUnion('mode', [
  FinalizePasswordUnlockRequestSchema,
  FinalizePasskeyUnlockRequestSchema,
]);
export type FinalizeUnlockRequest = z.infer<typeof FinalizeUnlockRequestSchema>;

/** PUT /api/v1/vault/records/:type/:id request body. */
export const PutRecordRequestSchema = z
  .object({
    ciphertext: CiphertextSchema,
  })
  .strict();
export type PutRecordRequest = z.infer<typeof PutRecordRequestSchema>;

/** Stored/returned vault record envelope. */
export const VaultRecordEnvelopeSchema = z
  .object({
    id: BlindRecordIdSchema,
    type: RecordTypeSchema,
    ciphertext: CiphertextSchema,
    updatedAt: z.number().int().nonnegative(),
  })
  .strict();
export type VaultRecordEnvelope = z.infer<typeof VaultRecordEnvelopeSchema>;

/** GET /api/v1/vault/records/:type cursor query schema. */
export const ListRecordsQuerySchema = z
  .object({
    after: BlindRecordIdSchema.optional(),
  })
  .strict();
export type ListRecordsQuery = z.infer<typeof ListRecordsQuerySchema>;

/** GET /api/v1/vault/records/:type response body. */
export const ListRecordsResponseSchema = z
  .object({
    records: z.array(VaultRecordEnvelopeSchema),
    nextCursor: BlindRecordIdSchema.nullable(),
  })
  .strict();
export type ListRecordsResponse = z.infer<typeof ListRecordsResponseSchema>;

/** Generic success response for mutations. */
export const OkResponseSchema = z
  .object({
    ok: z.literal(true),
  })
  .strict();
export type OkResponse = z.infer<typeof OkResponseSchema>;

/**
 * A mail server the relay can reach: implicit TLS on the one port each protocol uses for it.
 * The autoconfig lookup discards anything else a provider publishes (STARTTLS on 143/587, POP3),
 * because the relay accepts only 993 and 465.
 */
export const MailServerSchema = z
  .object({
    host: z.string().min(1).max(253),
    port: z.union([z.literal(993), z.literal(465)]),
  })
  .strict();
export type MailServer = z.infer<typeof MailServerSchema>;

/**
 * `GET /api/v1/autoconfig?domain=` — what a domain publishes about its mail servers. At least one
 * of `imap` / `smtp` is present; a domain with neither is a 404, not an empty answer.
 */
export const MailAutoconfigSchema = z
  .object({
    imap: MailServerSchema.nullable(),
    smtp: MailServerSchema.nullable(),
    /** Whether the login name is the whole address or only the part before the `@`. */
    username: z.enum(['address', 'localpart']),
    /** Where the answer came from — the wording on the form depends on it. */
    source: z.enum(['provider', 'ispdb', 'srv']),
    /** The domain the answer was found under: the asked domain, or the MX host's when that is what answered. */
    sourceDomain: z.string().min(1),
  })
  .strict();
export type MailAutoconfig = z.infer<typeof MailAutoconfigSchema>;
