# @yozz.app/smtp

Transport-agnostic SMTP client core for YOZZ, plus the RFC 5322 message builder.

```bash
pnpm add @yozz.app/smtp
```

## The seam

`@yozz.app/smtp` speaks SMTP over any `ByteDuplex` (`{ read, write }`, a type it declares itself; a
`@yozz.app/tls` connection satisfies it). No runtime dependencies. It knows replies, EHLO
keywords, AUTH PLAIN / LOGIN, the MAIL / RCPT / DATA sequence and dot-stuffing. It **never knows**
TLS, certificates or the vault. STARTTLS is not spoken: the transport is already TLS (465).

`buildMessage` turns composer fields into 7-bit bytes: RFC 2047 headers, 7bit or quoted-printable bodies,
`multipart/alternative` when an HTML rendering is given, `In-Reply-To` + `References` for replies.

## Tests

```bash
pnpm -F @yozz.app/smtp test
```

## Live

```bash
pnpm -F @yozz.app/smtp live                              # banner + EHLO on nine hosts over 465
YOZZ_SMTP_HOST=smtp.example.com YOZZ_SMTP_USER=me@example.com YOZZ_SMTP_PASSWORD=… \
  YOZZ_SMTP_TO=me@example.com pnpm -F @yozz.app/smtp live smtp.example.com   # auth + one real send
```
