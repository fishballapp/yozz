import { asciiToString, concatByteArrays, stringToBytes } from './bytes.ts';
import {
  buildAppendCommand,
  buildAuthenticatePlainInitialCommand,
  buildAuthenticatePlainResponse,
  buildAuthenticatePlainSaslIrCommand,
  buildCapabilityCommand,
  buildCreateCommand,
  buildExpungeCommand,
  buildFetchFlagsCommand,
  buildFetchRawCommand,
  buildFetchSummariesCommand,
  buildIdleCommand,
  buildIdleDoneLine,
  buildListCommand,
  buildLoginCommand,
  buildLogoutCommand,
  buildMoveCommand,
  buildNoopCommand,
  buildSelectCommand,
  buildStoreFlagsCommand,
  buildUidExpungeCommand,
  buildUidSearchHeaderCommand,
  type OutgoingCommand,
} from './commands.ts';
import type { ImapAddress, ImapEnvelope } from './envelope.ts';
import {
  type ImapMailbox,
  type ImapResponse,
  type ImapResponseCode,
  type ImapTagged,
  type ImapUntagged,
  parseResponse,
} from './response.ts';
import {
  DEFAULT_MAX_LITERAL_BYTES,
  type ImapFailure,
  type ImapResult,
  type ReadLineResume,
  readLogicalLine,
  tokenizeLogicalLine,
} from './tokenizer.ts';
import type { ByteDuplex } from './transport.ts';

export type { ImapAddress, ImapEnvelope, ImapMailbox, ImapResponseCode, ImapUntagged };

export type ImapMessageSummary = {
  readonly seq: number;
  readonly uid: number;
  readonly flags: readonly string[];
  readonly internalDate: string | null;
  readonly size: number | null;
  readonly envelope: ImapEnvelope | null;
  /** The msg-ids of the `References` header, in order; empty when the message carries none. */
  readonly references: readonly string[];
  /** Gmail's thread id (decimal digits), when the server was asked and answered. */
  readonly gmailThreadId: string | null;
};

export type ImapMessageFlags = {
  readonly uid: number;
  readonly flags: readonly string[];
};

export type ImapSelected = {
  readonly name: string;
  readonly exists: number;
  readonly uidValidity: number | null;
  readonly uidNext: number | null;
  readonly flags: readonly string[];
  readonly permanentFlags: readonly string[];
  readonly readOnly: boolean;
};

export type ImapClientOptions = {
  readonly onUntagged?: (response: ImapUntagged) => void;
  /** Default 32 MiB; a larger literal is a protocol failure. */
  readonly maxLiteralBytes?: number;
};

export type ImapIdle = {
  /** Sends DONE (once; later calls are no-ops) and resolves with the IDLE's outcome. */
  readonly done: () => Promise<ImapResult<void>>;
  /** The same outcome, for a caller that wants to observe an idle ending on its own (BYE, EOF). */
  readonly ended: Promise<ImapResult<void>>;
};

export type ImapClient = {
  readonly greeting: () => Promise<
    ImapResult<{ readonly text: string; readonly capabilities: readonly string[] | null }>
  >;
  readonly capability: () => Promise<ImapResult<readonly string[]>>;
  /** Last known. */
  readonly capabilities: () => readonly string[];
  /** Case-insensitive check against the last known capability list. */
  readonly hasCapability: (name: string) => boolean;
  readonly authenticate: (username: string, password: string) => Promise<ImapResult<void>>;
  readonly list: (
    reference: string,
    pattern: string,
  ) => Promise<ImapResult<readonly ImapMailbox[]>>;
  readonly select: (
    mailbox: string,
    options?: { readonly readOnly?: boolean },
  ) => Promise<ImapResult<ImapSelected>>;
  /** `uidSet` is an IMAP sequence-set, e.g. "1:*" or "100:200". */
  readonly fetchSummaries: (uidSet: string) => Promise<ImapResult<readonly ImapMessageSummary[]>>;
  /** By message sequence number (dense, 1..EXISTS) rather than uid (sparse after deletions). */
  readonly fetchSummariesBySeq: (
    seqSet: string,
  ) => Promise<ImapResult<readonly ImapMessageSummary[]>>;
  readonly fetchFlags: (uidSet: string) => Promise<ImapResult<readonly ImapMessageFlags[]>>;
  readonly fetchRaw: (uid: number) => Promise<ImapResult<Uint8Array>>;
  readonly storeFlags: (
    uidSet: string,
    mode: 'add' | 'remove' | 'set',
    flags: readonly string[],
  ) => Promise<ImapResult<void>>;
  /** Resolves with the RFC 4315 `APPENDUID`, or `null` from a server without UIDPLUS. */
  readonly append: (
    mailbox: string,
    message: Uint8Array,
    flags: readonly string[],
    internalDate?: Date,
  ) => Promise<ImapResult<AppendUid | null>>;
  readonly expunge: () => Promise<ImapResult<void>>;
  /** RFC 4315. Refuses without UIDPLUS rather than falling back to EXPUNGE, which erases more than asked. */
  readonly uidExpunge: (uidSet: string) => Promise<ImapResult<void>>;
  readonly uidSearchHeader: (
    header: string,
    value: string,
  ) => Promise<ImapResult<readonly number[]>>;
  /** RFC 6851. Answers with the RFC 4315 `COPYUID`, or null when the server gave none. Refuses without MOVE. */
  readonly move: (uidSet: string, mailbox: string) => Promise<ImapResult<CopyUid | null>>;
  readonly create: (mailbox: string) => Promise<ImapResult<void>>;
  readonly noop: () => Promise<ImapResult<void>>;
  /** RFC 2177. Occupies the command queue until `done()`; untagged responses meanwhile go to `onUntagged`. */
  readonly idle: () => ImapIdle;
  readonly logout: () => Promise<ImapResult<void>>;
};

/** RFC 4315 `[APPENDUID <uidvalidity> <uid>]`. */
export type AppendUid = { readonly uidValidity: number; readonly uid: number };

const appendUidOf = (tagged: ImapTagged): AppendUid | null => {
  const code = tagged.code;
  if (code?.kind !== 'other' || code.code !== 'APPENDUID') return null;
  const [uidValidity, uid] = code.args.map(Number);
  if (uidValidity === undefined || uid === undefined) return null;
  return Number.isInteger(uidValidity) && Number.isInteger(uid) ? { uidValidity, uid } : null;
};

/** `first` to `last` inclusive, ascending: RFC 4315 §3 reads a range `12:10` as 10, 11, 12. */
type UidRange = readonly [first: number, last: number];

/**
 * RFC 4315 `COPYUID`: the n-th uid of `source` is now the n-th uid of `target`, in a destination
 * mailbox whose UIDVALIDITY is `uidValidity`. Kept as ranges: a server's `1:4294967295` costs two
 * numbers, never four billion. Read one uid's destination with `copiedUid`.
 */
export type CopyUid = {
  readonly uidValidity: number;
  readonly source: readonly UidRange[];
  readonly target: readonly UidRange[];
};

/** RFC 3501 nz-number: what a uid can be. */
const MAX_UID = 4_294_967_295;

const uidOf = (text: string): number | null => {
  if (!/^[1-9][0-9]*$/.test(text)) return null;
  const uid = Number(text);
  return uid <= MAX_UID ? uid : null;
};

/** A uid set without `*`, which COPYUID never carries; null when malformed. */
const uidRangesOf = (text: string): readonly UidRange[] | null => {
  const ranges: UidRange[] = [];
  for (const part of text.split(',')) {
    const bounds = part.split(':').map(uidOf);
    const uids = bounds.filter(uid => uid !== null);
    const [first, last] = uids;
    if (first === undefined || uids.length < bounds.length || uids.length > 2) return null;
    const end = last ?? first;
    ranges.push([Math.min(first, end), Math.max(first, end)]);
  }
  return ranges;
};

const sizeOfRange = ([first, last]: UidRange) => last - first + 1;

const sizeOf = (ranges: readonly UidRange[]) =>
  ranges.reduce((size, range) => size + sizeOfRange(range), 0);

const copyUidOfCode = (code: ImapResponseCode | null): CopyUid | null => {
  if (code?.kind !== 'other' || code.code !== 'COPYUID') return null;
  const [validity, sourceSet, targetSet] = code.args;
  if (validity === undefined || sourceSet === undefined || targetSet === undefined) return null;
  const uidValidity = uidOf(validity);
  const source = uidRangesOf(sourceSet);
  const target = uidRangesOf(targetSet);
  if (uidValidity === null || source === null || target === null) return null;
  return sizeOf(source) === sizeOf(target) ? { uidValidity, source, target } : null;
};

/**
 * RFC 6851 §4.3 has a MOVE's COPYUID in an untagged OK ahead of its EXPUNGEs (Gmail, Dovecot);
 * RFC 4315 puts a COPY's on the tagged OK, and some servers do that for MOVE too. Either, or
 * several of them, read as one answer.
 */
const copyUidOf = (untagged: readonly ImapUntagged[], tagged: ImapTagged): CopyUid | null => {
  const answers = [
    ...untagged.map(response => (response.kind === 'status' ? response.code : null)),
    tagged.code,
  ].flatMap(code => copyUidOfCode(code) ?? []);
  const [first] = answers;
  if (first === undefined) return null;
  if (answers.some(answer => answer.uidValidity !== first.uidValidity)) return null;
  return {
    uidValidity: first.uidValidity,
    source: answers.flatMap(answer => answer.source),
    target: answers.flatMap(answer => answer.target),
  };
};

/** How many uids come before `uid`, counting through `ranges` in order; null when none holds it. */
const positionOf = (ranges: readonly UidRange[], uid: number): number | null => {
  let before = 0;
  for (const range of ranges) {
    const [first, last] = range;
    if (uid >= first && uid <= last) return before + uid - first;
    before += sizeOfRange(range);
  }
  return null;
};

/** The uid at `position`, counting through `ranges` in order; null past their end. */
const uidAt = (ranges: readonly UidRange[], position: number): number | null => {
  let before = 0;
  for (const range of ranges) {
    if (position < before + sizeOfRange(range)) return range[0] + position - before;
    before += sizeOfRange(range);
  }
  return null;
};

/** Where `COPYUID` says the message at `uid` went, or null when it does not mention it. */
export const copiedUid = ({ source, target }: CopyUid, uid: number): number | null => {
  const position = positionOf(source, uid);
  return position === null ? null : uidAt(target, position);
};

export const parseReferencesHeader = (bytes: Uint8Array | null): readonly string[] => {
  if (bytes === null) return [];
  const unfolded = asciiToString(bytes).replace(/\r?\n[ \t]+/g, ' ');
  const line = unfolded.split(/\r?\n/).find(l => /^references:/i.test(l));
  if (line === undefined) return [];
  return line.slice(line.indexOf(':') + 1).match(/<[^<>\s]+>/g) ?? [];
};

const summariesFrom = (untagged: readonly ImapUntagged[]): readonly ImapMessageSummary[] =>
  untagged.flatMap(item => {
    if (item.kind !== 'fetch') return [];
    let uid = 0;
    let flags: readonly string[] = [];
    let internalDate: string | null = null;
    let size: number | null = null;
    let envelope: ImapEnvelope | null = null;
    let references: readonly string[] = [];
    let gmailThreadId: string | null = null;

    for (const fItem of item.items) {
      if (fItem.kind === 'uid') {
        uid = fItem.uid;
      } else if (fItem.kind === 'flags') {
        flags = fItem.flags;
      } else if (fItem.kind === 'internalDate') {
        internalDate = fItem.date;
      } else if (fItem.kind === 'size') {
        size = fItem.size;
      } else if (fItem.kind === 'envelope') {
        envelope = fItem.envelope;
      } else if (fItem.kind === 'gmailThreadId') {
        gmailThreadId = fItem.id;
      } else if (fItem.kind === 'body' && fItem.section.toUpperCase().startsWith('HEADER.FIELDS')) {
        references = parseReferencesHeader(fItem.bytes);
      }
    }

    return [{ seq: item.seq, uid, flags, internalDate, size, envelope, references, gmailThreadId }];
  });

export const createImapClient = (
  transport: ByteDuplex,
  options?: ImapClientOptions,
): ImapClient => {
  const maxLiteralBytes = options?.maxLiteralBytes ?? DEFAULT_MAX_LITERAL_BYTES;
  const onUntagged = options?.onUntagged;

  let chunks: Uint8Array[] = [];
  let totalBufferedBytes = 0;
  let resumeState: ReadLineResume | undefined;
  let isClosed = false;
  let failureReason: ImapFailure | null = null;
  let knownCapabilities: string[] = [];
  let tagCounter = 1;

  const nextTag = (): string => `A${String(tagCounter++).padStart(4, '0')}`;

  const readNextResponse = async (): Promise<ImapResult<ImapResponse>> => {
    if (failureReason !== null) {
      return { ok: false, reason: failureReason };
    }
    if (isClosed) {
      return { ok: false, reason: { kind: 'closed' } };
    }

    while (true) {
      if (resumeState === undefined || totalBufferedBytes >= resumeState.needBytes) {
        const buffer =
          chunks.length === 1 && chunks[0] !== undefined ? chunks[0] : concatByteArrays(chunks);

        const lineResult = readLogicalLine(buffer, maxLiteralBytes, resumeState);

        if (lineResult.status === 'failure') {
          isClosed = true;
          failureReason = lineResult.failure;
          return { ok: false, reason: lineResult.failure };
        }

        if (lineResult.status === 'complete') {
          const remainingBytes = buffer.length - lineResult.consumedBytes;
          if (remainingBytes > 0) {
            chunks = [buffer.slice(lineResult.consumedBytes)];
            totalBufferedBytes = remainingBytes;
          } else {
            chunks = [];
            totalBufferedBytes = 0;
          }
          resumeState = undefined;

          const tokenResult = tokenizeLogicalLine(lineResult.line);
          if (!tokenResult.ok) {
            isClosed = true;
            failureReason = tokenResult.reason;
            return { ok: false, reason: tokenResult.reason };
          }

          const parseResult = parseResponse(tokenResult.value);
          if (!parseResult.ok) {
            isClosed = true;
            failureReason = parseResult.reason;
            return { ok: false, reason: parseResult.reason };
          }

          return parseResult;
        }

        resumeState = lineResult;
      }

      // A transport that throws has closed; the greeting read is not awaited by anyone, so this must never reject.
      const chunk = await transport.read().catch(() => null);
      if (chunk === null) {
        isClosed = true;
        failureReason = { kind: 'closed' };
        return { ok: false, reason: { kind: 'closed' } };
      }

      chunks.push(chunk);
      totalBufferedBytes += chunk.length;
    }
  };

  const greetingPromise: Promise<
    ImapResult<{ readonly text: string; readonly capabilities: readonly string[] | null }>
  > = (async () => {
    const res = await readNextResponse();
    if (!res.ok) return res;

    if (res.value.kind === 'untagged' && res.value.untagged.kind === 'status') {
      const status = res.value.untagged.status;
      if (status === 'OK' || status === 'PREAUTH') {
        const code = res.value.untagged.code;
        const caps = code !== null && code.kind === 'capability' ? code.capabilities : null;
        if (caps !== null) {
          knownCapabilities = [...caps];
        }
        return {
          ok: true,
          value: {
            text: res.value.untagged.text,
            capabilities: caps,
          },
        };
      }
      if (status === 'BYE') {
        const reason = { kind: 'bye' as const, text: res.value.untagged.text };
        isClosed = true;
        failureReason = reason;
        return { ok: false, reason };
      }
    }

    return {
      ok: false,
      reason: { kind: 'protocol', detail: 'Invalid IMAP greeting received from server' },
    };
  })();

  let commandQueue: Promise<void> = Promise.resolve();

  const enqueueCommand = <T>(task: () => Promise<ImapResult<T>>): Promise<ImapResult<T>> => {
    const result = commandQueue.then(task);
    commandQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result.catch(() => ({ ok: false, reason: { kind: 'closed' } }));
  };

  const executeCommand = async (
    build: (tag: string) => OutgoingCommand,
    options?: {
      readonly onContinuation?: () => Promise<ImapResult<void>>;
      readonly allowBye?: boolean;
    },
  ): Promise<
    ImapResult<{
      readonly tagged: ImapTagged;
      readonly untagged: readonly ImapUntagged[];
      readonly seenCapability: boolean;
    }>
  > => {
    // The bye/protocol reason belonged to the command that observed it; later commands report closed.
    if (isClosed) {
      return { ok: false, reason: { kind: 'closed' } };
    }
    if (failureReason !== null) {
      return {
        ok: false,
        reason: failureReason.kind === 'protocol' ? { kind: 'closed' } : failureReason,
      };
    }

    const greetRes = await greetingPromise;
    if (!greetRes.ok) return greetRes;

    const tag = nextTag();
    const command = build(tag);

    const hasLiteralPlus = knownCapabilities.some(c => c.toUpperCase() === 'LITERAL+');
    const hasLiteralMinus = knownCapabilities.some(c => c.toUpperCase() === 'LITERAL-');

    const untaggedList: ImapUntagged[] = [];
    let seenCapability = false;
    let allowedByeReason: Extract<ImapFailure, { readonly kind: 'bye' }> | null = null;

    for (const line of command.lines) {
      try {
        await transport.write(line.text);
      } catch {
        isClosed = true;
        failureReason = { kind: 'closed' };
        return { ok: false, reason: { kind: 'closed' } };
      }

      if (line.literal !== undefined) {
        const len = line.literal.length;
        const canSynchronizeFree = hasLiteralPlus || (hasLiteralMinus && len <= 4096);

        if (canSynchronizeFree) {
          try {
            await transport.write(stringToBytes(`{${len}+}\r\n`));
            await transport.write(line.literal);
          } catch {
            isClosed = true;
            failureReason = { kind: 'closed' };
            return { ok: false, reason: { kind: 'closed' } };
          }
        } else {
          try {
            await transport.write(stringToBytes(`{${len}}\r\n`));
          } catch {
            isClosed = true;
            failureReason = { kind: 'closed' };
            return { ok: false, reason: { kind: 'closed' } };
          }

          let continuationReceived = false;
          while (!continuationReceived) {
            const respResult = await readNextResponse();
            if (!respResult.ok) {
              if (respResult.reason.kind === 'closed' && allowedByeReason !== null) {
                return { ok: false, reason: allowedByeReason };
              }
              return respResult;
            }

            const resp = respResult.value;
            if (resp.kind === 'untagged') {
              untaggedList.push(resp.untagged);
              onUntagged?.(resp.untagged);
              if (resp.untagged.kind === 'capability') {
                knownCapabilities = [...resp.untagged.capabilities];
                seenCapability = true;
              }
              if (resp.untagged.kind === 'status' && resp.untagged.status === 'BYE') {
                if (options?.allowBye !== true) {
                  const reason = { kind: 'bye' as const, text: resp.untagged.text };
                  isClosed = true;
                  failureReason = reason;
                  return { ok: false, reason };
                }
                allowedByeReason = { kind: 'bye', text: resp.untagged.text };
              }
            } else if (resp.kind === 'continuation') {
              continuationReceived = true;
              try {
                await transport.write(line.literal);
              } catch {
                isClosed = true;
                failureReason = { kind: 'closed' };
                return { ok: false, reason: { kind: 'closed' } };
              }
            } else if (resp.kind === 'tagged') {
              if (resp.tag !== tag) {
                isClosed = true;
                failureReason = {
                  kind: 'protocol',
                  detail: `Received unexpected tag ${resp.tag}, expected ${tag}`,
                };
                return { ok: false, reason: failureReason };
              }
              if (resp.status === 'NO') {
                return { ok: false, reason: { kind: 'no', text: resp.text } };
              }
              if (resp.status === 'BAD') {
                return { ok: false, reason: { kind: 'bad', text: resp.text } };
              }
            }
          }
        }
      }
    }

    while (true) {
      const respResult = await readNextResponse();
      if (!respResult.ok) {
        if (respResult.reason.kind === 'closed' && allowedByeReason !== null) {
          return { ok: false, reason: allowedByeReason };
        }
        return respResult;
      }

      const resp = respResult.value;

      if (resp.kind === 'untagged') {
        untaggedList.push(resp.untagged);
        onUntagged?.(resp.untagged);

        if (resp.untagged.kind === 'capability') {
          knownCapabilities = [...resp.untagged.capabilities];
          seenCapability = true;
        }

        if (resp.untagged.kind === 'status' && resp.untagged.status === 'BYE') {
          if (options?.allowBye !== true) {
            const reason = { kind: 'bye' as const, text: resp.untagged.text };
            isClosed = true;
            failureReason = reason;
            return { ok: false, reason };
          }
          allowedByeReason = { kind: 'bye', text: resp.untagged.text };
        }
      } else if (resp.kind === 'continuation') {
        if (options?.onContinuation !== undefined) {
          const contRes = await options.onContinuation();
          if (!contRes.ok) return contRes;
        } else {
          isClosed = true;
          failureReason = {
            kind: 'protocol',
            detail: 'Unexpected continuation response from server',
          };
          return { ok: false, reason: failureReason };
        }
      } else if (resp.kind === 'tagged') {
        if (resp.tag !== tag) {
          isClosed = true;
          failureReason = {
            kind: 'protocol',
            detail: `Received unexpected tag ${resp.tag}, expected ${tag}`,
          };
          return { ok: false, reason: failureReason };
        }

        if (resp.code !== null && resp.code.kind === 'capability') {
          knownCapabilities = [...resp.code.capabilities];
          seenCapability = true;
        }

        if (resp.status === 'OK') {
          return { ok: true, value: { tagged: resp, untagged: untaggedList, seenCapability } };
        }
        if (resp.status === 'NO') {
          return { ok: false, reason: { kind: 'no', text: resp.text } };
        }
        if (resp.status === 'BAD') {
          return { ok: false, reason: { kind: 'bad', text: resp.text } };
        }
      }
    }
  };

  const client: ImapClient = {
    greeting: () => greetingPromise,

    capability: () =>
      enqueueCommand(async () => {
        const res = await executeCommand(buildCapabilityCommand);
        if (!res.ok) return res;

        return { ok: true, value: [...knownCapabilities] };
      }),

    capabilities: () => [...knownCapabilities],

    hasCapability: name => knownCapabilities.some(c => c.toUpperCase() === name.toUpperCase()),

    authenticate: (username, password) =>
      enqueueCommand(async () => {
        const greetRes = await greetingPromise;
        if (!greetRes.ok) return greetRes;

        if (knownCapabilities.length === 0) {
          const capRes = await executeCommand(buildCapabilityCommand);
          if (!capRes.ok) return capRes;
        }

        const hasAuthPlain = knownCapabilities.some(
          c => c.toUpperCase() === 'AUTH=PLAIN' || c.toUpperCase() === 'AUTHENTICATE=PLAIN',
        );
        const hasSaslIr = knownCapabilities.some(c => c.toUpperCase() === 'SASL-IR');
        const hasLoginDisabled = knownCapabilities.some(c => c.toUpperCase() === 'LOGINDISABLED');

        let authCmdRes: ImapResult<{
          readonly tagged: ImapTagged;
          readonly untagged: readonly ImapUntagged[];
          readonly seenCapability: boolean;
        }>;

        if (hasAuthPlain) {
          if (hasSaslIr) {
            authCmdRes = await executeCommand(tag =>
              buildAuthenticatePlainSaslIrCommand(tag, username, password),
            );
          } else {
            authCmdRes = await executeCommand(tag => buildAuthenticatePlainInitialCommand(tag), {
              onContinuation: async () => {
                try {
                  const respCmd = buildAuthenticatePlainResponse(username, password);
                  for (const line of respCmd.lines) {
                    await transport.write(line.text);
                  }
                  return { ok: true, value: undefined };
                } catch {
                  isClosed = true;
                  failureReason = { kind: 'closed' };
                  return { ok: false, reason: { kind: 'closed' } };
                }
              },
            });
          }
        } else if (!hasLoginDisabled) {
          authCmdRes = await executeCommand(tag => buildLoginCommand(tag, username, password));
        } else {
          return {
            ok: false,
            reason: {
              kind: 'unsupported',
              detail: 'Server does not support AUTH=PLAIN and LOGIN is disabled',
            },
          };
        }

        if (!authCmdRes.ok) return authCmdRes;

        if (!authCmdRes.value.seenCapability) {
          const postAuthCapRes = await executeCommand(buildCapabilityCommand);
          if (!postAuthCapRes.ok) return postAuthCapRes;
        }

        return { ok: true, value: undefined };
      }),

    list: (reference, pattern) =>
      enqueueCommand(async () => {
        const res = await executeCommand(tag => buildListCommand(tag, reference, pattern));
        if (!res.ok) return res;

        const mailboxes: ImapMailbox[] = [];
        for (const item of res.value.untagged) {
          if (item.kind === 'list') {
            mailboxes.push(item.mailbox);
          }
        }
        return { ok: true, value: mailboxes };
      }),

    select: (mailbox, options) =>
      enqueueCommand(async () => {
        const isReadOnlyRequested = options?.readOnly ?? false;
        const res = await executeCommand(tag =>
          buildSelectCommand(tag, mailbox, isReadOnlyRequested),
        );
        if (!res.ok) return res;

        let exists = 0;
        let flags: string[] = [];
        let permanentFlags: string[] = [];
        let uidValidity: number | null = null;
        let uidNext: number | null = null;
        let isReadOnly = isReadOnlyRequested;

        const applyCode = (code: ImapResponseCode | null) => {
          if (code === null) return;
          if (code.kind === 'uidValidity') {
            uidValidity = code.value;
          } else if (code.kind === 'uidNext') {
            uidNext = code.value;
          } else if (code.kind === 'permanentFlags') {
            permanentFlags = [...code.flags];
          } else if (code.kind === 'readOnly') {
            isReadOnly = true;
          } else if (code.kind === 'readWrite') {
            isReadOnly = false;
          }
        };

        for (const item of res.value.untagged) {
          if (item.kind === 'exists') {
            exists = item.count;
          } else if (item.kind === 'flags') {
            flags = [...item.flags];
          } else if (item.kind === 'status') {
            applyCode(item.code);
          }
        }

        applyCode(res.value.tagged.code);

        return {
          ok: true,
          value: {
            name: mailbox,
            exists,
            uidValidity,
            uidNext,
            flags,
            permanentFlags,
            readOnly: isReadOnly,
          },
        };
      }),

    fetchSummaries: uidSet =>
      enqueueCommand(async () => {
        const gmail = knownCapabilities.some(c => c.toUpperCase() === 'X-GM-EXT-1');
        const res = await executeCommand(tag => buildFetchSummariesCommand(tag, uidSet, { gmail }));
        if (!res.ok) return res;
        return { ok: true, value: summariesFrom(res.value.untagged) };
      }),

    fetchSummariesBySeq: seqSet =>
      enqueueCommand(async () => {
        const gmail = knownCapabilities.some(c => c.toUpperCase() === 'X-GM-EXT-1');
        const res = await executeCommand(tag =>
          buildFetchSummariesCommand(tag, seqSet, { gmail, bySeq: true }),
        );
        if (!res.ok) return res;
        return { ok: true, value: summariesFrom(res.value.untagged) };
      }),

    fetchFlags: uidSet =>
      enqueueCommand(async () => {
        const res = await executeCommand(tag => buildFetchFlagsCommand(tag, uidSet));
        if (!res.ok) return res;
        const result: ImapMessageFlags[] = [];
        for (const item of res.value.untagged) {
          if (item.kind !== 'fetch') continue;
          let uid = 0;
          let flags: readonly string[] = [];
          for (const fItem of item.items) {
            if (fItem.kind === 'uid') {
              uid = fItem.uid;
            } else if (fItem.kind === 'flags') {
              flags = fItem.flags;
            }
          }
          if (uid !== 0) result.push({ uid, flags });
        }
        return { ok: true, value: result };
      }),

    fetchRaw: uid =>
      enqueueCommand(async () => {
        const res = await executeCommand(tag => buildFetchRawCommand(tag, uid));
        if (!res.ok) return res;

        for (const item of res.value.untagged) {
          if (item.kind === 'fetch') {
            for (const fItem of item.items) {
              if (fItem.kind === 'body' && fItem.bytes !== null) {
                return { ok: true, value: fItem.bytes };
              }
            }
          }
        }

        return { ok: false, reason: { kind: 'no', text: 'Raw message body not found' } };
      }),

    storeFlags: (uidSet, mode, flags) =>
      enqueueCommand(async () => {
        const res = await executeCommand(tag => buildStoreFlagsCommand(tag, uidSet, mode, flags));
        if (!res.ok) return res;
        return { ok: true, value: undefined };
      }),

    append: (mailbox, message, flags, internalDate) =>
      enqueueCommand(async () => {
        const res = await executeCommand(tag =>
          buildAppendCommand(tag, mailbox, flags, message, internalDate),
        );
        if (!res.ok) return res;
        return { ok: true, value: appendUidOf(res.value.tagged) };
      }),

    expunge: () =>
      enqueueCommand(async () => {
        const res = await executeCommand(buildExpungeCommand);
        if (!res.ok) return res;
        return { ok: true, value: undefined };
      }),

    uidExpunge: uidSet =>
      enqueueCommand(async () => {
        const greetRes = await greetingPromise;
        if (!greetRes.ok) return greetRes;
        if (!knownCapabilities.some(c => c.toUpperCase() === 'UIDPLUS')) {
          return {
            ok: false,
            reason: { kind: 'no', text: 'UID EXPUNGE needs UIDPLUS, which this server lacks' },
          };
        }
        const res = await executeCommand(tag => buildUidExpungeCommand(tag, uidSet));
        if (!res.ok) return res;
        return { ok: true, value: undefined };
      }),

    uidSearchHeader: (header, value) =>
      enqueueCommand(async () => {
        const res = await executeCommand(tag => buildUidSearchHeaderCommand(tag, header, value));
        if (!res.ok) return res;
        const found = res.value.untagged.flatMap(item =>
          item.kind === 'search' ? [...item.uids] : [],
        );
        return { ok: true, value: found };
      }),

    move: (uidSet, mailbox) =>
      enqueueCommand(async () => {
        const greetRes = await greetingPromise;
        if (!greetRes.ok) return greetRes;
        // MOVE is an extension to rev1 (RFC 6851) and part of rev2 itself (RFC 9051 §6.4.8).
        const hasMove = knownCapabilities.some(c => {
          const name = c.toUpperCase();
          return name === 'MOVE' || name === 'IMAP4REV2';
        });
        if (!hasMove) {
          return {
            ok: false,
            reason: { kind: 'no', text: 'MOVE is not supported by this server' },
          };
        }
        const res = await executeCommand(tag => buildMoveCommand(tag, uidSet, mailbox));
        if (!res.ok) return res;
        return { ok: true, value: copyUidOf(res.value.untagged, res.value.tagged) };
      }),

    create: mailbox =>
      enqueueCommand(async () => {
        const res = await executeCommand(tag => buildCreateCommand(tag, mailbox));
        if (!res.ok) return res;
        return { ok: true, value: undefined };
      }),

    noop: () =>
      enqueueCommand(async () => {
        const res = await executeCommand(buildNoopCommand);
        if (!res.ok) return res;
        return { ok: true, value: undefined };
      }),

    idle: (): ImapIdle => {
      if (isClosed || failureReason !== null) {
        const closed: ImapResult<void> = { ok: false, reason: { kind: 'closed' } };
        const ended = Promise.resolve(closed);
        return { done: async () => ended, ended };
      }

      let doneRequested = false;
      let doneSent = false;
      /** Set once '+' arrived; only then may DONE be written. */
      let isIdling = false;
      let isEnded = false;

      const sendDone = async (): Promise<ImapResult<void> | null> => {
        if (doneSent || !isIdling || isEnded) return null;
        doneSent = true;
        try {
          await transport.write(buildIdleDoneLine());
          return null;
        } catch {
          isClosed = true;
          failureReason = { kind: 'closed' };
          return { ok: false, reason: { kind: 'closed' } };
        }
      };

      const ended = enqueueCommand(async (): Promise<ImapResult<void>> => {
        if (failureReason !== null) {
          return {
            ok: false,
            reason: failureReason.kind === 'protocol' ? { kind: 'closed' } : failureReason,
          };
        }
        if (isClosed) return { ok: false, reason: { kind: 'closed' } };

        const greetRes = await greetingPromise;
        if (!greetRes.ok) return greetRes;

        const tag = nextTag();
        const command = buildIdleCommand(tag);
        for (const line of command.lines) {
          try {
            await transport.write(line.text);
          } catch {
            isClosed = true;
            failureReason = { kind: 'closed' };
            return { ok: false, reason: { kind: 'closed' } };
          }
        }

        while (true) {
          const respResult = await readNextResponse();
          if (!respResult.ok) return respResult;

          const resp = respResult.value;
          if (resp.kind === 'untagged') {
            onUntagged?.(resp.untagged);
            if (resp.untagged.kind === 'status' && resp.untagged.status === 'BYE') {
              const reason = { kind: 'bye' as const, text: resp.untagged.text };
              isClosed = true;
              failureReason = reason;
              return { ok: false, reason };
            }
            continue;
          }
          if (resp.kind === 'continuation') break;
          if (resp.kind === 'tagged') {
            if (resp.tag !== tag) {
              isClosed = true;
              failureReason = {
                kind: 'protocol',
                detail: `Received unexpected tag ${resp.tag}, expected ${tag}`,
              };
              return { ok: false, reason: failureReason };
            }
            if (resp.status === 'NO') return { ok: false, reason: { kind: 'no', text: resp.text } };
            if (resp.status === 'BAD') {
              return { ok: false, reason: { kind: 'bad', text: resp.text } };
            }
            isClosed = true;
            failureReason = {
              kind: 'protocol',
              detail: 'IDLE completed without a continuation',
            };
            return { ok: false, reason: failureReason };
          }
        }

        isIdling = true;
        // A `done()` that arrived before '+' sends DONE now.
        if (doneRequested) {
          const sendFail = await sendDone();
          if (sendFail !== null) return sendFail;
        }

        while (true) {
          const respResult = await readNextResponse();
          if (!respResult.ok) return respResult;

          const resp = respResult.value;
          if (resp.kind === 'untagged') {
            onUntagged?.(resp.untagged);
            if (resp.untagged.kind === 'status' && resp.untagged.status === 'BYE') {
              const reason = { kind: 'bye' as const, text: resp.untagged.text };
              isClosed = true;
              failureReason = reason;
              return { ok: false, reason };
            }
            continue;
          }
          if (resp.kind === 'continuation') {
            isClosed = true;
            failureReason = {
              kind: 'protocol',
              detail: 'Unexpected continuation while IDLE',
            };
            return { ok: false, reason: failureReason };
          }
          if (resp.kind === 'tagged') {
            if (resp.tag !== tag) {
              isClosed = true;
              failureReason = {
                kind: 'protocol',
                detail: `Received unexpected tag ${resp.tag}, expected ${tag}`,
              };
              return { ok: false, reason: failureReason };
            }
            if (!doneSent) {
              isClosed = true;
              failureReason = {
                kind: 'protocol',
                detail: 'Tagged response while IDLE before DONE',
              };
              return { ok: false, reason: failureReason };
            }
            if (resp.status === 'OK') return { ok: true, value: undefined };
            if (resp.status === 'NO') return { ok: false, reason: { kind: 'no', text: resp.text } };
            if (resp.status === 'BAD') {
              return { ok: false, reason: { kind: 'bad', text: resp.text } };
            }
          }
        }
      });

      void ended.finally(() => {
        isEnded = true;
      });

      return {
        done: async () => {
          doneRequested = true;
          await sendDone();
          return ended;
        },
        ended,
      };
    },

    logout: () =>
      enqueueCommand(async () => {
        // RFC 9051 requires an untagged BYE before the tagged OK completion.
        const res = await executeCommand(buildLogoutCommand, { allowBye: true });
        isClosed = true;
        if (!res.ok) return res;
        return { ok: true, value: undefined };
      }),
  };

  return client;
};
