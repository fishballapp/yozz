import { bytesToBase64, stringToBytes } from './bytes.ts';
import { encodeModifiedUtf7 } from './utf7.ts';

export type OutgoingCommandLine = {
  readonly text: Uint8Array;
  readonly literal?: Uint8Array;
};

export type OutgoingCommand = {
  readonly lines: readonly OutgoingCommandLine[];
};

export const quoteString = (str: string): string => {
  const escaped = str.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `"${escaped}"`;
};

export const isSafeQuotedString = (str: string): boolean => {
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code < 0x20 || code > 0x7e || code === 0x00) {
      return false;
    }
  }
  return true;
};

export const buildSaslPlainBytes = (user: string, pass: string): Uint8Array => {
  const userBytes = stringToBytes(user);
  const passBytes = stringToBytes(pass);
  const result = new Uint8Array(1 + userBytes.length + 1 + passBytes.length);
  result[0] = 0;
  result.set(userBytes, 1);
  result[1 + userBytes.length] = 0;
  result.set(passBytes, 2 + userBytes.length);
  return result;
};

export const buildCapabilityCommand = (tag: string): OutgoingCommand => ({
  lines: [{ text: stringToBytes(`${tag} CAPABILITY\r\n`) }],
});

export const buildAuthenticatePlainSaslIrCommand = (
  tag: string,
  user: string,
  pass: string,
): OutgoingCommand => {
  const base64Auth = bytesToBase64(buildSaslPlainBytes(user, pass));
  return {
    lines: [{ text: stringToBytes(`${tag} AUTHENTICATE PLAIN ${base64Auth}\r\n`) }],
  };
};

export const buildAuthenticatePlainInitialCommand = (tag: string): OutgoingCommand => ({
  lines: [{ text: stringToBytes(`${tag} AUTHENTICATE PLAIN\r\n`) }],
});

export const buildAuthenticatePlainResponse = (user: string, pass: string): OutgoingCommand => {
  const base64Auth = bytesToBase64(buildSaslPlainBytes(user, pass));
  return {
    lines: [{ text: stringToBytes(`${base64Auth}\r\n`) }],
  };
};

export const buildLoginCommand = (tag: string, user: string, pass: string): OutgoingCommand => {
  const userSafe = isSafeQuotedString(user);
  const passSafe = isSafeQuotedString(pass);

  if (userSafe && passSafe) {
    return {
      lines: [
        {
          text: stringToBytes(`${tag} LOGIN ${quoteString(user)} ${quoteString(pass)}\r\n`),
        },
      ],
    };
  }

  if (!userSafe && passSafe) {
    return {
      lines: [
        {
          text: stringToBytes(`${tag} LOGIN `),
          literal: stringToBytes(user),
        },
        {
          text: stringToBytes(` ${quoteString(pass)}\r\n`),
        },
      ],
    };
  }

  if (userSafe && !passSafe) {
    return {
      lines: [
        {
          text: stringToBytes(`${tag} LOGIN ${quoteString(user)} `),
          literal: stringToBytes(pass),
        },
        {
          text: stringToBytes('\r\n'),
        },
      ],
    };
  }

  return {
    lines: [
      {
        text: stringToBytes(`${tag} LOGIN `),
        literal: stringToBytes(user),
      },
      {
        text: stringToBytes(' '),
        literal: stringToBytes(pass),
      },
      {
        text: stringToBytes('\r\n'),
      },
    ],
  };
};

export const buildListCommand = (
  tag: string,
  reference: string,
  pattern: string,
): OutgoingCommand => {
  const refUtf7 = encodeModifiedUtf7(reference);
  const patUtf7 = encodeModifiedUtf7(pattern);
  return {
    lines: [
      {
        text: stringToBytes(`${tag} LIST ${quoteString(refUtf7)} ${quoteString(patUtf7)}\r\n`),
      },
    ],
  };
};

export const buildSelectCommand = (
  tag: string,
  mailbox: string,
  readOnly = false,
): OutgoingCommand => {
  const verb = readOnly ? 'EXAMINE' : 'SELECT';
  const mboxUtf7 = encodeModifiedUtf7(mailbox);
  return {
    lines: [{ text: stringToBytes(`${tag} ${verb} ${quoteString(mboxUtf7)}\r\n`) }],
  };
};

/** `X-GM-THRID` is asked for only when the server advertised `X-GM-EXT-1`: an unknown item is a BAD. */
export const buildFetchSummariesCommand = (
  tag: string,
  set: string,
  { gmail, bySeq = false }: { readonly gmail: boolean; readonly bySeq?: boolean },
): OutgoingCommand => ({
  lines: [
    {
      text: stringToBytes(
        `${tag} ${bySeq ? 'FETCH' : 'UID FETCH'} ${set} (FLAGS ENVELOPE INTERNALDATE RFC822.SIZE UID BODY.PEEK[HEADER.FIELDS (REFERENCES)]${gmail ? ' X-GM-THRID' : ''})\r\n`,
      ),
    },
  ],
});

export const buildFetchFlagsCommand = (tag: string, uidSet: string): OutgoingCommand => ({
  lines: [{ text: stringToBytes(`${tag} UID FETCH ${uidSet} (FLAGS UID)\r\n`) }],
});

export const buildFetchRawCommand = (tag: string, uid: number): OutgoingCommand => ({
  lines: [{ text: stringToBytes(`${tag} UID FETCH ${uid} (BODY.PEEK[])\r\n`) }],
});

export const buildStoreFlagsCommand = (
  tag: string,
  uidSet: string,
  mode: 'add' | 'remove' | 'set',
  flags: readonly string[],
): OutgoingCommand => {
  const op = mode === 'add' ? '+FLAGS' : mode === 'remove' ? '-FLAGS' : 'FLAGS';
  return {
    lines: [{ text: stringToBytes(`${tag} UID STORE ${uidSet} ${op} (${flags.join(' ')})\r\n`) }],
  };
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const two = (value: number) => String(value).padStart(2, '0');

/** RFC 9051 date-time. The day is space-padded, which the grammar requires and several servers enforce. */
export const formatImapDateTime = (date: Date): string => {
  const offset = -date.getTimezoneOffset();
  const sign = offset < 0 ? '-' : '+';
  const zone = `${sign}${two(Math.floor(Math.abs(offset) / 60))}${two(Math.abs(offset) % 60)}`;
  const day = String(date.getDate()).padStart(2, ' ');
  return `"${day}-${MONTHS[date.getMonth()]}-${date.getFullYear()} ${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())} ${zone}"`;
};

export const buildAppendCommand = (
  tag: string,
  mailbox: string,
  flags: readonly string[],
  message: Uint8Array,
  internalDate?: Date,
): OutgoingCommand => {
  const mboxUtf7 = encodeModifiedUtf7(mailbox);
  const stamp = internalDate === undefined ? '' : `${formatImapDateTime(internalDate)} `;
  return {
    lines: [
      {
        text: stringToBytes(`${tag} APPEND ${quoteString(mboxUtf7)} (${flags.join(' ')}) ${stamp}`),
        literal: message,
      },
      { text: stringToBytes('\r\n') },
    ],
  };
};

export const buildExpungeCommand = (tag: string): OutgoingCommand => ({
  lines: [{ text: stringToBytes(`${tag} EXPUNGE\r\n`) }],
});

/** RFC 4315. */
export const buildUidExpungeCommand = (tag: string, uidSet: string): OutgoingCommand => ({
  lines: [{ text: stringToBytes(`${tag} UID EXPUNGE ${uidSet}\r\n`) }],
});

/** A server need only index the headers IMAP names; on a private `X-` header it may answer the empty list. */
export const buildUidSearchHeaderCommand = (
  tag: string,
  header: string,
  value: string,
): OutgoingCommand => ({
  lines: [
    {
      text: stringToBytes(
        `${tag} UID SEARCH HEADER ${quoteString(header)} ${quoteString(value)}\r\n`,
      ),
    },
  ],
});

/** RFC 6851. */
export const buildMoveCommand = (
  tag: string,
  uidSet: string,
  mailbox: string,
): OutgoingCommand => ({
  lines: [
    {
      text: stringToBytes(
        `${tag} UID MOVE ${uidSet} ${quoteString(encodeModifiedUtf7(mailbox))}\r\n`,
      ),
    },
  ],
});

export const buildCreateCommand = (tag: string, mailbox: string): OutgoingCommand => ({
  lines: [
    {
      text: stringToBytes(`${tag} CREATE ${quoteString(encodeModifiedUtf7(mailbox))}\r\n`),
    },
  ],
});

export const buildNoopCommand = (tag: string): OutgoingCommand => ({
  lines: [{ text: stringToBytes(`${tag} NOOP\r\n`) }],
});

export const buildIdleCommand = (tag: string): OutgoingCommand => ({
  lines: [{ text: stringToBytes(`${tag} IDLE\r\n`) }],
});

/** RFC 2177: the client ends IDLE with a bare DONE line (no tag). */
export const buildIdleDoneLine = (): Uint8Array => stringToBytes('DONE\r\n');

export const buildLogoutCommand = (tag: string): OutgoingCommand => ({
  lines: [{ text: stringToBytes(`${tag} LOGOUT\r\n`) }],
});
