---
layout: ../layouts/Policy.astro
title: Terms of use
description: The terms for using YOZZ, a free zero-knowledge webmail client over the mail accounts you already have.
updated: 13 November 2026
---

These terms are between you and Fishball Ltd ("we", "us"), which makes YOZZ. They cover the app at
yozz.app, its server at api.yozz.app and the `yozz` command-line tool. By creating an account or
using YOZZ, you agree to them. How we handle your data is in the [privacy policy](/privacy).

Fishball Ltd is registered in England and Wales (company number 16287336), with its registered
office at 66 Paul Street, London, EC2A 4NA.

## What YOZZ is

YOZZ is an email client over mail accounts you already have. It reads your mail over IMAP and sends
it over SMTP. The app in your browser does this through a relay we run, which forwards encrypted
bytes it cannot read; the command-line tool connects to your mail servers directly. YOZZ keeps your
mail passwords and settings in a vault encrypted with a key only you hold.

YOZZ is not a mail provider. It hosts no mailbox and gives you no address. Your mail stays with
your providers, under their terms.

YOZZ is free, and early: it is still being built and will change.

## Your responsibilities

- **Your accounts.** Connect only mail accounts that are yours, or that you are allowed to use.
- **Your providers' terms.** Your mail providers' terms still apply when you use them through YOZZ,
  including any limits on how often you connect or send.
- **Lawful use.** Do not use YOZZ to send spam, to break the law, to harm others, or to attack or
  overload YOZZ, the relay or anyone's mail server.
- **Your password or passkey.** It is the only key to your vault, and we cannot recover it. If you
  lose it, the vault is gone, with your drafts and any mail you sent from an address with no
  mailbox. Keep it safe.

## Availability and changes

Because YOZZ is still being built, we cannot promise that it will always be available or free of
errors. We will provide it with reasonable care and skill. We may suspend or end your access if
you break these terms.

We may change YOZZ, limit it or stop it. If a change would materially reduce what you get from
YOZZ, or we stop it, we will tell you beforehand by email, at the address you sign in with, and you
can stop using YOZZ and delete your account. Smaller changes we simply make. You can stop using
YOZZ and delete your account at any time in Settings › Account.

## Your mail

Your mail stays with your providers, and YOZZ does not replace them: keep your mail there as you
would without YOZZ. YOZZ does keep some things for you in your vault, encrypted: your drafts and
the files attached to them, a copy of each mailbox's list (no message bodies), and mail sent from
an address with no mailbox, of which the vault holds the only copy. If you lose your password or
passkey, or delete your account, that copy is gone with the vault.

## Open source

YOZZ's source is public at [github.com/fishballapp/yozz](https://github.com/fishballapp/yozz).
The app, its server and the command-line tool are licensed under the
[GNU Affero General Public License v3.0](https://www.gnu.org/licenses/agpl-3.0.html). The
`@yozz.app/tls`, `@yozz.app/x509`, `@yozz.app/imap` and `@yozz.app/smtp` libraries are licensed under
the MIT License. Those licences govern the code, and nothing in these terms limits what they allow
you to do with it. These terms cover the service we run at yozz.app. The YOZZ name and logo are
ours.

## Our responsibility for loss

We are responsible for loss or damage you suffer that is a foreseeable result of our breaking these
terms or failing to use reasonable care and skill. Loss is foreseeable if it is obvious it would
happen, or if you and we both knew it might happen when you started using YOZZ.

We are not responsible for:

- loss that was not foreseeable;
- loss caused by your mail providers, or by anything outside our reasonable control;
- losing your vault because you lost your password or passkey, which we cannot recover, as
  explained above;
- loss of business, profits or opportunity.

Nothing in these terms limits our responsibility for death or personal injury caused by our
negligence, or for fraud, or affects your legal rights as a consumer.

## Governing law

These terms are governed by the law of England and Wales. If you live in Scotland or Northern
Ireland, you can also bring a claim in your local courts under your local law. If you live in the
European Union, you keep the protection of the mandatory laws of the country you live in, and you
can bring a claim in its courts.

## Changes to these terms

When these terms change, we update them here and change the date at the top. If a change would
materially reduce your rights or what you get from YOZZ, we will email you at the address you sign
in with before it takes effect, and you can stop using YOZZ and delete your account. Smaller
changes take effect when we publish them.

## Contact

Questions about these terms: [yo@fishball.app](mailto:yo@fishball.app).
