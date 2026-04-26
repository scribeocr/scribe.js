import { decodePNGPredictor } from './codecs/decodePNG.js';
import { decodeLZW } from './codecs/decodeLZW.js';
import { decodeCCITTFax } from './codecs/decodeCCITT.js';
import { decodeJBIG2 } from './codecs/decodeJBIG2.js';
import { inflate as pakoInflate, inflatePartial as pakoInflatePartial } from '../../lib/pako-inflate.js';
import {
  setupEncryption, aesDecrypt, computeObjectKey, rc4,
  parsePdfLiteralString, parsePdfHexString,
} from './pdfCrypto.js';

// ──── Byte-scan primitives ────
// Used by xref / dict / stream extractors so the parser can operate on the raw
// PDF Uint8Array without first decoding the entire file to a latin1 JS string
// (which would otherwise double the in-memory footprint of the PDF — JS strings
// are UTF-16 internally, so a 1.2 GB PDF becomes a 2.4 GB string).

/**
 * Find the byte offset of `needle` (an ASCII string) inside `bytes`, scanning
 * forward from `from`. Returns -1 if not found.
 *
 * Uses `Uint8Array.prototype.indexOf` (native, fast) to skip to the first
 * candidate byte, then verifies the remaining needle bytes in interpreted JS.
 * Much faster than a plain JS loop, especially for sparse needles.
 *
 * @param {Uint8Array} bytes
 * @param {string} needle - ASCII only
 * @param {number} [from=0]
 */
export function byteIndexOf(bytes, needle, from = 0) {
  const nLen = needle.length;
  if (nLen === 0) return from;
  const c0 = needle.charCodeAt(0);
  if (nLen === 1) return bytes.indexOf(c0, from);
  const last = bytes.length - nLen;
  let i = from;
  while (i <= last) {
    i = bytes.indexOf(c0, i);
    if (i === -1 || i > last) return -1;
    let j = 1;
    while (j < nLen && bytes[i + j] === needle.charCodeAt(j)) j++;
    if (j === nLen) return i;
    i++;
  }
  return -1;
}

/**
 * Find the byte offset of the last occurrence of `needle` in `bytes` at or
 * before `fromEnd`. Returns -1 if not found.
 * @param {Uint8Array} bytes
 * @param {string} needle - ASCII only
 * @param {number} [fromEnd] - inclusive end byte index (defaults to bytes.length-1)
 */
export function byteLastIndexOf(bytes, needle, fromEnd) {
  const nLen = needle.length;
  if (nLen === 0) return fromEnd ?? bytes.length;
  const start = Math.min(fromEnd ?? bytes.length - 1, bytes.length - nLen);
  const c0 = needle.charCodeAt(0);
  if (nLen === 1) return bytes.lastIndexOf(c0, start);
  let i = start;
  while (i >= 0) {
    i = bytes.lastIndexOf(c0, i);
    if (i === -1) return -1;
    let j = 1;
    while (j < nLen && bytes[i + j] === needle.charCodeAt(j)) j++;
    if (j === nLen) return i;
    i--;
  }
  return -1;
}

/**
 * True if the bytes at `bytes[off..off+needle.length]` equal `needle`.
 * @param {Uint8Array} bytes
 * @param {number} off
 * @param {string} needle - ASCII only
 */
export function bytesEqualAt(bytes, off, needle) {
  const nLen = needle.length;
  if (off < 0 || off + nLen > bytes.length) return false;
  for (let j = 0; j < nLen; j++) {
    if (bytes[off + j] !== needle.charCodeAt(j)) return false;
  }
  return true;
}

/**
 * PDF whitespace bytes per spec §3.1.1: NUL, HT, LF, FF, CR, SP.
 * @param {number} b
 */
function isPdfWhitespace(b) {
  return b === 0x20 || b === 0x09 || b === 0x0A || b === 0x0D || b === 0x0C || b === 0x00;
}

/**
 * ASCII digit byte (0-9).
 * @param {number} b
 */
function isAsciiDigit(b) {
  return b >= 0x30 && b <= 0x39;
}

/**
 * Extract a balanced << ... >> dictionary directly from PDF bytes, returning
 * the bracketed slice as a latin1 string. Used during xref-stream parsing
 * where we cannot afford to materialize the whole document as a string.
 * @param {Uint8Array} bytes
 * @param {number} start - byte offset of the first '<' of '<<'
 */
function extractDictFromBytes(bytes, start) {
  let depth = 0;
  let i = start;
  const len = bytes.length;
  while (i < len) {
    if (bytes[i] === 0x3C && i + 1 < len && bytes[i + 1] === 0x3C) {
      depth++;
      i += 2;
    } else if (bytes[i] === 0x3E && i + 1 < len && bytes[i + 1] === 0x3E) {
      depth--;
      i += 2;
      if (depth === 0) return bytesToLatin1(bytes, start, i);
    } else {
      i++;
    }
  }
  return bytesToLatin1(bytes, start);
}

/**
 * Find the xref offset from the end of the PDF (uses the last startxref for linearized PDFs).
 * @param {Uint8Array} pdfBytes
 */
export function findXrefOffset(pdfBytes) {
  const len = pdfBytes.length;
  const lastIdx = byteLastIndexOf(pdfBytes, 'startxref');
  if (lastIdx !== -1) {
    // Parse the digits after "startxref" + whitespace.
    let p = lastIdx + 9;
    while (p < len && isPdfWhitespace(pdfBytes[p])) p++;
    let num = 0;
    let hasDigit = false;
    while (p < len && isAsciiDigit(pdfBytes[p])) {
      num = num * 10 + (pdfBytes[p] - 0x30);
      p++;
      hasDigit = true;
    }
    if (hasDigit) {
      // startxref value is relative to %PDF header; adjust for junk prefix
      const pdfHeaderOffset = byteIndexOf(pdfBytes, '%PDF');
      const headerAdjust = pdfHeaderOffset > 0 ? pdfHeaderOffset : 0;
      const offset = num + headerAdjust;
      if (offset < len) {
        let checkPos = offset;
        while (checkPos < len && isPdfWhitespace(pdfBytes[checkPos])) checkPos++;
        if (bytesEqualAt(pdfBytes, checkPos, 'xref') || matchesObjHeader(pdfBytes, checkPos) || matchesBareXrefEntry(pdfBytes, checkPos)) {
          return offset;
        }
      }
    }
  }
  // Fallback: scan for the last standalone xref table (not inside "startxref")
  let searchFrom = len - 1;
  while (searchFrom >= 0) {
    const idx = byteLastIndexOf(pdfBytes, 'xref', searchFrom);
    if (idx === -1) break;
    // Ensure this is a standalone "xref" (preceded by newline/start, not "start")
    if (idx === 0 || pdfBytes[idx - 1] === 0x0A || pdfBytes[idx - 1] === 0x0D) return idx;
    searchFrom = idx - 1;
  }
  throw new Error('Could not find startxref');
}

/**
 * Returns true if the bytes at `pos` look like "<digits> <digits> obj".
 * @param {Uint8Array} bytes
 * @param {number} pos
 */
function matchesObjHeader(bytes, pos) {
  const len = bytes.length;
  let p = pos;
  if (!isAsciiDigit(bytes[p])) return false;
  while (p < len && isAsciiDigit(bytes[p])) p++;
  if (p >= len || bytes[p] !== 0x20) return false;
  p++;
  if (p >= len || !isAsciiDigit(bytes[p])) return false;
  while (p < len && isAsciiDigit(bytes[p])) p++;
  if (p >= len || bytes[p] !== 0x20) return false;
  p++;
  return bytesEqualAt(bytes, p, 'obj');
}

/**
 * Returns true if the bytes at `pos` start with "<objNum> <gen> obj" (any
 * generation number is accepted). Used to validate xref offsets.
 * @param {Uint8Array} bytes
 * @param {number} pos
 * @param {number} objNum
 */
function matchesObjMarker(bytes, pos, objNum) {
  const len = bytes.length;
  const objStr = String(objNum);
  if (!bytesEqualAt(bytes, pos, objStr)) return false;
  let p = pos + objStr.length;
  if (p >= len || !isPdfWhitespace(bytes[p])) return false;
  while (p < len && isPdfWhitespace(bytes[p])) p++;
  if (p >= len || !isAsciiDigit(bytes[p])) return false;
  while (p < len && isAsciiDigit(bytes[p])) p++;
  if (p >= len || !isPdfWhitespace(bytes[p])) return false;
  while (p < len && isPdfWhitespace(bytes[p])) p++;
  if (!bytesEqualAt(bytes, p, 'obj')) return false;
  // Word boundary: next char must be non-word
  const after = p + 3;
  if (after < len) {
    const c = bytes[after];
    if (isAsciiDigit(c) || (c >= 0x41 && c <= 0x5A) || (c >= 0x61 && c <= 0x7A) || c === 0x5F) return false;
  }
  return true;
}

/**
 * Returns true if the bytes at `pos` look like a bare xref entry "NNNNNNNNNN NNNNN [fn]".
 * @param {Uint8Array} bytes
 * @param {number} pos
 */
function matchesBareXrefEntry(bytes, pos) {
  if (pos + 18 >= bytes.length) return false;
  for (let j = 0; j < 10; j++) if (!isAsciiDigit(bytes[pos + j])) return false;
  if (bytes[pos + 10] !== 0x20) return false;
  for (let j = 11; j < 16; j++) if (!isAsciiDigit(bytes[pos + j])) return false;
  if (bytes[pos + 16] !== 0x20) return false;
  return bytes[pos + 17] === 0x66 || bytes[pos + 17] === 0x6E; // 'f' or 'n'
}

/**
 * Parse xref table/stream to get object positions.
 * @param {Uint8Array} pdfBytes
 * @param {number} xrefOffset
 * @returns {{ [objNum: number]: { type: number, offset?: number, objStmNum?: number, indexInStm?: number } }}
 */
export function parseXref(pdfBytes, xrefOffset) {
  /** @type {{ [objNum: number]: { type: number, offset?: number, objStmNum?: number, indexInStm?: number } }} */
  const entries = {};
  const visited = new Set();
  const len = pdfBytes.length;

  // Detect junk before %PDF header — xref offsets are relative to %PDF position
  const pdfHeaderOffset = byteIndexOf(pdfBytes, '%PDF');
  const headerAdjust = pdfHeaderOffset > 0 ? pdfHeaderOffset : 0;

  /** @type {number|null} */
  let currentOffset = xrefOffset;
  while (currentOffset !== null && !visited.has(currentOffset)) {
    visited.add(currentOffset);
    // Skip leading whitespace (linearized PDFs may pad xref stream offsets)
    let effectiveOffset = currentOffset;
    while (effectiveOffset < len && isPdfWhitespace(pdfBytes[effectiveOffset])) {
      effectiveOffset++;
    }
    let prevOffset = null;

    if (matchesObjHeader(pdfBytes, effectiveOffset)) {
      prevOffset = parseXrefStream(pdfBytes, effectiveOffset, entries);
      if (prevOffset !== null) prevOffset += headerAdjust;
    } else if (bytesEqualAt(pdfBytes, effectiveOffset, 'xref')) {
      parseXrefTable(pdfBytes, effectiveOffset, entries);
      // Check trailer for /Prev
      const trailerStart = byteIndexOf(pdfBytes, 'trailer', effectiveOffset);
      if (trailerStart !== -1) {
        const trailerDict = bytesToLatin1(pdfBytes, trailerStart, Math.min(trailerStart + 1000, len));
        const prevMatch = /\/Prev\s+(\d+)/.exec(trailerDict);
        if (prevMatch) prevOffset = Number(prevMatch[1]) + headerAdjust;
        // Also check for /XRefStm
        const xrefStmMatch = /\/XRefStm\s+(\d+)/.exec(trailerDict);
        if (xrefStmMatch) {
          parseXrefStream(pdfBytes, Number(xrefStmMatch[1]) + headerAdjust, entries);
        }
      }
    } else if (matchesBareXrefEntry(pdfBytes, effectiveOffset)) {
      // Bare xref table: entries without "xref" keyword or subsection header
      parseBareXrefTable(pdfBytes, effectiveOffset, entries);
      const trailerStart = byteIndexOf(pdfBytes, 'trailer', effectiveOffset);
      if (trailerStart !== -1) {
        const trailerDict = bytesToLatin1(pdfBytes, trailerStart, Math.min(trailerStart + 1000, len));
        const prevMatch = /\/Prev\s+(\d+)/.exec(trailerDict);
        if (prevMatch) prevOffset = Number(prevMatch[1]) + headerAdjust;
      }
    }

    currentOffset = prevOffset;
  }

  // Adjust type-1 entry offsets for junk before %PDF header
  if (headerAdjust > 0) {
    for (const entry of Object.values(entries)) {
      if (entry.type === 1 && entry.offset !== undefined) entry.offset += headerAdjust;
    }
  }

  return entries;
}

/**
 * Find the boundary between an xref section and the following trailer keyword
 * (or end of file). Used to bound the byte slice we materialize as a string
 * for line-based xref-table parsing.
 * @param {Uint8Array} bytes
 * @param {number} offset
 */
function findXrefSectionEnd(bytes, offset) {
  // The xref section ends at "trailer" (traditional) or at the next non-xref content.
  // Cap the search at 256 KB which is generous: an xref entry is 20 bytes, so 256 KB
  // covers ~12,000 entries — more than enough for a single subsection header lookup.
  // The actual section may be larger; if so, parseXrefTable's line walk will stop
  // when it sees a non-entry line.
  const trailerIdx = byteIndexOf(bytes, 'trailer', offset);
  const cap = Math.min(bytes.length, offset + 256 * 1024);
  if (trailerIdx !== -1 && trailerIdx < cap) return trailerIdx + 7;
  return cap;
}

/**
 * Parse a traditional xref table.
 * @param {Uint8Array} bytes
 * @param {number} offset
 * @param {{ [objNum: number]: any }} entries
 */
function parseXrefTable(bytes, offset, entries) {
  const sectionEnd = findXrefSectionEnd(bytes, offset);
  const section = bytesToLatin1(bytes, offset, sectionEnd);
  const lines = section.split(/\r?\n|\r/);
  let i = 1; // skip "xref" line
  while (i < lines.length) {
    const line = lines[i].trim();
    if (line === 'trailer' || line === '') break;
    const subsectionMatch = /^(\d+)\s+(\d+)$/.exec(line);
    if (subsectionMatch) {
      const startObj = Number(subsectionMatch[1]);
      const count = Number(subsectionMatch[2]);
      for (let j = 0; j < count; j++) {
        i++;
        if (i >= lines.length) break;
        const entryLine = lines[i].trim();
        const entryMatch = /^(\d+)\s+(\d+)\s+(n|f)$/.exec(entryLine);
        if (entryMatch && entryMatch[3] === 'n') {
          // Only store if not already set — newer xref sections (processed first) take precedence.
          if (!entries[startObj + j]) {
            entries[startObj + j] = { type: 1, offset: Number(entryMatch[1]) };
          }
        }
      }
    }
    i++;
  }
}

/**
 * Parse a bare xref table (missing "xref" keyword and subsection header).
 * Entries start directly at the offset as "NNNNNNNNNN NNNNN n/f" lines, starting from obj 0.
 * @param {Uint8Array} bytes
 * @param {number} offset
 * @param {{ [objNum: number]: any }} entries
 */
function parseBareXrefTable(bytes, offset, entries) {
  const sectionEnd = findXrefSectionEnd(bytes, offset);
  const section = bytesToLatin1(bytes, offset, sectionEnd);
  const lines = section.split(/\r?\n|\r/);
  let objNum = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === 'trailer' || trimmed === '') break;
    const entryMatch = /^(\d{10})\s+(\d{5})\s+(n|f)$/.exec(trimmed);
    if (entryMatch && entryMatch[3] === 'n') {
      if (!entries[objNum]) {
        entries[objNum] = { type: 1, offset: Number(entryMatch[1]) };
      }
    }
    if (entryMatch) objNum++;
  }
}

/**
 * Parse a cross-reference stream. Returns the /Prev offset if present, or null.
 * @param {Uint8Array} pdfBytes
 * @param {number} offset
 * @param {{ [objNum: number]: any }} entries
 * @returns {number|null}
 */
function parseXrefStream(pdfBytes, offset, entries) {
  const headerEnd = Math.min(offset + 200, pdfBytes.length);
  let dictStart = -1;
  for (let i = offset; i < headerEnd - 1; i++) {
    if (pdfBytes[i] === 0x3C && pdfBytes[i + 1] === 0x3C) { dictStart = i; break; }
  }
  if (dictStart === -1) return null;
  const dictText = extractDictFromBytes(pdfBytes, dictStart);

  const sizeMatch = /\/Size\s+(\d+)/.exec(dictText);
  const wMatch = /\/W\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s*\]/.exec(dictText);
  if (!sizeMatch || !wMatch) {
    // Dict parsing failed, but still follow /Prev chain
    const prevMatch = /\/Prev\s+(\d+)/.exec(dictText);
    return prevMatch ? Number(prevMatch[1]) : null;
  }

  const w = [Number(wMatch[1]), Number(wMatch[2]), Number(wMatch[3])];
  const entrySize = w[0] + w[1] + w[2];

  // Parse /Index array (or default to [0 Size])
  let indexArr;
  const indexMatch = /\/Index\s*\[([\d\s]+)\]/.exec(dictText);
  if (indexMatch) {
    indexArr = indexMatch[1].trim().split(/\s+/).map(Number);
  } else {
    indexArr = [0, Number(sizeMatch[1])];
  }

  // Find and decompress the stream (extractStream handles PNG predictor via DecodeParms)
  const streamData = extractStream(pdfBytes, offset);
  if (!streamData) {
    // Stream decompression failed, but still follow /Prev chain
    const prevMatch = /\/Prev\s+(\d+)/.exec(dictText);
    return prevMatch ? Number(prevMatch[1]) : null;
  }

  let pos = 0;
  for (let idx = 0; idx < indexArr.length; idx += 2) {
    const startObj = indexArr[idx];
    const count = indexArr[idx + 1];
    for (let j = 0; j < count; j++) {
      if (pos + entrySize > streamData.length) break;
      const type = w[0] > 0 ? readInt(streamData, pos, w[0]) : 1;
      const field2 = readInt(streamData, pos + w[0], w[1]);
      const field3 = w[2] > 0 ? readInt(streamData, pos + w[0] + w[1], w[2]) : 0;
      pos += entrySize;

      const objNum = startObj + j;
      // Only store if not already set — newer xref sections (processed first) take precedence.
      if (!entries[objNum]) {
        if (type === 1) {
          entries[objNum] = { type: 1, offset: field2 };
        } else if (type === 2) {
          entries[objNum] = { type: 2, objStmNum: field2, indexInStm: field3 };
        }
      }
      // type 0 = free entry, skip
    }
  }

  const prevMatch = /\/Prev\s+(\d+)/.exec(dictText);
  return prevMatch ? Number(prevMatch[1]) : null;
}

/**
 * Read a big-endian integer from bytes.
 * @param {Uint8Array} data
 * @param {number} offset
 * @param {number} length
 */
export function readInt(data, offset, length) {
  let val = 0;
  for (let i = 0; i < length; i++) {
    val = (val << 8) | data[offset + i];
  }
  return val;
}

/**
 * Extract a balanced << ... >> dictionary from text starting at the given position.
 * @param {string} text
 * @param {number} start - Position of the first '<'
 */
export function extractDict(text, start) {
  let depth = 0;
  let i = start;
  while (i < text.length) {
    if (text[i] === '<' && text[i + 1] === '<') {
      depth++;
      i += 2;
    } else if (text[i] === '>' && text[i + 1] === '>') {
      depth--;
      i += 2;
      if (depth === 0) return text.substring(start, i);
    } else {
      i++;
    }
  }
  return text.substring(start);
}

/**
 * Decompress zlib-wrapped deflate data using pako.
 * Throws on any error — callers are expected to catch and handle
 * (e.g. retry without trailing byte, or return null for encrypted streams).
 * @param {Uint8Array} data - zlib-wrapped deflate data
 */
export function inflate(data) {
  const result = pakoInflate(data);
  // Pako returns undefined (without throwing) for truncated streams where it
  // processes valid blocks but never reaches end-of-stream. Treat as failure.
  if (!(result instanceof Uint8Array)) throw new Error('inflate: no output');
  return result;
}

/**
 * Compress data using zlib/deflate via the native CompressionStream API.
 * @param {Uint8Array} data
 * @returns {Promise<Uint8Array>}
 */
export async function deflate(data) {
  const cs = new CompressionStream('deflate');
  const compressedStream = new Blob([data]).stream().pipeThrough(cs);
  const arrayBuffer = await new Response(compressedStream).arrayBuffer();
  return new Uint8Array(arrayBuffer);
}

/**
 * Extract raw stream bytes from a PDF object: find "stream" keyword, parse /Length,
 * slice the byte range, decrypt if needed. Used by extractStream.
 * @param {Uint8Array} pdfBytes
 * @param {number} objOffset
 * @param {Uint8Array|null} encryptionKey
 * @param {number} encryptObjNum
 * @param {string} cipherMode
 * @param {number} objNum
 * @returns {{ data: Uint8Array, dictText: string } | null}
 */
function extractRawStreamBytes(pdfBytes, objOffset, encryptionKey, encryptObjNum, cipherMode, objNum) {
  // Bound the per-object scan: locate endobj first, then materialize the small
  // object slice as a string for the existing dict-text parsing logic.
  const len = pdfBytes.length;
  let objEnd = byteIndexOf(pdfBytes, 'endobj', objOffset);
  if (objEnd === -1) objEnd = Math.min(objOffset + 100000, len);
  const objText = bytesToLatin1(pdfBytes, objOffset, objEnd);

  const dictEnd = objText.indexOf('>>');
  const streamKeyword = objText.indexOf('stream', dictEnd !== -1 ? dictEnd : 0);
  if (streamKeyword === -1) return null;

  // Restrict dictionary property searches to before the stream keyword so that
  // /Filter, /Length, /DecodeParms from inline image dicts inside the stream content
  // are not mistakenly picked up as the object's own properties.
  const dictText = objText.substring(0, streamKeyword);

  const lengthMatch = /\/Length\s+(\d+)/.exec(dictText);
  if (!lengthMatch) return null;
  let streamLength = Number(lengthMatch[1]);
  const indirectLengthMatch = /\/Length\s+(\d+)\s+\d+\s+R/.exec(dictText);
  if (indirectLengthMatch) {
    const refObjNum = Number(indirectLengthMatch[1]);
    // Forward whole-document scan for "<refObjNum> 0 obj <length>". Used only
    // in the rare indirect-/Length case; cap at first match.
    const marker = `${refObjNum} `;
    let scanIdx = 0;
    while ((scanIdx = byteIndexOf(pdfBytes, marker, scanIdx)) !== -1) {
      // Verify "N M obj <digits>" pattern starting at scanIdx
      let p = scanIdx + marker.length;
      while (p < len && isAsciiDigit(pdfBytes[p])) p++;
      if (p < len && pdfBytes[p] === 0x20) {
        p++;
        if (bytesEqualAt(pdfBytes, p, 'obj')) {
          p += 3;
          while (p < len && isPdfWhitespace(pdfBytes[p])) p++;
          if (p < len && isAsciiDigit(pdfBytes[p])) {
            let v = 0;
            while (p < len && isAsciiDigit(pdfBytes[p])) { v = v * 10 + (pdfBytes[p] - 0x30); p++; }
            streamLength = v;
            break;
          }
        }
      }
      scanIdx += marker.length;
    }
  }

  let streamStart = objOffset + streamKeyword + 6; // after "stream"
  if (pdfBytes[streamStart] === 0x0D && pdfBytes[streamStart + 1] === 0x0A) {
    streamStart += 2;
  } else if (pdfBytes[streamStart] === 0x0A || pdfBytes[streamStart] === 0x0D) {
    streamStart += 1;
  }

  let data = pdfBytes.slice(streamStart, streamStart + streamLength);

  // Fallback: if /Length appears incorrect, use endstream marker as boundary.
  // Strip at most one EOL (CRLF, CR, or LF) before endstream — per PDF spec,
  // one optional EOL marker precedes endstream. Do NOT strip multiple CR/LF bytes
  // because the stream data itself may legitimately end with CR/LF values.
  const endstreamIdx = byteIndexOf(pdfBytes, 'endstream', objOffset + streamKeyword);
  if (endstreamIdx !== -1) {
    let actualEnd = endstreamIdx;
    // Strip at most one EOL: CRLF, CR, or LF
    if (actualEnd >= 2 && pdfBytes[actualEnd - 2] === 0x0D && pdfBytes[actualEnd - 1] === 0x0A) {
      actualEnd -= 2;
    } else if (actualEnd >= 1 && (pdfBytes[actualEnd - 1] === 0x0A || pdfBytes[actualEnd - 1] === 0x0D)) {
      actualEnd -= 1;
    }
    if (actualEnd - streamStart !== streamLength) {
      data = pdfBytes.slice(streamStart, actualEnd);
    }
  }

  // Decrypt stream data if the PDF is encrypted (applied before decompression filters).
  if (encryptionKey && objNum >= 0 && objNum !== encryptObjNum) {
    if (cipherMode === 'AESV3') {
      data = aesDecrypt(encryptionKey, data);
    } else if (cipherMode === 'AESV2') {
      const objKey = computeObjectKey(encryptionKey, objNum, 0, true);
      data = aesDecrypt(objKey, data);
    } else {
      const objKey = computeObjectKey(encryptionKey, objNum, 0, false);
      data = rc4(objKey, data);
    }
  }

  return { data, dictText };
}

/**
 * Reverse a PDF /Predictor on already-decompressed filter output.
 * Reads /Predictor, /Colors, /Columns, /BitsPerComponent from `dpText`
 * (supporting indirect refs via `objCache`). Returns the de-predicted
 * bytes, or the input unchanged if no predictor is requested.
 *
 * Shared by `extractStream`'s FlateDecode/LZWDecode branches and by the
 * inline-image path in `renderPdfPage.js`.
 *
 * @param {Uint8Array} data - Decompressed filter output (post-inflate / post-LZW).
 * @param {string} dpText - The DecodeParms dict text (content between `<<` and `>>`).
 * @param {ObjectCache|null} objCache
 */
export function applyPredictor(data, dpText, objCache) {
  const pred = resolveIntValue(dpText, 'Predictor', objCache);
  if (!pred || pred === 1) return data;
  const colors = resolveIntValue(dpText, 'Colors', objCache, 1);
  const columns = resolveIntValue(dpText, 'Columns', objCache, 1);
  const bpc = resolveIntValue(dpText, 'BitsPerComponent', objCache, 8);
  const bytesPerRow = Math.ceil(columns * colors * bpc / 8);

  if (pred === 2) {
    // TIFF Predictor 2: horizontal differencing. Each sample is stored as the
    // delta from the previous sample on the same row in the same component.
    const numRows = Math.floor(data.length / bytesPerRow);
    const result = new Uint8Array(data);
    if (bpc === 16) {
      // 16-bit samples: must add as 16-bit values (with carry between bytes)
      const bytesPerSample = 2;
      const strideBytes = colors * bytesPerSample;
      for (let row = 0; row < numRows; row++) {
        const rowOff = row * bytesPerRow;
        for (let j = strideBytes; j < bytesPerRow; j += bytesPerSample) {
          const cur = (result[rowOff + j] << 8) | result[rowOff + j + 1];
          const prev = (result[rowOff + j - strideBytes] << 8) | result[rowOff + j - strideBytes + 1];
          const sum = (cur + prev) & 0xFFFF;
          result[rowOff + j] = sum >> 8;
          result[rowOff + j + 1] = sum & 0xFF;
        }
      }
    } else if (bpc >= 8) {
      const stride = colors * (bpc / 8);
      for (let row = 0; row < numRows; row++) {
        const rowOff = row * bytesPerRow;
        for (let j = stride; j < bytesPerRow; j++) {
          result[rowOff + j] = (result[rowOff + j] + result[rowOff + j - stride]) & 0xFF;
        }
      }
    } else {
      const mask = (1 << bpc) - 1;
      for (let row = 0; row < numRows; row++) {
        const rowOff = row * bytesPerRow;
        const prevSamples = new Uint8Array(colors);
        let sampleIdx = 0;
        for (let byteIdx = 0; byteIdx < bytesPerRow; byteIdx++) {
          const inByte = data[rowOff + byteIdx];
          let outByte = 0;
          for (let bitPos = 8 - bpc; bitPos >= 0; bitPos -= bpc) {
            const compIdx = sampleIdx % colors;
            const encoded = (inByte >> bitPos) & mask;
            const decoded = (encoded + prevSamples[compIdx]) & mask;
            outByte |= (decoded << bitPos);
            prevSamples[compIdx] = decoded;
            sampleIdx++;
          }
          result[rowOff + byteIdx] = outByte;
        }
      }
    }
    return result;
  }

  if (pred >= 10) {
    const bpp = Math.ceil(colors * bpc / 8);
    return new Uint8Array(decodePNGPredictor(data, bytesPerRow, bpp));
  }

  return data;
}

/**
 * Extract and decompress a stream from an object at the given offset.
 * @param {Uint8Array} pdfBytes
 * @param {number} objOffset
 * @param {ObjectCache|null} [objCache]
 * @param {number} [objNum]
 */
export function extractStream(pdfBytes, objOffset, objCache = null, objNum = -1) {
  const raw = extractRawStreamBytes(
    pdfBytes, objOffset,
    objCache?.encryptionKey ?? null, objCache?.encryptObjNum ?? 0, objCache?.cipherMode ?? 'RC4',
    objNum,
  );
  if (!raw) return null;
  let { data } = raw;
  const { dictText } = raw;

  // Parse filter chain: /Filter /Name or /Filter [/Name1 /Name2 ...] or /Filter N 0 R (indirect)
  // Use dictText (before stream keyword) to avoid matching inline image dicts inside stream content.
  let filterArrayMatch = /\/Filter\s*\[([\s\S]*?)\]/.exec(dictText);
  let filterSingleMatch = /\/Filter\s*\/([^\s/<>[\]]+)/.exec(dictText);
  if (!filterArrayMatch && !filterSingleMatch && objCache) {
    // Handle indirect filter reference: /Filter N M R
    const filterIndirectMatch = /\/Filter\s+(\d+)\s+\d+\s+R/.exec(dictText);
    if (filterIndirectMatch) {
      const filterObjText = objCache.getObjectText(Number(filterIndirectMatch[1]));
      if (filterObjText) {
        const resolved = filterObjText.replace(/^\d+\s+\d+\s+obj\s*/, '').replace(/\s*endobj.*$/, '').trim();
        filterArrayMatch = /^\[([\s\S]*)\]$/.exec(resolved);
        if (!filterArrayMatch) filterSingleMatch = /^\/([^\s/<>[\]]+)/.exec(resolved);
      }
    }
  }
  const filters = filterArrayMatch
    ? [...filterArrayMatch[1].matchAll(/\/([^\s/<>[\]]+)/g)].map((m) => m[1])
    : (filterSingleMatch ? [filterSingleMatch[1]] : []);

  // Parse DecodeParms for filters that need parameters (e.g. CCITTFaxDecode).
  // Can be a single dict or an array of dicts/nulls matching the filter array.
  /** @type {string[]} */
  const decodeParmsList = [];
  const dpArrayMatch = /\/DecodeParms\s*\[([\s\S]*?)\]/.exec(dictText);
  if (dpArrayMatch) {
    // Array form — walk through and extract each <<...>> dict or null entry
    const dpContent = dpArrayMatch[1];
    let di = 0;
    while (di < dpContent.length) {
      const ch = dpContent[di];
      if (ch === '<' && dpContent[di + 1] === '<') {
        let depth = 0;
        let end = di;
        for (let k = di; k < dpContent.length; k++) {
          if (dpContent[k] === '<' && dpContent[k + 1] === '<') { depth++; k++; } else if (dpContent[k] === '>' && dpContent[k + 1] === '>') {
            depth--;
            k++;
            if (depth === 0) { end = k + 1; break; }
          }
        }
        decodeParmsList.push(dpContent.substring(di, end));
        di = end;
      } else if (ch === 'n' && dpContent.substring(di, di + 4) === 'null') {
        decodeParmsList.push('');
        di += 4;
      } else if (ch >= '0' && ch <= '9' && objCache) {
        // Indirect reference: N 0 R
        const refMatch = /^(\d+)\s+\d+\s+R/.exec(dpContent.substring(di));
        if (refMatch) {
          const dpObjText = objCache.getObjectText(Number(refMatch[1]));
          decodeParmsList.push(dpObjText || '');
          di += refMatch[0].length;
        } else {
          di++;
        }
      } else {
        di++;
      }
    }
  } else {
    // Single dict form: /DecodeParms <<...>> or indirect ref /DecodeParms N 0 R
    const dpStart = dictText.indexOf('/DecodeParms');
    if (dpStart !== -1) {
      const afterDP = dictText.substring(dpStart + 12).trim();
      if (afterDP.startsWith('<<')) {
        let depth = 0;
        let end = 0;
        for (let k = 0; k < afterDP.length; k++) {
          if (afterDP[k] === '<' && afterDP[k + 1] === '<') { depth++; k++; } else if (afterDP[k] === '>' && afterDP[k + 1] === '>') {
            depth--;
            k++;
            if (depth === 0) { end = k + 1; break; }
          }
        }
        if (end > 0) decodeParmsList.push(afterDP.substring(0, end));
      } else if (objCache) {
        // Indirect reference: /DecodeParms N 0 R
        const dpRefMatch = /^(\d+)\s+\d+\s+R/.exec(afterDP);
        if (dpRefMatch) {
          const dpObjText = objCache.getObjectText(Number(dpRefMatch[1]));
          if (dpObjText) decodeParmsList.push(dpObjText);
        }
      }
    }
  }

  for (let fi = 0; fi < filters.length; fi++) {
    const filter = filters[fi];
    const dpText = decodeParmsList[fi] || '';
    if (objCache) objCache.filtersUsed.add(filter);

    if (filter === 'FlateDecode') {
      try {
        data = inflate(data);
      } catch (e1) {
        try {
          data = inflate(data.slice(0, -1));
        } catch (e2) {
          // Both attempts failed — try partial recovery for corrupted streams
          data = pakoInflatePartial(data);
          if (data.length === 0) return null;
        }
      }
      data = applyPredictor(data, dpText, objCache);
    } else if (filter === 'ASCIIHexDecode') {
      const hexStr = new TextDecoder('latin1').decode(data).replace(/\s/g, '');
      const end = hexStr.indexOf('>');
      const cleanHex = end >= 0 ? hexStr.substring(0, end) : hexStr;
      const bytes = new Uint8Array(Math.ceil(cleanHex.length / 2));
      for (let j = 0; j < bytes.length; j++) {
        bytes[j] = parseInt(cleanHex.substring(j * 2, j * 2 + 2) || '0', 16);
      }
      data = bytes;
    } else if (filter === 'CCITTFaxDecode') {
      /** @type {Record<string, any>} */
      const params = {};
      const kVal = resolveIntValue(dpText, 'K', objCache);
      const colVal = resolveIntValue(dpText, 'Columns', objCache);
      const rowVal = resolveIntValue(dpText, 'Rows', objCache);
      if (kVal || /\/K\s/.test(dpText)) params.K = kVal;
      if (colVal) params.Columns = colVal;
      if (rowVal) params.Rows = rowVal;
      if (/\/BlackIs1/.test(dpText)) params.BlackIs1 = resolveBoolValue(dpText, 'BlackIs1', objCache);
      if (/\/EncodedByteAlign/.test(dpText)) params.EncodedByteAlign = resolveBoolValue(dpText, 'EncodedByteAlign', objCache);
      if (/\/EndOfLine/.test(dpText)) params.EndOfLine = resolveBoolValue(dpText, 'EndOfLine', objCache);
      const decoded = decodeCCITTFax(data, params);
      data = new Uint8Array(decoded.buffer);
    } else if (filter === 'ASCII85Decode' || filter === 'A85') {
      const ascii = new TextDecoder('latin1').decode(data);
      const clean = ascii.replace(/\s/g, '');
      const endMarker = clean.indexOf('~>');
      const encoded = endMarker >= 0 ? clean.substring(0, endMarker) : clean;

      const output = [];
      let ai = 0;
      while (ai < encoded.length) {
        if (encoded[ai] === 'z') {
          output.push(0, 0, 0, 0);
          ai++;
        } else {
          const groupLen = Math.min(5, encoded.length - ai);
          const group = [];
          for (let j = 0; j < groupLen; j++) {
            group.push(encoded.charCodeAt(ai + j) - 33);
          }
          while (group.length < 5) group.push(84);
          let val = 0;
          for (let j = 0; j < 5; j++) {
            val = val * 85 + group[j];
          }
          // Extract bytes big-endian. Use division instead of bitwise
          // to handle partial groups where val may exceed 2^32.
          const numBytes = groupLen === 5 ? 4 : groupLen - 1;
          const divisors = [16777216, 65536, 256, 1];
          for (let j = 0; j < numBytes; j++) {
            output.push(Math.floor(val / divisors[j]) % 256);
          }
          ai += groupLen;
        }
      }
      data = new Uint8Array(output);
    } else if (filter === 'LZWDecode' || filter === 'LZW') {
      data = decodeLZW(data, dpText);
      data = applyPredictor(data, dpText, objCache);
    } else if (filter === 'RunLengthDecode' || filter === 'RL') {
      const output = [];
      let pos = 0;
      while (pos < data.length) {
        const len = data[pos++];
        if (len < 128) {
          // Copy the next len+1 bytes literally
          for (let j = 0; j < len + 1 && pos < data.length; j++) {
            output.push(data[pos++]);
          }
        } else if (len > 128) {
          // Repeat the next byte 257-len times
          const val = pos < data.length ? data[pos++] : 0;
          for (let j = 0; j < 257 - len; j++) {
            output.push(val);
          }
        } else {
          // len === 128: EOD
          break;
        }
      }
      data = new Uint8Array(output);
    } else if (filter === 'JBIG2Decode') {
      let globals = null;
      if (objCache) {
        const globalsMatch = /\/JBIG2Globals\s+(\d+)\s+\d+\s+R/.exec(dpText);
        if (globalsMatch) {
          globals = objCache.getStreamBytes(Number(globalsMatch[1]));
          if (!globals) {
            console.warn(`extractStream: JBIG2Globals stream ${globalsMatch[1]} could not be decoded synchronously`);
          }
        }
      }
      data = decodeJBIG2(data, globals);
    } else if (filter !== 'DCTDecode' && filter !== 'JPXDecode') {
      // Unrecognized filter — pass through raw data but track it
      if (objCache) objCache.unsupportedFilters.add(filter);
    }
    // DCTDecode and JPXDecode pass through raw data (decoded downstream)
  }

  return data;
}

/**
 * Maximum total bytes (sum of cached string `.length`) we hold in `textCache`
 * before evicting LRU entries. JS strings are UTF-16, so two bytes per char;
 * the cap below corresponds to ~64 MB of string memory.
 */
const TEXT_CACHE_BUDGET_CHARS = 32 * 1024 * 1024;

/**
 * Maximum total bytes of decoded ObjStm content held across all cached
 * object streams. Re-decompressing an evicted ObjStm is expensive (full
 * inflate), so this is set higher than the textCache budget.
 */
const OBJ_STM_CACHE_BUDGET_CHARS = 32 * 1024 * 1024;

/**
 * Maximum total bytes of decoded stream data held in `streamBytesCache`.
 * Page content streams and form XObject streams are typically fetched
 * multiple times (once by text extraction, once by path extraction,
 * and again per page that references a shared form). Caching the
 * decompressed bytes avoids re-running the full filter chain on every
 * repeat fetch. Bounded so that image-heavy multi-hundred-MB PDFs don't
 * blow up memory.
 */
const STREAM_BYTES_CACHE_BUDGET = 128 * 1024 * 1024;

let _objectCacheDocIdCounter = 0;

/**
 * Cache for reading PDF objects, handling both direct objects and ObjStm-contained objects.
 */
export class ObjectCache {
  /**
   * @param {Uint8Array} pdfBytes
   * @param {{ [objNum: number]: any }} xrefEntries
   */
  constructor(pdfBytes, xrefEntries) {
    this.pdfBytes = pdfBytes;
    this.xrefEntries = xrefEntries;
    /**
     * Process-unique identifier for this document.
     * @type {number}
     */
    this.docId = ++_objectCacheDocIdCounter;
    /**
     * LRU cache of object-text strings keyed by objNum. `Map` insertion order
     * is the LRU order; on hit we delete + re-set to refresh recency.
     * @type {Map<number, string>}
     */
    this.textCache = new Map();
    /** @type {number} Total characters across all entries in `textCache` */
    this.textCacheChars = 0;
    /**
     * LRU cache of decompressed object streams. Each value is a map from
     * contained-objNum to its raw text.
     * @type {Map<number, Map<number, string>>}
     */
    this.objStmCache = new Map();
    /** @type {number} Total characters across all per-object entries in `objStmCache` */
    this.objStmCacheChars = 0;
    /**
     * Cache of parsed FontInfo objects keyed by the font's indirect-object
     * number. Populated by `parsePageFonts` so that documents which reference
     * the same font from many containers (typical of Form-XObject-heavy PDFs)
     * pay the per-font parse cost only once. Inline font dicts (no objNum)
     * bypass this cache.
     * @type {Map<number, *>}
     */
    this.fontCache = new Map();
    /**
     * Cache of converted font binaries (OTF) keyed by fontObjNum.
     * Stores the result of buildFontFromCFF / convertType1ToOTFNew /
     * rebuildFontFromGlyphs so each font is converted at most once per
     * document. Not evicted — font data must persist for the document lifetime.
     * @type {Map<number, { familyName: string, otfData: ArrayBuffer, usesPUA: boolean,
     *   cmapType: string|null, cidCollisions: Set<number>|null, fontMatrix: number[]|null }>}
     */
    this.fontConversionCache = new Map();
    /**
     * Cache of decompressed stream bytes keyed by stream object number.
     * Populated by `getStreamBytes`. Eliminates repeat decompression when
     * (a) text and path extraction both walk the same page content stream,
     * and (b) a Form XObject is referenced from multiple pages.
     * FIFO-evicted when total cached bytes exceed the budget.
     * @type {Map<number, Uint8Array>}
     */
    this.streamBytesCache = new Map();
    /** @type {number} Total bytes across all entries in `streamBytesCache`. */
    this.streamBytesCacheBytes = 0;
    /**
     * Parsed ICC profile transforms keyed by the profile stream's objNum.
     * @type {Map<number, {gamma: number[], matrix: number[]}|null>}
     */
    this.iccProfileCache = new Map();
    /** @type {Uint8Array|null} Base encryption key (null if not encrypted) */
    this.encryptionKey = null;
    /** @type {number} Object number of the /Encrypt dict (excluded from decryption) */
    this.encryptObjNum = 0;
    /** @type {string} Cipher mode: 'RC4' or 'AESV2' */
    this.cipherMode = 'RC4';
    /** @type {Set<string>} All stream filter names encountered during parsing */
    this.filtersUsed = new Set();
    /** @type {Set<string>} Filter names that were not decoded (passed through raw) */
    this.unsupportedFilters = new Set();
    /** @type {boolean} True if xref had entries with offsets beyond file size (severe corruption) */
    this.xrefSeverelyCorrupt = false;
    /** @type {Set<number>|null} Lazily-computed set of OCGs hidden in View mode */
    this._offOCGs = null;
    // Repair broken xref entries by scanning the file for "N 0 obj" markers.
    this._repairXref();
    // Detect and set up encryption (synchronous — reads from raw bytes)
    setupEncryption(this);
  }

  /**
   * Insert an entry into `textCache`, evicting FIFO entries while the total
   * cached character count exceeds the budget. FIFO (insertion-order) eviction
   * was chosen over LRU because PDF parsing is mostly read-once per object;
   * the LRU "touch on hit" cost (delete+set on every cache lookup) was a
   * significant overhead with no meaningful hit-rate benefit in practice.
   * @param {number} objNum
   * @param {string} content
   */
  _putText(objNum, content) {
    this.textCache.set(objNum, content);
    this.textCacheChars += content.length;
    while (this.textCacheChars > TEXT_CACHE_BUDGET_CHARS && this.textCache.size > 1) {
      const firstKey = this.textCache.keys().next().value;
      const evicted = this.textCache.get(firstKey);
      this.textCache.delete(firstKey);
      this.textCacheChars -= evicted.length;
    }
  }

  _repairXref() {
    const bytes = this.pdfBytes;
    const len = bytes.length;
    // Detect xref entries with offsets beyond file size before repair
    for (const entry of Object.values(this.xrefEntries)) {
      if (entry.type === 1 && entry.offset >= len) {
        this.xrefSeverelyCorrupt = true;
        break;
      }
    }

    // Byte-state-machine port of `/(?:^|[^\d])(\d+)\s+(\d+)\s+obj\b/g`.
    // Keeps the latest digit-position seen for each objNum.
    const scanIndex = {};
    let pos = 0;
    while (pos < len) {
      // Skip non-digit bytes
      while (pos < len && !isAsciiDigit(bytes[pos])) pos++;
      if (pos >= len) break;
      // Require previous byte to be non-digit (regex's `(?:^|[^\d])`).
      if (pos > 0 && isAsciiDigit(bytes[pos - 1])) {
        // Walk to end of this digit run, then continue.
        while (pos < len && isAsciiDigit(bytes[pos])) pos++;
        continue;
      }
      const numStart = pos;
      let objNum = 0;
      while (pos < len && isAsciiDigit(bytes[pos])) {
        objNum = objNum * 10 + (bytes[pos] - 0x30);
        pos++;
      }
      // Required: \s+ (one or more whitespace bytes per regex; we accept any PDF whitespace)
      if (pos >= len || !isPdfWhitespace(bytes[pos])) continue;
      while (pos < len && isPdfWhitespace(bytes[pos])) pos++;
      // Required: <gen digits>
      if (pos >= len || !isAsciiDigit(bytes[pos])) continue;
      while (pos < len && isAsciiDigit(bytes[pos])) pos++;
      // Required: \s+
      if (pos >= len || !isPdfWhitespace(bytes[pos])) continue;
      while (pos < len && isPdfWhitespace(bytes[pos])) pos++;
      // Required: 'obj' followed by a non-word character (regex's `\b`).
      if (!bytesEqualAt(bytes, pos, 'obj')) continue;
      const after = pos + 3;
      if (after < len) {
        const c = bytes[after];
        if (isAsciiDigit(c) || (c >= 0x41 && c <= 0x5A) || (c >= 0x61 && c <= 0x7A) || c === 0x5F) {
          pos = after;
          continue;
        }
      }
      // Match — keep the last occurrence per object number.
      scanIndex[objNum] = numStart;
      pos = after;
    }

    for (const objNumStr of Object.keys(scanIndex)) {
      const objNum = Number(objNumStr);
      const scannedOffset = scanIndex[objNum];
      const entry = this.xrefEntries[objNum];
      if (!entry) {
        this.xrefEntries[objNum] = { type: 1, offset: scannedOffset };
      } else if (entry.type === 1) {
        // Validate the xref offset: the bytes at the offset must be "N <gen> obj"
        if (!matchesObjMarker(bytes, entry.offset, objNum)) entry.offset = scannedOffset;
      }
    }

    // Validate all remaining type 1 xref entries: if the offset doesn't point to "N <gen> obj",
    // the entry is corrupt and must be removed. This catches entries for object numbers
    // that don't actually exist in the file (no scan match to override them).
    for (const objNumStr of Object.keys(this.xrefEntries)) {
      const objNum = Number(objNumStr);
      const entry = this.xrefEntries[objNum];
      if (entry && entry.type === 1 && !scanIndex[objNum]) {
        if (!matchesObjMarker(bytes, entry.offset, objNum)) delete this.xrefEntries[objNum];
      }
    }
  }

  /**
   * Get the text content of an object (the dictionary/value part, not including "N 0 obj").
   * @param {number} objNum
   * @returns {string|null}
   */
  getObjectText(objNum) {
    const cached = this.textCache.get(objNum);
    if (cached !== undefined) return cached;

    const bytes = this.pdfBytes;
    const entry = this.xrefEntries[objNum];
    if (entry) {
      if (entry.type === 1) {
        const offset = entry.offset;
        const endObj = byteIndexOf(bytes, 'endobj', offset);
        if (endObj !== -1) {
          const objStart = byteIndexOf(bytes, 'obj', offset);
          if (objStart !== -1 && objStart < endObj) {
            const content = bytesToLatin1(bytes, objStart + 3, endObj).trim();
            this._putText(objNum, content);
            return content;
          }
        }
      } else if (entry.type === 2) {
        // Object in ObjStm
        this.decompressObjStm(entry.objStmNum);
        const cachedStm = this.objStmCache.get(entry.objStmNum);
        if (cachedStm && cachedStm.has(objNum)) {
          const content = cachedStm.get(objNum);
          this._putText(objNum, content);
          return content;
        }
      }
    }

    // Fallback for broken xref: scan raw bytes for "N 0 obj" marker at line boundary.
    // This handles PDFs where the xref table has wrong offsets or missing entries.
    const marker = `${objNum} 0 obj`;
    let scanIdx = 0;
    while ((scanIdx = byteIndexOf(bytes, marker, scanIdx)) !== -1) {
      if (scanIdx === 0 || isPdfWhitespace(bytes[scanIdx - 1])) {
        const endObj = byteIndexOf(bytes, 'endobj', scanIdx);
        if (endObj !== -1) {
          const objStart = byteIndexOf(bytes, 'obj', scanIdx);
          if (objStart !== -1 && objStart < endObj) {
            const content = bytesToLatin1(bytes, objStart + 3, endObj).trim();
            this._putText(objNum, content);
            return content;
          }
        }
      }
      scanIdx += marker.length;
    }

    return null;
  }

  /**
   * Returns the set of OCG object numbers that should be hidden when rendering
   * for on-screen viewing. Computed lazily on first call from:
   *   1. /OCProperties/D/OFF[...] — explicitly hidden OCGs
   *   2. /OCProperties/D/AS[...] — auto-state entries with /Event/View; for
   *      each listed OCG, /Usage/View/ViewState=/OFF marks it hidden in View
   *      mode (used to author print-only watermarks).
   * Cached for the lifetime of the ObjectCache. Always returns the same Set
   * instance so callers may compare or short-circuit on identity.
   */
  getOffOCGs() {
    if (this._offOCGs !== null) return this._offOCGs;
    /** @type {Set<number>} */
    const off = new Set();
    const rootObjNum = findRootObjNum(this.pdfBytes);
    if (rootObjNum != null) {
      const catText = this.getObjectText(rootObjNum);
      if (catText) {
        const ocpMatch = /\/OCProperties\s+(\d+)\s+\d+\s+R/.exec(catText)
          || /\/OCProperties\s*<</.exec(catText);
        const ocpText = ocpMatch && ocpMatch[1]
          ? this.getObjectText(Number(ocpMatch[1]))
          : catText;
        if (ocpText) {
          const offMatch = /\/OFF\s*\[([^\]]*)\]/.exec(ocpText);
          if (offMatch) {
            for (const m of offMatch[1].matchAll(/(\d+)\s+\d+\s+R/g)) off.add(Number(m[1]));
          }
          // AS (AutoState) — find entries with Event=/View and consult each
          // OCG's Usage.View.ViewState. We render for on-screen viewing, so any
          // OCG marked ViewState=/OFF must be hidden.
          const asIdx = ocpText.indexOf('/AS');
          if (asIdx !== -1) {
            const asOpen = ocpText.indexOf('[', asIdx);
            if (asOpen !== -1) {
              // Bracket-balanced extraction of the AS array (may contain nested [..]).
              let depth = 0;
              let asEnd = -1;
              for (let k = asOpen; k < ocpText.length; k++) {
                const ch = ocpText[k];
                if (ch === '[') depth++;
                else if (ch === ']') {
                  depth--;
                  if (depth === 0) { asEnd = k; break; }
                }
              }
              if (asEnd !== -1) {
                const asBody = ocpText.substring(asOpen + 1, asEnd);
                // Each AS entry is a dict <</Event/View/OCGs[...]/Category[...]>>.
                // Find top-level entries by scanning for matched << ... >> pairs.
                let j = 0;
                while (j < asBody.length) {
                  const dictOpen = asBody.indexOf('<<', j);
                  if (dictOpen === -1) break;
                  let dDepth = 0;
                  let dictEnd = -1;
                  for (let k = dictOpen; k < asBody.length - 1; k++) {
                    if (asBody[k] === '<' && asBody[k + 1] === '<') {
                      dDepth++;
                      k++;
                    } else if (asBody[k] === '>' && asBody[k + 1] === '>') {
                      dDepth--;
                      if (dDepth === 0) {
                        dictEnd = k + 2;
                        break;
                      }
                      k++;
                    }
                  }
                  if (dictEnd === -1) break;
                  const entry = asBody.substring(dictOpen, dictEnd);
                  j = dictEnd;
                  if (!/\/Event\s*\/View\b/.test(entry)) continue;
                  const ocgsMatch = /\/OCGs\s*\[([^\]]*)\]/.exec(entry);
                  if (!ocgsMatch) continue;
                  for (const m of ocgsMatch[1].matchAll(/(\d+)\s+\d+\s+R/g)) {
                    const ocgNum = Number(m[1]);
                    const ocgText = this.getObjectText(ocgNum);
                    if (!ocgText) continue;
                    const viewStateMatch = /\/View\s*<<[^<>]*?\/ViewState\s*\/(\w+)/.exec(ocgText);
                    if (viewStateMatch && viewStateMatch[1] === 'OFF') {
                      off.add(ocgNum);
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
    this._offOCGs = off;
    return off;
  }

  /**
   * Get the raw stream bytes for a stream object.
   * @param {number} objNum
   * @returns {Uint8Array|null}
   */
  getStreamBytes(objNum) {
    const cached = this.streamBytesCache.get(objNum);
    if (cached !== undefined) return cached;

    const bytes = this.pdfBytes;
    let entry = this.xrefEntries[objNum];
    // If the xref offset is beyond the file size, the entry is corrupt — scan instead
    if (entry && entry.type === 1 && entry.offset >= bytes.length) {
      entry = null;
    }
    let result = null;
    if (!entry) {
      // Fallback for broken xref: scan raw bytes for "N 0 obj" marker at line boundary
      const marker = `${objNum} 0 obj`;
      let idx = 0;
      while ((idx = byteIndexOf(bytes, marker, idx)) !== -1) {
        if (idx === 0 || isPdfWhitespace(bytes[idx - 1])) {
          result = extractStream(bytes, idx, this, objNum);
          break;
        }
        idx += marker.length;
      }
    } else if (entry.type === 1) {
      result = extractStream(bytes, entry.offset, this, objNum);
    }

    if (result !== null) this._putStreamBytes(objNum, result);
    return result;
  }

  /**
   * Insert a decompressed stream into the cache, evicting FIFO-oldest
   * entries while the total byte count exceeds the budget.
   * @param {number} objNum
   * @param {Uint8Array} data
   */
  _putStreamBytes(objNum, data) {
    this.streamBytesCache.set(objNum, data);
    this.streamBytesCacheBytes += data.byteLength;
    while (this.streamBytesCacheBytes > STREAM_BYTES_CACHE_BUDGET && this.streamBytesCache.size > 1) {
      const firstKey = this.streamBytesCache.keys().next().value;
      if (firstKey === objNum) break;
      const evicted = this.streamBytesCache.get(firstKey);
      this.streamBytesCache.delete(firstKey);
      this.streamBytesCacheBytes -= evicted.byteLength;
    }
  }

  /**
   * Decompress an ObjStm and cache its contained objects.
   * @param {number} objStmNum
   */
  decompressObjStm(objStmNum) {
    if (this.objStmCache.has(objStmNum)) return;

    /** @type {Map<number, string>} */
    const stmEntries = new Map();
    // Insert immediately so concurrent callers don't double-decompress; populate below.
    this.objStmCache.set(objStmNum, stmEntries);

    const bytes = this.pdfBytes;
    const entry = this.xrefEntries[objStmNum];
    if (!entry || entry.type !== 1) return;

    const offset = entry.offset;
    let endObj = byteIndexOf(bytes, 'endobj', offset);
    if (endObj === -1) endObj = Math.min(offset + 100000, bytes.length);
    const objText = bytesToLatin1(bytes, offset, endObj);

    const nMatch = /\/N\s+(\d+)/.exec(objText);
    const firstMatch = /\/First\s+(\d+)/.exec(objText);
    if (!nMatch || !firstMatch) return;

    const n = Number(nMatch[1]);
    const first = Number(firstMatch[1]);

    const streamData = extractStream(bytes, offset, this, objStmNum);
    if (!streamData) return;

    const streamText = bytesToLatin1(streamData);

    // Parse the header: pairs of (objNum, offset) repeated N times
    const headerPart = streamText.substring(0, first).trim();
    const headerNums = headerPart.split(/\s+/).map(Number);

    let addedChars = 0;
    for (let i = 0; i < n; i++) {
      const objNum = headerNums[i * 2];
      const objOffset = headerNums[i * 2 + 1];
      const startPos = first + objOffset;
      // End is either the next object's start or end of stream
      const nextObjOffset = (i + 1 < n) ? first + headerNums[(i + 1) * 2 + 1] : streamText.length;
      const content = streamText.substring(startPos, nextObjOffset).trim();
      stmEntries.set(objNum, content);
      addedChars += content.length;
    }
    this.objStmCacheChars += addedChars;
    // Evict LRU object streams while over budget. Always keep the just-loaded entry.
    while (this.objStmCacheChars > OBJ_STM_CACHE_BUDGET_CHARS && this.objStmCache.size > 1) {
      const firstKey = this.objStmCache.keys().next().value;
      if (firstKey === objStmNum) break;
      const evicted = this.objStmCache.get(firstKey);
      let evictedChars = 0;
      for (const v of evicted.values()) evictedChars += v.length;
      this.objStmCache.delete(firstKey);
      this.objStmCacheChars -= evictedChars;
    }
  }

  /**
   * Decrypt a PDF string's raw bytes for the given object.
   * PDF encryption applies per-object keys to string values (Algorithm 3.1 from spec).
   * @param {Uint8Array} encryptedBytes - Raw encrypted string bytes
   * @param {number} objNum - Object number
   * @param {number} [genNum=0] - Generation number
   */
  decryptStringBytes(encryptedBytes, objNum, genNum = 0) {
    if (!this.encryptionKey || objNum === this.encryptObjNum) return encryptedBytes;
    if (this.cipherMode === 'AESV3') {
      return aesDecrypt(this.encryptionKey, encryptedBytes);
    }
    if (this.cipherMode === 'AESV2') {
      const objKey = computeObjectKey(this.encryptionKey, objNum, genNum, true);
      return aesDecrypt(objKey, encryptedBytes);
    }
    const objKey = computeObjectKey(this.encryptionKey, objNum, genNum, false);
    return rc4(objKey, encryptedBytes);
  }

  /**
   * Find a PDF string value for a given dict key in an object's raw bytes,
   * decrypt it, and return the result. Works directly with raw bytes to avoid
   * TextDecoder('latin1') Windows-1252 corruption of encrypted byte values.
   * @param {number} objNum - Object number containing the dict
   * @param {string} keyName - Dict key without leading slash (e.g., 'Registry')
   */
  decryptDictString(objNum, keyName) {
    if (!this.encryptionKey) return null;
    const entry = this.xrefEntries[objNum];
    if (!entry || entry.type !== 1) return null;

    const offset = entry.offset;
    const bytes = this.pdfBytes;

    let endIdx = offset;
    while (endIdx < bytes.length - 6) {
      if (bytes[endIdx] === 0x65 && bytes[endIdx + 1] === 0x6E && bytes[endIdx + 2] === 0x64
        && bytes[endIdx + 3] === 0x6F && bytes[endIdx + 4] === 0x62 && bytes[endIdx + 5] === 0x6A) break;
      endIdx++;
    }
    if (endIdx >= bytes.length - 6) return null;

    const keyStr = `/${keyName}`;
    let pos = offset;
    let found = false;
    while (pos < endIdx - keyStr.length) {
      let match = true;
      for (let k = 0; k < keyStr.length; k++) {
        if (bytes[pos + k] !== keyStr.charCodeAt(k)) { match = false; break; }
      }
      if (match) { found = true; break; }
      pos++;
    }
    if (!found) return null;

    pos += keyStr.length;
    while (pos < endIdx && (bytes[pos] === 0x20 || bytes[pos] === 0x0A || bytes[pos] === 0x0D || bytes[pos] === 0x09)) pos++;
    if (pos >= endIdx) return null;

    let rawBytes;
    if (bytes[pos] === 0x28) {
      rawBytes = parsePdfLiteralString(bytes, pos).value;
    } else if (bytes[pos] === 0x3C && pos + 1 < endIdx && bytes[pos + 1] !== 0x3C) {
      rawBytes = parsePdfHexString(bytes, pos).value;
    } else {
      return null;
    }

    const decrypted = this.decryptStringBytes(rawBytes, objNum);
    let result = '';
    for (let i = 0; i < decrypted.length; i++) result += String.fromCharCode(decrypted[i]);
    return result;
  }
}

/**
 * Strip the `N M obj ... endobj` wrapper from an object's text, returning just the value.
 * @param {string} objText
 */
function stripObjWrapper(objText) {
  return objText.replace(/^\s*\d+\s+\d+\s+obj\s*/, '').replace(/\s*endobj[\s\S]*$/, '').trim();
}

/**
 * Resolve an integer value from a PDF dict, handling indirect refs.
 * Checks for indirect ref pattern FIRST (superset of direct pattern) to avoid
 * capturing the object number as the value (Type B bug).
 * @param {string} dictText
 * @param {string} key - key name without leading slash
 * @param {ObjectCache|null} objCache
 * @param {number} [defaultValue=0]
 */
export function resolveIntValue(dictText, key, objCache, defaultValue = 0) {
  const refMatch = new RegExp(`/${key}\\s+(\\d+)\\s+\\d+\\s+R`).exec(dictText);
  if (refMatch && objCache) {
    const objText = objCache.getObjectText(Number(refMatch[1]));
    if (objText) {
      const val = /(-?\d+)/.exec(stripObjWrapper(objText));
      if (val) return Number(val[1]);
    }
    return defaultValue;
  }
  const direct = new RegExp(`/${key}\\s+(-?\\d+)`).exec(dictText);
  return direct ? Number(direct[1]) : defaultValue;
}

/**
 * Resolve a numeric (possibly floating-point) value from a PDF dict.
 * @param {string} dictText
 * @param {string} key
 * @param {ObjectCache|null} objCache
 * @param {number} [defaultValue=0]
 */
export function resolveNumValue(dictText, key, objCache, defaultValue = 0) {
  const refMatch = new RegExp(`/${key}\\s+(\\d+)\\s+\\d+\\s+R`).exec(dictText);
  if (refMatch && objCache) {
    const objText = objCache.getObjectText(Number(refMatch[1]));
    if (objText) {
      const val = /(-?[\d.]+)/.exec(stripObjWrapper(objText));
      if (val) return Number(val[1]);
    }
    return defaultValue;
  }
  const direct = new RegExp(`/${key}\\s+(-?[\\d.]+)`).exec(dictText);
  return direct ? Number(direct[1]) : defaultValue;
}

/**
 * Resolve an array value from a PDF dict, handling indirect refs.
 * Returns the raw array content string (between [ ]), or null.
 * @param {string} dictText
 * @param {string} key
 * @param {ObjectCache|null} objCache
 */
export function resolveArrayValue(dictText, key, objCache) {
  // Use depth-aware bracket matching instead of [^\]]+ so that nested arrays
  // inside inline dicts (e.g. /Functions [ << /Domain [0 1] >> ]) are handled.
  const keyIdx = dictText.indexOf(`/${key}`);
  if (keyIdx !== -1) {
    const after = dictText.substring(keyIdx + key.length + 1).trimStart();
    if (after[0] === '[') {
      let depth = 0;
      for (let k = 0; k < after.length; k++) {
        if (after[k] === '[') depth++;
        else if (after[k] === ']') { depth--; if (depth === 0) return after.substring(1, k).trim(); }
      }
    }
  }
  if (!objCache) return null;
  const refMatch = new RegExp(`/${key}\\s+(\\d+)\\s+\\d+\\s+R`).exec(dictText);
  if (refMatch) {
    const objText = objCache.getObjectText(Number(refMatch[1]));
    if (objText) {
      const arr = /\[\s*([\s\S]*?)\s*\]/.exec(stripObjWrapper(objText));
      if (arr) return arr[1].trim();
    }
  }
  return null;
}

/**
 * Resolve a boolean value from a PDF dict, handling indirect refs.
 * @param {string} dictText
 * @param {string} key
 * @param {ObjectCache|null} objCache
 * @param {boolean} [defaultValue=false]
 */
export function resolveBoolValue(dictText, key, objCache, defaultValue = false) {
  const directMatch = new RegExp(`/${key}\\s+(true|false)`).exec(dictText);
  if (directMatch) return directMatch[1] === 'true';
  if (!objCache) return defaultValue;
  const refMatch = new RegExp(`/${key}\\s+(\\d+)\\s+\\d+\\s+R`).exec(dictText);
  if (refMatch) {
    const objText = objCache.getObjectText(Number(refMatch[1]));
    if (objText) {
      const val = /(true|false)/.exec(stripObjWrapper(objText));
      if (val) return val[1] === 'true';
    }
  }
  return defaultValue;
}

/**
 * Resolve a name value from a PDF dict, handling indirect refs.
 * Returns the name without the leading slash, or null.
 * @param {string} dictText
 * @param {string} key
 * @param {ObjectCache|null} objCache
 */
export function resolveNameValue(dictText, key, objCache) {
  const directMatch = new RegExp(`/${key}\\s*/([^\\s/<>\\[\\]]+)`).exec(dictText);
  if (directMatch) return directMatch[1];
  if (!objCache) return null;
  const refMatch = new RegExp(`/${key}\\s+(\\d+)\\s+\\d+\\s+R`).exec(dictText);
  if (refMatch) {
    const objText = objCache.getObjectText(Number(refMatch[1]));
    if (objText) {
      const val = /\/([^\s/<>[\]]+)/.exec(stripObjWrapper(objText));
      if (val) return val[1];
    }
  }
  return null;
}

/**
 * Convert a Uint8Array (or a slice thereof) to a string preserving raw byte values (true ISO-8859-1).
 * @param {Uint8Array} bytes
 * @param {number} [start=0]
 * @param {number} [end] - exclusive (defaults to bytes.length)
 */
export function bytesToLatin1(bytes, start = 0, end) {
  const stop = end === undefined ? bytes.length : end;
  const chunkSize = 8192;
  let result = '';
  for (let i = start; i < stop; i += chunkSize) {
    const chunkEnd = Math.min(i + chunkSize, stop);
    result += String.fromCharCode.apply(null, bytes.subarray(i, chunkEnd));
  }
  return result;
}

/**
 * Find Form XObjects in a container's Resources dictionary.
 * Shared by parsePdfDoc and parsePdfPaths.
 * @param {string} containerObjText
 * @param {ObjectCache} objCache
 */
export function findFormXObjects(containerObjText, objCache) {
  const forms = new Map();

  // Resolve Resources (may be inline or an indirect reference)
  let resourcesText = containerObjText;
  const resRefMatch = /\/Resources\s+(\d+)\s+\d+\s+R/.exec(containerObjText);
  if (resRefMatch) {
    const resObj = objCache.getObjectText(Number(resRefMatch[1]));
    if (resObj) resourcesText = resObj;
  } else {
    const resInlineIdx = containerObjText.indexOf('/Resources');
    if (resInlineIdx !== -1) {
      const afterRes = containerObjText.substring(resInlineIdx + 10).trim();
      if (afterRes.startsWith('<<')) {
        const resDictText = extractDict(
          containerObjText,
          resInlineIdx + 10 + containerObjText.substring(resInlineIdx + 10).indexOf('<<'),
        );
        if (resDictText) resourcesText = resDictText;
      }
    }
  }

  const xobjStart = resourcesText.indexOf('/XObject');
  if (xobjStart === -1) return forms;

  let xobjDictText;
  const afterXObj = resourcesText.substring(xobjStart + 8).trim();
  if (afterXObj.startsWith('<<')) {
    xobjDictText = extractDict(
      resourcesText,
      xobjStart + 8 + resourcesText.substring(xobjStart + 8).indexOf('<<'),
    );
  } else {
    const xobjRefMatch = /^(\d+)\s+\d+\s+R/.exec(afterXObj);
    if (xobjRefMatch) {
      const xObj = objCache.getObjectText(Number(xobjRefMatch[1]));
      if (xObj) xobjDictText = xObj;
    }
  }
  if (!xobjDictText) return forms;

  const entryRegex = /\/([^\s/]+)\s+(\d+)\s+\d+\s+R/g;
  for (const entry of xobjDictText.matchAll(entryRegex)) {
    const tag = entry[1];
    const objNum = Number(entry[2]);
    const entryObjText = objCache.getObjectText(objNum);
    if (!entryObjText) continue;
    if (/\/Subtype\s*\/Form/.test(entryObjText)) {
      forms.set(tag, { objNum });
    }
  }

  return forms;
}

/**
 * Find the /Root (Catalog) object number from the PDF trailer.
 * @param {Uint8Array} pdfBytes
 */
export function findRootObjNum(pdfBytes) {
  const len = pdfBytes.length;
  const startxrefIdx = byteLastIndexOf(pdfBytes, 'startxref');
  if (startxrefIdx === -1) return null;

  const trailerIdx = byteLastIndexOf(pdfBytes, 'trailer', startxrefIdx);
  if (trailerIdx !== -1) {
    const trailerText = bytesToLatin1(pdfBytes, trailerIdx, startxrefIdx);
    const rootMatch = /\/Root\s+(\d+)\s+\d+\s+R/.exec(trailerText);
    if (rootMatch) return Number(rootMatch[1]);
  }

  // Parse digits after "startxref" to locate the xref dict (xref-stream form).
  let p = startxrefIdx + 9;
  while (p < len && isPdfWhitespace(pdfBytes[p])) p++;
  if (p < len && isAsciiDigit(pdfBytes[p])) {
    let xrefOffset = 0;
    while (p < len && isAsciiDigit(pdfBytes[p])) {
      xrefOffset = xrefOffset * 10 + (pdfBytes[p] - 0x30);
      p++;
    }
    const xrefDictEnd = Math.min(xrefOffset + 2000, len);
    if (xrefOffset < len) {
      const xrefDict = bytesToLatin1(pdfBytes, xrefOffset, xrefDictEnd);
      const rootMatch = /\/Root\s+(\d+)\s+\d+\s+R/.exec(xrefDict);
      if (rootMatch) return Number(rootMatch[1]);
    }
  }

  let searchIdx = 0;
  while (true) {
    const tIdx = byteIndexOf(pdfBytes, 'trailer', searchIdx);
    if (tIdx === -1) break;
    const trailerText = bytesToLatin1(pdfBytes, tIdx, Math.min(tIdx + 500, len));
    const rootMatch = /\/Root\s+(\d+)\s+\d+\s+R/.exec(trailerText);
    if (rootMatch) return Number(rootMatch[1]);
    searchIdx = tIdx + 7;
  }

  return null;
}

/**
 * Find the Catalog object and extract the /Pages reference.
 * @param {ObjectCache} objCache
 */
function findCatalogAndPages(objCache) {
  const catalogObjNum = findRootObjNum(objCache.pdfBytes);
  if (!catalogObjNum) throw new Error('Could not find PDF Catalog');

  const catalogText = objCache.getObjectText(catalogObjNum);
  if (!catalogText) throw new Error('Could not read Catalog object');

  const pagesRefMatch = /\/Pages\s+(\d+)\s+\d+\s+R/.exec(catalogText);
  if (pagesRefMatch) return { catalogObjNum, pagesRefMatch };

  for (const objNumStr of Object.keys(objCache.xrefEntries)) {
    const objNum = Number(objNumStr);
    if (objNum === catalogObjNum) continue;
    const t = objCache.getObjectText(objNum);
    if (t && /\/Type\s*\/Catalog/.test(t)) {
      const m = /\/Pages\s+(\d+)\s+\d+\s+R/.exec(t);
      if (m) return { catalogObjNum: objNum, pagesRefMatch: m };
    }
  }

  throw new Error('Could not find /Pages reference in Catalog');
}

/**
 * Extract the contents of the /Kids array from a /Pages tree node, handling
 * both inline (/Kids [...]) and indirect-reference (/Kids N 0 R) forms.
 *
 * @param {string} objText
 * @param {ObjectCache} objCache
 */
function getKidsArrayContent(objText, objCache) {
  const kidsKeyIdx = objText.indexOf('/Kids');
  if (kidsKeyIdx < 0) return null;
  const after = objText.substring(kidsKeyIdx + 5);
  const wsMatch = /^\s*/.exec(after);
  const leadWs = wsMatch ? wsMatch[0].length : 0;
  const firstChar = after.charAt(leadWs);
  let arrText = null;
  let bracketStart = -1;
  if (firstChar === '[') {
    arrText = objText;
    bracketStart = kidsKeyIdx + 5 + leadWs;
  } else {
    const refMatch = /^(\d+)\s+\d+\s+R/.exec(after.substring(leadWs));
    if (!refMatch) return null;
    const kidsObjText = objCache.getObjectText(Number(refMatch[1]));
    if (!kidsObjText) return null;
    arrText = kidsObjText;
    bracketStart = kidsObjText.indexOf('[');
    if (bracketStart < 0) return null;
  }
  let depth = 1;
  let ki = bracketStart + 1;
  while (ki < arrText.length && depth > 0) {
    if (arrText[ki] === '[') depth++;
    else if (arrText[ki] === ']') depth--;
    if (depth > 0) ki++;
  }
  return arrText.substring(bracketStart + 1, ki);
}

/**
 * Recursively collect leaf Page objects from the page tree.
 * @param {number} objNum
 * @param {ObjectCache} objCache
 * @param {number[]} inheritedMediaBox
 * @param {number} inheritedRotate
 * @param {string} inheritedResources
 * @param {Array<{ objNum: number, objText: string, mediaBox: number[], cropBox: number[]|null, rotate: number }>} pages
 */
function collectPages(objNum, objCache, inheritedMediaBox, inheritedRotate, inheritedResources, pages) {
  const objText = objCache.getObjectText(objNum);
  if (!objText) return;

  const mbMatch = /\/MediaBox\s*\[\s*([\d.+-]+)\s+([\d.+-]+)\s+([\d.+-]+)\s+([\d.+-]+)\s*\]/.exec(objText);
  let mediaBox;
  if (mbMatch) {
    mediaBox = [Number(mbMatch[1]), Number(mbMatch[2]), Number(mbMatch[3]), Number(mbMatch[4])];
  } else {
    const mbRefMatch = /\/MediaBox\s+(\d+)\s+\d+\s+R/.exec(objText);
    if (mbRefMatch) {
      const mbObjText = objCache.getObjectText(Number(mbRefMatch[1]));
      const mbArr = mbObjText && /\[\s*([\d.+-]+)\s+([\d.+-]+)\s+([\d.+-]+)\s+([\d.+-]+)\s*\]/.exec(mbObjText);
      mediaBox = mbArr
        ? [Number(mbArr[1]), Number(mbArr[2]), Number(mbArr[3]), Number(mbArr[4])]
        : inheritedMediaBox;
    } else {
      mediaBox = inheritedMediaBox;
    }
  }

  const hasRotate = /\/Rotate\s/.test(objText);
  const rotate = hasRotate ? ((resolveIntValue(objText, 'Rotate', objCache) % 360) + 360) % 360 : inheritedRotate;

  let resources = inheritedResources;
  const resInlineMatch = /\/Resources\s*<</.exec(objText);
  const resRefMatch = /\/Resources\s+\d+\s+\d+\s+R/.exec(objText);
  if (resInlineMatch || resRefMatch) {
    if (resRefMatch) {
      resources = resRefMatch[0];
    } else {
      const dictStart = resInlineMatch.index + resInlineMatch[0].length - 2;
      resources = `/Resources${extractDict(objText, dictStart)}`;
    }
  }

  if (/\/Type\s*\/Pages\b/.test(objText)) {
    const kidsContent = getKidsArrayContent(objText, objCache);
    if (kidsContent === null) return;

    if (/<</.test(kidsContent)) {
      let pos = 0;
      while (pos < kidsContent.length) {
        const dictIdx = kidsContent.indexOf('<<', pos);
        const refMatch = /(\d+)\s+\d+\s+R/.exec(kidsContent.substring(pos, dictIdx >= 0 ? dictIdx : undefined));
        if (refMatch && (dictIdx < 0 || pos + refMatch.index < dictIdx)) {
          collectPages(Number(refMatch[1]), objCache, mediaBox, rotate, resources, pages);
          pos += refMatch.index + refMatch[0].length;
        } else if (dictIdx >= 0) {
          const inlineDict = extractDict(kidsContent, dictIdx);
          let finalObjText = inlineDict;
          if (!/\/Resources/.test(finalObjText) && resources) {
            const lastClose = finalObjText.lastIndexOf('>>');
            if (lastClose >= 0) {
              finalObjText = finalObjText.substring(0, lastClose) + resources + finalObjText.substring(lastClose);
            }
          }
          const inlineMb = /\/MediaBox\s*\[\s*([\d.+-]+)\s+([\d.+-]+)\s+([\d.+-]+)\s+([\d.+-]+)\s*\]/.exec(finalObjText);
          const inlineMediaBox = inlineMb
            ? [Number(inlineMb[1]), Number(inlineMb[2]), Number(inlineMb[3]), Number(inlineMb[4])]
            : mediaBox;
          const inlineHasRot = /\/Rotate\s/.test(finalObjText);
          const inlineRotate = inlineHasRot ? ((resolveIntValue(finalObjText, 'Rotate', objCache) % 360) + 360) % 360 : rotate;
          pages.push({
            objNum: -1, objText: finalObjText, mediaBox: inlineMediaBox, cropBox: null, rotate: inlineRotate,
          });
          pos = dictIdx + inlineDict.length;
        } else {
          break;
        }
      }
    } else {
      const kidRefs = [...kidsContent.matchAll(/(\d+)\s+\d+\s+R/g)].map((m) => Number(m[1]));
      for (const kidNum of kidRefs) {
        collectPages(kidNum, objCache, mediaBox, rotate, resources, pages);
      }
    }
  } else {
    let finalObjText = objText;
    if (!resInlineMatch && !resRefMatch && resources) {
      const lastClose = finalObjText.lastIndexOf('>>');
      if (lastClose >= 0) {
        finalObjText = finalObjText.substring(0, lastClose) + resources + finalObjText.substring(lastClose);
      }
    }

    const cbMatch = /\/CropBox\s*\[\s*([\d.+-]+)\s+([\d.+-]+)\s+([\d.+-]+)\s+([\d.+-]+)\s*\]/.exec(finalObjText);
    let cropBox;
    if (cbMatch) {
      cropBox = [Number(cbMatch[1]), Number(cbMatch[2]), Number(cbMatch[3]), Number(cbMatch[4])];
    } else {
      const cbRefMatch = /\/CropBox\s+(\d+)\s+\d+\s+R/.exec(finalObjText);
      if (cbRefMatch) {
        const cbObjText = objCache.getObjectText(Number(cbRefMatch[1]));
        const cbArr = cbObjText && /\[\s*([\d.+-]+)\s+([\d.+-]+)\s+([\d.+-]+)\s+([\d.+-]+)\s*\]/.exec(cbObjText);
        cropBox = cbArr
          ? [Number(cbArr[1]), Number(cbArr[2]), Number(cbArr[3]), Number(cbArr[4])]
          : null;
      } else {
        cropBox = null;
      }
    }
    if (cropBox && (cropBox[0] < mediaBox[0] || cropBox[1] < mediaBox[1]
      || cropBox[2] > mediaBox[2] || cropBox[3] > mediaBox[3])) {
      cropBox = [
        Math.max(cropBox[0], mediaBox[0]),
        Math.max(cropBox[1], mediaBox[1]),
        Math.min(cropBox[2], mediaBox[2]),
        Math.min(cropBox[3], mediaBox[3]),
      ];
    }
    pages.push({
      objNum, objText: finalObjText, mediaBox, cropBox, rotate,
    });
  }
}

/**
 * Traverse PDF page tree and return ordered page objects with inherited MediaBox.
 * @param {ObjectCache} objCache
 */
export function getPageObjects(objCache) {
  const { pagesRefMatch } = findCatalogAndPages(objCache);
  const pages = [];
  collectPages(Number(pagesRefMatch[1]), objCache, [0, 0, 612, 792], 0, '', pages);
  return pages;
}

/**
 * Recursively collect all object numbers in the page tree.
 * @param {number} objNum
 * @param {ObjectCache} objCache
 * @param {Set<number>} nodeSet
 */
function collectPageTreeNodes(objNum, objCache, nodeSet) {
  const objText = objCache.getObjectText(objNum);
  if (!objText) return;
  if (/\/Type\s*\/Pages\b/.test(objText)) {
    const kidsContent = getKidsArrayContent(objText, objCache);
    if (kidsContent === null) return;
    const kidRefs = [...kidsContent.matchAll(/(\d+)\s+\d+\s+R/g)].map((m) => Number(m[1]));
    for (const kidNum of kidRefs) {
      nodeSet.add(kidNum);
      collectPageTreeNodes(kidNum, objCache, nodeSet);
    }
  }
}

/**
 * Traverse the page tree and collect all object numbers that are part of it.
 * @param {ObjectCache} objCache
 */
export function collectPageTreeObjNums(objCache) {
  const { catalogObjNum, pagesRefMatch } = findCatalogAndPages(objCache);
  const pagesRootObjNum = Number(pagesRefMatch[1]);
  /** @type {Set<number>} */
  const pageTreeObjNums = new Set([catalogObjNum, pagesRootObjNum]);
  collectPageTreeNodes(pagesRootObjNum, objCache, pageTreeObjNums);
  return { catalogObjNum, pagesRootObjNum, pageTreeObjNums };
}

/**
 * Get the content stream text for a page (handles single or array of content streams).
 * @param {string} pageObjText
 * @param {ObjectCache} objCache
 */
export function getPageContentStream(pageObjText, objCache) {
  const parts = getPageContentStreams(pageObjText, objCache);
  return parts && parts.length > 0 ? parts.join('\n') : null;
}

/**
 * Get the content streams for a page as an array (one entry per stream in /Contents).
 * @param {string} pageObjText
 * @param {ObjectCache} objCache
 */
export function getPageContentStreams(pageObjText, objCache) {
  const contentsArrayMatch = /\/Contents\s*\[([\s\S]*?)\]/.exec(pageObjText);
  const contentsSingleMatch = /\/Contents\s+(\d+)\s+\d+\s+R/.exec(pageObjText);

  if (contentsArrayMatch) {
    const refs = [...contentsArrayMatch[1].matchAll(/(\d+)\s+\d+\s+R/g)].map((m) => Number(m[1]));
    const parts = [];
    for (const ref of refs) {
      let bytes;
      try {
        bytes = objCache.getStreamBytes(ref);
      } catch (e) {
        console.warn(`getPageContentStreams: skipping corrupt content stream obj ${ref}: ${e.message}`);
        continue;
      }
      if (bytes) parts.push(bytesToLatin1(bytes));
      else console.warn(`getPageContentStreams: content stream obj ${ref} decoded to no bytes; page content may be incomplete`);
    }
    return parts.length > 0 ? parts : null;
  } if (contentsSingleMatch) {
    const objNum = Number(contentsSingleMatch[1]);
    const objText = objCache.getObjectText(objNum);
    if (objText) {
      const arrayContentMatch = /^\s*\[([\s\S]*)\]\s*$/.exec(objText);
      if (arrayContentMatch) {
        const refs = [...arrayContentMatch[1].matchAll(/(\d+)\s+\d+\s+R/g)].map((m) => Number(m[1]));
        const parts = [];
        for (const ref of refs) {
          const bytes = objCache.getStreamBytes(ref);
          if (bytes) parts.push(bytesToLatin1(bytes));
        }
        return parts.length > 0 ? parts : null;
      }
    }
    const bytes = objCache.getStreamBytes(objNum);
    return bytes ? [bytesToLatin1(bytes)] : null;
  }

  return null;
}

/**
 * @typedef {(
 *   { type: 'number', value: number } |
 *   { type: 'name', value: string } |
 *   { type: 'string', value: string } |
 *   { type: 'hexstring', value: string } |
 *   { type: 'array', value: Array<{ type: string, value: any }> } |
 *   { type: 'operator', value: string } |
 *   { type: 'inlineImage', value: { dictText: string, imageData: string } }
 * )} PDFToken
 */

/** All valid PDF content stream operators (PDF Reference 1.7, Table A.1). */
const PDF_CONTENT_OPERATORS = new Set([
  'w', 'J', 'j', 'M', 'd', 'ri', 'i', 'gs',
  'q', 'Q', 'cm',
  'm', 'l', 'c', 'v', 'y', 'h', 're',
  'S', 's', 'f', 'F', 'f*', 'B', 'B*', 'b', 'b*', 'n',
  'W', 'W*',
  'BT', 'ET',
  'Tc', 'Tw', 'Tz', 'TL', 'Tf', 'Tr', 'Ts',
  'Td', 'TD', 'Tm', 'T*',
  'Tj', 'TJ', "'", '"',
  'd0', 'd1',
  'CS', 'cs', 'SC', 'SCN', 'sc', 'scn', 'G', 'g', 'RG', 'rg', 'K', 'k',
  'sh',
  'BI', 'ID', 'EI',
  'Do',
  'MP', 'DP', 'BMC', 'BDC', 'EMC',
  'BX', 'EX',
]);

// Character classification tables for the tokenizer. Indexed by charCode (0-255).
const TOK_WS = new Uint8Array(256);
const TOK_NAME_DELIM = new Uint8Array(256); // whitespace + /<>[](){}%
const TOK_DIGIT = new Uint8Array(256);
const TOK_OCTAL = new Uint8Array(256);
const TOK_NUM_START = new Uint8Array(256); // digit . + -
const TOK_OP_CHAR = new Uint8Array(256); // a-zA-Z'"*
const TOK_WS_OR_SLASH = new Uint8Array(256); // whitespace + /
for (const c of [0, 9, 10, 12, 13, 32]) TOK_WS[c] = 1;
for (let c = 0; c < 256; c++) if (TOK_WS[c]) { TOK_NAME_DELIM[c] = 1; TOK_WS_OR_SLASH[c] = 1; }
for (const c of [0x2F, 0x3C, 0x3E, 0x5B, 0x5D, 0x28, 0x29, 0x7B, 0x7D, 0x25]) TOK_NAME_DELIM[c] = 1;
TOK_WS_OR_SLASH[0x2F] = 1;
for (let c = 0x30; c <= 0x39; c++) { TOK_DIGIT[c] = 1; TOK_NUM_START[c] = 1; }
for (let c = 0x30; c <= 0x37; c++) TOK_OCTAL[c] = 1;
TOK_NUM_START[0x2E] = 1; TOK_NUM_START[0x2B] = 1; TOK_NUM_START[0x2D] = 1;
for (let c = 0x41; c <= 0x5A; c++) TOK_OP_CHAR[c] = 1;
for (let c = 0x61; c <= 0x7A; c++) TOK_OP_CHAR[c] = 1;
TOK_OP_CHAR[0x27] = 1; TOK_OP_CHAR[0x22] = 1; TOK_OP_CHAR[0x2A] = 1;

/**
 * Tokenize a PDF content stream into tokens.
 * @param {string} streamText
 * @returns {Array<PDFToken>}
 */
export function tokenizeContentStream(streamText) {
  const tokens = /** @type {Array<PDFToken>} */ ([]);
  let i = 0;
  const len = streamText.length;

  while (i < len) {
    const cc = streamText.charCodeAt(i);

    if (TOK_WS[cc]) { i++; continue; }

    if (cc === 0x25) { // %
      while (i < len) {
        const c2 = streamText.charCodeAt(i);
        if (c2 === 0x0A || c2 === 0x0D) break;
        i++;
      }
      continue;
    }

    if (cc === 0x2F) { // /
      i++;
      const nameStart = i;
      while (i < len && !TOK_NAME_DELIM[streamText.charCodeAt(i)]) i++;
      tokens.push({ type: 'name', value: streamText.slice(nameStart, i) });
      continue;
    }

    if (cc === 0x3C) { // <
      if (i + 1 < len && streamText.charCodeAt(i + 1) === 0x3C) {
        // Dict <<...>> — skip without emitting
        i += 2;
        let depth = 1;
        while (i < len && depth > 0) {
          const dc = streamText.charCodeAt(i);
          if (dc === 0x3C && i + 1 < len && streamText.charCodeAt(i + 1) === 0x3C) {
            depth++;
            i += 2;
          } else if (dc === 0x3E && i + 1 < len && streamText.charCodeAt(i + 1) === 0x3E) {
            depth--;
            i += 2;
          } else {
            i++;
          }
        }
        continue;
      }
      i++;
      let hex = '';
      while (i < len && streamText.charCodeAt(i) !== 0x3E) {
        if (!TOK_WS[streamText.charCodeAt(i)]) hex += streamText[i];
        i++;
      }
      i++;
      tokens.push({ type: 'hexstring', value: hex });
      continue;
    }

    if (cc === 0x28) { // (
      i++;
      let str = '';
      let depth = 1;
      while (i < len && depth > 0) {
        const sc = streamText.charCodeAt(i);
        if (sc === 0x5C) { // backslash
          i++;
          if (i >= len) break;
          const ec = streamText.charCodeAt(i);
          if (ec === 0x6E) str += '\n';
          else if (ec === 0x72) str += '\r';
          else if (ec === 0x74) str += '\t';
          else if (ec === 0x62) str += '\b';
          else if (ec === 0x66) str += '\f';
          else if (ec === 0x28 || ec === 0x29 || ec === 0x5C) str += streamText[i];
          else if (ec === 0x0D) {
            if (i + 1 < len && streamText.charCodeAt(i + 1) === 0x0A) i++;
          } else if (ec === 0x0A) {
            /* line continuation */
          } else if (TOK_OCTAL[ec]) {
            let val = ec - 0x30;
            if (i + 1 < len && TOK_OCTAL[streamText.charCodeAt(i + 1)]) {
              i++;
              val = val * 8 + (streamText.charCodeAt(i) - 0x30);
              if (i + 1 < len && TOK_OCTAL[streamText.charCodeAt(i + 1)]) {
                i++;
                val = val * 8 + (streamText.charCodeAt(i) - 0x30);
              }
            }
            str += String.fromCharCode(val);
          } else {
            str += streamText[i];
          }
          i++;
        } else if (sc === 0x28) {
          depth++; str += '('; i++;
        } else if (sc === 0x29) {
          depth--;
          if (depth > 0) str += ')';
          i++;
        } else {
          str += streamText[i];
          i++;
        }
      }
      tokens.push({ type: 'string', value: str });
      continue;
    }

    if (cc === 0x5B) { // [
      i++;
      const arrTokens = [];
      while (i < len) {
        const ac = streamText.charCodeAt(i);
        if (ac === 0x5D) { i++; break; }
        if (TOK_WS[ac]) { i++; continue; }
        if (ac === 0x3C && (i + 1 >= len || streamText.charCodeAt(i + 1) !== 0x3C)) {
          i++;
          let hex = '';
          while (i < len && streamText.charCodeAt(i) !== 0x3E) {
            if (!TOK_WS[streamText.charCodeAt(i)]) hex += streamText[i];
            i++;
          }
          i++;
          arrTokens.push({ type: 'hexstring', value: hex });
          continue;
        }
        if (ac === 0x28) {
          i++;
          let str = '';
          let d = 1;
          while (i < len && d > 0) {
            const sc = streamText.charCodeAt(i);
            if (sc === 0x5C) {
              i++;
              if (i >= len) break;
              const ec = streamText.charCodeAt(i);
              if (ec === 0x6E) str += '\n';
              else if (ec === 0x72) str += '\r';
              else if (ec === 0x74) str += '\t';
              else if (ec === 0x62) str += '\b';
              else if (ec === 0x66) str += '\f';
              else if (ec === 0x28 || ec === 0x29 || ec === 0x5C) str += streamText[i];
              else if (ec === 0x0D) { if (i + 1 < len && streamText.charCodeAt(i + 1) === 0x0A) i++; } else if (ec === 0x0A) { /* line continuation */ } else if (TOK_OCTAL[ec]) {
                let val = ec - 0x30;
                if (i + 1 < len && TOK_OCTAL[streamText.charCodeAt(i + 1)]) {
                  i++;
                  val = val * 8 + (streamText.charCodeAt(i) - 0x30);
                  if (i + 1 < len && TOK_OCTAL[streamText.charCodeAt(i + 1)]) {
                    i++;
                    val = val * 8 + (streamText.charCodeAt(i) - 0x30);
                  }
                }
                str += String.fromCharCode(val);
              } else {
                str += streamText[i];
              }
              i++;
            } else if (sc === 0x28) { d++; str += '('; i++; } else if (sc === 0x29) { d--; if (d > 0) str += ')'; i++; } else { str += streamText[i]; i++; }
          }
          arrTokens.push({ type: 'string', value: str });
          continue;
        }
        if (TOK_NUM_START[ac]) {
          const nstart = i;
          let hasDot = false;
          while (i < len) {
            const nc = streamText.charCodeAt(i);
            if (nc === 0x2E) { if (hasDot) break; hasDot = true; } else if (nc === 0x2B || nc === 0x2D) { if (i > nstart) break; } else if (!TOK_DIGIT[nc]) { break; }
            i++;
          }
          const nv = Number(streamText.slice(nstart, i));
          arrTokens.push({ type: 'number', value: Number.isFinite(nv) ? nv : 0 });
          continue;
        }
        i++;
      }
      tokens.push({ type: 'array', value: arrTokens });
      continue;
    }

    if (TOK_NUM_START[cc]) {
      const nstart = i;
      let hasDot = false;
      while (i < len) {
        const nc = streamText.charCodeAt(i);
        if (nc === 0x2E) { if (hasDot) break; hasDot = true; } else if (nc === 0x2B || nc === 0x2D) { if (i > nstart) break; } else if (!TOK_DIGIT[nc]) { break; }
        i++;
      }
      const nv = Number(streamText.slice(nstart, i));
      tokens.push({ type: 'number', value: Number.isFinite(nv) ? nv : 0 });
      continue;
    }

    if (TOK_OP_CHAR[cc]) {
      // Inline image BI ... ID ... EI
      if (cc === 0x42 && i + 1 < len && streamText.charCodeAt(i + 1) === 0x49
          && (i + 2 >= len || TOK_WS_OR_SLASH[streamText.charCodeAt(i + 2)])) {
        i += 2;
        let dictText = '';
        while (i < len) {
          const dc = streamText.charCodeAt(i);
          if (dc === 0x49 && i + 1 < len && streamText.charCodeAt(i + 1) === 0x44
              && (i === 0 || TOK_WS[streamText.charCodeAt(i - 1)])
              && i + 2 < len && TOK_WS[streamText.charCodeAt(i + 2)]) {
            i += 3;
            break;
          }
          dictText += streamText[i];
          i++;
        }
        const dataStart = i;
        while (i < len) {
          const ec = streamText.charCodeAt(i);
          if (ec === 0x45 && i + 1 < len && streamText.charCodeAt(i + 1) === 0x49
              && i > dataStart && TOK_WS[streamText.charCodeAt(i - 1)]
              && (i + 2 >= len || TOK_WS_OR_SLASH[streamText.charCodeAt(i + 2)])) {
            break;
          }
          i++;
        }
        const imageData = streamText.substring(dataStart, i > dataStart ? i - 1 : i);
        i += 2;
        tokens.push({ type: 'inlineImage', value: { dictText: dictText.trim(), imageData } });
        continue;
      }

      // 3-char operator (letters only)
      if (i + 2 < len) {
        const c2 = streamText.charCodeAt(i + 1);
        const c3 = streamText.charCodeAt(i + 2);
        if (TOK_OP_CHAR[c2] && TOK_OP_CHAR[c3]) {
          const op3 = streamText.slice(i, i + 3);
          if (PDF_CONTENT_OPERATORS.has(op3)) {
            tokens.push({ type: 'operator', value: op3 });
            i += 3;
            continue;
          }
        }
      }
      // 2-char operator (second char may be digit for d0/d1)
      if (i + 1 < len) {
        const c2 = streamText.charCodeAt(i + 1);
        if (TOK_OP_CHAR[c2] || TOK_DIGIT[c2]) {
          const op2 = streamText.slice(i, i + 2);
          if (PDF_CONTENT_OPERATORS.has(op2)) {
            tokens.push({ type: 'operator', value: op2 });
            i += 2;
            continue;
          }
        }
      }
      // 1-char operator
      tokens.push({ type: 'operator', value: streamText[i] });
      i++;
      continue;
    }

    i++;
  }

  return tokens;
}
