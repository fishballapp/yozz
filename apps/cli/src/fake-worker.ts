import {
  ADDRESS_RECORD_TYPE,
  type AddressRecord,
  addressRecordSchema,
} from '@yozz.app/mail/addresses/record';
import { createVault, deriveApprovalKeys, generateCliKeyPair, rewrapDek } from '@yozz.app/vault';
import {
  formatCliToken,
  MAX_STORED_BYTES_PER_USER,
  PutRecordRequestSchema,
  type VaultRecordEnvelope,
} from '@yozz.app/vault-contract';
import * as Effect from 'effect/Effect';

// A fake Worker that holds a real vault: the CLI key's wrap, its bearer, address records sealed as
// the browser seals them, and the record routes under compare-and-swap as the Worker answers them.

export const API = 'https://api.yozz.test';
export const WEB = 'https://yozz.test';
export const USER_ID = 'user_1';
export const EMAIL = 'jason@fishball.ltd';
export const KEY_ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
export const TOKEN = formatCliToken({ keyId: KEY_ID, secret: 'S'.repeat(43) });

export type Call = { readonly url: string; readonly method: string; readonly headers: Headers };

type StoredRecord = { readonly envelope: VaultRecordEnvelope };

/** A vault with one CLI key approved, and the Worker routes the CLI calls. */
export const makeWorld = Effect.fnUntraced(function* () {
  const account = {
    encKey: yield* Effect.promise(() =>
      crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['wrapKey', 'unwrapKey']),
    ),
  };
  const { vault, wrappedDek } = yield* Effect.promise(() => createVault(account));
  const cliKey = yield* Effect.promise(() => generateCliKeyPair());
  const approval = yield* Effect.promise(() => deriveApprovalKeys(cliKey.publicKey));
  const wrap = yield* Effect.promise(() => rewrapDek(account, approval, wrappedDek));

  const records = new Map<string, StoredRecord>();
  const calls: Call[] = [];
  /** `refusePuts`: how many record writes from now are refused as conflicts (a write that raced). */
  const state = { isRevoked: false, deleteStatus: 200, refusePuts: 0, isStorageFull: false };
  /** What R2 holds, sealed as the CLI sealed it. */
  const files = new Map<string, Uint8Array<ArrayBuffer>>();

  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  const unauthorized = () =>
    json(401, { error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });

  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input.toString());
    const call = {
      url: url.toString(),
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
    };
    calls.push(call);
    if (url.origin !== API) return json(404, {});
    const isKeyed =
      call.headers.get('authorization') === `Bearer ${TOKEN}` &&
      call.headers.get('yozz-account') === USER_ID;
    if (!isKeyed || state.isRevoked) return unauthorized();

    if (call.method === 'GET' && url.pathname === '/api/v1/vault/cli-key') {
      return json(200, {
        keyId: KEY_ID,
        ephemeralPublicKey: approval.ephemeralPublicKey,
        wrappedDek: wrap,
      });
    }
    if (call.method === 'DELETE' && url.pathname === `/api/v1/vault/cli-keys/${KEY_ID}`) {
      return json(state.deleteStatus, { ok: true });
    }
    const file = /^\/api\/v1\/vault\/files\/([A-Za-z0-9_-]+)$/u.exec(url.pathname)?.[1];
    if (file !== undefined) {
      if (call.method === 'PUT') {
        if (files.has(file)) {
          return json(409, { error: { code: 'CONFLICT', message: 'A file is never replaced' } });
        }
        if (state.isStorageFull) {
          return json(413, { error: { code: 'STORAGE_FULL', message: 'File storage is full' } });
        }
        files.set(file, new Uint8Array(init?.body as Uint8Array<ArrayBuffer>));
        return json(200, { ok: true });
      }
      if (call.method === 'DELETE') {
        files.delete(file);
        return json(200, { ok: true });
      }
      const stored = files.get(file);
      return stored === undefined
        ? json(404, { error: { code: 'NOT_FOUND', message: 'Not found' } })
        : new Response(stored);
    }
    if (call.method === 'GET' && url.pathname === '/api/v1/vault/files') {
      const sizes = [...files].map(([id, { length }]) => ({ id, size: length, createdAt: 0 }));
      return json(200, {
        files: sizes,
        nextCursor: null,
        usedBytes: sizes.reduce((sum, { size }) => sum + size, 0),
        capBytes: MAX_STORED_BYTES_PER_USER,
      });
    }
    // One record a page, so every listing follows the cursor.
    const listed = /^\/api\/v1\/vault\/records\/([a-z-]+)$/u.exec(url.pathname)?.[1];
    if (call.method === 'GET' && listed !== undefined) {
      const ofType = [...records.values()]
        .map(({ envelope }) => envelope)
        .filter(({ type }) => type === listed)
        .toSorted((a, b) => a.id.localeCompare(b.id));
      const after = url.searchParams.get('after');
      const start = after === null ? 0 : ofType.findIndex(({ id }) => id === after) + 1;
      const page = ofType.slice(start, start + 1);
      return json(200, {
        records: page,
        nextCursor: start + 1 < ofType.length ? (page[0]?.id ?? null) : null,
      });
    }
    const record = /^\/api\/v1\/vault\/records\/([a-z-]+)\/([A-Za-z0-9_-]+)$/u.exec(url.pathname);
    if (record !== null) {
      const [, type = '', id = ''] = record;
      const held = records.get(id);
      if (call.method === 'GET') {
        return held === undefined
          ? json(404, { error: { code: 'NOT_FOUND', message: 'Not found' } })
          : json(200, held.envelope);
      }
      if (call.method === 'PUT') {
        const { ciphertext, revision, precondition } = PutRecordRequestSchema.parse(
          JSON.parse(String(init?.body)),
        );
        const isRefused =
          state.refusePuts > 0 ||
          (precondition?.expect === 'absent' && held !== undefined) ||
          (precondition?.expect === 'revision' &&
            (held?.envelope.revision ?? null) !== precondition.revision);
        if (state.refusePuts > 0) state.refusePuts -= 1;
        if (isRefused) {
          return json(409, { error: { code: 'CONFLICT', message: 'Revision mismatch' } });
        }
        records.set(id, { envelope: { id, type, ciphertext, updatedAt: 0, revision } });
        return json(200, { ok: true });
      }
    }
    return json(404, { error: { code: 'NOT_FOUND', message: 'Not found' } });
  }) as typeof globalThis.fetch;

  /** Seals a record at `revision` as the browser would, replacing what the Worker held. */
  const putRecord = (item: {
    readonly type: string;
    readonly naturalKey: string;
    readonly revision: number;
    readonly plaintext: string;
  }) =>
    Effect.promise(async () => {
      const sealed = await vault.encryptRecord(item);
      records.set(sealed.id, { envelope: { ...sealed, updatedAt: 0, revision: item.revision } });
    });

  const putAddress = (record: AddressRecord, revision: number) =>
    putRecord({
      type: ADDRESS_RECORD_TYPE,
      naturalKey: record.address,
      revision,
      plaintext: JSON.stringify(addressRecordSchema.parse(record)),
    });

  /** What `yozz login` would have written for this key. */
  const credentials = {
    apiUrl: API,
    userId: USER_ID,
    email: EMAIL,
    keyId: KEY_ID,
    token: TOKEN,
    privateKey: cliKey.privateKey,
  };

  /** Opens every record of `type` the Worker holds, as the CLI would. */
  const readRecords = (type: string) =>
    Effect.promise(() =>
      Promise.all(
        [...records.values()]
          .filter(({ envelope }) => envelope.type === type)
          .map(({ envelope }) => vault.decryptListedRecord(type, envelope)),
      ),
    );

  /** Removes a stored file, as if R2 had lost it. */
  const loseFile = (fileId: string) => files.delete(fileId);

  /** Opens every file the Worker holds, as a client would. */
  const readFiles = Effect.promise(async () =>
    Object.fromEntries(
      await Promise.all(
        [...files].map(async ([id, sealed]) => [id, await vault.decryptFile(id, sealed)] as const),
      ),
    ),
  );

  return {
    fetch,
    calls,
    state,
    files,
    loseFile,
    readFiles,
    putRecord,
    putAddress,
    readRecords,
    credentials,
  };
});
