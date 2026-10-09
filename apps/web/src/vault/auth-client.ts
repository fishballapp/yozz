import { passkeyClient } from '@better-auth/passkey/client';
import { ACCOUNT_HEADER } from '@yozz.app/vault-contract';
import { magicLinkClient } from 'better-auth/client/plugins';
import { createAuthClient } from 'better-auth/react';
import { getApiBaseUrl } from './api-base-url';

/** Signing in names no account: whoever signs in is the account. */
const authClient = createAuthClient({
  baseURL: getApiBaseUrl(),
  fetchOptions: {
    credentials: 'include',
  },
  plugins: [passkeyClient(), magicLinkClient()],
});

/**
 * Names `userId` on every request (`ACCOUNT_HEADER`), which the Worker refuses under any other
 * account's session. A client of its own because the passkey plugin sends call-site options with
 * the registration it verifies, never with the options it asks for. Inert until something
 * subscribes to its session, which nothing does.
 */
const accountAuthClient = (userId: string) =>
  createAuthClient({
    baseURL: getApiBaseUrl(),
    fetchOptions: {
      credentials: 'include',
      headers: { [ACCOUNT_HEADER]: userId },
    },
    plugins: [passkeyClient()],
  });

/**
 * Absolute: Better Auth resolves a relative `callbackURL` against its own base URL, the API.
 * Both links land on `/enrol`; `?reset=1` is what lets a recovery link reset a live vault.
 */
const callbackURL = (path: string) => `${window.location.origin}${path}`;

/** The email on purpose: the passkey plugin uses `user.name` as the WebAuthn `user.name`, the label a password manager shows. */
export const requestSignupLink = async (email: string) => {
  return authClient.signIn.magicLink({
    email,
    name: email,
    callbackURL: callbackURL('/enrol'),
  });
};

export const requestRecoveryLink = async (email: string) => {
  return authClient.signIn.magicLink({
    email,
    callbackURL: callbackURL('/enrol?reset=1'),
  });
};

export const signInWithPassword = async (email: string, authValue: string) => {
  return authClient.signIn.email({
    email,
    password: authValue,
  });
};

export const signInWithPasskey = async (extensions?: AuthenticationExtensionsClientInputs) => {
  return authClient.signIn.passkey({
    extensions,
    returnWebAuthnResponse: true,
  });
};

/** No `name`, or every password manager files the passkey under it. */
export const addPasskeyAuthenticator = async ({
  userId,
  extensions,
}: {
  readonly userId: string;
  readonly extensions?: AuthenticationExtensionsClientInputs;
}) => {
  return accountAuthClient(userId).passkey.addPasskey({
    extensions,
    returnWebAuthnResponse: true,
  });
};

export const deletePasskeyAuthenticator = async ({
  userId,
  passkeyId,
}: {
  readonly userId: string;
  readonly passkeyId: string;
}) => {
  return accountAuthClient(userId).passkey.deletePasskey({ id: passkeyId });
};

/** Signs `userId` out, and nobody who signed in since. */
export const signOut = async (userId: string) => {
  return accountAuthClient(userId).signOut();
};

export const getSession = async () => {
  return authClient.getSession();
};
