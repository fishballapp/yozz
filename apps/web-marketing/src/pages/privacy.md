---
layout: ../layouts/Policy.astro
title: Privacy policy
description: What YOZZ's servers hold and can read, what they cannot, what your browser keeps, who else handles your data, why, for how long, and how to delete it.
updated: 13 November 2026
---

YOZZ is a zero-knowledge webmail client: a client over mail accounts you already have. Our servers
cannot read your mail passwords, the encrypted records YOZZ keeps for you, or mail crossing our
relay. They can see some things, and this page lists them. It covers the app at yozz.app, its
server at api.yozz.app, the `yozz` command-line tool and these pages.

Zero-knowledge describes the servers we run. It is not end-to-end encrypted email: your mail
provider keeps whatever access it already has. And because we serve the code that encrypts, this
describes the published code and today's deployment, which you can check at
[github.com/fishballapp/yozz](https://github.com/fishballapp/yozz).

## Who we are

YOZZ is made by Fishball Ltd, a company registered in England and Wales (company number 16287336),
with its registered office at 66 Paul Street, London, EC2A 4NA. It is the controller of the
personal data described here. Write to us at [yo@fishball.app](mailto:yo@fishball.app).

## What our servers cannot read

- **Your mail passwords and server settings.** Your device encrypts them before YOZZ stores them,
  with a key made from your password or your passkey. That key never reaches us.
- **Mail crossing the relay.** Your browser opens the encrypted connection (TLS) to your mail
  server itself. The relay copies bytes it has no key for, and stores none of them.
- **What we store for you, sealed under your key:**
  - your drafts, and the files you attach to them;
  - mail sent from an address with no mailbox, of which YOZZ keeps the only copy;
  - a copy of each mailbox's list, so a new device shows it at once: for every folder YOZZ syncs
    except Junk (Inbox, Sent, Archive, Trash and Drafts), each message's sender and recipients
    (to, cc and bcc), subject, date, size, flags, message IDs and attachment names, and no bodies;
  - which messages and senders you have allowed remote images for.

Your mail's bodies, subjects and senders, and your mail passwords, never reach our servers in the
clear.

## What our servers can see

- **The email address you sign in with**, and when your account was made. It cannot be changed.
- **How you sign in**: a password or a passkey. With a password, we keep a hash of a value your
  device derives from it, which cannot open your vault.
- **Each sign-in session**: when it started, when it was last renewed and when it ends, and the IP
  address and browser (user agent) it was made from.
- **Your passkeys**: each one's public key, the name it is shown under (made from your browser and
  device, such as "Chrome on Mac", unless you rename it), the kind of authenticator, whether it is
  synced, how it connects (such as USB or built in) and when it was added.
- **Each `yozz` command-line tool you approve**: the name you gave it, its public keys, when it was
  approved and when it was last used.
- **Your encrypted records and files**: how many you keep, the kind of each record (an address, a
  draft and so on), their sizes and when they changed.
- **A sign-in link or passkey sign-in in progress**: the address or account it is for, and a
  random code that matches it.
- **Which mail servers you connect to through the relay**, when, and how many bytes cross. Our
  servers keep none of this beyond the logs below.
- **The domain of an address you add**, when YOZZ looks up its mail settings for you.

### Logs

Our servers run on Cloudflare, which keeps logs of requests to them for 7 days: a request's time,
the address it asked for and its result. A connection through the relay names the mail server and
port in its address, and a settings lookup names the domain. When a relay connection fails, the log
also says which mail server it was. Cloudflare sees your IP address with every request, as any host
does.

## Analytics, on the home page only

We count visits to the home page, yozz.app/, with PostHog, in PostHog's EU cloud: page views, time
on the page, and clicks on its "Start using YOZZ" and "Log in" links. Nothing else is recorded: no
session recordings, no heatmaps, no automatic click tracking, no scroll depth.

- **Before you choose** in the cookie banner, we count your visit without cookies, and nothing is
  stored in your browser. PostHog tells visitors apart by a hash of your IP address and browser,
  made with a value that changes every day and is then deleted, so it cannot follow you from one
  day to the next.
- **If you accept**, PostHog stores a random ID in a cookie and in your browser's storage, so it
  can tell a returning visitor from a new one, and it records that you accepted. It also works out
  your country and city from your IP address before discarding the address.
- **If you reject**, we keep counting your visits without cookies, as before you chose. If you
  had accepted before, PostHog's cookie and its stored ID are removed; an ID for the browser tab
  stays in session storage until you close the tab. PostHog keeps a note in your browser that you
  declined.
- **If you already use YOZZ** in this browser, the home page sends you on to the app without
  counting you.

Each count carries the full address of the page, including any campaign tags in it (such as
`utm_source`), with advertising click IDs masked; the page's title; the page you came from; your
browser's user agent, which names your browser, operating system and their versions; the kind of
device; your browser's language and time zone; the size of your screen and of the browser window;
and the time. After you accept, it also carries the random ID and IDs for your visit and browser
tab, and the page and referrer you arrived with.

PostHog receives your IP address with each count, as any server does. Our project is set to discard
it, so PostHog does not store it.

Change your mind any time with "Cookie settings" at the foot of the home page, or at
[yozz.app/?cookie-settings](/?cookie-settings), which opens the choice even when you are signed in.
A visit to that page is counted only if you accept.

The app, these policy pages and the command-line tool send nothing to PostHog.

## Cookies and what your browser keeps

On **api.yozz.app**:

- `__Secure-better-auth.session_token` keeps you signed in. It lasts 7 days and is renewed, at most
  once a day, while you use YOZZ. Logging out ends it.
- `__Secure-better-auth-passkey` lasts 5 minutes, while you sign in with a passkey or add one. It
  matches your browser to that sign-in.

On **yozz.app**, cookies:

- `yozz-signed-in` says this browser is signed in, so yozz.app/ opens the app instead of the home
  page. It holds no identity. It lasts 400 days and is written again each time you unlock; logging
  out and deleting your account clear it.
- `ph_<project key>_posthog`, only if you accept analytics: PostHog's random ID. It lasts 1 year,
  belongs to yozz.app alone, and is never sent to api.yozz.app.

On **yozz.app**, the browser's local storage:

- `fishball.cookie-consent`, your cookie banner choice. It has no expiry: it stays until you clear
  this site's data in your browser.
- PostHog's `__ph_opt_in_out_<project key>`, a note of whether you accepted or declined, once you
  choose; and, if you accept, `ph_<project key>_posthog`, the same random ID as the cookie.
- The app's layout: pane widths (`yozz:rail-width`, `yozz:list-width`), how messages are shown
  (`yozz:reading-mode`) and whether to ask before loading remote images
  (`yozz:ask-before-remote-images`).
- `yozz:draft:<account ID>`, a readable copy of the message you are writing, so a reload does not
  lose it. It goes when you send or discard the message. Logging out and deleting your account
  leave it.

On **yozz.app**, the browser's session storage, which goes when you close the tab:

- PostHog's `ph_<project key>_posthog` and `ph_<project key>_window_id`, only if you accept.
- `yozz:reloaded-for-preload`, the time the app last reloaded itself after an update.

On **yozz.app**, in the browser's IndexedDB database `yozz-device-state`:

- Your unlock keys, in a form the page cannot export.
- A cache of your mailbox lists and of the messages the app has fetched, kept readable on the
  device as any mail app's cache is, not encrypted by YOZZ.
- Revision marks: for each of your encrypted records, the version this device last saw. No content.
- TLS session tickets, one for each mail server (host and port) you have connected to, so
  reconnecting is faster. Each is used once.

The **`yozz` command-line tool** keeps, on the computer it runs on: its sign-in key, in
`credentials.json` under your config folder (usually `~/.config/yozz/`); its revision marks, under
`~/.local/state/yozz/`; and its mail cache, encrypted, under `~/.cache/yozz/`.

### What logging out and deleting remove from your devices

- **Logging out** in the app ends the session, and in this browser deletes your unlock keys and
  the mail cache and clears `yozz-signed-in`. It leaves the revision marks, the TLS session
  tickets, the layout settings, any copy of a message you were writing, and your cookie choice and
  PostHog's storage. Your other devices are not touched.
- **Deleting your account** in the app does the same in this browser, and also deletes the
  revision marks. On your other devices it ends every session, but what each browser keeps stays
  there until you clear yozz.app's data in it.
- **`yozz logout`** revokes the tool's key and deletes its files on that computer (the sign-in key,
  unless it came from the `YOZZ_CLI_KEY` environment variable, the revision marks and the cache). Deleting your account revokes every tool's key, but leaves their files until you
  run `yozz logout` on each computer or delete the folders above.

## Who else handles your data

- **Cloudflare** hosts yozz.app and api.yozz.app: the app, our database, the encrypted files, the
  relay and the logs above. Everything listed under "What our servers can see" is held there.
  [Privacy policy](https://www.cloudflare.com/privacypolicy/)
- **Cloudflare's DNS resolver** (cloudflare-dns.com) answers lookups. Our servers ask it for your
  mail servers' addresses and for an added domain's mail records. In the app, your browser asks it
  directly for the keys that check who sent a message, so it sees the domains of the mail you
  open, from your IP address.
- **Forward Email** (forwardemail.net) sends your sign-in links. It receives your email address and
  the link. [Privacy policy](https://forwardemail.net/en/privacy)
- **Mail settings lookups.** When you add an address, our servers ask for its mail settings:
  Mozilla's Thunderbird settings database (autoconfig.thunderbird.net), the domain's own settings
  servers if it has them, and the mail provider found through the domain's MX record (that
  provider's settings servers, and the Thunderbird database's entry for it). They receive the
  domain, or the provider's domain, from our servers, not your address.
- **PostHog**, in its EU cloud, counts visits to the home page (above).
  [Privacy policy](https://posthog.com/privacy)
- **Remote images.** If you load a message's remote images, your browser fetches them from
  wherever the sender put them, and that server sees your IP address.
- **The `yozz` command-line tool** connects to your mail servers directly from your computer, not
  through our relay, and asks your computer's own DNS resolver for the keys that check who sent a
  message. It reaches api.yozz.app for your encrypted records.

We do not sell your data or use it for advertising.

## Why we use it, and on what lawful basis

- **To provide YOZZ under our agreement with you** (contract): your account, signing in and its
  sessions, your passkeys and approved command-line tools, the vault, the relay, the mail settings
  lookup and the sign-in emails. We need your email address to make an account: it is how you sign
  in and where your sign-in links go.
- **In our legitimate interests:**
  - keeping YOZZ working and secure: the request logs, the IP address and browser recorded with
    each session, and limits on how often the relay and settings lookup can be used;
  - knowing how many people visit the home page and whether it leads them to try YOZZ: the count
    without cookies. You can object at any time by writing to us.
- **With your consent:** PostHog's cookie and storage, and what they allow: recognising a returning
  visitor and working out your country and city. Withdraw it at any time with "Cookie settings".

The cookies and storage the app needs to work (the session, `yozz-signed-in`, your unlock keys and
the cache) and the note of your cookie choice are strictly necessary, so they need no consent.

## How long we keep it

- **Your account and everything stored for it:** until you delete the account.
- **A sign-in session** stops working when you log out or 7 days after it was last renewed. Its
  record, with its IP address and browser, is deleted when you log out, when an expired session's
  cookie is next used, or when you delete your account. A session that expired in a browser that
  never comes back stays in our database until you delete your account.
- **A sign-in link** works for 10 minutes; a passkey sign-in in progress, for 5. Each one's record
  is deleted when it is used or when you delete your account. One never used stays in our
  database, even for an address that never became an account, because we do not yet clear them on
  a schedule. Write to us and we will delete it.
- **Cloudflare's request logs:** 7 days.
- **The home page's visit counts at PostHog:** no longer than 2 years.
- **What your browser and the command-line tool keep:** until you log out or delete it, as above.

## Deleting your data

- **Delete account** (Settings › Account) deletes your account, your email address, every sign-in
  session and sign-in method, your passkeys, every encrypted record and file, your approved
  command-line tools and any pending sign-in links. Request logs expire on their own within 7
  days.
- **Start again**, offered when you sign in with a link but cannot unlock, deletes every encrypted
  record and file, your password or passkeys and your approved command-line tools. Your account,
  your email address and your sign-in sessions stay, so you can make a new vault.
- Neither reaches your mail. What is at your providers, including the Sent copies and drafts YOZZ
  put in your mailboxes, stays there.

**There is no recovery.** We never hold the key to your vault, so if you lose your password or
passkey, we cannot open it for you. You can start again and add your addresses back.

## Your mail provider

YOZZ signs in to your mail accounts as you. Your provider keeps the access it already has to your
mail and sees YOZZ's connections like any other mail app's. Its own privacy policy applies to your
mail.

## Your rights

If you are in the UK or the EU, you can ask us for a copy of the personal data we hold about you,
to correct it, to delete it, to restrict or object to how we use it, or to receive it in a portable
form, and you can withdraw consent at any time. Write to [yo@fishball.app](mailto:yo@fishball.app).
We answer within a month.

A copy includes everything listed under "What our servers can see", and your sealed records and
files exactly as we store them. We cannot open those for you: only your own devices can.

You can also complain to the UK Information Commissioner's Office at
[ico.org.uk](https://ico.org.uk), or to the data protection authority where you live.

## Where your data goes

We are based in the UK. Some of the companies above handle data outside the UK, under safeguards
they publish:

- **Cloudflare** runs a global network. For data it moves from the UK to the United States, it
  relies on its certification under the UK Extension to the EU-U.S. Data Privacy Framework, and on
  standard contractual clauses for other transfers.
- **Forward Email**'s data processing agreement applies the EU standard contractual clauses and the
  UK's International Data Transfer Addendum to transfers that no adequacy decision covers.
- **PostHog** keeps our project in its EU cloud; UK law treats the EU as adequate. For data that
  reaches PostHog in the United States, it relies on the UK Extension to the EU-U.S. Data Privacy
  Framework, and its data processing agreement includes standard contractual clauses with the UK
  Addendum.
- **Mozilla's settings database and a domain's own settings servers** receive only a domain name.
  Ask us about the safeguards for these, or any of the above, and we will tell you what we know.

## Children

YOZZ is not meant for children under 13. If you think a child has given us their data, write to
us and we will delete it.

## Changes

When this policy changes, we update it here and change the date at the top. If a change affects
what we do with data you have already given us, we will email the address you sign in with before
it takes effect.
