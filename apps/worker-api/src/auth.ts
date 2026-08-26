import { passkey } from '@better-auth/passkey';
import { betterAuth } from 'better-auth';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import { magicLink } from 'better-auth/plugins';
import { withCloudflare } from 'better-auth-cloudflare';
import { DISABLED_ENDPOINTS, ENDPOINT_POLICIES } from './auth-policy.ts';
import { consoleEmailSender, createProductionEmailSender, type EmailSender } from './email.ts';

import { getBaseUrl, getWebOrigin, type RuntimeEnv } from './env.ts';

export type CreateAuthOverrides = {
  readonly emailSender?: EmailSender;
};

/**
 * The `any` is load-bearing and both alternatives were tried and failed, which
 * is why this carries a reason rather than a bare suppression.
 *
 * Dropping the annotation entirely fails with TS2883: the inferred type cannot
 * be named without referencing `MiddlewareOptions` and `StrictEndpoint` from
 * `better-call`, plus two `@simplewebauthn/server` option types, none of which
 * are this package's direct dependencies — the composite build needs a portable
 * type. `ReturnType<typeof betterAuth>` instantiates the generic at its default,
 * whose `appName` is required while ours is optional, so the plugin surface no
 * longer matches. The Better Auth instance type is not exported in a form that
 * survives either.
 */
export const createAuth = (
  env: RuntimeEnv,
  overrides?: CreateAuthOverrides,
  // biome-ignore lint/suspicious/noExplicitAny: see above — TS2883 without it
): ReturnType<typeof betterAuth<any>> => {
  const webOrigin = getWebOrigin(env);
  const rpID = new URL(webOrigin).hostname;
  const emailSender =
    overrides?.emailSender ??
    (env.MODE === 'production' ? createProductionEmailSender(env) : consoleEmailSender);

  return betterAuth(
    withCloudflare(
      {
        d1Native: env.DB,
        autoDetectIpAddress: true,
        geolocationTracking: false,
        cf: {},
      },
      {
        appName: 'YOZZ',
        baseURL: getBaseUrl(env),
        trustedOrigins: [webOrigin],
        secret: env.BETTER_AUTH_SECRET,
        emailAndPassword: {
          enabled: true,
          disableSignUp: true,
        },
        user: {
          changeEmail: {
            enabled: false,
          },
        },
        hooks: {
          before: createAuthMiddleware(async ctx => {
            if (DISABLED_ENDPOINTS.has(ctx.path)) {
              throw new APIError('FORBIDDEN', {
                message: 'Endpoint is disabled',
                code: 'FORBIDDEN',
              });
            }
            await ENDPOINT_POLICIES[ctx.path]?.({
              env,
              overrides,
              body: ctx.body,
              headers: ctx.headers,
            });
          }),
        },
        plugins: [
          magicLink({
            // Better Auth defaults to 300s. The email copy promises 10 minutes,
            // and a link that dies at five while the mail says otherwise is a
            // support ticket, so the config follows the copy rather than the
            // other way round.
            expiresIn: 600,
            sendMagicLink: async ({ email, url, token }) => {
              await emailSender({ to: email, url, token });
            },
          }),
          passkey({
            rpID,
            rpName: 'YOZZ',
            origin: webOrigin,
            /**
             * PRF is requested by the CLIENT, not here, and that is forced by
             * the library rather than chosen. The plugin's `registration.extensions`
             * / `authentication.extensions` are typed as
             * `@simplewebauthn/server`'s `AuthenticationExtensionsClientInputs`,
             * which in 13.3.2 declares only `appid`, `credProps`,
             * `hmacCreateSecret` and `minPinLength` — it has no `prf` member at
             * all. Setting it would need a cast through a type that does not
             * model the extension, with no way to confirm from here that the
             * option survives into the generated options JSON.
             *
             * The supported path is the client's: the plugin merges
             * `opts.extensions` over whatever the server produced
             * (`dist/client.mjs`), and the browser's own DOM types do model
             * `prf`. So `getPrfEvalInput()` travels with every
             * `addPasskey` / `signIn.passkey` call, from the same
             * `PRF_INPUT_LABEL` constant this Worker would have used.
             *
             * The residual: a caller of the generate-options routes that is not
             * our client gets no PRF and completes a ceremony with no key
             * material. Ours is the only client.
             */
          }),
        ],
      },
    ),
  );
};
