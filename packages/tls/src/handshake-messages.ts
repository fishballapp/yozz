import {
  concat,
  readUint8,
  readUint16,
  readUint24,
  writeUint8,
  writeUint16,
  writeUint24,
} from './bytes.ts';
import {
  type AlertDescription,
  CERTIFICATE_SIGNATURE_SCHEMES,
  EXTENSION_TYPES,
  HANDSHAKE_TYPES,
  NAMED_GROUPS,
  type NamedGroup,
  OFFERED_CERTIFICATE_SIGNATURE_SCHEMES,
  PSK_KEY_EXCHANGE_MODES,
  SIGNATURE_SCHEMES,
  type SignatureScheme,
  SUPPORTED_GROUPS,
  SUPPORTED_SIGNATURE_SCHEMES,
  TLS_VERSION,
} from './wire.ts';

export type KeyShareEntry = {
  readonly group: number;
  readonly keyExchange: Uint8Array;
};

export type PskIdentity = {
  readonly identity: Uint8Array;
  readonly obfuscatedTicketAge: number;
};

export type Extension =
  | { readonly kind: 'server_name'; readonly serverNames: readonly string[] }
  | { readonly kind: 'supported_groups'; readonly groups: readonly number[] }
  | { readonly kind: 'signature_algorithms'; readonly schemes: readonly number[] }
  /** RFC 9846 §4.3.3; the same body as `signature_algorithms`. */
  | { readonly kind: 'signature_algorithms_cert'; readonly schemes: readonly number[] }
  /** RFC 7685: only the length carries meaning. */
  | { readonly kind: 'padding'; readonly length: number }
  | {
      readonly kind: 'supported_versions';
      readonly versions: readonly number[];
      readonly isServerHello?: boolean;
    }
  | {
      readonly kind: 'key_share';
      readonly clientShares?: readonly KeyShareEntry[];
      readonly serverShare?: KeyShareEntry;
      readonly selectedGroup?: number;
    }
  | { readonly kind: 'cookie'; readonly cookie: Uint8Array }
  | {
      readonly kind: 'pre_shared_key';
      readonly identities?: readonly PskIdentity[];
      readonly binders?: readonly Uint8Array[];
      readonly selectedIdentity?: number;
      readonly truncatedPreBinder?: boolean;
    }
  | { readonly kind: 'psk_key_exchange_modes'; readonly modes: readonly number[] }
  | { readonly kind: 'early_data'; readonly maxEarlyDataSize?: number }
  | { readonly kind: 'unknown'; readonly typeCode: number; readonly data: Uint8Array };

export type CertificateEntry = {
  readonly certData: Uint8Array;
  readonly extensions: readonly Extension[];
  readonly rawExtensions?: Uint8Array;
};

export type HandshakeMessage =
  | {
      readonly kind: 'client_hello';
      readonly legacyVersion: number;
      readonly random: Uint8Array;
      readonly legacySessionId: Uint8Array;
      readonly cipherSuites: readonly number[];
      readonly legacyCompressionMethods: Uint8Array;
      readonly extensions: readonly Extension[];
      readonly truncatedPreBinder?: boolean;
    }
  | {
      readonly kind: 'server_hello';
      readonly legacyVersion: number;
      readonly random: Uint8Array;
      readonly legacySessionIdEcho: Uint8Array;
      readonly cipherSuite: number;
      readonly legacyCompressionMethod: number;
      readonly extensions: readonly Extension[];
    }
  | {
      readonly kind: 'encrypted_extensions';
      readonly extensions: readonly Extension[];
    }
  | {
      readonly kind: 'certificate';
      readonly certificateRequestContext: Uint8Array;
      readonly certificateList: readonly CertificateEntry[];
    }
  | {
      readonly kind: 'certificate_request';
      readonly certificateRequestContext: Uint8Array;
      readonly extensions: readonly Extension[];
    }
  | {
      readonly kind: 'certificate_verify';
      readonly scheme: number;
      readonly signature: Uint8Array;
    }
  | {
      readonly kind: 'finished';
      readonly verifyData: Uint8Array;
    }
  | {
      readonly kind: 'new_session_ticket';
      readonly ticketLifetime: number;
      readonly ticketAgeAdd: number;
      readonly ticketNonce: Uint8Array;
      readonly ticket: Uint8Array;
      readonly extensions: readonly Extension[];
    }
  | {
      readonly kind: 'key_update';
      readonly requestUpdate: boolean;
    }
  | {
      readonly kind: 'end_of_early_data';
    };

export type DecodeResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly description: AlertDescription };

const encodeExtensions = (extensions: readonly Extension[]): Uint8Array<ArrayBuffer> => {
  const parts: Uint8Array[] = [];
  let declaredTotalLen: number | undefined;

  for (const ext of extensions) {
    const extTypeCode =
      ext.kind === 'unknown'
        ? ext.typeCode
        : EXTENSION_TYPES[ext.kind as keyof typeof EXTENSION_TYPES];

    if (extTypeCode === undefined) {
      throw new Error(`Unknown extension kind: ${ext.kind}`);
    }

    let body: Uint8Array;
    let declaredExtLen: number | undefined;

    switch (ext.kind) {
      case 'server_name': {
        if (ext.serverNames.length === 0) {
          body = new Uint8Array(0);
        } else {
          const listParts: Uint8Array[] = [];
          for (const name of ext.serverNames) {
            const nameBytes = new TextEncoder().encode(name);
            listParts.push(writeUint8(0), writeUint16(nameBytes.length), nameBytes);
          }
          const listBytes = concat(...listParts);
          body = concat(writeUint16(listBytes.length), listBytes);
        }
        break;
      }
      case 'supported_groups': {
        const groupsBytes = concat(...ext.groups.map(g => writeUint16(g)));
        body = concat(writeUint16(groupsBytes.length), groupsBytes);
        break;
      }
      case 'padding': {
        body = new Uint8Array(ext.length);
        break;
      }
      case 'signature_algorithms':
      case 'signature_algorithms_cert': {
        const schemesBytes = concat(...ext.schemes.map(s => writeUint16(s)));
        body = concat(writeUint16(schemesBytes.length), schemesBytes);
        break;
      }
      case 'supported_versions': {
        if (ext.isServerHello) {
          body = writeUint16(ext.versions[0] ?? 0x0304);
        } else {
          const versionsBytes = concat(...ext.versions.map(v => writeUint16(v)));
          body = concat(writeUint8(versionsBytes.length), versionsBytes);
        }
        break;
      }
      case 'key_share': {
        if (ext.clientShares !== undefined) {
          const sharesParts: Uint8Array[] = [];
          for (const share of ext.clientShares) {
            sharesParts.push(
              writeUint16(share.group),
              writeUint16(share.keyExchange.length),
              share.keyExchange,
            );
          }
          const sharesBytes = concat(...sharesParts);
          body = concat(writeUint16(sharesBytes.length), sharesBytes);
        } else if (ext.serverShare !== undefined) {
          body = concat(
            writeUint16(ext.serverShare.group),
            writeUint16(ext.serverShare.keyExchange.length),
            ext.serverShare.keyExchange,
          );
        } else if (ext.selectedGroup !== undefined) {
          body = writeUint16(ext.selectedGroup);
        } else {
          body = new Uint8Array(0);
        }
        break;
      }
      case 'cookie': {
        body = concat(writeUint16(ext.cookie.length), ext.cookie);
        break;
      }
      case 'pre_shared_key': {
        if (ext.selectedIdentity !== undefined) {
          body = writeUint16(ext.selectedIdentity);
        } else if (ext.identities !== undefined) {
          const idParts: Uint8Array[] = [];
          for (const id of ext.identities) {
            const ageBytes = Uint8Array.of(
              (id.obfuscatedTicketAge >>> 24) & 0xff,
              (id.obfuscatedTicketAge >>> 16) & 0xff,
              (id.obfuscatedTicketAge >>> 8) & 0xff,
              id.obfuscatedTicketAge & 0xff,
            );
            idParts.push(writeUint16(id.identity.length), id.identity, ageBytes);
          }
          const idBytes = concat(...idParts);

          if (ext.truncatedPreBinder) {
            declaredExtLen = idBytes.length + 2 + 35;
            body = concat(writeUint16(idBytes.length), idBytes);
          } else if (ext.binders !== undefined) {
            const binderParts: Uint8Array[] = [];
            for (const binder of ext.binders) {
              binderParts.push(writeUint8(binder.length), binder);
            }
            const binderBytes = concat(...binderParts);
            body = concat(
              writeUint16(idBytes.length),
              idBytes,
              writeUint16(binderBytes.length),
              binderBytes,
            );
          } else {
            body = concat(writeUint16(idBytes.length), idBytes);
          }
        } else {
          body = new Uint8Array(0);
        }
        break;
      }
      case 'psk_key_exchange_modes': {
        body = concat(writeUint8(ext.modes.length), ...ext.modes.map(mode => writeUint8(mode)));
        break;
      }
      case 'early_data': {
        if (ext.maxEarlyDataSize !== undefined) {
          body = Uint8Array.of(
            (ext.maxEarlyDataSize >>> 24) & 0xff,
            (ext.maxEarlyDataSize >>> 16) & 0xff,
            (ext.maxEarlyDataSize >>> 8) & 0xff,
            ext.maxEarlyDataSize & 0xff,
          );
        } else {
          body = new Uint8Array(0);
        }
        break;
      }
      case 'unknown': {
        body = ext.data;
        break;
      }
    }

    parts.push(writeUint16(extTypeCode), writeUint16(declaredExtLen ?? body.length), body);
  }

  const allExtensions = concat(...parts);
  const actualLen = allExtensions.length;
  const hasTruncated = extensions.some(
    e => e.kind === 'pre_shared_key' && e.truncatedPreBinder === true,
  );
  if (hasTruncated) {
    declaredTotalLen = actualLen + 35;
  }
  return concat(writeUint16(declaredTotalLen ?? actualLen), allExtensions);
};

/**
 * An extension is parsed only in a message where it is defined; elsewhere it stays `unknown` for
 * RFC 9846 §4.3's wrong-message rule, which wants `illegal_parameter` rather than `decode_error`.
 */
type ExtensionContext = 'client_hello' | 'server_hello' | 'other';

const decodeExtensions = (
  bytes: Uint8Array,
  context: ExtensionContext = 'other',
  isHrr: boolean = false,
  allowPreBinderTruncation: boolean = false,
): DecodeResult<readonly Extension[]> => {
  const isServerHello = context === 'server_hello';
  /** `key_share`, `supported_versions`, `cookie` and `pre_shared_key` live only in the hellos. */
  const isHello = context !== 'other';
  if (bytes.length < 2) return { ok: false, description: 'decode_error' };
  const extTotalLength = readUint16(bytes, 0);
  const exactOk = bytes.length === 2 + extTotalLength;
  const truncatedOk = allowPreBinderTruncation && bytes.length === 2 + extTotalLength - 35;
  if (!exactOk && !truncatedOk) {
    return { ok: false, description: 'decode_error' };
  }

  const seenTypes = new Set<number>();
  const extensions: Extension[] = [];
  let offset = 2;

  while (offset < bytes.length) {
    if (offset + 4 > bytes.length) return { ok: false, description: 'decode_error' };
    const typeCode = readUint16(bytes, offset);
    const dataLen = readUint16(bytes, offset + 2);
    offset += 4;

    if (seenTypes.has(typeCode)) {
      return { ok: false, description: 'illegal_parameter' };
    }
    seenTypes.add(typeCode);

    // A pre-binder ClientHello (§4.3.11.2) declares 35 binder bytes that are absent.
    let extData: Uint8Array;
    if (offset + dataLen <= bytes.length) {
      extData = bytes.subarray(offset, offset + dataLen);
      offset += dataLen;
    } else if (
      allowPreBinderTruncation &&
      truncatedOk &&
      typeCode === EXTENSION_TYPES.pre_shared_key
    ) {
      extData = bytes.subarray(offset);
      offset = bytes.length;
    } else {
      return { ok: false, description: 'decode_error' };
    }

    if (typeCode === EXTENSION_TYPES.server_name) {
      if (extData.length === 0) {
        extensions.push({ kind: 'server_name', serverNames: [] });
      } else {
        if (extData.length < 2) return { ok: false, description: 'decode_error' };
        const listLen = readUint16(extData, 0);
        if (extData.length !== 2 + listLen) return { ok: false, description: 'decode_error' };
        let nOffset = 2;
        const serverNames: string[] = [];
        while (nOffset < extData.length) {
          if (nOffset + 3 > extData.length) return { ok: false, description: 'decode_error' };
          const nameType = readUint8(extData, nOffset);
          const nameLen = readUint16(extData, nOffset + 1);
          nOffset += 3;
          if (nOffset + nameLen > extData.length) return { ok: false, description: 'decode_error' };
          if (nameType === 0) {
            const nameBytes = extData.subarray(nOffset, nOffset + nameLen);
            serverNames.push(new TextDecoder().decode(nameBytes));
          }
          nOffset += nameLen;
        }
        extensions.push({ kind: 'server_name', serverNames });
      }
    } else if (typeCode === EXTENSION_TYPES.supported_groups) {
      if (extData.length < 2) return { ok: false, description: 'decode_error' };
      const listLen = readUint16(extData, 0);
      if (extData.length !== 2 + listLen || listLen % 2 !== 0) {
        return { ok: false, description: 'decode_error' };
      }
      const groups: number[] = [];
      for (let i = 2; i < extData.length; i += 2) {
        groups.push(readUint16(extData, i));
      }
      extensions.push({ kind: 'supported_groups', groups });
    } else if (typeCode === EXTENSION_TYPES.signature_algorithms) {
      if (extData.length < 2) return { ok: false, description: 'decode_error' };
      const listLen = readUint16(extData, 0);
      if (extData.length !== 2 + listLen || listLen % 2 !== 0) {
        return { ok: false, description: 'decode_error' };
      }
      const schemes: number[] = [];
      for (let i = 2; i < extData.length; i += 2) {
        schemes.push(readUint16(extData, i));
      }
      extensions.push({ kind: 'signature_algorithms', schemes });
    } else if (typeCode === EXTENSION_TYPES.signature_algorithms_cert) {
      if (extData.length < 2) return { ok: false, description: 'decode_error' };
      const listLen = readUint16(extData, 0);
      if (extData.length !== 2 + listLen || listLen % 2 !== 0) {
        return { ok: false, description: 'decode_error' };
      }
      const schemes: number[] = [];
      for (let i = 2; i < extData.length; i += 2) {
        schemes.push(readUint16(extData, i));
      }
      extensions.push({ kind: 'signature_algorithms_cert', schemes });
    } else if (typeCode === EXTENSION_TYPES.padding) {
      extensions.push({ kind: 'padding', length: extData.length });
    } else if (isHello && typeCode === EXTENSION_TYPES.supported_versions) {
      if (isServerHello) {
        if (extData.length !== 2) return { ok: false, description: 'decode_error' };
        extensions.push({
          kind: 'supported_versions',
          versions: [readUint16(extData, 0)],
          isServerHello: true,
        });
      } else {
        if (extData.length < 1) return { ok: false, description: 'decode_error' };
        const listLen = readUint8(extData, 0);
        if (extData.length !== 1 + listLen || listLen % 2 !== 0) {
          return { ok: false, description: 'decode_error' };
        }
        const versions: number[] = [];
        for (let i = 1; i < extData.length; i += 2) {
          versions.push(readUint16(extData, i));
        }
        extensions.push({ kind: 'supported_versions', versions, isServerHello: false });
      }
    } else if (isHello && typeCode === EXTENSION_TYPES.key_share) {
      if (isHrr) {
        if (extData.length !== 2) return { ok: false, description: 'decode_error' };
        extensions.push({ kind: 'key_share', selectedGroup: readUint16(extData, 0) });
      } else if (isServerHello) {
        if (extData.length < 4) return { ok: false, description: 'decode_error' };
        const group = readUint16(extData, 0);
        const kLen = readUint16(extData, 2);
        if (extData.length !== 4 + kLen) return { ok: false, description: 'decode_error' };
        extensions.push({
          kind: 'key_share',
          serverShare: { group, keyExchange: extData.subarray(4, 4 + kLen) },
        });
      } else {
        if (extData.length < 2) return { ok: false, description: 'decode_error' };
        const listLen = readUint16(extData, 0);
        if (extData.length !== 2 + listLen) return { ok: false, description: 'decode_error' };
        let sOffset = 2;
        const clientShares: KeyShareEntry[] = [];
        while (sOffset < extData.length) {
          if (sOffset + 4 > extData.length) return { ok: false, description: 'decode_error' };
          const group = readUint16(extData, sOffset);
          const kLen = readUint16(extData, sOffset + 2);
          sOffset += 4;
          if (sOffset + kLen > extData.length) return { ok: false, description: 'decode_error' };
          clientShares.push({ group, keyExchange: extData.subarray(sOffset, sOffset + kLen) });
          sOffset += kLen;
        }
        extensions.push({ kind: 'key_share', clientShares });
      }
    } else if (isHello && typeCode === EXTENSION_TYPES.cookie) {
      if (extData.length < 2) return { ok: false, description: 'decode_error' };
      const cLen = readUint16(extData, 0);
      if (extData.length !== 2 + cLen) return { ok: false, description: 'decode_error' };
      // RFC 9846 §4.3.2: `opaque cookie<1..2^16-1>`.
      if (readUint16(extData, 0) === 0) return { ok: false, description: 'decode_error' };
      extensions.push({ kind: 'cookie', cookie: extData.subarray(2) });
    } else if (isHello && typeCode === EXTENSION_TYPES.pre_shared_key) {
      if (isServerHello) {
        if (extData.length !== 2) return { ok: false, description: 'decode_error' };
        extensions.push({ kind: 'pre_shared_key', selectedIdentity: readUint16(extData, 0) });
      } else {
        if (extData.length < 4) return { ok: false, description: 'decode_error' };
        const idListLen = readUint16(extData, 0);
        let idOffset = 2;
        if (idOffset + idListLen > extData.length)
          return { ok: false, description: 'decode_error' };
        const identities: PskIdentity[] = [];
        const idEnd = 2 + idListLen;
        while (idOffset < idEnd) {
          if (idOffset + 6 > idEnd) return { ok: false, description: 'decode_error' };
          const idLen = readUint16(extData, idOffset);
          idOffset += 2;
          if (idOffset + idLen + 4 > idEnd) return { ok: false, description: 'decode_error' };
          const identity = extData.subarray(idOffset, idOffset + idLen);
          idOffset += idLen;
          const age =
            ((extData[idOffset] ?? 0) << 24) |
            ((extData[idOffset + 1] ?? 0) << 16) |
            ((extData[idOffset + 2] ?? 0) << 8) |
            (extData[idOffset + 3] ?? 0);
          idOffset += 4;
          identities.push({ identity, obfuscatedTicketAge: age >>> 0 });
        }

        if (idOffset === extData.length && dataLen === extData.length + 35) {
          // A truncated pre-binder ClientHello.
          extensions.push({
            kind: 'pre_shared_key',
            identities,
            binders: [],
            truncatedPreBinder: true,
          });
        } else {
          if (idOffset + 2 > extData.length) return { ok: false, description: 'decode_error' };
          const binderListLen = readUint16(extData, idOffset);
          idOffset += 2;
          if (idOffset + binderListLen !== extData.length) {
            return { ok: false, description: 'decode_error' };
          }
          const binders: Uint8Array[] = [];
          while (idOffset < extData.length) {
            const bLen = readUint8(extData, idOffset);
            idOffset += 1;
            if (idOffset + bLen > extData.length) return { ok: false, description: 'decode_error' };
            binders.push(extData.subarray(idOffset, idOffset + bLen));
            idOffset += bLen;
          }
          extensions.push({ kind: 'pre_shared_key', identities, binders });
        }
      }
    } else if (context === 'client_hello' && typeCode === EXTENSION_TYPES.psk_key_exchange_modes) {
      // §4.3.9: `ke_modes<1..255>`, defined in the ClientHello alone.
      if (extData.length < 2) return { ok: false, description: 'decode_error' };
      const modesLen = readUint8(extData, 0);
      if (modesLen === 0 || extData.length !== 1 + modesLen) {
        return { ok: false, description: 'decode_error' };
      }
      extensions.push({ kind: 'psk_key_exchange_modes', modes: [...extData.subarray(1)] });
    } else if (typeCode === EXTENSION_TYPES.early_data) {
      if (extData.length === 4) {
        const maxEarlyDataSize =
          ((extData[0] ?? 0) << 24) |
          ((extData[1] ?? 0) << 16) |
          ((extData[2] ?? 0) << 8) |
          (extData[3] ?? 0);
        extensions.push({ kind: 'early_data', maxEarlyDataSize: maxEarlyDataSize >>> 0 });
      } else {
        extensions.push({ kind: 'early_data' });
      }
    } else {
      extensions.push({ kind: 'unknown', typeCode, data: extData });
    }
  }

  return { ok: true, value: extensions };
};

export const encodeHandshakeMessage = (msg: HandshakeMessage): Uint8Array<ArrayBuffer> => {
  let typeCode: number;
  let body: Uint8Array;
  let declaredLength: number | undefined;

  switch (msg.kind) {
    case 'client_hello': {
      typeCode = HANDSHAKE_TYPES.client_hello;
      const suitesBytes = concat(...msg.cipherSuites.map(s => writeUint16(s)));
      const suitesBlock = concat(writeUint16(suitesBytes.length), suitesBytes);
      const sessionBlock = concat(writeUint8(msg.legacySessionId.length), msg.legacySessionId);
      const compBlock = concat(
        writeUint8(msg.legacyCompressionMethods.length),
        msg.legacyCompressionMethods,
      );
      const extBlock = encodeExtensions(msg.extensions);
      body = concat(
        writeUint16(msg.legacyVersion),
        msg.random,
        sessionBlock,
        suitesBlock,
        compBlock,
        extBlock,
      );
      if (msg.truncatedPreBinder) {
        declaredLength = body.length + 35;
      }
      break;
    }
    case 'server_hello': {
      typeCode = HANDSHAKE_TYPES.server_hello;
      const sessionBlock = concat(
        writeUint8(msg.legacySessionIdEcho.length),
        msg.legacySessionIdEcho,
      );
      const extBlock = encodeExtensions(msg.extensions);
      body = concat(
        writeUint16(msg.legacyVersion),
        msg.random,
        sessionBlock,
        writeUint16(msg.cipherSuite),
        writeUint8(msg.legacyCompressionMethod),
        extBlock,
      );
      break;
    }
    case 'encrypted_extensions': {
      typeCode = HANDSHAKE_TYPES.encrypted_extensions;
      body = encodeExtensions(msg.extensions);
      break;
    }
    case 'certificate': {
      typeCode = HANDSHAKE_TYPES.certificate;
      const contextBlock = concat(
        writeUint8(msg.certificateRequestContext.length),
        msg.certificateRequestContext,
      );
      const entryParts: Uint8Array[] = [];
      for (const entry of msg.certificateList) {
        const certBlock = concat(writeUint24(entry.certData.length), entry.certData);
        const extBlock = entry.rawExtensions ?? encodeExtensions(entry.extensions);
        entryParts.push(certBlock, extBlock);
      }
      const listBytes = concat(...entryParts);
      body = concat(contextBlock, writeUint24(listBytes.length), listBytes);
      break;
    }
    case 'certificate_request': {
      typeCode = HANDSHAKE_TYPES.certificate_request;
      const contextBlock = concat(
        writeUint8(msg.certificateRequestContext.length),
        msg.certificateRequestContext,
      );
      const extBlock = encodeExtensions(msg.extensions);
      body = concat(contextBlock, extBlock);
      break;
    }
    case 'certificate_verify': {
      typeCode = HANDSHAKE_TYPES.certificate_verify;
      body = concat(writeUint16(msg.scheme), writeUint16(msg.signature.length), msg.signature);
      break;
    }
    case 'finished': {
      typeCode = HANDSHAKE_TYPES.finished;
      body = msg.verifyData;
      break;
    }
    case 'new_session_ticket': {
      typeCode = HANDSHAKE_TYPES.new_session_ticket;
      const lifeBytes = Uint8Array.of(
        (msg.ticketLifetime >>> 24) & 0xff,
        (msg.ticketLifetime >>> 16) & 0xff,
        (msg.ticketLifetime >>> 8) & 0xff,
        msg.ticketLifetime & 0xff,
      );
      const ageBytes = Uint8Array.of(
        (msg.ticketAgeAdd >>> 24) & 0xff,
        (msg.ticketAgeAdd >>> 16) & 0xff,
        (msg.ticketAgeAdd >>> 8) & 0xff,
        msg.ticketAgeAdd & 0xff,
      );
      const nonceBlock = concat(writeUint8(msg.ticketNonce.length), msg.ticketNonce);
      const ticketBlock = concat(writeUint16(msg.ticket.length), msg.ticket);
      const extBlock = encodeExtensions(msg.extensions);
      body = concat(lifeBytes, ageBytes, nonceBlock, ticketBlock, extBlock);
      break;
    }
    case 'key_update': {
      typeCode = HANDSHAKE_TYPES.key_update;
      body = Uint8Array.of(msg.requestUpdate ? 1 : 0);
      break;
    }
    case 'end_of_early_data': {
      typeCode = HANDSHAKE_TYPES.end_of_early_data;
      body = new Uint8Array(0);
      break;
    }
  }

  return concat(writeUint8(typeCode), writeUint24(declaredLength ?? body.length), body);
};

export const decodeHandshakeMessage = (bytes: Uint8Array): DecodeResult<HandshakeMessage> => {
  if (bytes.length < 4) return { ok: false, description: 'decode_error' };
  const typeCode = readUint8(bytes, 0);
  const length = readUint24(bytes, 1);
  const isTruncatedAllowed =
    typeCode === HANDSHAKE_TYPES.client_hello && bytes.length === 4 + length - 35;
  if (!isTruncatedAllowed && bytes.length !== 4 + length) {
    return { ok: false, description: 'decode_error' };
  }
  const body = bytes.subarray(4);

  switch (typeCode) {
    case HANDSHAKE_TYPES.client_hello: {
      if (body.length < 34) return { ok: false, description: 'decode_error' };
      const legacyVersion = readUint16(body, 0);
      const random = body.subarray(2, 34);
      let offset = 34;

      if (offset + 1 > body.length) return { ok: false, description: 'decode_error' };
      const sessLen = readUint8(body, offset);
      offset += 1;
      if (offset + sessLen > body.length) return { ok: false, description: 'decode_error' };
      const legacySessionId = body.subarray(offset, offset + sessLen);
      offset += sessLen;

      if (offset + 2 > body.length) return { ok: false, description: 'decode_error' };
      const suitesLen = readUint16(body, offset);
      offset += 2;
      if (offset + suitesLen > body.length || suitesLen % 2 !== 0) {
        return { ok: false, description: 'decode_error' };
      }
      const cipherSuites: number[] = [];
      for (let i = offset; i < offset + suitesLen; i += 2) {
        cipherSuites.push(readUint16(body, i));
      }
      offset += suitesLen;

      if (offset + 1 > body.length) return { ok: false, description: 'decode_error' };
      const compLen = readUint8(body, offset);
      offset += 1;
      if (offset + compLen > body.length) return { ok: false, description: 'decode_error' };
      const legacyCompressionMethods = body.subarray(offset, offset + compLen);
      offset += compLen;

      let extensions: readonly Extension[] = [];
      if (offset < body.length) {
        const extRes = decodeExtensions(body.subarray(offset), 'client_hello', false, true);
        if (!extRes.ok) return extRes;
        extensions = extRes.value;
      }

      const truncatedPreBinder = extensions.some(
        e => e.kind === 'pre_shared_key' && e.truncatedPreBinder === true,
      );

      return {
        ok: true,
        value: {
          kind: 'client_hello',
          legacyVersion,
          random,
          legacySessionId,
          cipherSuites,
          legacyCompressionMethods,
          extensions,
          ...(truncatedPreBinder ? { truncatedPreBinder: true } : {}),
        },
      };
    }

    case HANDSHAKE_TYPES.server_hello: {
      if (body.length < 34) return { ok: false, description: 'decode_error' };
      const legacyVersion = readUint16(body, 0);
      // RFC 9846 §4.2.3: a legacy_version other than 0x0303 is `protocol_version`, checked before
      // parsing on, since an SSL 3.0 ServerHello has no extensions block.
      if (legacyVersion !== 0x0303) return { ok: false, description: 'protocol_version' };
      const random = body.subarray(2, 34);
      let offset = 34;

      if (offset + 1 > body.length) return { ok: false, description: 'decode_error' };
      const sessLen = readUint8(body, offset);
      offset += 1;
      if (offset + sessLen > body.length) return { ok: false, description: 'decode_error' };
      const legacySessionIdEcho = body.subarray(offset, offset + sessLen);
      offset += sessLen;

      if (offset + 3 > body.length) return { ok: false, description: 'decode_error' };
      const cipherSuite = readUint16(body, offset);
      const legacyCompressionMethod = readUint8(body, offset + 2);
      offset += 3;

      const isHrr =
        random.length === 32 &&
        random.every(
          (b, i) =>
            b ===
            [
              0xcf, 0x21, 0xad, 0x74, 0xe5, 0x9a, 0x61, 0x11, 0xbe, 0x1d, 0x8c, 0x02, 0x1e, 0x65,
              0xb8, 0x91, 0xc2, 0xa2, 0x11, 0x16, 0x7a, 0xbb, 0x8c, 0x5e, 0x07, 0x9e, 0x09, 0xe2,
              0xc8, 0xa8, 0x33, 0x9c,
            ][i],
        );

      let extensions: readonly Extension[] = [];
      if (offset < body.length) {
        const extRes = decodeExtensions(body.subarray(offset), 'server_hello', isHrr);
        if (!extRes.ok) return extRes;
        extensions = extRes.value;
      }

      return {
        ok: true,
        value: {
          kind: 'server_hello',
          legacyVersion,
          random,
          legacySessionIdEcho,
          cipherSuite,
          legacyCompressionMethod,
          extensions,
        },
      };
    }

    case HANDSHAKE_TYPES.encrypted_extensions: {
      const extRes = decodeExtensions(body);
      if (!extRes.ok) return extRes;
      return { ok: true, value: { kind: 'encrypted_extensions', extensions: extRes.value } };
    }

    case HANDSHAKE_TYPES.certificate: {
      if (body.length < 4) return { ok: false, description: 'decode_error' };
      const ctxLen = readUint8(body, 0);
      let offset = 1;
      if (offset + ctxLen > body.length) return { ok: false, description: 'decode_error' };
      const certificateRequestContext = body.subarray(offset, offset + ctxLen);
      offset += ctxLen;

      if (offset + 3 > body.length) return { ok: false, description: 'decode_error' };
      const listLen = readUint24(body, offset);
      offset += 3;
      if (offset + listLen !== body.length) return { ok: false, description: 'decode_error' };

      const certificateList: CertificateEntry[] = [];
      const listEnd = offset + listLen;
      while (offset < listEnd) {
        if (offset + 3 > listEnd) return { ok: false, description: 'decode_error' };
        const certLen = readUint24(body, offset);
        offset += 3;
        if (offset + certLen > listEnd) return { ok: false, description: 'decode_error' };
        const certData = body.subarray(offset, offset + certLen);
        offset += certLen;

        if (offset + 2 > listEnd) return { ok: false, description: 'decode_error' };
        const extLen = readUint16(body, offset);
        if (offset + 2 + extLen > listEnd) return { ok: false, description: 'decode_error' };
        const rawExtensions = body.subarray(offset, offset + 2 + extLen);
        const extRes = decodeExtensions(rawExtensions);
        if (!extRes.ok) return extRes;
        offset += 2 + extLen;

        certificateList.push({ certData, extensions: extRes.value, rawExtensions });
      }

      return {
        ok: true,
        value: { kind: 'certificate', certificateRequestContext, certificateList },
      };
    }

    case HANDSHAKE_TYPES.certificate_request: {
      if (body.length < 1) return { ok: false, description: 'decode_error' };
      const ctxLen = readUint8(body, 0);
      let offset = 1;
      if (offset + ctxLen > body.length) return { ok: false, description: 'decode_error' };
      const certificateRequestContext = body.subarray(offset, offset + ctxLen);
      offset += ctxLen;

      const extRes = decodeExtensions(body.subarray(offset));
      if (!extRes.ok) return extRes;
      return {
        ok: true,
        value: { kind: 'certificate_request', certificateRequestContext, extensions: extRes.value },
      };
    }

    case HANDSHAKE_TYPES.certificate_verify: {
      if (body.length < 4) return { ok: false, description: 'decode_error' };
      const scheme = readUint16(body, 0);
      const sigLen = readUint16(body, 2);
      if (body.length !== 4 + sigLen) return { ok: false, description: 'decode_error' };
      return {
        ok: true,
        value: { kind: 'certificate_verify', scheme, signature: body.subarray(4) },
      };
    }

    case HANDSHAKE_TYPES.finished: {
      return { ok: true, value: { kind: 'finished', verifyData: body } };
    }

    case HANDSHAKE_TYPES.new_session_ticket: {
      if (body.length < 13) return { ok: false, description: 'decode_error' };
      const ticketLifetime =
        ((body[0] ?? 0) << 24) | ((body[1] ?? 0) << 16) | ((body[2] ?? 0) << 8) | (body[3] ?? 0);
      const ticketAgeAdd =
        ((body[4] ?? 0) << 24) | ((body[5] ?? 0) << 16) | ((body[6] ?? 0) << 8) | (body[7] ?? 0);
      let offset = 8;
      const nonceLen = readUint8(body, offset);
      offset += 1;
      if (offset + nonceLen > body.length) return { ok: false, description: 'decode_error' };
      const ticketNonce = body.subarray(offset, offset + nonceLen);
      offset += nonceLen;

      if (offset + 2 > body.length) return { ok: false, description: 'decode_error' };
      const ticketLen = readUint16(body, offset);
      offset += 2;
      // §4.7.1: `opaque ticket<1..2^16-1>`.
      if (ticketLen === 0) return { ok: false, description: 'decode_error' };
      if (offset + ticketLen > body.length) return { ok: false, description: 'decode_error' };
      const ticket = body.subarray(offset, offset + ticketLen);
      offset += ticketLen;

      const extRes = decodeExtensions(body.subarray(offset));
      if (!extRes.ok) return extRes;

      return {
        ok: true,
        value: {
          kind: 'new_session_ticket',
          ticketLifetime: ticketLifetime >>> 0,
          ticketAgeAdd: ticketAgeAdd >>> 0,
          ticketNonce,
          ticket,
          extensions: extRes.value,
        },
      };
    }

    case HANDSHAKE_TYPES.key_update: {
      if (body.length !== 1) return { ok: false, description: 'decode_error' };
      const val = body[0];
      if (val !== 0 && val !== 1) return { ok: false, description: 'illegal_parameter' };
      return { ok: true, value: { kind: 'key_update', requestUpdate: val === 1 } };
    }

    case HANDSHAKE_TYPES.end_of_early_data: {
      if (body.length !== 0) return { ok: false, description: 'decode_error' };
      return { ok: true, value: { kind: 'end_of_early_data' } };
    }

    default:
      return { ok: false, description: 'unexpected_message' };
  }
};

export const decodeHandshakeMessages = (
  bytes: Uint8Array,
): DecodeResult<readonly HandshakeMessage[]> => {
  const messages: HandshakeMessage[] = [];
  let offset = 0;

  while (offset < bytes.length) {
    if (offset + 4 > bytes.length) return { ok: false, description: 'decode_error' };
    const length = readUint24(bytes, offset + 1);
    if (length > 16384 * 4 || offset + 4 + length > bytes.length) {
      return { ok: false, description: 'decode_error' };
    }

    const singleBytes = bytes.subarray(offset, offset + 4 + length);
    const result = decodeHandshakeMessage(singleBytes);
    if (!result.ok) return result;
    messages.push(result.value);
    offset += 4 + length;
  }

  return { ok: true, value: messages };
};

export type ProductionClientHelloOptions = {
  readonly serverName: string;
  readonly keySharePublicKey: Uint8Array;
  readonly group?: NamedGroup;
  /** What `supported_groups` offers. The share sits on `group`, not on the first of these. */
  readonly supportedGroups?: readonly NamedGroup[];
  /** What `signature_algorithms` offers, in preference order. */
  readonly signatureSchemes?: readonly SignatureScheme[];
  readonly random?: Uint8Array;
  readonly legacySessionId?: Uint8Array;
  readonly cookie?: Uint8Array;
  /** The binder is left as zeroes; `bindClientHello` fills it in. */
  readonly psk?: {
    readonly identity: Uint8Array;
    readonly obfuscatedTicketAge: number;
    readonly binderLength: number;
  };
};

/** The tail of the message, since `pre_shared_key` must be last (RFC 9846 §4.3.11): list length, entry length, binder. */
export const binderListLength = (binderLength: number): number => 3 + binderLength;

/**
 * RFC 7685 §4: a ClientHello of 256..511 bytes is padded to 512. The extension's own 4-byte header
 * counts, so a 509-byte message takes an empty one and lands at 513.
 */
const PADDING_TARGET = 512;
const PADDING_RANGE_START = 256;
const PADDING_EXTENSION_HEADER_BYTES = 4;

export const paddingFor = (messageLength: number): number | null => {
  if (messageLength < PADDING_RANGE_START || messageLength >= PADDING_TARGET) return null;
  return Math.max(0, PADDING_TARGET - messageLength - PADDING_EXTENSION_HEADER_BYTES);
};

export const encodeProductionClientHello = (
  options: ProductionClientHelloOptions,
): Uint8Array<ArrayBuffer> => {
  const random = options.random ?? crypto.getRandomValues(new Uint8Array(32));
  const legacySessionId = options.legacySessionId ?? crypto.getRandomValues(new Uint8Array(32));
  const group = options.group ?? 'x25519';

  const extensions: Extension[] = [
    { kind: 'server_name', serverNames: [options.serverName] },
    {
      kind: 'supported_groups',
      groups: (options.supportedGroups ?? SUPPORTED_GROUPS).map(name => NAMED_GROUPS[name]),
    },
    {
      kind: 'signature_algorithms',
      schemes: (options.signatureSchemes ?? SUPPORTED_SIGNATURE_SCHEMES).map(
        name => SIGNATURE_SCHEMES[name],
      ),
    },
    // Not derived from `signatureSchemes`: that is policy about CertificateVerify, this is what
    // `@yozz.app/x509` can verify in a chain (RFC 9846 §4.3.3).
    {
      kind: 'signature_algorithms_cert',
      schemes: OFFERED_CERTIFICATE_SIGNATURE_SCHEMES.map(
        name => CERTIFICATE_SIGNATURE_SCHEMES[name].code,
      ),
    },
    { kind: 'supported_versions', versions: [TLS_VERSION.V1_3], isServerHello: false },
    {
      kind: 'key_share',
      clientShares: [{ group: NAMED_GROUPS[group], keyExchange: options.keySharePublicKey }],
    },
  ];

  if (options.cookie !== undefined) {
    extensions.push({ kind: 'cookie', cookie: options.cookie });
  }

  // Offered even without a session: RFC 9846 §4.7.1 lets a server withhold a ticket otherwise, and BoringSSL does.
  extensions.push({
    kind: 'psk_key_exchange_modes',
    modes: [PSK_KEY_EXCHANGE_MODES.psk_dhe_ke],
  });

  // §4.3.11: `pre_shared_key` must be the last extension.
  if (options.psk !== undefined) {
    extensions.push({
      kind: 'pre_shared_key',
      identities: [
        {
          identity: options.psk.identity,
          obfuscatedTicketAge: options.psk.obfuscatedTicketAge,
        },
      ],
      binders: [new Uint8Array(options.psk.binderLength)],
    });
  }

  // `bindClientHello` cuts a fixed-size tail off the message, so this must really hold.
  if (options.psk !== undefined && extensions.at(-1)?.kind !== 'pre_shared_key') {
    throw new Error('pre_shared_key must be the last ClientHello extension');
  }

  const build = (withExtensions: readonly Extension[]): Uint8Array<ArrayBuffer> =>
    encodeHandshakeMessage({
      kind: 'client_hello',
      legacyVersion: TLS_VERSION.V1_2,
      random,
      legacySessionId,
      cipherSuites: [0x1301, 0x1302],
      legacyCompressionMethods: Uint8Array.of(0),
      extensions: withExtensions,
    });

  const unpadded = build(extensions);
  const padding = paddingFor(unpadded.length);
  if (padding === null) return unpadded;

  // Before `pre_shared_key`, which must stay last.
  const insertAt = extensions.at(-1)?.kind === 'pre_shared_key' ? -1 : extensions.length;
  return build(extensions.toSpliced(insertAt, 0, { kind: 'padding', length: padding }));
};
