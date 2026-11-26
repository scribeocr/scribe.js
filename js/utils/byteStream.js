export class ByteWriter {
  /** @param {number} [initial] */
  constructor(initial = 1 << 16) {
    this.buf = new Uint8Array(initial);
    this.length = 0;
  }

  /** @param {number} extra */
  _grow(extra) {
    if (this.length + extra <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.length + extra) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.length));
    this.buf = next;
  }

  /** @param {number} value - A non-negative integer below 2^53. */
  varint(value) {
    this._grow(10);
    while (value >= 0x80) {
      this.buf[this.length++] = (value % 0x80) | 0x80;
      value = Math.floor(value / 0x80);
    }
    this.buf[this.length++] = value;
  }

  /** @param {Uint8Array} bytes */
  bytes(bytes) {
    this._grow(bytes.length);
    this.buf.set(bytes, this.length);
    this.length += bytes.length;
  }

  /**
   * @param {ArrayLike<number>} values - Non-negative integers below 2^32.
   * @param {number} from
   * @param {number} n
   */
  packed(values, from, n) {
    let max = 0;
    for (let i = from; i < from + n; i++) {
      if (values[i] > max) max = values[i];
    }
    if (max > 0xffffffff) throw new Error(`cannot pack ${max} in 32 bits`);
    const b = 32 - Math.clz32(max);
    this._grow(5 + Math.ceil((n * b) / 8));
    const buf = this.buf;
    let at = this.length;
    buf[at++] = b;
    let word = 0;
    let shift = 0;
    if (b > 0) {
      for (let i = from; i < from + n; i++) {
        const v = values[i];
        word |= v << shift;
        shift += b;
        if (shift >= 32) {
          buf[at] = word & 0xff;
          buf[at + 1] = (word >>> 8) & 0xff;
          buf[at + 2] = (word >>> 16) & 0xff;
          buf[at + 3] = (word >>> 24) & 0xff;
          at += 4;
          shift -= 32;
          word = shift ? v >>> (b - shift) : 0;
        }
      }
    }
    for (let k = 0; k * 8 < shift; k++) buf[at++] = (word >>> (8 * k)) & 0xff;
    this.length = at;
  }

  /** @param {number} value */
  u32(value) {
    this._grow(4);
    this.buf[this.length] = value & 0xff;
    this.buf[this.length + 1] = (value >>> 8) & 0xff;
    this.buf[this.length + 2] = (value >>> 16) & 0xff;
    this.buf[this.length + 3] = (value >>> 24) & 0xff;
    this.length += 4;
  }

  /** @param {number} at @param {number} value */
  u32At(at, value) {
    this.buf[at] = value & 0xff;
    this.buf[at + 1] = (value >>> 8) & 0xff;
    this.buf[at + 2] = (value >>> 16) & 0xff;
    this.buf[at + 3] = (value >>> 24) & 0xff;
  }

  /** @returns {Uint8Array} */
  result() {
    return this.buf.subarray(0, this.length);
  }
}

export class ByteReader {
  /** @param {Uint8Array} buf @param {number} [at] */
  constructor(buf, at = 0) {
    this.buf = buf;
    this.at = at;
  }

  /** @returns {number} */
  varint() {
    const buf = this.buf;
    let at = this.at;
    let b = buf[at++];
    if (b < 0x80) {
      this.at = at;
      return b;
    }
    if (b === undefined) throw new Error(`varint overrun at byte ${at - 1} of ${buf.length}`);
    let value = b & 0x7f;
    let shift = 7;
    for (;;) {
      b = buf[at++];
      if (b === undefined || shift > 63) throw new Error(`varint overrun at byte ${at - 1} of ${buf.length}`);
      if (shift < 28) value |= (b & 0x7f) << shift;
      else value += (b & 0x7f) * 2 ** shift;
      if (b < 0x80) break;
      shift += 7;
    }
    this.at = at;
    return value;
  }

  /** @returns {number} */
  u32() {
    const buf = this.buf;
    const at = this.at;
    this.at += 4;
    return (buf[at] | (buf[at + 1] << 8) | (buf[at + 2] << 16)) + buf[at + 3] * 0x1000000;
  }

  /** @param {number} n @returns {Uint8Array} */
  bytes(n) {
    const out = this.buf.subarray(this.at, this.at + n);
    this.at += n;
    return out;
  }
}

// A top-level `await` here would make every importing module initialize asynchronously, which deadlocks scribe-ui's import cycles.
/** Node's zlib module, or null outside Node. */
export const nodeZlib = (typeof process !== 'undefined' && typeof process.versions?.node === 'string')
  ? process.getBuiltinModule('node:zlib')
  : null;

const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
  }
  crcTable[n] = c;
}

/**
 * Compute the CRC-32 checksum of a byte array.
 * @param {Uint8Array} bytes
 * @param {number} [crc] - Prior CRC-32 checksum when continuing across chunks.
 * @returns {number}
 */
export function crc32(bytes, crc = 0) {
  if (nodeZlib?.crc32) return nodeZlib.crc32(bytes, crc);
  crc ^= 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) {
    crc = crcTable[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

/**
 * Run byte chunks through a compression stream, yielding the compressed bytes as they come out.
 * @param {Iterable<Uint8Array>} chunks
 * @param {'gzip'|'deflate-raw'} format
 * @returns {AsyncGenerator<Uint8Array>}
 */
export async function* compressChunks(chunks, format) {
  const cs = new CompressionStream(format);
  const writer = cs.writable.getWriter();
  const reader = cs.readable.getReader();
  /** @type {Array<Uint8Array>} */
  const out = [];
  const drained = (async () => {
    for (let read = await reader.read(); !read.done; read = await reader.read()) out.push(read.value);
  })();
  drained.catch(() => {});
  let finished = false;
  try {
    for (const chunk of chunks) {
      await writer.write(chunk);
      yield* out.splice(0);
    }
    await writer.close();
    await drained;
    finished = true;
    yield* out.splice(0);
  } finally {
    if (!finished) writer.abort().catch(() => {});
  }
}

/**
 * Run bytes through a compression or decompression stream.
 * @param {Uint8Array} bytes
 * @param {'deflate'|'deflate-raw'} format
 * @param {boolean} inflate - Whether to decompress.
 * @returns {Promise<Uint8Array>}
 */
export const codec = async (bytes, format, inflate) => {
  const stream = inflate ? new DecompressionStream(format) : new CompressionStream(format);
  const writer = stream.writable.getWriter();
  // Corrupt or truncated input rejects reader.read() as well as the unawaited writer calls, which need .catch() to avoid unhandled rejections.
  writer.write(bytes).catch(() => {});
  writer.close().catch(() => {});
  const reader = stream.readable.getReader();
  /** @type {Uint8Array[]} */
  const parts = [];
  let length = 0;
  let chunk = await reader.read();
  while (!chunk.done) {
    parts.push(chunk.value);
    length += chunk.value.length;
    chunk = await reader.read();
  }
  if (parts.length === 1) return parts[0];
  const out = new Uint8Array(length);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};
