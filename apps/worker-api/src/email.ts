import { createForwardEmailClient } from '@fishballapps/email';
import type { RuntimeEnv } from './env.ts';

export const EMAIL_SENDER = 'no-reply@yozz.app';

export type EmailSender = (input: {
  readonly to: string;
  readonly url: string;
  readonly token: string;
}) => Promise<void>;

export const createProductionEmailSender = (env: RuntimeEnv): EmailSender => {
  const client = createForwardEmailClient({
    alias: EMAIL_SENDER,
    password: env.FORWARD_EMAIL_ALIAS_PASSWORD,
  });

  return async ({ to, url }) => {
    await client.send({
      from: `YOZZ <${EMAIL_SENDER}>`,
      to,
      subject: 'YOZZ sign-in link',
      text: `Your sign-in link for YOZZ:\n\n${url}\n\nThis link is valid for 10 minutes. If you did not request this link, you can safely ignore this email.`,
    });
  };
};

/**
 * Dev only: there is no mailbox to deliver to on localhost, so the link goes to
 * the Worker's terminal. `wrangler dev` prints console output inline.
 */
export const consoleEmailSender: EmailSender = async ({ to, url }) => {
  // biome-ignore lint/suspicious/noConsole: the terminal IS the delivery channel in dev
  console.log(`\n[yozz] magic link for ${to}:\n${url}\n`);
};
