// A Resend-shaped client over the forwardemail.net REST API. Web-standard `fetch` only.

export type SendEmailInput = {
  // Defaults to the client's alias. May carry a display name: 'Acme <no-reply@acme.example>'.
  from?: string;
  to: string | readonly string[];
  subject: string;
  text?: string;
  html?: string;
};

export type EmailClient = {
  send: (input: SendEmailInput) => Promise<void>;
};

export type ForwardEmailClientOptions = {
  // Bare address; forwardemail authenticates sends with the alias's own credentials (HTTP Basic).
  alias: string;
  password: string;
};

export const createForwardEmailClient = ({
  alias,
  password,
}: ForwardEmailClientOptions): EmailClient => ({
  send: async ({ from = alias, to, subject, text, html }) => {
    if (text === undefined && html === undefined)
      throw new TypeError('send needs at least one of text/html');
    const response = await fetch('https://api.forwardemail.net/v1/emails', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${btoa(`${alias}:${password}`)}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from,
        to: Array.isArray(to) ? to.join(', ') : to,
        subject,
        ...(text !== undefined && { text }),
        ...(html !== undefined && { html }),
      }),
    });
    if (!response.ok)
      throw new Error(`forwardemail send failed: ${response.status} ${await response.text()}`);
  },
});
