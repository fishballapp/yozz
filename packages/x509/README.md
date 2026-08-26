# @yozz.app/x509

Strict DER, X.509 certificate decoding and RFC 5280 path validation in TypeScript, with a compiled
trust store built from curl's `cacert.pem` and NSS's distrust cutoffs. It is the certificate half
of [`@yozz.app/tls`](https://www.npmjs.com/package/@yozz.app/tls).

- `decodeDer` / `decodeCertificate`: total parsers that reject rather than guess.
- `YOZZ_VALIDATOR`: hostname matching, chain building, signature verification (WebCrypto),
  validity, name constraints, key usage.
- `ROOT_BUNDLE`: the shipped anchors, so a browser has a root store.
- Gate: x509-limbo, 902/902 accepts and 8827/8837 rejects, every over-accept attributed.

```bash
pnpm add @yozz.app/x509
```

```ts
import { compileAnchors, ROOT_BUNDLE, SERVER_AUTH, YOZZ_VALIDATOR } from '@yozz.app/x509';

const result = await YOZZ_VALIDATOR.validatePath({
  peerCertificateDer: leafDer,
  untrustedIntermediateDer: intermediatesDer,
  trustAnchors: compileAnchors(ROOT_BUNDLE).source,
  validationTime: new Date(), // never the clock implicitly; every limbo case pins this
  expectedPeerName: { kind: 'dns', value: 'imap.example.com' },
  requiredKeyUsages: [],
  requiredExtendedKeyUsages: [SERVER_AUTH],
  maximumIntermediateCount: null,
});
// { ok: true, path } or { ok: false, reason } naming the check that refused
```

`src/index.ts` is the whole public API and says why each export exists; the request and result
types are in `src/validator.ts`. The source is in
[fishballapp/yozz](https://github.com/fishballapp/yozz), which takes issues but no pull requests.

MIT.
