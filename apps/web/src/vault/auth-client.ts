import { passkeyClient } from '@better-auth/passkey/client';
import { magicLinkClient } from 'better-auth/client/plugins';
import { createAuthClient } from 'better-auth/react';
import { getApiBaseUrl } from './api-base-url.ts';

const authClient = createAuthClient({
  baseURL: getApiBaseUrl(),
  fetchOptions: {
    credentials: 'include',
  },
  plugins: [passkeyClient(), magicLinkClient()],
});

/**
 * Absolute, because Better Auth resolves a relative `callbackURL` against ITS
 * base URL — the API — and a verified link would land on the Worker's 404.
 *
 * Both links land on `/enrol`, and the query is the difference: a recovery link
 * is allowed to reset a live vault, a signup link is not. `/enrol` bounces an
 * already-enrolled account to `/login` unless `?reset=1` says otherwise.
 */
const callbackURL = (path: string) => `${window.location.origin}${path}`;

/**
 * `name` is the email on purpose: Better Auth's passkey plugin uses `user.name` as the WebAuthn
 * `user.name`, which is the label a password manager shows for the passkey. An address is the
 * one label a reader recognises.
 */
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

/**
 * No `name`: the plugin would send it as the WebAuthn `user.name` and every password manager
 * would file the passkey under it instead of under the address.
 */
export const addPasskeyAuthenticator = async (
  extensions?: AuthenticationExtensionsClientInputs,
) => {
  return authClient.passkey.addPasskey({
    extensions,
    returnWebAuthnResponse: true,
  });
};

export const deletePasskeyAuthenticator = async (passkeyId: string) => {
  return authClient.passkey.deletePasskey({
    id: passkeyId,
  });
};

export const signOut = async () => {
  return authClient.signOut();
};

export const getSession = async () => {
  return authClient.getSession();
};
