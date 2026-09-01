/**
 * An RFC 5322 message as bytes, built from fields the composer owns. Everything non-ASCII is
 * encoded on the way out (RFC 2047 `=?utf-8?B?…?=` in headers, quoted-printable bodies), so the result is
 * 7-bit clean and needs nothing from the server. Line endings are CRLF throughout.
 */

export type MessageInput = {
  readonly from: { readonly address: string; readonly name?: string };
  readonly to: readonly string[];
  /** Carbon copies, named in a `Cc` header. Blind copies are the envelope's business, never a header. */
  readonly cc?: readonly string[];
  readonly subject: string;
  readonly date: Date;
  /** `<local@domain>`; the caller mints it so it can keep the id for its own Sent copy. */
  readonly messageId: string;
  readonly text: string;
  /** When present the message is `multipart/alternative`, text first. */
  readonly html?: string;
  readonly inReplyTo?: string;
  /**
   * The parent's `References` followed by its Message-ID, oldest first — the chain RFC 5322 §3.6.4
   * asks a reply to carry. Without it a client that threads on References alone (and the base
   * subject is a guess, not a rule) sees a reply to a reply as a new conversation. Defaults to
   * `[inReplyTo]`, which is what a first reply's chain is anyway.
   */
  readonly references?: readonly string[];
  /** When present the whole message becomes `multipart/mixed`: the body first, then each file. */
  readonly attachments?: readonly MessageAttachment[];
  /**
   * Headers this client owns, appended after the standard block.
   *
   * YOZZ no longer uses this. It stamped `X-Yozz-Draft` here to find its own copies again without
   * trusting a Message-ID a provider may rewrite, and that failed on a more basic point: a server
   * need only index the headers IMAP names, so `SEARCH HEADER` on a private one can answer the
   * empty list for a message that carries it (docs/knowledge/forwardemail-api.md). The field stays
   * because a message builder should be able to set a header; do not build a LOOKUP on one.
   */
  readonly extraHeaders?: readonly (readonly [string, string])[];
};

export type MessageAttachment = {
  readonly filename: string;
  readonly mimeType: string;
  readonly content: Uint8Array;
};

const encoder = new TextEncoder();

const isAscii = (value: string) =>
  [...value].every(ch => ch.charCodeAt(0) >= 0x20 && ch.charCodeAt(0) <= 0x7e);

const BASE64_CHUNK = 0x8000;
const base64 = (bytes: Uint8Array): string => {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + BASE64_CHUNK));
  return btoa(binary);
};

/** RFC 2045 §6.8: base64 in lines of 76. */
const base64Lines = (bytes: Uint8Array): string => base64(bytes).replace(/.{76}/g, '$&\r\n');

const toCrlf = (text: string) => text.replace(/\r?\n/g, '\r\n');

/**
 * RFC 2045 §6.7 quoted-printable: bytes outside printable ASCII become `=XX`, trailing
 * whitespace is protected, and lines are soft-wrapped with `=` before 76 characters. Chosen over
 * base64 because filters treat a base64 text part as text that is hiding something.
 */
export const quotedPrintable = (text: string): string => {
  const lines = toCrlf(text).split('\r\n');
  return lines
    .map(line => {
      let encoded = '';
      const bytes = encoder.encode(line);
      bytes.forEach((byte, index) => {
        const isLast = index === bytes.length - 1;
        const literal =
          (byte >= 0x21 && byte <= 0x7e && byte !== 0x3d) ||
          ((byte === 0x20 || byte === 0x09) && !isLast);
        encoded += literal
          ? String.fromCharCode(byte)
          : `=${byte.toString(16).toUpperCase().padStart(2, '0')}`;
      });
      // Soft breaks: never split an `=XX` escape, never exceed 76 including the `=`.
      const out: string[] = [];
      let rest = encoded;
      while (rest.length > 76) {
        let cut = 75;
        if (rest[cut - 1] === '=') cut -= 1;
        else if (rest[cut - 2] === '=') cut -= 2;
        out.push(`${rest.slice(0, cut)}=`);
        rest = rest.slice(cut);
      }
      out.push(rest);
      return out.join('\r\n');
    })
    .join('\r\n');
};

/** 7bit when the text already is (ASCII, lines under 998), quoted-printable otherwise. */
const encodeBody = (text: string): { readonly encoding: string; readonly body: string } => {
  const crlf = toCrlf(text);
  const is7bit =
    [...crlf].every(ch => {
      const code = ch.charCodeAt(0);
      return code === 0x0d || code === 0x0a || code === 0x09 || (code >= 0x20 && code <= 0x7e);
    }) && crlf.split('\r\n').every(line => line.length <= 998);
  return is7bit
    ? { encoding: '7bit', body: crlf }
    : { encoding: 'quoted-printable', body: quotedPrintable(text) };
};

const textPartOf = (contentType: string, text: string): string => {
  const { encoding, body } = encodeBody(text);
  return [
    `Content-Type: ${contentType}; charset=utf-8`,
    `Content-Transfer-Encoding: ${encoding}`,
    '',
    body,
    '',
  ].join('\r\n');
};

/**
 * RFC 2231 for a filename: plain ASCII is a quoted-string, anything else goes as
 * `filename*=utf-8''` with the bytes percent-encoded. Both forms name the same file.
 */
const filenameParameter = (filename: string): string =>
  isAscii(filename)
    ? `filename="${filename.replace(/["\\]/g, '\\$&')}"`
    : `filename*=utf-8''${encodeURIComponent(filename).replace(
        // attr-char excludes what encodeURIComponent leaves alone.
        /[*'()]/g,
        ch => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
      )}`;

const attachmentPartOf = ({ filename, mimeType, content }: MessageAttachment): string =>
  [
    `Content-Type: ${mimeType}`,
    `Content-Disposition: attachment; ${filenameParameter(filename)}`,
    'Content-Transfer-Encoding: base64',
    '',
    base64Lines(content),
    '',
  ].join('\r\n');

const multipartOf = (subtype: string, parts: readonly string[]): string => {
  const boundary = `=_yozz_${crypto.randomUUID()}`;
  return [
    `Content-Type: multipart/${subtype}; boundary="${boundary}"`,
    '',
    ...parts.flatMap(part => [`--${boundary}`, part]),
    `--${boundary}--`,
    '',
  ].join('\r\n');
};

/**
 * RFC 2047 B-encoding. One encoded-word may be at most 75 characters: `=?utf-8?B?` + `?=` is 12,
 * so 63 of base64, which is 45 bytes of UTF-8. Split on code points so no character straddles
 * two words; the words are folded onto continuation lines, which a reader joins back together.
 */
const ENCODED_WORD_BYTES = 45;
const encodedWords = (value: string): string => {
  const words: string[] = [];
  let chunk = '';
  for (const ch of value) {
    if (encoder.encode(chunk + ch).length > ENCODED_WORD_BYTES) {
      words.push(chunk);
      chunk = '';
    }
    chunk += ch;
  }
  words.push(chunk);
  return words.map(word => `=?utf-8?B?${base64(encoder.encode(word))}?=`).join('\r\n ');
};

/** RFC 5322 §2.2.3 folding for plain ASCII: break at spaces so no line passes 78 characters. */
const foldAscii = (value: string): string => {
  const lines: string[] = [];
  let line = '';
  for (const word of value.split(' ')) {
    if (line !== '' && line.length + 1 + word.length > 76) {
      lines.push(line);
      line = word;
    } else {
      line = line === '' ? word : `${line} ${word}`;
    }
  }
  lines.push(line);
  return lines.join('\r\n ');
};

export const encodeHeaderText = (value: string): string =>
  isAscii(value) ? foldAscii(value) : encodedWords(value);

/** `Name <addr>` with the name quoted or encoded as its characters require; a bare address otherwise. */
export const formatMailbox = ({ address, name }: MessageInput['from']): string => {
  if (name === undefined || name.trim() === '') return address;
  if (!isAscii(name)) return `${encodedWords(name)} <${address}>`;
  const needsQuotes = /[()<>[\]:;@\\,."]/.test(name);
  const display = needsQuotes ? `"${name.replace(/["\\]/g, '\\$&')}"` : name;
  return `${display} <${address}>`;
};

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const two = (n: number) => String(n).padStart(2, '0');

/** RFC 5322 §3.3, in the caller's local zone so the header says when the sender wrote it. */
export const formatDate = (date: Date): string => {
  const offset = -date.getTimezoneOffset();
  const sign = offset < 0 ? '-' : '+';
  const zone = `${sign}${two(Math.floor(Math.abs(offset) / 60))}${two(Math.abs(offset) % 60)}`;
  return `${DAYS[date.getDay()]}, ${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()} ${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())} ${zone}`;
};

/** A header value may not contain CR or LF: a field that could end the header block is refused. */
const assertNoLineBreak = (field: string, value: string) => {
  if (/[\r\n]/.test(value)) throw new Error(`${field} contains a line break`);
};

export const buildMessage = (input: MessageInput): Uint8Array => {
  for (const recipient of input.to) assertNoLineBreak('To', recipient);
  for (const recipient of input.cc ?? []) assertNoLineBreak('Cc', recipient);
  assertNoLineBreak('From', input.from.address);
  assertNoLineBreak('From', input.from.name ?? '');
  assertNoLineBreak('Message-ID', input.messageId);
  assertNoLineBreak('In-Reply-To', input.inReplyTo ?? '');

  const headers: [string, string][] = [
    ['From', formatMailbox(input.from)],
    // A Cc-only or Bcc-only message has no To, and an empty `To:` is not an address list.
    ...(input.to.length === 0 ? [] : [['To', input.to.join(', ')] as [string, string]]),
  ];
  // Bcc has no header by construction: a blind copy that names itself in the bytes is not blind,
  // and every recipient would read it. The envelope is the only place it exists.
  const cc = input.cc ?? [];
  if (cc.length > 0) headers.push(['Cc', cc.join(', ')]);
  headers.push(
    ['Subject', encodeHeaderText(input.subject)],
    ['Date', formatDate(input.date)],
    ['Message-ID', input.messageId],
    ['MIME-Version', '1.0'],
  );
  if (input.inReplyTo !== undefined) {
    headers.push(['In-Reply-To', input.inReplyTo]);
  }
  // A long chain folds: RFC 5322 caps a line at 998 octets, and a dozen ids pass that. Folding is
  // the header's own rule (§2.2.3) — CRLF then one space, which unfolds back to the same list.
  const references = input.references ?? (input.inReplyTo === undefined ? [] : [input.inReplyTo]);
  if (references.length > 0) {
    for (const id of references) assertNoLineBreak('References', id);
    headers.push(['References', references.join('\r\n ')]);
  }

  for (const [name, value] of input.extraHeaders ?? []) {
    assertNoLineBreak(name, value);
    headers.push([name, value]);
  }

  for (const { filename, mimeType } of input.attachments ?? []) {
    assertNoLineBreak('filename', filename);
    assertNoLineBreak('Content-Type', mimeType);
  }

  const textPart = textPartOf('text/plain', input.text);
  const bodyPart =
    input.html === undefined
      ? textPart
      : multipartOf('alternative', [textPart, textPartOf('text/html', input.html)]);
  const attachments = input.attachments ?? [];
  const body =
    attachments.length === 0
      ? bodyPart
      : multipartOf('mixed', [bodyPart, ...attachments.map(attachmentPartOf)]);

  const headerBlock = headers.map(([name, value]) => `${name}: ${value}`).join('\r\n');
  return encoder.encode(`${headerBlock}\r\n${body}`);
};
