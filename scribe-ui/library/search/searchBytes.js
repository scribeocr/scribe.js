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
    // The shift operators truncate to 32 bits, so the high part is split off with arithmetic.
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
    for (let i = from; i < from + n; i++) if (values[i] > max) max = values[i];
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

/**
 * What a structure costs on the heap beyond its own bytes, measured in Node's V8.
 */
export const HEAP_TYPED_ARRAY = 216;
export const HEAP_VIEW = 104;
export const HEAP_STRING = 16;
export const HEAP_OBJECT = 56;

/**
 * @param {Uint8Array} buf
 * @param {number} at
 * @param {number} n
 * @param {number} b
 * @param {number[]} out
 * @param {number} to
 */
export const unpack = (buf, at, n, b, out, to) => {
  if (b === 0) {
    out.fill(0, to, to + n);
    return;
  }
  const end = at + Math.ceil((n * b) / 8);
  const mask = b === 32 ? 0xffffffff : 2 ** b - 1;
  let word = 0;
  if (at + 4 <= end) word = buf[at] | (buf[at + 1] << 8) | (buf[at + 2] << 16) | (buf[at + 3] << 24);
  else for (let k = 0; at + k < end; k++) word |= buf[at + k] << (8 * k);
  at += 4;
  let shift = 0;
  for (let i = 0; i < n; i++) {
    let v = word >>> shift;
    shift += b;
    if (shift >= 32) {
      shift -= 32;
      if (shift > 0 || i < n - 1) {
        if (at + 4 <= end) word = buf[at] | (buf[at + 1] << 8) | (buf[at + 2] << 16) | (buf[at + 3] << 24);
        else {
          word = 0;
          for (let k = 0; at + k < end; k++) word |= buf[at + k] << (8 * k);
        }
        at += 4;
        if (shift) v |= word << (b - shift);
      }
    }
    out[to + i] = (v & mask) >>> 0;
  }
};

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder();
/** @param {string} s */
export const utf8Encode = (s) => utf8Encoder.encode(s);
/** @param {Uint8Array} b */
export const utf8Decode = (b) => utf8Decoder.decode(b);

/**
 * @param {Uint8Array} bytes
 * @param {'deflate-raw'} format
 * @param {boolean} inflate
 * @returns {Promise<Uint8Array>}
 */
export const codec = async (bytes, format, inflate) => {
  const stream = inflate ? new DecompressionStream(format) : new CompressionStream(format);
  // A Blob and a Response around the stream would cost nine times as much per page record in Chromium's worker.
  const writer = stream.writable.getWriter();
  // A corrupt or truncated input rejects the read below, so these two would only repeat the error.
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
