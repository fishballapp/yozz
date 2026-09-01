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

export const createAuth = (
  env: RuntimeEnv,
  overrides?: CreateAuthOverrides,
  // biome-ignore lint/suspicious/noExplicitAny: without it the inferred type is not portable (TS2883), and `ReturnType<typeof betterAuth>` instantiates a generic whose `appName` is required
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
            // The email copy promises 10 minutes.
            expiresIn: 600,
            sendMagicLink: async ({ email, url, token }) => {
              await emailSender({ to: email, url, token });
            },
          }),
          passkey({
            rpID,
            rpName: 'YOZZ',
            origin: webOrigin,
            // PRF is requested by the client: the plugin's `extensions` type has no `prf` member.
          }),
        ],
      },
    ),
  );
};
