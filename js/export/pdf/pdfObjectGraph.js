import { extractRawStreamBytes, findInfoObjNum } from '../../pdf/parsePdfUtils.js';
import {
  extractDict, extractDictFromBytes, byteIndexOf, bytesToLatin1,
  parsePdfLiteralString, parsePdfHexString, parseDictEntries, toUtf16BeHex, formatPdfDate,
} from '../../pdf/pdfPrimitives.js';
import { md5 } from '../../pdf/pdfCrypto.js';

/**
 * Walk a byte range and decrypt every PDF literal `(...)` and hex `<...>` string,
 * returning a new Uint8Array.
 *
 * @param {Uint8Array} bytes
 * @param {number} objNum
 * @param {import('../../pdf/objectCache.js').ObjectCache} objCache
 */
export function decryptObjectStrings(bytes, objNum, objCache) {
  if (!objCache.encryptionKey || objNum === objCache.encryptObjNum) return bytes;
  /** @type {number[]} */
  const out = [];
  let i = 0;
  const n = bytes.length;
  while (i < n) {
    const b = bytes[i];
    if (b === 0x28) {
      const parsed = parsePdfLiteralString(bytes, i);
      const decrypted = objCache.decryptStringBytes(parsed.value, objNum);
      out.push(0x28);
      for (let k = 0; k < decrypted.length; k++) {
        const v = decrypted[k];
        if (v === 0x28 || v === 0x29 || v === 0x5C) {
          out.push(0x5C, v);
        } else if (v === 0x0A) {
          out.push(0x5C, 0x6E);
        } else if (v === 0x0D) {
          out.push(0x5C, 0x72);
        } else if (v === 0x09) {
          out.push(0x5C, 0x74);
        } else if (v === 0x08) {
          out.push(0x5C, 0x62);
        } else if (v === 0x0C) {
          out.push(0x5C, 0x66);
        } else {
          out.push(v);
        }
      }
      out.push(0x29);
      i = parsed.end;
    } else if (b === 0x3C && bytes[i + 1] === 0x3C) {
      out.push(0x3C);
      out.push(0x3C);
      i += 2;
    } else if (b === 0x3C) {
      const parsed = parsePdfHexString(bytes, i);
      const decrypted = objCache.decryptStringBytes(parsed.value, objNum);
      out.push(0x3C);
      for (let k = 0; k < decrypted.length; k++) {
        const v = decrypted[k];
        const hi = (v >> 4) & 0xF;
        const lo = v & 0xF;
        out.push(hi < 10 ? hi + 0x30 : hi - 10 + 0x41);
        out.push(lo < 10 ? lo + 0x30 : lo - 10 + 0x41);
      }
      out.push(0x3E);
      i = parsed.end;
    } else {
      out.push(b);
      i++;
    }
  }
  return new Uint8Array(out);
}

const TRAILER_ID_RE = /\/ID\s*\[\s*<([0-9A-Fa-f\s]*)>\s*<[0-9A-Fa-f\s]*>\s*\]/;
const TRAILER_INFO_RE = /\/Info\s+(\d{1,10})\s+(\d{1,10})\s+R/;

/**
 * Parse the trailer dict's /Root, /Size, /Info and /ID.
 * `id0Hex` is the permanent file identifier as bare uppercase hex, without the enclosing angle brackets.
 * @param {Uint8Array} pdfBytes
 * @param {number} xrefOffset
 */
export function parseTrailerInfo(pdfBytes, xrefOffset) {
  const atOffset = bytesToLatin1(pdfBytes, xrefOffset, Math.min(xrefOffset + 50, pdfBytes.length));
  let dictText;

  if (/^\d+ \d+ obj/.test(atOffset)) {
    // Xref stream: the dict is in the stream object itself
    const dictStart = byteIndexOf(pdfBytes, '<<', xrefOffset);
    dictText = dictStart === -1 ? '' : extractDictFromBytes(pdfBytes, dictStart);
  } else {
    // Traditional trailer
    const trailerStart = byteIndexOf(pdfBytes, 'trailer', xrefOffset);
    if (trailerStart === -1) {
      return {
        rootRef: '1 0 R', size: 1, infoRef: null, id0Hex: null,
      };
    }
    const dictStart = byteIndexOf(pdfBytes, '<<', trailerStart);
    dictText = dictStart === -1 ? '' : extractDictFromBytes(pdfBytes, dictStart);
  }

  const rootMatch = /\/Root\s+(\d+)\s+(\d+)\s+R/.exec(dictText);
  const sizeMatch = /\/Size\s+(\d+)/.exec(dictText);
  const infoMatch = TRAILER_INFO_RE.exec(dictText);
  const idMatch = TRAILER_ID_RE.exec(dictText);
  let id0Hex = idMatch ? idMatch[1].replace(/\s+/g, '').toUpperCase() : null;
  if (id0Hex && id0Hex.length % 2) id0Hex += '0';

  return {
    rootRef: rootMatch ? `${rootMatch[1]} ${rootMatch[2]} R` : '1 0 R',
    size: sizeMatch ? Number(sizeMatch[1]) : 1,
    infoRef: infoMatch ? `${infoMatch[1]} ${infoMatch[2]} R` : null,
    id0Hex,
  };
}

/**
 * @typedef {Object} TrailerExtras
 * @property {?string} [infoRef] - Reference to the document information dictionary, e.g. "1 0 R".
 * @property {?[string, string]} [idHexPair] - File-identifier elements as bare hex, permanent first.
 */

/**
 * Serialize the document-level trailer entries.
 * @param {TrailerExtras} extras
 */
function trailerExtraEntries(extras) {
  const info = extras.infoRef ? `/Info ${extras.infoRef}` : '';
  const id = extras.idHexPair ? `/ID [<${extras.idHexPair[0]}><${extras.idHexPair[1]}>]` : '';
  return `${info}${id}`;
}

/** A file-identifier element, as 32 uppercase hex digits. */
export function fileIdHex(bytes) {
  let out = '';
  for (const b of md5(bytes)) out += b.toString(16).toUpperCase().padStart(2, '0');
  return out;
}

/** Placeholder written in place of a file identifier the writer patches in once the body bytes exist. */
export const FILE_ID_PLACEHOLDER = '0'.repeat(32);

/**
 * Overwrite the file-identifier placeholders in an already-assembled output buffer with the hash of its body.
 * The identifier lives in the trailer, so it cannot be inside the range it hashes.
 * @param {Uint8Array} result - The complete output, body and trailer.
 * @param {string} trailerStr - The trailer text as written, used to locate the placeholders.
 * @param {number} trailerStart - Byte offset of `trailerStr` within `result`.
 * @param {number} bodyStart - First byte of the range identifying this revision.
 * @param {number} bodyEnd - One past its last byte.
 */
export function patchFileId(result, trailerStr, trailerStart, bodyStart, bodyEnd) {
  const idIdx = trailerStr.indexOf('/ID [<');
  if (idIdx === -1) return;
  const hex = fileIdHex(result.subarray(bodyStart, bodyEnd));
  // Only placeholders match, so a carried permanent identifier is left alone and a first write patches both elements.
  let at = trailerStr.indexOf(FILE_ID_PLACEHOLDER, idIdx);
  while (at !== -1) {
    for (let i = 0; i < hex.length; i++) result[trailerStart + at + i] = hex.charCodeAt(i);
    at = trailerStr.indexOf(FILE_ID_PLACEHOLDER, at + FILE_ID_PLACEHOLDER.length);
  }
}

/**
 * Read the source's document information dictionary body, without the `<<`/`>>` wrapper.
 * @param {Uint8Array} pdfBytes
 * @param {import('../../pdf/objectCache.js').ObjectCache} objCache
 * @returns {?string}
 */
export function readSourceInfoBody(pdfBytes, objCache) {
  const objNum = findInfoObjNum(pdfBytes);
  if (!objNum) return null;
  const objText = objCache.getObjectText(objNum);
  const start = objText ? objText.indexOf('<<') : -1;
  if (start === -1) return null;
  const dict = extractDict(objText, start);
  return dict ? dict.slice(2, -2) : null;
}

// PDF 2.0 names are UTF-8 byte sequences, so a key is encoded before escaping.
// Escaping UTF-16 code units instead would write `Caf#E9` for `Café`, and bare surrogate halves above U+FFFF.
const NAME_SAFE = /[A-Za-z0-9_.-]/;

/**
 * Build the output document information dictionary body from the source's entries plus caller overrides.
 * @param {?string} sourceInfoBody - Body of the source /Info dict, or null when the file has none.
 * @param {?Object<string, ?string>} docInfo - Caller entries; a null value drops that key.
 * @returns {?string} The dict body, or null when there is nothing to write.
 */
export function buildInfoDictBody(sourceInfoBody, docInfo) {
  const overrides = new Map(Object.entries(docInfo || {}));
  const entries = [];

  if (sourceInfoBody) {
    // Copied verbatim because decoding and re-encoding would not round-trip a name value, a number, or an indirect reference.
    for (const e of parseDictEntries(sourceInfoBody)) {
      if (!overrides.has(e.name)) entries.push(`/${e.name} ${e.valueText.trim()}`);
    }
  }

  for (const [name, value] of overrides) {
    if (value === null || value === undefined) continue;
    let safeName = '';
    for (const byte of new TextEncoder().encode(name)) {
      const char = String.fromCharCode(byte);
      safeName += NAME_SAFE.test(char) ? char : `#${byte.toString(16).toUpperCase().padStart(2, '0')}`;
    }
    const isDate = name === 'CreationDate' || name === 'ModDate';
    const text = isDate && !value.startsWith('D:') ? (formatPdfDate(value) || value) : value;
    entries.push(`/${safeName} <${toUtf16BeHex(text)}>`);
  }

  return entries.length ? entries.join(' ') : null;
}

/**
 * Build an incremental xref table, trailer, startxref, and %%EOF.
 * @param {Array<{objNum: number, offset: number}>} entries
 * @param {number} totalSize - Total object count (must be >= highest objNum + 1)
 * @param {number} prevXrefOffset - Offset of the previous xref section
 * @param {string} rootRef - The /Root reference e.g. "1 0 R"
 * @param {number} newXrefOffset - Byte offset where this xref section starts
 * @param {number[]} [freedObjNums=[]] - Object numbers to mark deleted (free entries).
 * @param {TrailerExtras} [extras] - Document-level entries the added trailer carries forward.
 */
export function buildIncrementalXrefAndTrailer(entries, totalSize, prevXrefOffset, rootRef, newXrefOffset, freedObjNums = [], extras = {}) {
  const liveSorted = entries.slice().sort((a, b) => a.objNum - b.objNum);

  /** @type {Array<{objNum: number, status: 'n' | 'f', offset: number}>} */
  const merged = liveSorted.map((e) => ({ objNum: e.objNum, status: /** @type {'n'} */ ('n'), offset: e.offset }));
  const liveSet = new Set(liveSorted.map((e) => e.objNum));
  for (const n of freedObjNums) {
    if (liveSet.has(n)) continue;
    merged.push({ objNum: n, status: /** @type {'f'} */ ('f'), offset: 0 });
  }
  merged.sort((a, b) => a.objNum - b.objNum);

  let xrefStr = 'xref\n';

  let i = 0;
  while (i < merged.length) {
    const rangeStart = i;
    let rangeEnd = i;
    while (rangeEnd + 1 < merged.length && merged[rangeEnd + 1].objNum === merged[rangeEnd].objNum + 1) {
      rangeEnd++;
    }
    const startObj = merged[rangeStart].objNum;
    const count = rangeEnd - rangeStart + 1;
    xrefStr += `${startObj} ${count}\n`;
    for (let j = rangeStart; j <= rangeEnd; j++) {
      const entry = merged[j];
      if (entry.status === 'f') {
        xrefStr += '0000000000 00001 f \n';
      } else {
        xrefStr += `${String(entry.offset).padStart(10, '0')} 00000 n \n`;
      }
    }
    i = rangeEnd + 1;
  }

  xrefStr += 'trailer\n';
  xrefStr += `<</Size ${totalSize}/Root ${rootRef}/Prev ${prevXrefOffset}${trailerExtraEntries(extras)}>>\n`;
  xrefStr += 'startxref\n';
  xrefStr += `${newXrefOffset}\n`;
  xrefStr += '%%EOF\n';

  return xrefStr;
}

/**
 * BFS traversal to find all objects transitively referenced from starting text(s).
 * Follows all indirect references (N M R) except those in the exclusion set.
 * Skips /Parent references from page dicts to avoid pulling in the page tree.
 * @param {string[]} startingTexts - Text contents to start tracing from
 * @param {import('../../pdf/objectCache.js').ObjectCache} objCache
 * @param {Set<number>} excludeObjNums - Object numbers to skip (page tree objects)
 * @param {((objText: string) => string) | null} [refTextTransform] - Optional filter applied to each object's text before its references are extracted.
 *   The metadata scrub uses it to drop refs under keys it removes, so objects reachable only through those keys are not copied into the output.
 */
export function traceReferencedObjects(startingTexts, objCache, excludeObjNums, refTextTransform = null) {
  const visited = new Set();
  const queue = [];

  for (const startText of startingTexts) {
    // Find /Parent reference to exclude (relevant for page dicts)
    const parentMatch = /\/Parent\s+(\d+)\s+\d+\s+R/.exec(startText);
    const parentObjNum = parentMatch ? Number(parentMatch[1]) : -1;

    const scanStart = refTextTransform ? refTextTransform(startText) : startText;
    const refs = [...scanStart.matchAll(/(\d+)\s+\d+\s+R/g)];
    for (const ref of refs) {
      const objNum = Number(ref[1]);
      if (objNum === parentObjNum) continue;
      if (excludeObjNums.has(objNum)) continue;
      if (!visited.has(objNum)) {
        visited.add(objNum);
        queue.push(objNum);
      }
    }
  }

  while (queue.length > 0) {
    const objNum = /** @type {number} */ (queue.shift());
    let objText = objCache.getObjectText(objNum);
    if (!objText) continue;
    if (refTextTransform) objText = refTextTransform(objText);

    const refs = [...objText.matchAll(/(\d+)\s+\d+\s+R/g)];
    for (const ref of refs) {
      const refNum = Number(ref[1]);
      if (excludeObjNums.has(refNum)) continue;
      if (!visited.has(refNum)) {
        visited.add(refNum);
        queue.push(refNum);
      }
    }
  }

  return visited;
}

/**
 * Build a standalone xref table and trailer for a new PDF (not incremental).
 *
 * @param {Array<{objNum: number, offset: number}>} entries
 * @param {number} totalSize
 * @param {string} rootRef - e.g. "5 0 R"
 * @param {number} xrefOffset
 * @param {TrailerExtras} [extras] - Document-level entries the output trailer carries.
 */
export function buildFullXrefAndTrailer(entries, totalSize, rootRef, xrefOffset, extras = {}) {
  const sorted = entries.slice().sort((a, b) => a.objNum - b.objNum);

  let xrefStr = 'xref\n';

  // Free entry for object 0
  xrefStr += '0 1\n';
  xrefStr += '0000000000 65535 f \n';

  // Generate subsections for contiguous ranges
  let i = 0;
  while (i < sorted.length) {
    const rangeStart = i;
    let rangeEnd = i;
    while (rangeEnd + 1 < sorted.length && sorted[rangeEnd + 1].objNum === sorted[rangeEnd].objNum + 1) {
      rangeEnd++;
    }
    const startObj = sorted[rangeStart].objNum;
    const count = rangeEnd - rangeStart + 1;
    xrefStr += `${startObj} ${count}\n`;
    for (let j = rangeStart; j <= rangeEnd; j++) {
      xrefStr += `${String(sorted[j].offset).padStart(10, '0')} 00000 n \n`;
    }
    i = rangeEnd + 1;
  }

  xrefStr += 'trailer\n';
  xrefStr += `<</Size ${totalSize}/Root ${rootRef}${trailerExtraEntries(extras)}>>\n`;
  xrefStr += 'startxref\n';
  xrefStr += `${xrefOffset}\n`;
  xrefStr += '%%EOF\n';

  return xrefStr;
}

/**
 * Locate a type-1 object's exact byte range in the source PDF.
 * @param {Uint8Array} pdfBytes
 * @param {import('../../pdf/objectCache.js').ObjectCache} objCache
 * @param {{type: number, offset: number}} entry
 */
export function locateObjectByteRange(pdfBytes, objCache, entry) {
  const offset = entry.offset;
  let searchFrom = offset;
  let streamStart = offset;
  let streamEnd = offset;

  const firstEndObj = byteIndexOf(pdfBytes, 'endobj', offset);
  if (firstEndObj === -1) return null;
  // The bound is load-bearing, not a duplicate of the comparison below.
  // Without it the scan runs to end of file on every non-stream object, chasing the very common byte `s` the whole way.
  const streamKw = byteIndexOf(pdfBytes, 'stream', offset, firstEndObj + 'stream'.length);

  if (streamKw !== -1 && streamKw < firstEndObj) {
    // Stream object: use /Length to skip past stream data.
    const headerText = bytesToLatin1(pdfBytes, offset, streamKw);
    const indirectLenMatch = /\/Length\s+(\d+)\s+\d+\s+R/.exec(headerText);
    const directLenMatch = /\/Length\s+(\d+)/.exec(headerText);
    let streamLength = 0;
    if (indirectLenMatch) {
      const refObjNum = Number(indirectLenMatch[1]);
      const refText = objCache.getObjectText(refObjNum);
      if (refText) streamLength = Number(refText.trim());
    } else if (directLenMatch) {
      streamLength = Number(directLenMatch[1]);
    }
    streamStart = streamKw + 6;
    if (pdfBytes[streamStart] === 0x0D && pdfBytes[streamStart + 1] === 0x0A) {
      streamStart += 2;
    } else if (pdfBytes[streamStart] === 0x0A || pdfBytes[streamStart] === 0x0D) {
      streamStart += 1;
    }
    streamEnd = streamStart + streamLength;
    searchFrom = streamEnd;
  }

  const endObjPos = byteIndexOf(pdfBytes, 'endobj', searchFrom);
  if (endObjPos === -1) return null;
  return {
    start: offset,
    end: endObjPos + 6,
    streamStart,
    streamEnd,
  };
}

/**
 * Copy a type-1 object's raw bytes from the source PDF, preserving binary stream data exactly.
 * When the source is encrypted, the stream payload is decrypted on the way out so the copy
 * is usable in an output PDF that doesn't carry the source's /Encrypt dict.
 *
 * @param {Uint8Array} pdfBytes
 * @param {import('../../pdf/objectCache.js').ObjectCache} objCache
 * @param {{type: number, offset: number}} entry
 * @param {number} [objNum=-1] - Required when copying from an encrypted source.
 */
export function copyRawObjectBytes(pdfBytes, objCache, entry, objNum = -1) {
  const range = locateObjectByteRange(pdfBytes, objCache, entry);
  if (!range) return null;

  const isEncrypted = !!objCache.encryptionKey && objNum >= 0 && objNum !== objCache.encryptObjNum;
  const hasStream = range.streamStart < range.streamEnd;

  if (isEncrypted && hasStream) {
    const raw = extractRawStreamBytes(
      pdfBytes, entry.offset, objCache.encryptionKey, objCache.encryptObjNum, objCache.cipherMode, objNum, objCache,
    );
    if (raw) {
      const { data, dictText } = raw;
      // The optional `(?:\s+\d+\s+R)?` is required: indirect `/Length N M R` must
      // be replaced whole, otherwise the leftover `M R` re-parses as a stray ref.
      const updatedDict = dictText.replace(/\/Length\s+\d+(?:\s+\d+\s+R)?/, `/Length ${data.length}`);
      // The dict still carries encrypted string values (e.g. CIDSystemInfo /Registry).
      // Decrypt them so readers without the file key can interpret the dict correctly.
      const dictBytes = new Uint8Array(updatedDict.length);
      for (let i = 0; i < updatedDict.length; i++) dictBytes[i] = updatedDict.charCodeAt(i) & 0xFF;
      const dictDecrypted = decryptObjectStrings(dictBytes, objNum, objCache);
      const trailerStr = '\nendstream\nendobj\n\n';
      const trailerBytes = new Uint8Array(trailerStr.length);
      for (let i = 0; i < trailerStr.length; i++) trailerBytes[i] = trailerStr.charCodeAt(i) & 0xFF;
      const streamKw = new Uint8Array([0x73, 0x74, 0x72, 0x65, 0x61, 0x6D, 0x0A]); // 'stream\n'
      const out = new Uint8Array(dictDecrypted.length + streamKw.length + data.length + trailerBytes.length);
      out.set(dictDecrypted, 0);
      out.set(streamKw, dictDecrypted.length);
      out.set(data, dictDecrypted.length + streamKw.length);
      out.set(trailerBytes, dictDecrypted.length + streamKw.length + data.length);
      return out;
    }
  }

  if (isEncrypted && !hasStream) {
    // Gated on `!hasStream`: decryptObjectStrings would scan the binary payload of
    // a stream object for `(...)` and `<...>` markers and corrupt it.
    const sliced = pdfBytes.subarray(range.start, range.end);
    const decrypted = decryptObjectStrings(sliced, objNum, objCache);
    const out = new Uint8Array(decrypted.length + 2);
    out.set(decrypted, 0);
    out[decrypted.length] = 0x0A;
    out[decrypted.length + 1] = 0x0A;
    return out;
  }

  if (hasStream) {
    // PDF spec permits 0/1/2 EOL bytes between stream data and `endstream`.
    // Accept the source's /Length when the gap matches any of those,
    // otherwise rewrite it to the actual byte count so strict readers don't reject the stream.
    const dictText = bytesToLatin1(pdfBytes, range.start, range.streamStart);
    const streamKw = dictText.lastIndexOf('stream');
    const headerStr = streamKw >= 0 ? dictText.substring(0, streamKw) : dictText;
    const declaredMatch = /\/Length\s+(\d+)(?!\s+\d+\s+R)/.exec(headerStr);
    const declared = declaredMatch ? Number(declaredMatch[1]) : null;
    const endStreamIdx = byteIndexOf(pdfBytes, 'endstream', range.streamStart);
    if (endStreamIdx >= 0) {
      let actualLength;
      if (declared !== null) {
        const expectedEnd = range.streamStart + declared;
        const consistent = endStreamIdx === expectedEnd
          || (endStreamIdx === expectedEnd + 1
              && (pdfBytes[expectedEnd] === 0x0A || pdfBytes[expectedEnd] === 0x0D))
          || (endStreamIdx === expectedEnd + 2
              && pdfBytes[expectedEnd] === 0x0D && pdfBytes[expectedEnd + 1] === 0x0A);
        if (consistent) {
          actualLength = declared;
        } else {
          // Don't strip a trailing EOL — it may be the data's last byte (e.g. a CFF binary ending in 0x0A).
          // Filters tolerate trailing bytes past their end marker.
          actualLength = endStreamIdx - range.streamStart;
        }
      } else {
        // Indirect /Length or no /Length in the dict — fall back to the full gap.
        actualLength = endStreamIdx - range.streamStart;
      }
      const updatedHeader = headerStr.replace(/\/Length\s+\d+(?:\s+\d+\s+R)?/, `/Length ${actualLength}`);
      const headerBytes = new Uint8Array(updatedHeader.length);
      for (let i = 0; i < updatedHeader.length; i++) headerBytes[i] = updatedHeader.charCodeAt(i) & 0xFF;
      const streamKwBytes = new Uint8Array([0x73, 0x74, 0x72, 0x65, 0x61, 0x6D, 0x0A]); // 'stream\n'
      const streamBytes = pdfBytes.subarray(range.streamStart, range.streamStart + actualLength);
      const trailer = '\nendstream\nendobj\n\n';
      const trailerBytes = new Uint8Array(trailer.length);
      for (let i = 0; i < trailer.length; i++) trailerBytes[i] = trailer.charCodeAt(i) & 0xFF;
      const out = new Uint8Array(headerBytes.length + streamKwBytes.length + streamBytes.length + trailerBytes.length);
      let off = 0;
      out.set(headerBytes, off); off += headerBytes.length;
      out.set(streamKwBytes, off); off += streamKwBytes.length;
      out.set(streamBytes, off); off += streamBytes.length;
      out.set(trailerBytes, off);
      return out;
    }
  }

  const rawCopy = new Uint8Array(range.end - range.start + 2);
  rawCopy.set(pdfBytes.subarray(range.start, range.end));
  rawCopy[range.end - range.start] = 0x0A;
  rawCopy[range.end - range.start + 1] = 0x0A;
  return rawCopy;
}
