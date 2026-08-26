// Transactional email over the forwardemail.net REST API, behind a Resend-shaped client
// (`createForwardEmailClient(...).send({ from?, to, subject, text/html })`) so consumers never
// touch the provider wire format and a provider swap stays inside this package. Web-standard
// `fetch` only — runs on workerd and Node alike.

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
  // The sending alias (bare address, e.g. no-reply@acme.example) — forwardemail authenticates
  // sends with the alias's own credentials (HTTP Basic: alias as username).
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
