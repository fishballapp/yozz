import type { ByteDuplex, MailSocket } from './servers.ts';

// An IMAP server in memory, for tests: the commands `@yozz.app/imap` sends on the CLI's paths
// (AUTHENTICATE, LIST, SELECT, FETCH and UID FETCH, UID STORE, UID MOVE with COPYUID, CREATE,
// APPEND with APPENDUID, UID SEARCH TEXT and HEADER, IDLE, NOOP, LOGOUT), over a byte pipe, so the
// real client parses real responses.

export type FakeMessage = {
  readonly from: string;
  readonly fromName?: string;
  readonly to: string;
  readonly subject: string;
  readonly messageId: string;
  /** RFC 5322, e.g. `Thu, 29 Oct 2026 08:14:00 +0000`. */
  readonly date: string;
  readonly text: string;
  readonly inReplyTo?: string;
  readonly references?: readonly string[];
  readonly cc?: readonly string[];
  readonly replyTo?: string;
  readonly attachments?: readonly {
    readonly name: string;
    readonly type: string;
    readonly content: string;
  }[];
  /** `Authentication-Results` headers, top first. */
  readonly authenticationResults?: readonly string[];
};

type Stored = {
  readonly uid: number;
  flags: Set<string>;
  readonly message: FakeMessage;
  readonly raw: Uint8Array;
};

type Mailbox = {
  readonly attributes: readonly string[];
  uidValidity: number;
  uidNext: number;
  messages: Stored[];
};

const encoder = new TextEncoder();
const bytes = (text: string) => encoder.encode(text);
const concat = (...parts: readonly Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};

const isAscii = (text: string) => [...text].every(character => character.charCodeAt(0) < 0x80);

/** An RFC 2047 encoded word when the text is not plain ASCII, as a server's ENVELOPE carries it. */
const encodedWord = (text: string) =>
  isAscii(text) ? text : `=?UTF-8?B?${bytes(text).toBase64()}?=`;

const unquote = (text: string) => text.trim().replace(/^"|"$/g, '').replace(/\\(.)/g, '$1');

const quoted = (text: string | undefined) =>
  text === undefined ? 'NIL' : `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

const addressList = (address: string, name?: string) => {
  const at = address.lastIndexOf('@');
  return `((${name === undefined ? 'NIL' : quoted(encodedWord(name))} NIL ${quoted(address.slice(0, at))} ${quoted(address.slice(at + 1))}))`;
};

const rawOf = (message: FakeMessage): Uint8Array => {
  const headers = [
    ...(message.authenticationResults ?? []).map(value => `Authentication-Results: ${value}`),
    `From: ${message.fromName === undefined ? '' : `${encodedWord(message.fromName)} `}<${message.from}>`,
    `To: <${message.to}>`,
    ...(message.cc === undefined
      ? []
      : [`Cc: ${message.cc.map(address => `<${address}>`).join(', ')}`]),
    ...(message.replyTo === undefined ? [] : [`Reply-To: <${message.replyTo}>`]),
    `Subject: ${encodedWord(message.subject)}`,
    `Message-ID: ${message.messageId}`,
    `Date: ${message.date}`,
    ...(message.inReplyTo === undefined ? [] : [`In-Reply-To: ${message.inReplyTo}`]),
    ...(message.references === undefined ? [] : [`References: ${message.references.join(' ')}`]),
    'MIME-Version: 1.0',
  ];
  const text = message.text.replace(/\n/g, '\r\n');
  if (message.attachments === undefined || message.attachments.length === 0) {
    return bytes(
      `${[...headers, 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: 8bit'].join('\r\n')}\r\n\r\n${text}\r\n`,
    );
  }
  const boundary = 'fake-boundary-1';
  const parts = [
    `--${boundary}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n${text}\r\n`,
    ...message.attachments.map(
      ({ name, type, content }) =>
        `--${boundary}\r\nContent-Type: ${type}; name="${name}"\r\nContent-Disposition: attachment; filename="${name}"\r\nContent-Transfer-Encoding: base64\r\n\r\n${bytes(content).toBase64()}\r\n`,
    ),
  ];
  return bytes(
    `${[...headers, `Content-Type: multipart/mixed; boundary="${boundary}"`].join('\r\n')}\r\n\r\n${parts.join('')}--${boundary}--\r\n`,
  );
};

/** The headers a summary shows, read back from a message a client appended. */
const appendedOf = (raw: string): FakeMessage => {
  const head = raw.slice(0, raw.indexOf('\r\n\r\n')).replace(/\r\n[ \t]+/gu, ' ');
  const header = (name: string) =>
    head
      .split('\r\n')
      .find(line => line.toLowerCase().startsWith(`${name.toLowerCase()}:`))
      ?.slice(name.length + 1)
      .trim();
  const addressOf = (value: string | undefined) =>
    /<([^>]+)>/u.exec(value ?? '')?.[1] ?? value ?? '';
  return {
    from: addressOf(header('From')),
    to: addressOf(header('To')?.split(',')[0]),
    subject: header('Subject') ?? '',
    messageId: header('Message-ID') ?? '',
    date: header('Date') ?? '',
    text: raw.slice(raw.indexOf('\r\n\r\n') + 4),
    ...(header('In-Reply-To') === undefined ? {} : { inReplyTo: header('In-Reply-To') }),
    ...(header('References') === undefined
      ? {}
      : { references: (header('References') ?? '').split(/\s+/u) }),
  };
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const internalDateOf = ({ date }: FakeMessage) => {
  const at = new Date(Date.parse(date));
  const two = (n: number) => String(n).padStart(2, '0');
  return `${two(at.getUTCDate())}-${MONTHS[at.getUTCMonth()]}-${at.getUTCFullYear()} ${two(at.getUTCHours())}:${two(at.getUTCMinutes())}:${two(at.getUTCSeconds())} +0000`;
};

/** A pipe whose two ends read what the other writes. */
export const pipe = () => {
  const make = () => {
    const queue: (Uint8Array | null)[] = [];
    let waiter: ((chunk: Uint8Array | null) => void) | null = null;
    return {
      push: (chunk: Uint8Array | null) => {
        const pending = waiter;
        waiter = null;
        if (pending === null) {
          queue.push(chunk);
        } else {
          pending(chunk);
        }
      },
      read: () =>
        new Promise<Uint8Array | null>(resolve => {
          if (queue.length > 0) return resolve(queue.shift() ?? null);
          waiter = resolve;
        }),
    };
  };
  const toServer = make();
  const toClient = make();
  const client: ByteDuplex = {
    read: toClient.read,
    write: async chunk => toServer.push(chunk.slice()),
  };
  const server: ByteDuplex = {
    read: toServer.read,
    write: async chunk => toClient.push(chunk.slice()),
  };
  return {
    client,
    server,
    close: () => {
      toServer.push(null);
      toClient.push(null);
    },
  };
};

/** The uids a set names in `stored` (by uid, or by sequence number), `*` the last. */
const select = (set: string, stored: readonly Stored[], byUid: boolean): Stored[] => {
  const keyOf = (message: Stored, index: number) => (byUid ? message.uid : index + 1);
  const last =
    stored.length === 0 ? 0 : keyOf(stored[stored.length - 1] as Stored, stored.length - 1);
  const value = (text: string) => (text === '*' ? last : Number(text));
  const ranges = set.split(',').map(part => {
    const [from = '', to = from] = part.split(':');
    const [a, b] = [value(from), value(to)];
    return [Math.min(a, b), Math.max(a, b)] as const;
  });
  return stored.filter((message, index) =>
    ranges.some(([low, high]) => {
      const key = keyOf(message, index);
      // `n:*` past the last still names the last, as RFC 9051 has it.
      return (key >= low && key <= high) || (high === last && low > last && key === last);
    }),
  );
};

export type FakeImapServer = {
  /** Every command the server received, without its tag. */
  readonly commands: string[];
  readonly mailboxes: Map<string, Mailbox>;
  /** Files a message in a mailbox, telling any connection idling on it. */
  readonly deliver: (mailbox: string, message: FakeMessage, flags?: readonly string[]) => number;
  /** Opens a connection, as `MailServers.open` would. */
  readonly open: () => MailSocket;
  /** How many connections were opened. */
  readonly connections: () => number;
};

export const makeFakeImapServer = ({
  username,
  password,
  capabilities = ['IMAP4rev1', 'SASL-IR', 'AUTH=PLAIN', 'UIDPLUS', 'MOVE', 'IDLE'],
  quirks = {},
  mailboxes = [
    { name: 'INBOX', attributes: [] },
    { name: 'Sent', attributes: ['\\Sent'] },
    { name: 'Archive', attributes: ['\\Archive'] },
    { name: 'Trash', attributes: ['\\Trash'] },
  ],
}: {
  readonly username: string;
  readonly password: string;
  readonly capabilities?: readonly string[];
  readonly mailboxes?: readonly { readonly name: string; readonly attributes: readonly string[] }[];
  /** Misbehaviour to stage: a SELECT held this long. */
  readonly quirks?: {
    readonly selectDelayMs?: (mailbox: string, nth: number) => number;
  };
}): FakeImapServer => {
  const commands: string[] = [];
  const boxes = new Map<string, Mailbox>(
    mailboxes.map(({ name, attributes }, index) => [
      name,
      { attributes, uidValidity: 100 + index, uidNext: 1, messages: [] },
    ]),
  );
  const idlers = new Set<(mailbox: string) => void>();
  const selects = new Map<string, number>();
  let opened = 0;

  const deliver: FakeImapServer['deliver'] = (name, message, flags = []) => {
    const box = boxes.get(name);
    if (box === undefined) throw new Error(`no mailbox ${name}`);
    const uid = box.uidNext;
    box.uidNext += 1;
    box.messages.push({ uid, flags: new Set(flags), message, raw: rawOf(message) });
    for (const idler of idlers) idler(name);
    return uid;
  };

  const session = (io: ByteDuplex, close: () => void) => {
    let selected: string | null = null;
    let buffer = new Uint8Array();
    const send = (...lines: (string | Uint8Array)[]) =>
      io.write(concat(...lines.map(line => (typeof line === 'string' ? bytes(line) : line))));

    /** One line, or null at the end; a `{n}` literal is asked for and read in. */
    const readLine = async (): Promise<string | null> => {
      let line = new Uint8Array();
      for (;;) {
        const end = buffer.findIndex((byte, index) => byte === 0x0a && buffer[index - 1] === 0x0d);
        if (end === -1) {
          const chunk = await io.read();
          if (chunk === null) return null;
          buffer = concat(buffer, chunk);
          continue;
        }
        const text = new TextDecoder().decode(buffer.slice(0, end - 1));
        buffer = buffer.slice(end + 1);
        const literal = /\{(\d+)\+?\}$/u.exec(text);
        if (literal === null) return new TextDecoder().decode(concat(line, bytes(text)));
        const size = Number(literal[1]);
        if (!literal[0].includes('+')) await send('+ go ahead\r\n');
        while (buffer.length < size) {
          const chunk = await io.read();
          if (chunk === null) return null;
          buffer = concat(buffer, chunk);
        }
        line = concat(
          line,
          bytes(text.slice(0, -literal[0].length)),
          bytes('"'),
          buffer.slice(0, size),
          bytes('"'),
        );
        buffer = buffer.slice(size);
      }
    };

    const box = () => (selected === null ? undefined : boxes.get(selected));
    const summary = (message: Stored, seq: number) => {
      const { from, fromName, to, cc, replyTo, subject, messageId, date, inReplyTo, references } =
        message.message;
      const ccList =
        cc === undefined || cc.length === 0
          ? 'NIL'
          : `(${cc.map(address => addressList(address).slice(1, -1)).join('')})`;
      const replyToList =
        replyTo === undefined ? addressList(from, fromName) : addressList(replyTo);
      const envelope = `(${quoted(date)} ${quoted(encodedWord(subject))} ${addressList(from, fromName)} ${addressList(from, fromName)} ${replyToList} ${addressList(to)} ${ccList} NIL ${quoted(inReplyTo)} ${quoted(messageId)})`;
      const referencesHeader = bytes(
        references === undefined ? '\r\n' : `References: ${references.join(' ')}\r\n\r\n`,
      );
      return concat(
        bytes(
          `* ${seq} FETCH (UID ${message.uid} FLAGS (${[...message.flags].join(' ')}) INTERNALDATE "${internalDateOf(message.message)}" RFC822.SIZE ${message.raw.length} ENVELOPE ${envelope} BODY[HEADER.FIELDS (REFERENCES)] {${referencesHeader.length}}\r\n`,
        ),
        referencesHeader,
        bytes(')\r\n'),
      );
    };
    const seqOf = (mailbox: Mailbox, message: Stored) => mailbox.messages.indexOf(message) + 1;

    const handle = async (tag: string, command: string, rest: string): Promise<boolean> => {
      const ok = (text = `${command} completed`) => send(`${tag} OK ${text}\r\n`);
      const no = (text: string) => send(`${tag} NO ${text}\r\n`);
      const mailbox = box();
      switch (command) {
        case 'CAPABILITY':
          await send(`* CAPABILITY ${capabilities.join(' ')}\r\n`);
          await ok();
          return true;
        case 'AUTHENTICATE': {
          const [, initial = ''] = rest.split(' ');
          const [, user, pass] = new TextDecoder()
            .decode(Uint8Array.fromBase64(initial))
            .split('\u0000');
          if (user === username && pass === password) {
            await ok();
          } else {
            await no('[AUTHENTICATIONFAILED] Invalid credentials');
          }
          return true;
        }
        case 'LIST':
          for (const [name, { attributes }] of boxes) {
            await send(`* LIST (${attributes.join(' ')}) "/" ${quoted(name)}\r\n`);
          }
          await ok();
          return true;
        case 'SELECT':
        case 'EXAMINE': {
          const name = unquote(rest);
          const nth = (selects.get(name) ?? 0) + 1;
          selects.set(name, nth);
          const delay = quirks.selectDelayMs?.(name, nth) ?? 0;
          if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
          const target = boxes.get(name);
          if (target === undefined) {
            selected = null;
            await no(`No mailbox ${name}`);
            return true;
          }
          selected = name;
          await send(
            `* ${target.messages.length} EXISTS\r\n`,
            `* OK [UIDVALIDITY ${target.uidValidity}] UIDs valid\r\n`,
            `* OK [UIDNEXT ${target.uidNext}] Predicted next UID\r\n`,
            '* FLAGS (\\Seen \\Flagged \\Answered \\Deleted \\Draft)\r\n',
          );
          await ok('[READ-WRITE] SELECT completed');
          return true;
        }
        case 'CREATE': {
          const name = unquote(rest);
          boxes.set(name, {
            attributes: [],
            uidValidity: 900 + boxes.size,
            uidNext: 1,
            messages: [],
          });
          await ok();
          return true;
        }
        case 'APPEND': {
          // The literal arrives inlined as a quoted string: `"Sent" (\Seen) "<message>"`.
          const target = boxes.get(unquote(rest.slice(0, rest.indexOf(' ('))));
          if (target === undefined) {
            await no('[TRYCREATE] No such mailbox');
            return true;
          }
          const raw = rest.slice(rest.indexOf(') "') + 3, -1);
          const uid = target.uidNext;
          target.uidNext += 1;
          target.messages.push({
            uid,
            flags: new Set(/\(([^)]*)\)/u.exec(rest)?.[1]?.split(' ').filter(Boolean)),
            message: appendedOf(raw),
            raw: bytes(raw),
          });
          await ok(`[APPENDUID ${target.uidValidity} ${uid}] APPEND completed`);
          return true;
        }
        case 'FETCH':
        case 'UID': {
          if (mailbox === undefined) {
            await send(`${tag} BAD No mailbox selected\r\n`);
            return true;
          }
          const isUid = command === 'UID';
          const [verb, ...args] = isUid ? rest.split(' ') : ['FETCH', ...rest.split(' ')];
          const set = args[0] ?? '';
          const items = args.slice(1).join(' ');
          if (verb === 'FETCH') {
            for (const message of select(set, mailbox.messages, isUid)) {
              const seq = seqOf(mailbox, message);
              if (items.includes('ENVELOPE')) {
                await send(summary(message, seq));
              } else if (items.includes('BODY.PEEK[]')) {
                await send(
                  `* ${seq} FETCH (UID ${message.uid} BODY[] {${message.raw.length}}\r\n`,
                  message.raw,
                  ')\r\n',
                );
              } else {
                await send(
                  `* ${seq} FETCH (UID ${message.uid} FLAGS (${[...message.flags].join(' ')}))\r\n`,
                );
              }
            }
            await ok(`${verb} completed`);
            return true;
          }
          if (verb === 'STORE') {
            const [mode = '', ...flagWords] = args.slice(1);
            const flags = flagWords.join(' ').replace(/[()]/g, '').split(' ').filter(Boolean);
            for (const message of select(set, mailbox.messages, true)) {
              for (const flag of flags) {
                if (mode.startsWith('+')) {
                  message.flags.add(flag);
                } else {
                  message.flags.delete(flag);
                }
              }
              await send(
                `* ${seqOf(mailbox, message)} FETCH (UID ${message.uid} FLAGS (${[...message.flags].join(' ')}))\r\n`,
              );
            }
            await ok('STORE completed');
            return true;
          }
          if (verb === 'MOVE') {
            const destination = boxes.get(unquote(args.slice(1).join(' ')));
            if (destination === undefined) {
              await no('[TRYCREATE] No such mailbox');
              return true;
            }
            const moving = select(set, mailbox.messages, true);
            const sources: number[] = [];
            const targets: number[] = [];
            for (const message of moving) {
              sources.push(message.uid);
              targets.push(destination.uidNext);
              destination.messages.push({ ...message, uid: destination.uidNext });
              destination.uidNext += 1;
            }
            if (capabilities.includes('UIDPLUS') && moving.length > 0) {
              await send(
                `* OK [COPYUID ${destination.uidValidity} ${sources.join(',')} ${targets.join(',')}] Moved\r\n`,
              );
            }
            for (const message of moving.toReversed()) {
              await send(`* ${seqOf(mailbox, message)} EXPUNGE\r\n`);
              mailbox.messages = mailbox.messages.filter(candidate => candidate !== message);
            }
            await ok('MOVE completed');
            return true;
          }
          if (verb === 'SEARCH') {
            const quotedArgs = [...rest.matchAll(/"((?:[^"\\]|\\.)*)"/gu)].map(([, arg = '']) =>
              arg.replace(/\\(.)/gu, '$1'),
            );
            const isHeader = / HEADER /u.test(rest);
            const [header = '', value = ''] = quotedArgs;
            const text = quotedArgs.at(-1) ?? '';
            const hits = mailbox.messages.filter(message => {
              const raw = new TextDecoder().decode(message.raw);
              if (!isHeader) return raw.toLowerCase().includes(text.toLowerCase());
              const head = raw.slice(0, raw.indexOf('\r\n\r\n'));
              return head
                .split('\r\n')
                .some(
                  line =>
                    line.toLowerCase().startsWith(`${header.toLowerCase()}:`) &&
                    line.toLowerCase().includes(value.toLowerCase()),
                );
            });
            await send(`* SEARCH${hits.map(({ uid }) => ` ${uid}`).join('')}\r\n`);
            await ok('SEARCH completed');
            return true;
          }
          await send(`${tag} BAD Unknown UID command\r\n`);
          return true;
        }
        case 'IDLE': {
          await send('+ idling\r\n');
          const notify = (name: string) => {
            if (name === selected && mailbox !== undefined) {
              void send(`* ${mailbox.messages.length} EXISTS\r\n`);
            }
          };
          idlers.add(notify);
          const done = await readLine();
          idlers.delete(notify);
          if (done === null) return false;
          commands.push('DONE');
          await ok('IDLE terminated');
          return true;
        }
        case 'NOOP':
          await ok();
          return true;
        case 'LOGOUT':
          await send('* BYE Logging out\r\n');
          await ok();
          return false;
        default:
          await send(`${tag} BAD Unknown command\r\n`);
          return true;
      }
    };

    void (async () => {
      await send(`* OK [CAPABILITY ${capabilities.join(' ')}] Fake IMAP ready\r\n`);
      for (;;) {
        const line = await readLine();
        if (line === null) break;
        const [tag = '', command = '', ...rest] = line.split(' ');
        commands.push(`${command.toUpperCase()} ${rest.join(' ')}`.trim());
        if (!(await handle(tag, command.toUpperCase(), rest.join(' ')))) break;
      }
      close();
    })();
  };

  return {
    commands,
    mailboxes: boxes,
    deliver,
    open: () => {
      opened += 1;
      const { client, server, close } = pipe();
      session(server, close);
      return { duplex: client, setQuietLimit: () => {}, destroy: close };
    },
    connections: () => opened,
  };
};
