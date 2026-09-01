export type RelayTarget = {
  readonly hostname: string;
  readonly port: 993 | 465;
};

const HOSTNAME_REGEX =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

const parseIpv4Octets = (ip: string): [number, number, number, number] | null => {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^(0|[1-9]\d{0,2})$/.test(part)) return null;
    const num = Number(part);
    if (num < 0 || num > 255) return null;
    octets.push(num);
  }
  const a = octets[0];
  const b = octets[1];
  const c = octets[2];
  const d = octets[3];
  if (a === undefined || b === undefined || c === undefined || d === undefined) return null;
  return [a, b, c, d];
};

const isPublicIpv4Octets = (a: number, b: number, _c: number, _d: number): boolean => {
  if (a === 0) return false; // 0.0.0.0/8
  if (a === 10) return false; // 10.0.0.0/8
  if (a === 100 && b >= 64 && b <= 127) return false; // 100.64.0.0/10 CGNAT
  if (a === 127) return false; // loopback
  if (a === 169 && b === 254) return false; // link-local
  if (a === 172 && b >= 16 && b <= 31) return false; // 172.16.0.0/12
  if (a === 192 && b === 168) return false; // 192.168.0.0/16
  if (a >= 224) return false; // multicast and reserved
  return true;
};

const parseIpv6Hextets = (raw: string): number[] | null => {
  let ip = raw;

  const lastColonIndex = ip.lastIndexOf(':');
  if (lastColonIndex === -1) return null;
  const potentialV4 = ip.slice(lastColonIndex + 1);
  if (potentialV4.includes('.')) {
    const embeddedV4 = parseIpv4Octets(potentialV4);
    if (!embeddedV4) return null;
    const [a, b, c, d] = embeddedV4;
    const hex1 = (((a << 8) | b) & 0xffff).toString(16);
    const hex2 = (((c << 8) | d) & 0xffff).toString(16);
    ip = `${ip.slice(0, lastColonIndex)}:${hex1}:${hex2}`;
  }

  const doubleColonParts = ip.split('::');
  if (doubleColonParts.length > 2) return null;

  const parseHextet = (part: string): number | null => {
    if (!/^[0-9a-fA-F]{1,4}$/.test(part)) return null;
    const num = Number.parseInt(part, 16);
    return Number.isNaN(num) || num < 0 || num > 0xffff ? null : num;
  };

  if (doubleColonParts.length === 2) {
    const headStr = doubleColonParts[0] ?? '';
    const tailStr = doubleColonParts[1] ?? '';
    const headParts = headStr === '' ? [] : headStr.split(':');
    const tailParts = tailStr === '' ? [] : tailStr.split(':');

    if (headParts.length + tailParts.length > 7) return null;

    const head: number[] = [];
    for (const p of headParts) {
      const h = parseHextet(p);
      if (h === null) return null;
      head.push(h);
    }
    const tail: number[] = [];
    for (const p of tailParts) {
      const h = parseHextet(p);
      if (h === null) return null;
      tail.push(h);
    }

    const zerosCount = 8 - (head.length + tail.length);
    const zeros = Array.from({ length: zerosCount }, () => 0);
    return [...head, ...zeros, ...tail];
  }

  const parts = ip.split(':');
  if (parts.length !== 8) return null;
  const hextets: number[] = [];
  for (const p of parts) {
    const h = parseHextet(p);
    if (h === null) return null;
    hextets.push(h);
  }
  return hextets;
};

export const isPublicIp = (ip: string): boolean => {
  const trimmed = ip.trim();
  if (trimmed === '') return false;

  const v4Octets = parseIpv4Octets(trimmed);
  if (v4Octets !== null) {
    return isPublicIpv4Octets(v4Octets[0], v4Octets[1], v4Octets[2], v4Octets[3]);
  }

  const v6Hextets = parseIpv6Hextets(trimmed);
  if (v6Hextets === null || v6Hextets.length !== 8) return false;

  const h0 = v6Hextets[0];
  const h1 = v6Hextets[1];
  const h2 = v6Hextets[2];
  const h3 = v6Hextets[3];
  const h4 = v6Hextets[4];
  const h5 = v6Hextets[5];
  const h6 = v6Hextets[6];
  const h7 = v6Hextets[7];

  if (
    h0 === undefined ||
    h1 === undefined ||
    h2 === undefined ||
    h3 === undefined ||
    h4 === undefined ||
    h5 === undefined ||
    h6 === undefined ||
    h7 === undefined
  ) {
    return false;
  }

  if (
    h0 === 0 &&
    h1 === 0 &&
    h2 === 0 &&
    h3 === 0 &&
    h4 === 0 &&
    h5 === 0 &&
    h6 === 0 &&
    h7 === 0
  ) {
    return false;
  }

  if (
    h0 === 0 &&
    h1 === 0 &&
    h2 === 0 &&
    h3 === 0 &&
    h4 === 0 &&
    h5 === 0 &&
    h6 === 0 &&
    h7 === 1
  ) {
    return false;
  }

  // IPv4-mapped, ::ffff:a.b.c.d
  if (h0 === 0 && h1 === 0 && h2 === 0 && h3 === 0 && h4 === 0 && h5 === 0xffff) {
    const a = (h6 >> 8) & 0xff;
    const b = h6 & 0xff;
    const c = (h7 >> 8) & 0xff;
    const d = h7 & 0xff;
    return isPublicIpv4Octets(a, b, c, d);
  }

  // IPv4-compatible, ::a.b.c.d
  if (h0 === 0 && h1 === 0 && h2 === 0 && h3 === 0 && h4 === 0 && h5 === 0) {
    const a = (h6 >> 8) & 0xff;
    const b = h6 & 0xff;
    const c = (h7 >> 8) & 0xff;
    const d = h7 & 0xff;
    return isPublicIpv4Octets(a, b, c, d);
  }

  // fc00::/7 unique local
  if ((h0 & 0xfe00) === 0xfc00) {
    return false;
  }

  // fe80::/10 link-local
  if ((h0 & 0xffc0) === 0xfe80) {
    return false;
  }

  // ff00::/8 multicast
  if ((h0 & 0xff00) === 0xff00) {
    return false;
  }

  return true;
};

export const parseHostname = (raw: string): string | null => {
  const hostname = raw.trim().toLowerCase();

  if (hostname.endsWith('.')) return null;

  if (hostname === 'localhost') return null;

  if (parseIpv4Octets(hostname) !== null || parseIpv6Hextets(hostname) !== null) return null;

  const lastDot = hostname.lastIndexOf('.');
  if (lastDot === -1) return null;
  const tld = hostname.slice(lastDot + 1);
  if (/^\d+$/.test(tld)) return null;

  if (!HOSTNAME_REGEX.test(hostname)) return null;

  return hostname;
};

export const parseRelayTarget = (search: URLSearchParams): RelayTarget | null => {
  const rawHost = search.get('host');
  const rawPort = search.get('port');
  if (!rawHost || !rawPort) return null;

  const hostname = parseHostname(rawHost);
  if (hostname === null) return null;

  if (rawPort !== '993' && rawPort !== '465') return null;
  const port = Number(rawPort);
  if (port !== 993 && port !== 465) return null;

  return { hostname, port };
};
