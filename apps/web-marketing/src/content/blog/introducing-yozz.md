---
title: "Introducing YOZZ · Zero-knowledge webmail for your own addresses"
description: "YOZZ is a zero-knowledge webmail client over the mail accounts you already own: one inbox, unlimited send-as over your own SMTP, and a terminal CLI."
heading: "Introducing YOZZ"
summary: "One inbox for the mail accounts you already own, unlimited send-as over your own SMTP, and a client that does less than Gmail."
publishedOn: 2026-11-27
kind: "update"
---

YOZZ is live at [yozz.app](https://yozz.app). It is a webmail client over the mail accounts you
already own: your personal Gmail, your work account, and the custom-domain addresses you run for a
side project or a small company. It never hosts mailboxes and issues no `@yozz.app` addresses.

Two choices define it. You can send from as many addresses as you own, each over its own SMTP
server, and the client has fewer features than Gmail on purpose.

## Why we built it

If you live in more than one address, you usually end up in one of two setups: several Gmail tabs
open side by side, or your custom-domain mail routed in and out of one Gmail inbox.

That second setup is coming to an end. In January 2027, Google fully removes "Send mail as",
POP fetch and Gmailify for third-party addresses in Gmail. If you currently write as
`you@yourdomain.com` from inside Gmail, that stops working.

In YOZZ, multiple identities are the normal case rather than a setting buried three screens deep.
Connect as many accounts as you want, read them as one unified **Inbox** or one address at a time,
and send from any identity over the SMTP server you already use. A **send-only** address with no
inbox behind it is a first-class address here, not an error. When you start a new message, **From**
starts blank so you pick the identity explicitly instead of firing off a note from whichever
account happened to be listed first.

## Fewer features than Gmail, on purpose

Most mail clients answer Gmail with more: AI side panels, inbox tabs, categories, promotions, chat,
meetings and calendars.

YOZZ goes the other way. It is deliberately smaller — the minimum client that can run a working
life across several accounts, keeping Gmail's three-pane shape so your habits carry over. Every
addition has to push something else out.

What is here:

- One unified inbox for everything, or one address at a time.
- Threads, stars, archive, junk, trash and search across every connected address.
- A plain-text Markdown composer with a preview step before Send, and drafts that follow you
  between devices.
- Received HTML rendered in a sandboxed frame with no network and remote images off until you ask
  — once for a message, or always for a sender once client-side DKIM checks confirm the mail came
  from that domain.

What is deliberately left out:

- No assistant in a side panel, no tabs or promotions, no chat, meetings or calendar.
- **No light theme.** YOZZ ships one dark surface and no toggle.
- **No keyboard-shortcut layer.** Standard Tab, Enter and arrow navigation works everywhere, but
  there is no command palette and no single-key shortcuts to memorise.

## Zero-knowledge webmail, and where the boundary sits

The usual way to build a webmail client over third-party accounts is to ask for your mail password,
connect to IMAP from the app's own servers, and sync your mailbox into their database. That hands
another company a full, readable copy of your email.

YOZZ starts from one rule: **our servers never hold anything they can read.**

Browsers cannot open raw TCP sockets directly, so YOZZ runs a Cloudflare Worker relay at
`api.yozz.app`. When your browser connects to a mail server, the relay opens a plain TCP socket
(`secureTransport` left at `"off"`) and copies bytes both ways. It parses no IMAP, holds no keys
and stores nothing. Your browser performs the TLS 1.3 or modern TLS 1.2 (ephemeral ECDHE + AES-GCM)
handshake straight to your mail server using our TypeScript TLS and X.509 implementation over
WebCrypto, validates the certificate chain itself, and speaks IMAP and SMTP inside that tunnel.

Your mail passwords and server settings are encrypted on your device before YOZZ stores them, with
a key derived from your passkey (via WebAuthn PRF) or your password. That key never reaches us.

YOZZ is a **zero-knowledge webmail client**: our servers keep ciphertext they cannot open, and our
relay forwards encrypted bytes it cannot read. If we were breached or subpoenaed, there is no
readable mailbox or credential store to hand over. **YOZZ does not create another readable copy of
your mailbox** — your mail stays wherever it already lives.

Four kinds of mail-derived data do reach our servers, all sealed under your key like your stored
passwords:

- your drafts, and the files you attach to them, so a draft started on a laptop is waiting on your
  phone;
- mail sent from a send-only address, because no mailbox exists to hold a Sent copy;
- a copy of each mailbox's list — sender, recipients, subject, dates, flags and attachment names,
  with no message bodies — so a new device shows a recent list at once;
- which messages and senders you have allowed remote images for.

Zero-knowledge here has a clear boundary, and it belongs next to the claim:

- **Not end-to-end encrypted email.** Your existing mail providers keep whatever access they
  already have. YOZZ signs in to them as you, like any other mail client.
- **Operational metadata is visible.** Our servers still see the email address you sign in to YOZZ
  with; your sessions, including IP address and browser; which IMAP and SMTP hosts you connect to
  through the relay, when, and how many bytes cross; how many encrypted records and files you keep,
  each record's type (`address`, `draft`, `sent` and so on), their sizes and when they changed;
  your passkeys' public keys; and the names and timestamps of any CLI you approve. Every item is
  listed in the [privacy policy](/privacy).
- **Auditable code, not a mathematical guarantee.** Because we serve the JavaScript that runs in
  your browser and does the encryption, this describes the published architecture and today's
  deployment rather than a proof against malicious replacement code. The source is public at
  [github.com/fishballapp/yozz](https://github.com/fishballapp/yozz), and production deploys from
  that repository.
- **No vault recovery.** Because we never hold your key, we cannot reset your vault. Lose your
  passkey or password and the vault is gone, along with your drafts and any mail sent from a
  send-only address. Everything at your mail providers is untouched: make a new vault and add your
  addresses again.

## Honest trade-offs and current limits

Keeping credentials off our servers has real costs, and YOZZ is still early:

- **No background sync or notifications while the tab is closed.** A service that can wake up to
  check your mail is a service that holds your mail passwords. We accept that cost rather than
  moving sync onto our servers.
- **IMAP on port 993 and SMTP on port 465 only.** YOZZ supports implicit TLS only, so there is no
  port 587 STARTTLS and no plaintext upgrade phase to strip. OAuth sign-in is not built yet, so
  Gmail connects with an app password. We test the encrypted connection against nine providers
  (Gmail, Fastmail, Forward Email, Gandi, Disroot, mailbox.org, Riseup, Migadu and Posteo), and any
  server with IMAP on 993 and SMTP on 465 should work.
- **No native phone app yet.** YOZZ is web-first; the web app works on a phone while native apps
  wait.

## From a terminal, or with an agent

Because our servers hold only ciphertext, there is no server-side mail API for a script or an agent
to call. Instead, we shipped two ways to work with your mailbox where it is actually decrypted.

First, the `yozz` CLI (`@yozz.app/cli` on npm, Node 26+). It is a full second mail client: approve
a pairing code in an unlocked `yozz.app` tab, and it unlocks your vault on your machine and speaks
IMAP and SMTP directly to your own servers over TLS without using the relay. Every command prints
one JSON document, and drafting and sending are separate commands so a coding agent can prepare
replies for you to check before anything goes out:

```sh
npm i -g @yozz.app/cli
yozz login
yozz list --query 'is:unread'
yozz draft --reply 'mid/<message-id>' --text @reply.md
```

Second, an unlocked `yozz.app` tab registers six WebMCP tools (`get_addresses`, `get_threads`,
`update_threads`, `save_draft`, `delete_draft` and `navigate`) for agents that drive your browser.
Reading changes nothing, and **no browser tool can send**: an agent writes a draft into your
encrypted vault, and you press Send.

## Open source and libraries

YOZZ's source is public at [github.com/fishballapp/yozz](https://github.com/fishballapp/yozz). The
web app, Worker backend and CLI are licensed under AGPL-3.0.

To run mail from a browser without a backend reading it, we wrote four TypeScript protocol
libraries with no native code — [`@yozz.app/tls`](https://www.npmjs.com/package/@yozz.app/tls),
[`@yozz.app/x509`](https://www.npmjs.com/package/@yozz.app/x509),
[`@yozz.app/imap`](https://www.npmjs.com/package/@yozz.app/imap) and
[`@yozz.app/smtp`](https://www.npmjs.com/package/@yozz.app/smtp) — and published them on npm under
the MIT licence. They run in browsers and Node alike, and CI runs `@yozz.app/tls` against
BoringSSL's BoGo suite and `@yozz.app/x509` against x509-limbo on every push.

If a mail server misbehaves or you hit a rough edge, open an issue at
[github.com/fishballapp/yozz/issues](https://github.com/fishballapp/yozz/issues).
