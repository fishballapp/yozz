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

A transport whose `write` can resolve with the bytes still on their way (a relay, say) adds an
optional `flush`, which settles once everything written has gone. `send` awaits it before the
message's terminator, so a drop before then is a refusal rather than `unconfirmed`. A plain socket
leaves it out.

A server that declares a limit (RFC 1870, `SIZE 35882577`) is asked nothing it would refuse: `send`
answers a message over it as `{ kind: 'too-large', limitBytes }` before `MAIL FROM`, so nothing is
written and the connection stays usable. The message is counted as given, before dot-stuffing and
without the terminator. A server that advertises `SIZE` is also told the size on `MAIL FROM`
(`SIZE=<n>`), so one that declares no limit can still refuse there. `SIZE` alone, or `SIZE 0`,
declares no limit; `ehlo` reports the value as `maxMessageBytes`.

`buildMessage` turns composer fields into 7-bit bytes: RFC 2047 headers, 7bit or quoted-printable bodies,
`multipart/alternative` when an HTML rendering is given, `In-Reply-To` + the folded `References` chain for replies.

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
