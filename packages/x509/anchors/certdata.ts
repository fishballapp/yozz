/**
 * Reading Mozilla's server distrust-after cutoffs out of NSS's `certdata.txt`.
 *
 * A cutoff says: this root stays trusted, but only for certificates issued
 * BEFORE this instant. It is how a root program retires a CA without breaking
 * every certificate already in the wild, and it is the one piece of trust
 * metadata `cacert.pem` cannot carry — a PEM is certificates and nothing else.
 *
 * This reads only what it needs. It is not an NSS object-format parser and
 * should not become one: the file is a flat list of PKCS#11 attribute
 * assignments, and the two shapes below are all this build step looks at.
 */

/**
 * `\ooo` per byte, three octal digits each. The values here are ASCII — a
 * UTCTime string — but the escape is how NSS writes every binary attribute, so
 * this decodes bytes and lets the caller decide what they mean.
 */
const decodeOctal = (body: string): Uint8Array =>
  Uint8Array.from(
    [...body.matchAll(/\\([0-7]{3})/g)].map(([, digits]) => Number.parseInt(digits, 8)),
  );

type Attributes = Readonly<Record<string, string | Uint8Array>>;

/**
 * A scalar attribute keeps its TYPE token — `UTF8 "Izenpe.com"`,
 * `CK_BBOOL CK_FALSE` — because the type is what says whether a value means
 * anything. This unwraps the one form that carries a human name.
 */
const labelOf = (attributes: Attributes): string => {
  const raw = attributes.CKA_LABEL;
  if (typeof raw !== 'string') return '';
  return /^UTF8 "(.*)"$/s.exec(raw)?.[1] ?? raw;
};

/**
 * Objects begin at `CKA_CLASS` and run to the next one. Blank lines are NOT the
 * boundary — a certificate's `CKA_VALUE` runs for dozens of lines and the file
 * puts comments and blank lines wherever it likes.
 */
const parseObjects = (text: string): readonly Attributes[] => {
  const lines = text.split('\n');
  const objects: Record<string, string | Uint8Array>[] = [];
  let current: Record<string, string | Uint8Array> | null = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (line.startsWith('CKA_CLASS')) {
      current = {};
      objects.push(current);
    }
    if (current === null || !line.startsWith('CKA_')) continue;

    const [name = '', type] = line.split(/\s+/);
    if (type === 'MULTILINE_OCTAL') {
      const body: string[] = [];
      while (index + 1 < lines.length && lines[index + 1] !== 'END') {
        index += 1;
        body.push(lines[index] ?? '');
      }
      index += 1; // the END
      current[name] = decodeOctal(body.join('\n'));
    } else {
      current[name] = line.slice(name.length).trim();
    }
  }
  return objects;
};

/**
 * `YYMMDDHHMMSSZ`, RFC 5280 §4.1.2.5.1's UTCTime, whose two-digit year splits
 * at 50 — "where YY is greater than or equal to 50, the year SHALL be
 * interpreted as 19YY", and below it as 20YY.
 */
const parseUtcTime = (text: string): Date => {
  const match = /^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/.exec(text);
  if (match === null) throw new Error(`not a UTCTime: ${JSON.stringify(text)}`);
  const [, yy = '', month = '', day = '', hour = '', minute = '', second = ''] = match;
  const year = Number(yy) >= 50 ? 1900 + Number(yy) : 2000 + Number(yy);
  return new Date(
    Date.UTC(year, Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second)),
  );
};

/**
 * Issuer and serial together — PKIX's own name for one certificate (RFC 5280
 * §4.1.2.2, "the combination of the issuer name and serial number uniquely
 * identifies a certificate"). Latin-1 for the same reason `anchors.ts` uses it:
 * a total, injective byte-to-code-unit map, so distinct DER cannot collide.
 */
export const issuerSerialKey = (issuerDer: Uint8Array, serialDer: Uint8Array): string =>
  `${String.fromCharCode(...issuerDer)}|${String.fromCharCode(...serialDer)}`;

export type ServerDistrust = {
  readonly label: string;
  readonly notAfter: Date;
};

/**
 * Every root carrying a server distrust-after, keyed by issuer and serial.
 *
 * **The attribute hangs off EITHER object class, and reading one of them is a
 * silent miss.** Measured against NSS `70a8ff50` on 2026-08-20: four cutoffs,
 * three on `CKO_CERTIFICATE` (the Entrust roots) and one on `CKO_NSS_TRUST`
 * (`Izenpe.com`). The obvious parser reads certificate objects, finds three,
 * and drops exactly the one that matters — the Entrust three are already gone
 * from curl's bundle, and Izenpe is the only root that is both shipped and past
 * its cutoff. So this walks every object and keys on issuer+serial, which both
 * classes carry.
 *
 * A cutoff in the FUTURE is returned like any other. Whether it bites is the
 * caller's decision, because it depends on the leaf, not on the root.
 */
export const serverDistrustAfter = (certdata: string): ReadonlyMap<string, ServerDistrust> =>
  new Map(
    parseObjects(certdata).flatMap(attributes => {
      const raw = attributes.CKA_NSS_SERVER_DISTRUST_AFTER;
      const issuer = attributes.CKA_ISSUER;
      const serial = attributes.CKA_SERIAL_NUMBER;
      // `CK_BBOOL CK_FALSE` is how the file says "no cutoff", and it parses to a
      // string — only the MULTILINE_OCTAL form is a date.
      if (!(raw instanceof Uint8Array)) return [];
      if (!(issuer instanceof Uint8Array) || !(serial instanceof Uint8Array)) return [];
      return [
        [
          issuerSerialKey(issuer, serial),
          {
            label: labelOf(attributes),
            notAfter: parseUtcTime(new TextDecoder().decode(raw)),
          },
        ] as const,
      ];
    }),
  );

/** Latin-1, for the same reason `issuerSerialKey` uses it: no two DER collide. */
export const derKey = (der: Uint8Array): string => String.fromCharCode(...der);

/**
 * The same cutoffs, keyed by the certificate's own DER instead of by
 * issuer+serial — which is what the build step can actually look up, because
 * `cacert.pem` gives it certificates and nothing else.
 *
 * The join runs through certdata's own `CKO_CERTIFICATE` objects, which carry
 * `CKA_VALUE` alongside the issuer and serial. Every root in curl's bundle is
 * derived from one of them, so a bundle certificate that finds no match here
 * means the two pinned files disagree about what NSS contains — worth failing
 * the build over, which is `build.ts`'s job rather than this one's.
 */
export const serverDistrustByCertificate = (
  certdata: string,
): ReadonlyMap<string, ServerDistrust> => {
  const byIssuerSerial = serverDistrustAfter(certdata);
  return new Map(
    parseObjects(certdata).flatMap(attributes => {
      const der = attributes.CKA_VALUE;
      const issuer = attributes.CKA_ISSUER;
      const serial = attributes.CKA_SERIAL_NUMBER;
      if (!(der instanceof Uint8Array)) return [];
      if (!(issuer instanceof Uint8Array) || !(serial instanceof Uint8Array)) return [];
      const distrust = byIssuerSerial.get(issuerSerialKey(issuer, serial));
      return distrust === undefined ? [] : [[derKey(der), distrust] as const];
    }),
  );
};

/**
 * Which certificates certdata carries a TRUST object for, keyed by DER.
 *
 * `certificateDerKeys` below answers "is this root described at all"; this
 * answers the narrower question a cutoff actually depends on. A
 * `CKA_NSS_SERVER_DISTRUST_AFTER` most often hangs off `CKO_NSS_TRUST`, and NSS
 * writes those objects AFTER the `CKO_CERTIFICATE` they belong to — measured on
 * `70a8ff50`, the last trust object is 128 lines past the last certificate. So a
 * file truncated between the two has every certificate and no trust at all, and
 * a reader that only counts certificates calls that complete.
 *
 * That matters in exactly one direction and it is the dangerous one: a cutoff
 * that was not read is indistinguishable from a root that has none.
 */
export const trustedCertificateDerKeys = (certdata: string): ReadonlySet<string> => {
  const objects = parseObjects(certdata);
  const trusted = new Set(
    objects.flatMap(attributes => {
      if (typeof attributes.CKA_CLASS !== 'string') return [];
      if (!attributes.CKA_CLASS.includes('CKO_NSS_TRUST')) return [];
      const issuer = attributes.CKA_ISSUER;
      const serial = attributes.CKA_SERIAL_NUMBER;
      if (!(issuer instanceof Uint8Array) || !(serial instanceof Uint8Array)) return [];
      return [issuerSerialKey(issuer, serial)];
    }),
  );
  return new Set(
    objects.flatMap(attributes => {
      const der = attributes.CKA_VALUE;
      const issuer = attributes.CKA_ISSUER;
      const serial = attributes.CKA_SERIAL_NUMBER;
      if (!(der instanceof Uint8Array)) return [];
      if (!(issuer instanceof Uint8Array) || !(serial instanceof Uint8Array)) return [];
      return trusted.has(issuerSerialKey(issuer, serial)) ? [derKey(der)] : [];
    }),
  );
};

/** Every certificate certdata holds, by DER — so the build can spot a bundle root it does not know. */
export const certificateDerKeys = (certdata: string): ReadonlySet<string> =>
  new Set(
    parseObjects(certdata).flatMap(attributes =>
      attributes.CKA_VALUE instanceof Uint8Array ? [derKey(attributes.CKA_VALUE)] : [],
    ),
  );
