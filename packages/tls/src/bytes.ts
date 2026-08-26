/**
 * Byte-level encoding and decoding primitives for TLS records and messages.
 */

export const concat = (...parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> => {
  const joined = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.length;
  }
  return joined;
};

export const readUint8 = (bytes: Uint8Array, offset: number): number => {
  if (!Number.isInteger(offset) || offset < 0 || offset >= bytes.length) {
    throw new Error(`readUint8 out of bounds: offset ${offset}, length ${bytes.length}`);
  }
  const val = bytes[offset];
  if (val === undefined) throw new Error(`readUint8 byte at offset ${offset} is undefined`);
  return val;
};

export const readUint16 = (bytes: Uint8Array, offset: number): number => {
  if (!Number.isInteger(offset) || offset < 0 || offset + 2 > bytes.length) {
    throw new Error(`readUint16 out of bounds: offset ${offset}, length ${bytes.length}`);
  }
  const b0 = bytes[offset];
  const b1 = bytes[offset + 1];
  if (b0 === undefined || b1 === undefined) {
    throw new Error(`readUint16 bytes at offset ${offset} undefined`);
  }
  return (b0 << 8) | b1;
};

export const readUint24 = (bytes: Uint8Array, offset: number): number => {
  if (!Number.isInteger(offset) || offset < 0 || offset + 3 > bytes.length) {
    throw new Error(`readUint24 out of bounds: offset ${offset}, length ${bytes.length}`);
  }
  const b0 = bytes[offset];
  const b1 = bytes[offset + 1];
  const b2 = bytes[offset + 2];
  if (b0 === undefined || b1 === undefined || b2 === undefined) {
    throw new Error(`readUint24 bytes at offset ${offset} undefined`);
  }
  return (b0 << 16) | (b1 << 8) | b2;
};

export const writeUint8 = (value: number): Uint8Array<ArrayBuffer> => {
  if (!Number.isInteger(value) || value < 0 || value > 0xff) {
    throw new Error(`writeUint8 invalid value: ${value}`);
  }
  return Uint8Array.of(value);
};

export const writeUint16 = (value: number): Uint8Array<ArrayBuffer> => {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
    throw new Error(`writeUint16 invalid value: ${value}`);
  }
  return Uint8Array.of((value >> 8) & 0xff, value & 0xff);
};

export const writeUint24 = (value: number): Uint8Array<ArrayBuffer> => {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffff) {
    throw new Error(`writeUint24 invalid value: ${value}`);
  }
  return Uint8Array.of((value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff);
};
