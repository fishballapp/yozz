# @yozz.app/imap

Transport-agnostic IMAP4rev2/rev1 client core for YOZZ.

```bash
pnpm add @yozz.app/imap
```

## The seam

`@yozz.app/imap` speaks IMAP over any `ByteDuplex` (`{ read(): Promise<Uint8Array | null>; write(bytes): Promise<void> }`)
from `@yozz.app/tls`. It knows protocol lines, `{n}` literals, command state, and RFC 2047 header
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
