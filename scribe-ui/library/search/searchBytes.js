export { ByteWriter, ByteReader, codec } from '../../../js/utils/byteStream.js';

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
