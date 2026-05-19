import { deflate } from '../../pdf/parsePdfUtils.js';

/**
 * @typedef {{ header: string, streamData: Uint8Array, trailer: string }} PdfBinaryObject
 */

// Browsers resolve to null and use CompressionStream (via `deflate`) instead.
const zlibDeflateSync = (typeof process !== 'undefined' && typeof process.versions?.node === 'string')
  ? (await import('node:zlib')).deflateSync
  : null;

/**
 * Compress raw bytes to a zlib-wrapped deflate stream, using the synchronous
 * Node path when available and the async CompressionStream path otherwise.
 * @param {Uint8Array} bytes
 */
export async function deflateBytes(bytes) {
  if (zlibDeflateSync) return zlibDeflateSync(bytes);
  return deflate(bytes);
}

/**
 * Build a PDF stream object from a content string. `dictExtras` is spliced
 * into the stream dict before `/Length` (e.g. `/Subtype/Form/BBox[...]`).
 *
 * @param {number} objNum
 * @param {string} contentStr - The raw (uncompressed) stream content.
 * @param {{ humanReadable?: boolean, dictExtras?: string }} [opts]
 */
export async function encodeStreamObject(objNum, contentStr, { humanReadable = false, dictExtras = '' } = {}) {
  if (humanReadable || contentStr.length === 0) {
    return `${objNum} 0 obj\n<<${dictExtras}/Length ${contentStr.length}>>\nstream\n${contentStr}\nendstream\nendobj\n\n`;
  }
  // Latin1 byte-for-byte. PDF content streams can embed inline image binary
  // via BI...ID...EI; TextEncoder (UTF-8) would double-encode bytes 0x80-0xFF.
  const bytes = new Uint8Array(contentStr.length);
  for (let i = 0; i < contentStr.length; i++) bytes[i] = contentStr.charCodeAt(i) & 0xFF;
  const deflated = await deflateBytes(bytes);
  return {
    header: `${objNum} 0 obj\n<<${dictExtras}/Length ${deflated.length} /Filter /FlateDecode>>\nstream\n`,
    streamData: deflated,
    trailer: '\nendstream\nendobj\n\n',
  };
}

/**
 * Same as `encodeStreamObject` but for a content payload that already lives
 * as bytes (e.g. a font file). The dict can carry extra entries (like
 * `/Length1` or `/Subtype/OpenType`) via `dictExtras` — they're spliced into
 * the header dict before `/Length`.
 *
 * @param {number} objNum
 * @param {Uint8Array} bytes - The raw (uncompressed) content.
 * @param {{ humanReadable?: boolean, dictExtras?: string }} [opts]
 */
export async function encodeBinaryStreamObject(objNum, bytes, { humanReadable = false, dictExtras = '' } = {}) {
  if (humanReadable) {
    // ASCIIHexDecode wrapper keeps the stream ASCII-safe for diffing.
    const hex = bytesToHex(bytes);
    return `${objNum} 0 obj\n<<${dictExtras}/Length ${hex.length}/Filter/ASCIIHexDecode>>\nstream\n${hex}\nendstream\nendobj\n\n`;
  }
  const deflated = await deflateBytes(bytes);
  return {
    header: `${objNum} 0 obj\n<<${dictExtras}/Length ${deflated.length}/Filter/FlateDecode>>\nstream\n`,
    streamData: deflated,
    trailer: '\nendstream\nendobj\n\n',
  };
}

/**
 * Hex-encode a byte array with newlines every 32 bytes for readability.
 * @param {Uint8Array} bytes
 */
function bytesToHex(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    if (i > 0 && i % 32 === 0) out += '\n';
    out += bytes[i].toString(16).padStart(2, '0');
  }
  return out;
}
