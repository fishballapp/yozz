export type MessageInput = {
  readonly from: { readonly address: string; readonly name?: string };
  readonly to: readonly string[];
  /** Named in a `Cc` header. Blind copies are the envelope's business, never a header. */
  readonly cc?: readonly string[];
  readonly subject: string;
  readonly date: Date;
  /** `<local@domain>`; the caller mints it so it can keep the id for its own Sent copy. */
  readonly messageId: string;
  readonly text: string;
  /** When present the message is `multipart/alternative`, text first. */
  readonly html?: string;
  readonly inReplyTo?: string;
  /** The parent's `References` then its Message-ID, oldest first (RFC 5322 §3.6.4). Defaults to `[inReplyTo]`. */
  readonly references?: readonly string[];
  /** When present the whole message becomes `multipart/mixed`: the body first, then each file. */
  readonly attachments?: readonly MessageAttachment[];
  /** Appended after the standard block. */
  readonly extraHeaders?: readonly (readonly [string, string])[];
};

/** A file named in the message, without its body. */
export type MessageAttachmentHead = {
  readonly filename: string;
  readonly mimeType: string;
};

export type MessageAttachment = MessageAttachmentHead & {
  readonly content: Uint8Array;
};

/**
 * A message with each attachment's body left out. `head` is every other byte; the body of the
 * attachment at index `i` belongs at byte offset `splices[i]`, in the order they were given.
 */
export type MessageParts = {
  readonly head: Uint8Array<ArrayBuffer>;
  readonly splices: readonly number[];
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

/** RFC 2045 §6.7. */
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
      // A soft break (`=` CRLF) may not split an `=XX` escape.
      const out: string[] = [];
      let rest = encoded;
      while (rest.length > 76) {
        let cut = 75;
        if (rest[cut - 1] === '=') {
          cut -= 1;
        } else if (rest[cut - 2] === '=') {
          cut -= 2;
        }
        out.push(`${rest.slice(0, cut)}=`);
        rest = rest.slice(cut);
      }
      out.push(rest);
      return out.join('\r\n');
    })
    .join('\r\n');
};

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

/** RFC 2231. */
const filenameParameter = (filename: string): string =>
  isAscii(filename)
    ? `filename="${filename.replace(/["\\]/g, '\\$&')}"`
    : `filename*=utf-8''${encodeURIComponent(filename).replace(
        // RFC 2231 attr-char excludes these; encodeURIComponent leaves them alone.
        /[*'()]/g,
        ch => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
      )}`;

/**
 * A body as a frozen message's splice holds it. Its line format is part of what a claim froze: a
 * resend rebuilds the message from this, so changing it changes messages already claimed.
 */
export const encodeAttachmentBody = (content: Uint8Array): Uint8Array<ArrayBuffer> =>
  encoder.encode(base64Lines(content));

const attachmentHeadOf = ({ filename, mimeType }: MessageAttachmentHead): string =>
  [
    `Content-Type: ${mimeType}`,
    `Content-Disposition: attachment; ${filenameParameter(filename)}`,
    'Content-Transfer-Encoding: base64',
    '',
    '',
  ].join('\r\n');

const newBoundary = () => `=_yozz_${crypto.randomUUID()}`;

const multipartOf = (subtype: string, parts: readonly string[]): string => {
  const boundary = newBoundary();
  return [
    `Content-Type: multipart/${subtype}; boundary="${boundary}"`,
    '',
    ...parts.flatMap(part => [`--${boundary}`, part]),
    `--${boundary}--`,
    '',
  ].join('\r\n');
};

/** The text around each attachment body: one more piece than there are attachments. */
const mixedPiecesOf = (
  bodyPart: string,
  attachments: readonly MessageAttachmentHead[],
): readonly string[] => {
  const boundary = newBoundary();
  const opening = `Content-Type: multipart/mixed; boundary="${boundary}"\r\n\r\n--${boundary}\r\n${bodyPart}\r\n`;
  return [
    ...attachments.map(
      (attachment, index) =>
        `${index === 0 ? opening : '\r\n\r\n'}--${boundary}\r\n${attachmentHeadOf(attachment)}`,
    ),
    `\r\n\r\n--${boundary}--\r\n`,
  ];
};

/** RFC 2047 §2: an encoded-word is at most 75 characters; minus `=?utf-8?B?` and `?=` that is 63 of base64, 45 bytes. */
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

/** RFC 5322 §2.2.3: fold at spaces so no line passes 78 characters. */
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

/** RFC 5322 §3.3, in the local zone. */
export const formatDate = (date: Date): string => {
  const offset = -date.getTimezoneOffset();
  const sign = offset < 0 ? '-' : '+';
  const zone = `${sign}${two(Math.floor(Math.abs(offset) / 60))}${two(Math.abs(offset) % 60)}`;
  return `${DAYS[date.getDay()]}, ${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()} ${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())} ${zone}`;
};

const assertNoLineBreak = (field: string, value: string) => {
  if (/[\r\n]/.test(value)) throw new Error(`${field} contains a line break`);
};

export const buildMessageParts = (
  input: Omit<MessageInput, 'attachments'> & {
    readonly attachments?: readonly MessageAttachmentHead[];
  },
): MessageParts => {
  for (const recipient of input.to) assertNoLineBreak('To', recipient);
  for (const recipient of input.cc ?? []) assertNoLineBreak('Cc', recipient);
  assertNoLineBreak('From', input.from.address);
  assertNoLineBreak('From', input.from.name ?? '');
  assertNoLineBreak('Message-ID', input.messageId);
  assertNoLineBreak('In-Reply-To', input.inReplyTo ?? '');

  const headers: [string, string][] = [
    ['From', formatMailbox(input.from)],
    // An empty `To:` is not a valid address list, so a Cc-only message omits the header.
    ...(input.to.length === 0 ? [] : [['To', input.to.join(', ')] as [string, string]]),
  ];
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
  // Folded one id per line (RFC 5322 §2.2.3): a dozen ids would pass the 998-octet line cap.
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
  const headerBlock = headers.map(([name, value]) => `${name}: ${value}`).join('\r\n');
  if (attachments.length === 0) {
    return { head: encoder.encode(`${headerBlock}\r\n${bodyPart}`), splices: [] };
  }

  const pieces = mixedPiecesOf(bodyPart, attachments).map((piece, index) =>
    encoder.encode(index === 0 ? `${headerBlock}\r\n${piece}` : piece),
  );
  const head = new Uint8Array(pieces.reduce((sum, piece) => sum + piece.length, 0));
  let written = 0;
  const ends = pieces.map(piece => {
    head.set(piece, written);
    written += piece.length;
    return written;
  });
  return { head, splices: ends.slice(0, -1) };
};

/** The whole message: `parts` with each body at its splice, in the order the attachments were given. */
export const spliceMessage = (
  { head, splices }: MessageParts,
  bodies: readonly Uint8Array[],
): Uint8Array<ArrayBuffer> => {
  const whole = new Uint8Array(bodies.reduce((sum, body) => sum + body.length, head.length));
  let written = 0;
  let read = 0;
  for (const [index, at] of splices.entries()) {
    const body = bodies[index];
    if (body === undefined) throw new Error(`No body for attachment ${index}`);
    whole.set(head.subarray(read, at), written);
    written += at - read;
    whole.set(body, written);
    written += body.length;
    read = at;
  }
  whole.set(head.subarray(read), written);
  return whole;
};

export const buildMessage = (input: MessageInput): Uint8Array =>
  spliceMessage(
    buildMessageParts(input),
    (input.attachments ?? []).map(({ content }) => encodeAttachmentBody(content)),
  );
