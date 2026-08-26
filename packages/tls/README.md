# @yozz.app/tls

A TLS 1.3 client (RFC 9846) in TypeScript, over any byte duplex. It is what the YOZZ mail
client uses to reach IMAP and SMTP servers from inside a browser, where there is no socket API
and no platform TLS to call.

- Record layer, handshake state machine, key schedule, `KeyUpdate`, `close_notify`.
- 1-RTT PSK resumption; never 0-RTT.
- Certificate validation through [`@yozz.app/x509`](https://www.npmjs.com/package/@yozz.app/x509),
  plus trust-on-first-use public-key pinning as a `Validator` wrapper.
- WebCrypto only: runs in Node and in Chromium, Firefox and WebKit with no native code.
- Gates: RFC 8448 byte-exact on all five traces; BoringSSL's BoGo runner, 296/296 in scope.

```bash
pnpm add @yozz.app/tls
```

```ts
import { startTls } from '@yozz.app/tls';
import { compileAnchors, ROOT_BUNDLE, YOZZ_VALIDATOR } from '@yozz.app/x509';

// `transport` is a ByteDuplex: { read(): Promise<Uint8Array | null>; write(bytes): Promise<void> }
// over whatever carries bytes to the server (a TCP socket in Node, a WebSocket relay in a browser).
const result = await startTls({
  transport,
  serverName: 'imap.example.com',
  trustAnchors: compileAnchors(ROOT_BUNDLE).source,
  validationTime: new Date(),
  validator: YOZZ_VALIDATOR,
});
if (result.ok) {
  const { connection } = result; // read() / write() / close() over the encrypted channel
}
```

`HandshakeResult` is a discriminated union, never a throw for a refused certificate; the refusal
says which check failed. A session handed to `onSession` can be offered once on a later
connection to resume.

`src/index.ts` is the whole public API and says why each export exists. The source is in
[fishballapp/yozz](https://github.com/fishballapp/yozz), which takes issues but no pull requests.

MIT.
