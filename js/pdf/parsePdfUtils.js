import { decodePNGPredictor } from './codecs/decodePNG.js';
import { decodeLZW } from './codecs/decodeLZW.js';
import { decodeCCITTFax } from './codecs/decodeCCITT.js';
import { decodeJBIG2 } from './codecs/decodeJBIG2.js';
import { inflate as pakoInflate, inflatePartial as pakoInflatePartial } from '../../lib/pako-inflate.js';
import { aesDecrypt, computeObjectKey, rc4 } from './pdfCrypto.js';
import {
  byteIndexOf, byteLastIndexOf, bytesEqualAt, bytesToLatin1, extractDict, extractDictFromBytes,
  findTopLevelKeyIndex, isAsciiDigit, isPdfWhitespace, matchesBareXrefEntry, matchesObjHeader,
  objTextEnd, readInt, resolveBoolValue, resolveIntValue,
} from './pdfPrimitives.js';

/** @typedef {import('./objectCache.js').ObjectCache} ObjectCache */

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
        // Some producers write startxref values that are off by a few bytes relative to the actual xref keyword.
        // Snap to a nearby `xref` keyword before falling back to a whole-file scan,
        // which on a linearized PDF would land on the secondary xref at end-of-file (whose trailer is incomplete).
        // Accept any PDF whitespace before the keyword (not just newline) — the next byte before the
        // wrongly-pointed offset is sometimes a space.
        const windowStart = Math.max(0, offset - 16);
        const windowEnd = Math.min(len, offset + 16);
        /** @param {number} p */
        const looksLikeXrefStart = (p) => bytesEqualAt(pdfBytes, p, 'xref') && (p === 0 || isPdfWhitespace(pdfBytes[p - 1]));
        /** @param {number} p */
        const looksLikeStreamStart = (p) => matchesObjHeader(pdfBytes, p) && (p === 0 || isPdfWhitespace(pdfBytes[p - 1]));
        for (let p = offset; p >= windowStart; p--) {
          if (looksLikeXrefStart(p)) return p;
        }
        for (let p = offset + 1; p < windowEnd; p++) {
          if (looksLikeXrefStart(p)) return p;
        }
        for (let p = offset; p >= windowStart; p--) {
          if (looksLikeStreamStart(p)) return p;
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
 * Returns true if the final `startxref` value points exactly at an `xref` keyword or
 * an xref-stream object header. False if it's off-by-N, points into junk, or absent.
 * @param {Uint8Array} pdfBytes
 */
export function sourceXrefIsWellFormed(pdfBytes) {
  const sx = byteLastIndexOf(pdfBytes, 'startxref');
  if (sx === -1) return false;
  let p = sx + 9;
  while (p < pdfBytes.length && isPdfWhitespace(pdfBytes[p])) p++;
  let num = 0;
  let hasDigit = false;
  while (p < pdfBytes.length && isAsciiDigit(pdfBytes[p])) {
    num = num * 10 + (pdfBytes[p] - 0x30);
    p++;
    hasDigit = true;
  }
  if (!hasDigit) return false;
  const headerOff = byteIndexOf(pdfBytes, '%PDF');
  const declared = num + (headerOff > 0 ? headerOff : 0);
  let chk = declared;
  while (chk < pdfBytes.length && isPdfWhitespace(pdfBytes[chk])) chk++;
  if (chk >= pdfBytes.length) return false;
  if (bytesEqualAt(pdfBytes, chk, 'xref')) return true;
  // Xref stream: starts with "<digits> <digits> obj"
  let q = chk;
  while (q < pdfBytes.length && isAsciiDigit(pdfBytes[q])) q++;
  if (q > chk && pdfBytes[q] === 0x20) {
    let r = q + 1;
    while (r < pdfBytes.length && isAsciiDigit(pdfBytes[r])) r++;
    if (r > q + 1 && pdfBytes[r] === 0x20 && bytesEqualAt(pdfBytes, r + 1, 'obj')) return true;
  }
  return false;
}

/**
 * Parse xref table/stream to get object positions.
 * @param {Uint8Array} pdfBytes
 * @param {number} xrefOffset
 * @returns {{ [objNum: number]: { type: number, offset?: number, gen?: number, objStmNum?: number, indexInStm?: number } }}
 */
export function parseXref(pdfBytes, xrefOffset) {
  /** @type {{ [objNum: number]: { type: number, offset?: number, gen?: number, objStmNum?: number, indexInStm?: number } }} */
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
        if (!entryMatch) continue;
        // Newer xref sections (processed first) take precedence — including
        // free entries, since incremental updates that *delete* an obj must
        // shadow that obj's earlier in-use entry rather than be discarded.
        const objNum = startObj + j;
        if (entries[objNum]) continue;
        if (entryMatch[3] === 'n') {
          entries[objNum] = { type: 1, offset: Number(entryMatch[1]), gen: Number(entryMatch[2]) };
        } else {
          entries[objNum] = { type: 0, gen: Number(entryMatch[2]) };
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
    if (entryMatch && !entries[objNum]) {
      if (entryMatch[3] === 'n') {
        entries[objNum] = { type: 1, offset: Number(entryMatch[1]), gen: Number(entryMatch[2]) };
      } else {
        entries[objNum] = { type: 0, gen: Number(entryMatch[2]) };
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
          // Cross-reference stream: field3 is the generation number for type-1 entries.
          entries[objNum] = { type: 1, offset: field2, gen: field3 };
        } else if (type === 2) {
          // Objects in an ObjStm always have generation 0 by spec.
          entries[objNum] = {
            type: 2, objStmNum: field2, indexInStm: field3, gen: 0,
          };
        }
      }
      // type 0 = free entry, skip
    }
  }

  const prevMatch = /\/Prev\s+(\d+)/.exec(dictText);
  return prevMatch ? Number(prevMatch[1]) : null;
}

/**
 * Decompress zlib-wrapped deflate data using pako.
 * Throws on any error — callers are expected to catch and handle
 * (e.g. retry without trailing byte, or return null for encrypted streams).
 * @param {Uint8Array} data - zlib-wrapped deflate data
 * @param {{recovered?: boolean}} [meta] - set `recovered=true` if output was salvaged from a stream that errored mid-way
 */
export function inflate(data, meta) {
  const result = pakoInflate(data, meta);
  // Pako returns undefined (without throwing) for truncated streams where it
  // processes valid blocks but never reaches end-of-stream. Treat as failure.
  if (!(result instanceof Uint8Array)) throw new Error('inflate: no output');
  return result;
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
export function extractRawStreamBytes(pdfBytes, objOffset, encryptionKey, encryptObjNum, cipherMode, objNum) {
  // Bound the per-object scan: locate endobj first, then materialize only the dictionary as a string for the existing dict-text parsing logic.
  const len = pdfBytes.length;
  let objEnd = byteIndexOf(pdfBytes, 'endobj', objOffset);
  if (objEnd === -1) objEnd = Math.min(objOffset + 100000, len);
  const objText = bytesToLatin1(pdfBytes, objOffset, objTextEnd(pdfBytes, objOffset, objEnd));

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

  // PDF spec permits 0/1/2 EOL bytes between stream data and `endstream`; trust
  // /Length when it matches any of those, otherwise fall back to the endstream position.
  const endstreamIdx = byteIndexOf(pdfBytes, 'endstream', objOffset + streamKeyword);
  if (endstreamIdx !== -1) {
    const expectedEnd = streamStart + streamLength;
    const consistent = endstreamIdx === expectedEnd
      || (endstreamIdx === expectedEnd + 1
          && (pdfBytes[expectedEnd] === 0x0A || pdfBytes[expectedEnd] === 0x0D))
      || (endstreamIdx === expectedEnd + 2
          && pdfBytes[expectedEnd] === 0x0D && pdfBytes[expectedEnd + 1] === 0x0A);
    if (!consistent) {
      let actualEnd = endstreamIdx;
      if (actualEnd >= 2 && pdfBytes[actualEnd - 2] === 0x0D && pdfBytes[actualEnd - 1] === 0x0A) {
        actualEnd -= 2;
      } else if (actualEnd >= 1 && (pdfBytes[actualEnd - 1] === 0x0A || pdfBytes[actualEnd - 1] === 0x0D)) {
        actualEnd -= 1;
      }
      data = pdfBytes.slice(streamStart, actualEnd);
    }
  }

  // Decrypt stream data if the PDF is encrypted (applied before decompression filters).
  // The object key derives from (objNum, gen, fileKey); read the generation from the
  // "<n> <gen> obj" header at objOffset so streams with gen != 0 (common in linearised
  // and incrementally-updated PDFs) decrypt with the right key.
  if (encryptionKey && objNum >= 0 && objNum !== encryptObjNum) {
    const headerMatch = /^\s*\d+\s+(\d+)\s+obj/.exec(objText);
    const genNum = headerMatch ? Number(headerMatch[1]) : 0;
    if (cipherMode === 'AESV3') {
      data = aesDecrypt(encryptionKey, data);
    } else if (cipherMode === 'AESV2') {
      const objKey = computeObjectKey(encryptionKey, objNum, genNum, true);
      data = aesDecrypt(objKey, data);
    } else {
      const objKey = computeObjectKey(encryptionKey, objNum, genNum, false);
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
  let filters;
  if (filterArrayMatch) {
    filters = [];
    for (const tm of filterArrayMatch[1].matchAll(/\/([^\s/<>[\]]+)|(\d+)\s+\d+\s+R/g)) {
      if (tm[1]) {
        filters.push(tm[1]);
      } else if (objCache) {
        const refObjText = objCache.getObjectText(Number(tm[2]));
        if (refObjText) {
          const refResolved = refObjText.replace(/^\d+\s+\d+\s+obj\s*/, '').replace(/\s*endobj.*$/, '').trim();
          const refNameMatch = /^\/([^\s/<>[\]]+)/.exec(refResolved);
          if (refNameMatch) filters.push(refNameMatch[1]);
        }
      }
    }
  } else {
    filters = filterSingleMatch ? [filterSingleMatch[1]] : [];
  }

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
    let filter = filters[fi];
    const dpText = decodeParmsList[fi] || '';
    // PDF spec Annex H defines short filter names for inline images.
    // Many PDFs also use them in regular streams.
    const filterAlias = {
      AHx: 'ASCIIHexDecode',
      A85: 'ASCII85Decode',
      LZW: 'LZWDecode',
      Fl: 'FlateDecode',
      RL: 'RunLengthDecode',
      CCF: 'CCITTFaxDecode',
      DCT: 'DCTDecode',
    };
    if (filterAlias[filter]) filter = filterAlias[filter];
    if (objCache) objCache.filtersUsed.add(filter);

    if (filter === 'FlateDecode') {
      /** @type {{recovered?: boolean}} */
      const inflateMeta = {};
      try {
        data = inflate(data, inflateMeta);
      } catch (e1) {
        try {
          data = inflate(data.slice(0, -1), inflateMeta);
        } catch (e2) {
          // Both attempts failed — try partial recovery for corrupted streams
          data = pakoInflatePartial(data, inflateMeta);
          if (data.length === 0) return null;
        }
      }
      if (inflateMeta.recovered && objCache && objNum >= 0) objCache.recoveredStreamObjs.add(objNum);
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

      // Decode straight into a typed array. Sized for the common case (4 bytes per 5-char group).
      // A 'z' shorthand expands 1 char to 4 bytes, so grow on the rare overflow.
      let output = new Uint8Array(Math.ceil(encoded.length / 5) * 4);
      let outLen = 0;
      let ai = 0;
      while (ai < encoded.length) {
        if (outLen + 4 > output.length) {
          const grown = new Uint8Array(output.length * 2);
          grown.set(output.subarray(0, outLen));
          output = grown;
        }
        if (encoded[ai] === 'z') {
          output[outLen++] = 0;
          output[outLen++] = 0;
          output[outLen++] = 0;
          output[outLen++] = 0;
          ai++;
        } else {
          const groupLen = Math.min(5, encoded.length - ai);
          let val = 0;
          for (let j = 0; j < 5; j++) {
            val = val * 85 + (j < groupLen ? encoded.charCodeAt(ai + j) - 33 : 84);
          }
          // Extract bytes big-endian. Use division instead of bitwise
          // to handle partial groups where val may exceed 2^32.
          const numBytes = groupLen === 5 ? 4 : groupLen - 1;
          if (numBytes > 0) output[outLen++] = Math.floor(val / 16777216) % 256;
          if (numBytes > 1) output[outLen++] = Math.floor(val / 65536) % 256;
          if (numBytes > 2) output[outLen++] = Math.floor(val / 256) % 256;
          if (numBytes > 3) output[outLen++] = val % 256;
          ai += groupLen;
        }
      }
      data = outLen === output.length ? output : output.slice(0, outLen);
    } else if (filter === 'LZWDecode' || filter === 'LZW') {
      data = decodeLZW(data, dpText);
      data = applyPredictor(data, dpText, objCache);
    } else if (filter === 'RunLengthDecode' || filter === 'RL') {
      // Decode into a growable typed array (output size is unknown a priori).
      // Each packet emits at most 128 bytes. Literal runs are bulk-copied and repeats bulk-filled.
      let output = new Uint8Array(Math.max(128, data.length * 2));
      let outLen = 0;
      let pos = 0;
      while (pos < data.length) {
        const len = data[pos++];
        if (len === 128) break; // EOD
        let count;
        let runVal = -1;
        if (len < 128) {
          count = Math.min(len + 1, data.length - pos); // copy len+1 literal bytes
        } else {
          runVal = pos < data.length ? data[pos++] : 0; // repeat the next byte 257-len times
          count = 257 - len;
        }
        if (outLen + count > output.length) {
          let cap = output.length;
          while (cap < outLen + count) cap *= 2;
          const grown = new Uint8Array(cap);
          grown.set(output.subarray(0, outLen));
          output = grown;
        }
        if (runVal < 0) {
          output.set(data.subarray(pos, pos + count), outLen);
          pos += count;
        } else {
          output.fill(runVal, outLen, outLen + count);
        }
        outLen += count;
      }
      data = outLen === output.length ? output : output.slice(0, outLen);
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
 * Read a Form XObject's own /Matrix.
 * Matches only the dict's top-level /Matrix, not one nested in the form's /Resources (e.g. a shading pattern's matrix).
 * @param {string} objText - the form or appearance dict text
 */
export function parseFormMatrix(objText) {
  for (let i = 0, depth = 0; i < objText.length - 1; i++) {
    const c2 = objText[i] + objText[i + 1];
    if (c2 === '<<') {
      depth += 1;
      i += 1;
    } else if (c2 === '>>') {
      depth -= 1;
      i += 1;
    } else if (depth === 1 && objText.startsWith('/Matrix', i)) {
      const m = /\/Matrix\s*\[\s*([\d.\seE+-]+)\]/.exec(objText.slice(i));
      if (m) {
        const parsed = m[1].trim().split(/\s+/).map(Number);
        if (parsed.length === 6 && parsed.every((n) => Number.isFinite(n))) return parsed;
      }
      break;
    }
  }
  return null;
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
    if (xrefOffset < len) {
      const headerOff = byteIndexOf(pdfBytes, '%PDF');
      const adjusted = xrefOffset + (headerOff > 0 ? headerOff : 0);
      const headerEnd = Math.min(adjusted + 200, len);
      let dictStart = -1;
      for (let i = adjusted; i < headerEnd - 1; i++) {
        if (pdfBytes[i] === 0x3C && pdfBytes[i + 1] === 0x3C) { dictStart = i; break; }
      }
      if (dictStart !== -1) {
        const dictText = extractDictFromBytes(pdfBytes, dictStart);
        const rootMatch = /\/Root\s+(\d+)\s+\d+\s+R/.exec(dictText);
        if (rootMatch) return Number(rootMatch[1]);
      }
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
 * Resolve the catalog's top-level `/Pages` page-tree-root reference.
 * @param {string} catalogText
 * @returns {RegExpExecArray|null}
 */
function matchPagesRootRef(catalogText) {
  const dictStart = catalogText.indexOf('<<');
  if (dictStart < 0) return null;
  // A Catalog's /Names dict can hold its own /Pages name tree distinct from the page-tree root,
  // so resolve /Pages at the catalog's top level only.
  const body = extractDict(catalogText, dictStart).slice(2, -2);
  const idx = findTopLevelKeyIndex(body, '/Pages');
  if (idx < 0) return null;
  return /^\/Pages\s+(\d+)\s+\d+\s+R/.exec(body.slice(idx));
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

  const pagesRefMatch = matchPagesRootRef(catalogText);
  if (pagesRefMatch) return { catalogObjNum, pagesRefMatch };

  // The named Catalog had no /Pages reference.
  // Force any deferred xref repair so the search for an alternate Catalog below iterates the complete object set.
  objCache.ensureXrefRepaired();
  for (const objNumStr of Object.keys(objCache.xrefEntries)) {
    const objNum = Number(objNumStr);
    if (objNum === catalogObjNum) continue;
    const t = objCache.getObjectText(objNum);
    if (t && /\/Type\s*\/Catalog/.test(t)) {
      const m = matchPagesRootRef(t);
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
 * @param {number[]|null} inheritedCropBox
 * @param {number} inheritedRotate
 * @param {string} inheritedResources
 * @param {Array<{ objNum: number, objText: string, mediaBox: number[], cropBox: number[]|null, rotate: number }>} pages
 */
function collectPages(objNum, objCache, inheritedMediaBox, inheritedCropBox, inheritedRotate, inheritedResources, pages) {
  const objText = objCache.getObjectText(objNum);
  if (!objText) {
    console.warn(`collectPages: skipping page-tree ref ${objNum} — object not found, document may be truncated`);
    return;
  }

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

  const cbMatchAny = /\/CropBox\s*\[\s*([\d.+-]+)\s+([\d.+-]+)\s+([\d.+-]+)\s+([\d.+-]+)\s*\]/.exec(objText);
  let cropBoxResolved = inheritedCropBox;
  if (cbMatchAny) {
    cropBoxResolved = [Number(cbMatchAny[1]), Number(cbMatchAny[2]), Number(cbMatchAny[3]), Number(cbMatchAny[4])];
  } else {
    const cbRefMatchAny = /\/CropBox\s+(\d+)\s+\d+\s+R/.exec(objText);
    if (cbRefMatchAny) {
      const cbObjText = objCache.getObjectText(Number(cbRefMatchAny[1]));
      const cbArr = cbObjText && /\[\s*([\d.+-]+)\s+([\d.+-]+)\s+([\d.+-]+)\s+([\d.+-]+)\s*\]/.exec(cbObjText);
      if (cbArr) cropBoxResolved = [Number(cbArr[1]), Number(cbArr[2]), Number(cbArr[3]), Number(cbArr[4])];
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

  const looksLikePagesNode = /\/Type\s*\/Pages\b/.test(objText)
    || (/\/Kids\s*[\[<]/.test(objText) && !/\/Type\s*\/Page\b(?!s)/.test(objText));
  if (looksLikePagesNode) {
    const kidsContent = getKidsArrayContent(objText, objCache);
    if (kidsContent === null) return;

    if (/<</.test(kidsContent)) {
      let pos = 0;
      while (pos < kidsContent.length) {
        const dictIdx = kidsContent.indexOf('<<', pos);
        const refMatch = /(\d+)\s+\d+\s+R/.exec(kidsContent.substring(pos, dictIdx >= 0 ? dictIdx : undefined));
        if (refMatch && (dictIdx < 0 || pos + refMatch.index < dictIdx)) {
          collectPages(Number(refMatch[1]), objCache, mediaBox, cropBoxResolved, rotate, resources, pages);
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
          const inlineCb = /\/CropBox\s*\[\s*([\d.+-]+)\s+([\d.+-]+)\s+([\d.+-]+)\s+([\d.+-]+)\s*\]/.exec(finalObjText);
          let inlineCropBox = inlineCb
            ? [Number(inlineCb[1]), Number(inlineCb[2]), Number(inlineCb[3]), Number(inlineCb[4])]
            : cropBoxResolved;
          if (inlineCropBox && (inlineCropBox[0] < inlineMediaBox[0] || inlineCropBox[1] < inlineMediaBox[1]
            || inlineCropBox[2] > inlineMediaBox[2] || inlineCropBox[3] > inlineMediaBox[3])) {
            inlineCropBox = [
              Math.max(inlineCropBox[0], inlineMediaBox[0]),
              Math.max(inlineCropBox[1], inlineMediaBox[1]),
              Math.min(inlineCropBox[2], inlineMediaBox[2]),
              Math.min(inlineCropBox[3], inlineMediaBox[3]),
            ];
          }
          const inlineHasRot = /\/Rotate\s/.test(finalObjText);
          const inlineRotate = inlineHasRot ? ((resolveIntValue(finalObjText, 'Rotate', objCache) % 360) + 360) % 360 : rotate;
          pages.push({
            objNum: -1, objText: finalObjText, mediaBox: inlineMediaBox, cropBox: inlineCropBox, rotate: inlineRotate,
          });
          pos = dictIdx + inlineDict.length;
        } else {
          break;
        }
      }
    } else {
      const kidRefs = [...kidsContent.matchAll(/(\d+)\s+\d+\s+R/g)].map((m) => Number(m[1]));
      for (const kidNum of kidRefs) {
        collectPages(kidNum, objCache, mediaBox, cropBoxResolved, rotate, resources, pages);
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

    let cropBox = cropBoxResolved;
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
  /** @type {Array<{objNum: number, objText: string, mediaBox: number[], cropBox: number[]|null, rotate: number}>} */
  const pages = [];
  const pagesRootObjNum = Number(pagesRefMatch[1]);
  collectPages(pagesRootObjNum, objCache, [0, 0, 612, 792], null, 0, '', pages);
  // Recover orphan /Type/Page objects parented directly at the pages root,
  // since producers occasionally append a page without updating /Kids.
  // Orphans parented at intermediate /Pages nodes are excluded —
  // those are usually deliberately unlinked old pages.
  // Only run recovery when /Kids traversal under-delivers vs the declared /Count.
  // A self-consistent tree (collected == declared count) can still
  // have orphan Page objects pointing at the root, but those are stale and
  // must not be re-included.
  const pagesRootText = objCache.getObjectText(pagesRootObjNum) || '';
  const countMatch = /\/Count\s+(\d+)/.exec(pagesRootText);
  const declaredCount = countMatch ? Number(countMatch[1]) : null;
  if (declaredCount !== null && pages.length >= declaredCount) return pages;
  // The /Kids walk under-delivered. Force any deferred xref repair so the orphan scan below sees the complete object set.
  // A missing page can be an object absent from the xref as parsed.
  objCache.ensureXrefRepaired();
  const collectedObjNums = new Set(pages.map((p) => p.objNum).filter((n) => n > 0));
  for (const objNumStr of Object.keys(objCache.xrefEntries)) {
    const objNum = Number(objNumStr);
    if (collectedObjNums.has(objNum)) continue;
    const text = objCache.getObjectText(objNum);
    if (!text || !/\/Type\s*\/Page\b(?!s)/.test(text)) continue;
    const parentMatch = /\/Parent\s+(\d+)\s+\d+\s+R/.exec(text);
    if (!parentMatch || Number(parentMatch[1]) !== pagesRootObjNum) continue;
    collectPages(objNum, objCache, [0, 0, 612, 792], null, 0, '', pages);
  }
  if (declaredCount !== null && pages.length < declaredCount) {
    console.warn(`getPageObjects: page tree declares /Count ${declaredCount} but only ${pages.length} page object(s) resolved (${declaredCount - pages.length} missing). Truncated or corrupt PDF.`);
  }
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
  const looksLikePagesNode = /\/Type\s*\/Pages\b/.test(objText)
    || (/\/Kids\s*[\[<]/.test(objText) && !/\/Type\s*\/Page\b(?!s)/.test(objText));
  if (looksLikePagesNode) {
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
 * Also records per-stream partial-recovery flags in `objCache.lastContentStreamsRecovered`,
 * index-aligned with the returned array.
 * @param {string} pageObjText
 * @param {ObjectCache} objCache
 */
export function getPageContentStreams(pageObjText, objCache) {
  const contentsArrayMatch = /\/Contents\s*\[([\s\S]*?)\]/.exec(pageObjText);
  const contentsSingleMatch = /\/Contents\s+(\d+)\s+\d+\s+R/.exec(pageObjText);
  objCache.lastContentStreamsRecovered = [];

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
      if (bytes) {
        parts.push(bytesToLatin1(bytes));
        objCache.lastContentStreamsRecovered.push(objCache.recoveredStreamObjs.has(ref));
      } else console.warn(`getPageContentStreams: content stream obj ${ref} decoded to no bytes; page content may be incomplete`);
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
          if (bytes) {
            parts.push(bytesToLatin1(bytes));
            objCache.lastContentStreamsRecovered.push(objCache.recoveredStreamObjs.has(ref));
          }
        }
        return parts.length > 0 ? parts : null;
      }
    }
    const bytes = objCache.getStreamBytes(objNum);
    if (!bytes) return null;
    objCache.lastContentStreamsRecovered = [objCache.recoveredStreamObjs.has(objNum)];
    return [bytesToLatin1(bytes)];
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
 *   { type: 'dict', value: string } |
 *   { type: 'operator', value: string } |
 *   { type: 'inlineImage', value: { dictText: string, imageData: string } }
 * )} PDFToken
 */

/**
 * Whether an /OCG or /OCMD object is hidden, given the set of OFF OCG object numbers.
 * Resolves /OCMD membership policy (AnyOn/AllOn/AnyOff/AllOff).
 *
 * @param {number} ocObjNum - Object number of an /OCG or /OCMD dict
 * @param {Set<number>} offOCGs - Set of OCG object numbers that are OFF
 * @param {ObjectCache} objCache - PDF object cache
 * @returns {boolean}
 */
export function isOCObjHidden(ocObjNum, offOCGs, objCache) {
  if (offOCGs.size === 0) return false;
  const ocText = objCache.getObjectText(ocObjNum);
  if (!ocText) return false;
  if (/\/Type\s*\/OCG/.test(ocText)) return offOCGs.has(ocObjNum);
  if (/\/Type\s*\/OCMD/.test(ocText)) {
    const singleRef = /\/OCGs\s+(\d+)\s+\d+\s+R/.exec(ocText);
    if (singleRef) return offOCGs.has(Number(singleRef[1]));
    const arrayMatch = /\/OCGs\s*\[([^\]]*)\]/.exec(ocText);
    if (arrayMatch) {
      const refs = [...arrayMatch[1].matchAll(/(\d+)\s+\d+\s+R/g)].map((m) => Number(m[1]));
      const policyMatch = /\/P\s*\/(\w+)/.exec(ocText);
      const policy = policyMatch ? policyMatch[1] : 'AnyOn';
      if (policy === 'AnyOn') return refs.every((r) => offOCGs.has(r));
      if (policy === 'AllOn') return refs.some((r) => offOCGs.has(r));
      if (policy === 'AnyOff') return !refs.some((r) => offOCGs.has(r));
      if (policy === 'AllOff') return !refs.every((r) => offOCGs.has(r));
    }
  }
  return false;
}

/**
 * Whether a Form XObject is hidden by an /OC entry directly on its dict.
 *
 * @param {string} formObjText - The form XObject dictionary text
 * @param {Set<number>} offOCGs - Set of OCG object numbers that are OFF
 * @param {ObjectCache} objCache - PDF object cache
 * @returns {boolean}
 */
export function isFormOCHidden(formObjText, offOCGs, objCache) {
  if (offOCGs.size === 0) return false;
  const ocMatch = /\/OC\s+(\d+)\s+\d+\s+R/.exec(formObjText);
  if (!ocMatch) return false;
  return isOCObjHidden(Number(ocMatch[1]), offOCGs, objCache);
}

/**
 * Build the set of /Resources/Properties names whose OCG/OCMD is currently OFF.
 * Content wrapped in `/OC /<name> BDC ... EMC` for such a name must not be painted.
 *
 * @param {string} resourceOwnerText - Page or Form XObject dict text
 * @param {ObjectCache} objCache - PDF object cache
 * @param {Set<number>} offOCGs - Set of OCG object numbers that are OFF
 * @returns {Set<string>}
 */
export function parseHiddenOCMCNames(resourceOwnerText, objCache, offOCGs) {
  /** @type {Set<string>} */
  const hidden = new Set();
  if (offOCGs.size === 0) return hidden;

  let resourcesText = resourceOwnerText;
  const resRefMatch = /\/Resources\s+(\d+)\s+\d+\s+R/.exec(resourceOwnerText);
  if (resRefMatch) {
    const resObj = objCache.getObjectText(Number(resRefMatch[1]));
    if (resObj) resourcesText = resObj;
  }
  const propStart = resourcesText.indexOf('/Properties');
  if (propStart === -1) return hidden;
  let propDictText;
  const afterProp = resourcesText.substring(propStart + 11).trim();
  if (afterProp.startsWith('<<')) {
    propDictText = extractDict(resourcesText, propStart + 11 + resourcesText.substring(propStart + 11).indexOf('<<'));
  } else {
    const refMatch = /^(\d+)\s+\d+\s+R/.exec(afterProp);
    if (refMatch) propDictText = objCache.getObjectText(Number(refMatch[1]));
  }
  if (!propDictText) return hidden;
  for (const m of propDictText.matchAll(/\/([^\s/<>[\]]+)\s+(\d+)\s+\d+\s+R/g)) {
    if (isOCObjHidden(Number(m[2]), offOCGs, objCache)) hidden.add(m[1]);
  }
  return hidden;
}
