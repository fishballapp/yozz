/** Mozilla's server distrust-after cutoffs from NSS's `certdata.txt`: the one piece of trust metadata `cacert.pem` cannot carry. */

/** `\ooo` per byte, how NSS writes every binary attribute. */
const decodeOctal = (body: string): Uint8Array =>
  Uint8Array.from(
    [...body.matchAll(/\\([0-7]{3})/g)].map(([, digits]) => Number.parseInt(digits, 8)),
  );

type Attributes = Readonly<Record<string, string | Uint8Array>>;

/** A scalar keeps its type token (`UTF8 "Izenpe.com"`, `CK_BBOOL CK_FALSE`); this unwraps the one carrying a name. */
const labelOf = (attributes: Attributes): string => {
  const raw = attributes.CKA_LABEL;
  if (typeof raw !== 'string') return '';
  return /^UTF8 "(.*)"$/s.exec(raw)?.[1] ?? raw;
};

/** Objects begin at `CKA_CLASS`; blank lines are not a boundary. */
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

/** RFC 5280 §4.1.2.5.1 UTCTime: YY >= 50 is 19YY. */
const parseUtcTime = (text: string): Date => {
  const match = /^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/.exec(text);
  if (match === null) throw new Error(`not a UTCTime: ${JSON.stringify(text)}`);
  const [, yy = '', month = '', day = '', hour = '', minute = '', second = ''] = match;
  const year = Number(yy) >= 50 ? 1900 + Number(yy) : 2000 + Number(yy);
  return new Date(
    Date.UTC(year, Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second)),
  );
};

/** Issuer and serial name one certificate (RFC 5280 §4.1.2.2). Latin-1 so distinct DER cannot collide. */
export const issuerSerialKey = (issuerDer: Uint8Array, serialDer: Uint8Array): string =>
  `${String.fromCharCode(...issuerDer)}|${String.fromCharCode(...serialDer)}`;

export type ServerDistrust = {
  readonly label: string;
  readonly notAfter: Date;
};

/**
 * The attribute hangs off either object class. On NSS `70a8ff50`: three on `CKO_CERTIFICATE`, one
 * (`Izenpe.com`, the only shipped root past its cutoff) on `CKO_NSS_TRUST`. A future cutoff is
 * returned like any other.
 */
export const serverDistrustAfter = (certdata: string): ReadonlyMap<string, ServerDistrust> =>
  new Map(
    parseObjects(certdata).flatMap(attributes => {
      const raw = attributes.CKA_NSS_SERVER_DISTRUST_AFTER;
      const issuer = attributes.CKA_ISSUER;
      const serial = attributes.CKA_SERIAL_NUMBER;
      // `CK_BBOOL CK_FALSE` means no cutoff; only the MULTILINE_OCTAL form is a date.
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

/** Keyed by certificate DER, which is what `cacert.pem` gives the build to look up. */
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
 * Which certificates carry a trust object. NSS writes `CKO_NSS_TRUST` objects after every
 * `CKO_CERTIFICATE`, so a truncated file has every certificate and no cutoffs.
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
