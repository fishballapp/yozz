# @yozz.app/imap

Transport-agnostic IMAP4rev2/rev1 client core for YOZZ.

```bash
pnpm add @yozz.app/imap
```

## The seam

`@yozz.app/imap` speaks IMAP over any `ByteDuplex` (`{ read(): Promise<Uint8Array | null>; write(bytes): Promise<void> }`),
a type it declares itself; a `@yozz.app/tls` connection satisfies it, and so does anything else with
those two methods. The package has no runtime dependencies. It knows protocol lines, `{n}` literals, command state, and RFC 2047 header
decoding. It **never knows** TLS records, certificates, session keys, or vault storage.

In the browser, the duplex wraps `@yozz.app/tls` over the production WebSocket relay. In tests, it
wraps in-memory transcript drivers without network. In the live harness, it connects through
`@yozz.app/tls` over TCP sockets.

## Running tests

```bash
pnpm -F @yozz.app/imap test
```

## Running the live harness

Tests real IMAP servers across the nine host matrix:

```bash
pnpm -F @yozz.app/imap live
```

Or for a specific host with authentication:

```bash
YOZZ_IMAP_HOST=imap.example.com YOZZ_IMAP_USER=me@example.com YOZZ_IMAP_PASSWORD=secret pnpm -F @yozz.app/imap live imap.example.com
```

With credentials it also checks, read-only (`UID SEARCH` and `FETCH` only), that one `UID SEARCH` of several keys
answers the uids its keys answer apart, intersected: `ok` or `MISMATCH` per command. A slow server
(Forward Email takes 25 s or more a search) makes it take minutes.

**Requires a global `Temporal`.** `append` stamps a `Temporal.ZonedDateTime` (written in its own zone), and
`UID SEARCH` takes `BEFORE` / `SINCE` days as `Temporal.PlainDate`s. Node 26, Chrome and Firefox ship it; where the runtime has none (Safari, Node 24), install
[`temporal-polyfill`](https://www.npmjs.com/package/temporal-polyfill) and load it before this package is
imported (`import 'temporal-polyfill/global'`). The package imports no polyfill itself.

A literal over 64 MiB (`DEFAULT_MAX_LITERAL_BYTES`, or `maxLiteralBytes` in the options) is a protocol failure.

`harness/relay-load.ts` pushes large messages through the hosted yozz.app relay, up over SMTP and
back down over IMAP, using a throwaway Forward Email alias and YOZZ account that it deletes. It is
for the maintainers; it needs `FORWARD_EMAIL_API_KEY` for the yozz.app domain.
