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
