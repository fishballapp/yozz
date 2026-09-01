import type { EncryptedRecord } from '@yozz.app/vault';
import {
  type ApiErrorCode,
  ApiErrorResponseSchema,
  ListRecordsResponseSchema,
  PasskeyWrapResponseSchema,
  type PutPrecondition,
  type UnlockStatusResponse,
  UnlockStatusResponseSchema,
  type VaultRecordEnvelope,
  VaultRecordEnvelopeSchema,
} from '@yozz.app/vault-contract';
import { getApiBaseUrl } from './api-base-url.ts';

export class VaultApiError extends Error {
  readonly code: ApiErrorCode | 'NETWORK_ERROR';
  readonly status: number;

  constructor(code: ApiErrorCode | 'NETWORK_ERROR', message: string, status = 500) {
    super(message);
    this.name = 'VaultApiError';
    this.code = code;
    this.status = status;
  }
}

export type VaultApi = {
  readonly get: (type: string, id: string) => Promise<VaultRecordEnvelope | null>;
  readonly list: (type: string) => AsyncIterable<VaultRecordEnvelope>;
  /** `revision` is the number sealed in the ciphertext, restated in the clear for CAS; `precondition` omitted is last-write-wins. */
  readonly put: (
    record: EncryptedRecord,
    revision: number,
    precondition?: PutPrecondition,
  ) => Promise<void>;
  readonly remove: (type: string, id: string, ifRevision?: number) => Promise<void>;
};

export type VaultApiClient = VaultApi & {
  readonly getUnlockStatus: () => Promise<UnlockStatusResponse>;
  readonly getPasskeyWrap: (credentialId: string) => Promise<string>;
  readonly finalizePasswordUnlock: (input: {
    readonly isNewVault: boolean;
    readonly wrappedDek: string;
    readonly authValue: string;
  }) => Promise<void>;
  readonly finalizePasskeyUnlock: (input: {
    readonly isNewVault: boolean;
    readonly credentialId: string;
    readonly wrappedDek: string;
  }) => Promise<void>;
  readonly resetVault: () => Promise<void>;
};

const parseErrorResponse = async (res: Response): Promise<VaultApiError> => {
  try {
    const json = await res.json();
    const parsed = ApiErrorResponseSchema.safeParse(json);
    if (parsed.success) {
      return new VaultApiError(parsed.data.error.code, parsed.data.error.message, res.status);
    }
  } catch {}
  return new VaultApiError(
    'INTERNAL_ERROR',
    `HTTP request failed with status ${res.status}`,
    res.status,
  );
};

export const createVaultApiClient = (
  baseUrl = getApiBaseUrl(),
  customFetch: typeof fetch = fetch,
): VaultApiClient => {
  const request = async (path: string, init?: RequestInit): Promise<Response> => {
    const url = `${baseUrl.replace(/\/+$/, '')}${path}`;
    const headers = new Headers(init?.headers);
    if (!headers.has('Content-Type') && init?.body) {
      headers.set('Content-Type', 'application/json');
    }

    try {
      return await customFetch(url, {
        ...init,
        headers,
        credentials: 'include',
      });
    } catch (err) {
      throw new VaultApiError('NETWORK_ERROR', `Network error: ${String(err)}`, 0);
    }
  };

  const get = async (type: string, id: string): Promise<VaultRecordEnvelope | null> => {
    const res = await request(
      `/api/v1/vault/records/${encodeURIComponent(type)}/${encodeURIComponent(id)}`,
      { method: 'GET' },
    );

    if (res.status === 404) {
      return null;
    }

    if (!res.ok) {
      throw await parseErrorResponse(res);
    }

    const json = await res.json();
    return VaultRecordEnvelopeSchema.parse(json);
  };

  /** The cursor is the recursion. */
  const list = async function* (type: string, after?: string): AsyncGenerator<VaultRecordEnvelope> {
    const query = after === undefined ? '' : `?after=${encodeURIComponent(after)}`;
    const res = await request(`/api/v1/vault/records/${encodeURIComponent(type)}${query}`, {
      method: 'GET',
    });
    if (!res.ok) {
      throw await parseErrorResponse(res);
    }

    const page = ListRecordsResponseSchema.parse(await res.json());
    yield* page.records;
    if (page.nextCursor !== null) {
      yield* list(type, page.nextCursor);
    }
  };

  const put = async (
    record: EncryptedRecord,
    revision: number,
    precondition?: PutPrecondition,
  ): Promise<void> => {
    const res = await request(
      `/api/v1/vault/records/${encodeURIComponent(record.type)}/${encodeURIComponent(record.id)}`,
      {
        method: 'PUT',
        body: JSON.stringify({
          ciphertext: record.ciphertext,
          revision,
          ...(precondition === undefined ? {} : { precondition }),
        }),
      },
    );

    if (!res.ok) {
      throw await parseErrorResponse(res);
    }
  };

  const remove = async (type: string, id: string, ifRevision?: number): Promise<void> => {
    const query = ifRevision === undefined ? '' : `?ifRevision=${ifRevision}`;
    const res = await request(
      `/api/v1/vault/records/${encodeURIComponent(type)}/${encodeURIComponent(id)}${query}`,
      { method: 'DELETE' },
    );

    if (!res.ok) {
      throw await parseErrorResponse(res);
    }
  };

  const getUnlockStatus = async (): Promise<UnlockStatusResponse> => {
    const res = await request('/api/v1/vault/unlock', { method: 'GET' });
    if (!res.ok) {
      throw await parseErrorResponse(res);
    }
    const json = await res.json();
    return UnlockStatusResponseSchema.parse(json);
  };

  const getPasskeyWrap = async (credentialId: string): Promise<string> => {
    const res = await request(`/api/v1/vault/unlock/passkey/${encodeURIComponent(credentialId)}`, {
      method: 'GET',
    });
    if (!res.ok) {
      throw await parseErrorResponse(res);
    }
    const json = await res.json();
    const parsed = PasskeyWrapResponseSchema.parse(json);
    return parsed.wrappedDek;
  };

  const finalizePasswordUnlock: VaultApiClient['finalizePasswordUnlock'] = async input => {
    const res = await request('/api/v1/vault/unlock', {
      method: 'PUT',
      body: JSON.stringify({ mode: 'password', ...input }),
    });
    if (!res.ok) {
      throw await parseErrorResponse(res);
    }
  };

  const finalizePasskeyUnlock: VaultApiClient['finalizePasskeyUnlock'] = async input => {
    const res = await request('/api/v1/vault/unlock', {
      method: 'PUT',
      body: JSON.stringify({ mode: 'passkey', ...input }),
    });
    if (!res.ok) {
      throw await parseErrorResponse(res);
    }
  };

  const resetVault = async (): Promise<void> => {
    const res = await request('/api/v1/vault', { method: 'DELETE' });
    if (!res.ok) {
      throw await parseErrorResponse(res);
    }
  };

  return {
    get,
    list,
    put,
    remove,
    getUnlockStatus,
    getPasskeyWrap,
    finalizePasswordUnlock,
    finalizePasskeyUnlock,
    resetVault,
  };
};

export const vaultApi = createVaultApiClient();
