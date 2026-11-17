import {
  byteIndexOf, bytesEqualAt, bytesToLatin1, isAsciiDigit, isPdfWhitespace, matchesObjMarker,
  objTextEnd, parsePdfHexString, parsePdfLiteralString, resolveArrayValue, resolveDictValue, resolveIntValue,
} from './pdfPrimitives.js';
import {
  aesDecrypt, computeObjectKey, rc4, setupEncryption,
} from './pdfCrypto.js';
import {
  extractStream, findRootObjNum,
} from './parsePdfUtils.js';

const TEXT_CACHE_BUDGET_CHARS = 32 * 1024 * 1024;
const OBJ_STM_CACHE_BUDGET_CHARS = 32 * 1024 * 1024;
const STREAM_BYTES_CACHE_BUDGET = 128 * 1024 * 1024;

// Node workers share a process-wide font registry keyed by docId, whereas each browser worker has its own.
// Loaded synchronously because top-level `await` deadlocks scribe-ui's import cycles in the bundled app.
const THREAD_ID = (typeof process !== 'undefined' && typeof process.versions?.node === 'string')
  ? process.getBuiltinModule('node:worker_threads').threadId
  : 0;
let _objectCacheDocIdCounter = 0;

export class ObjectCache {
  /**
   * @param {Uint8Array} pdfBytes
   * @param {{ [objNum: number]: any }} xrefEntries
   */
  constructor(pdfBytes, xrefEntries) {
    this.pdfBytes = pdfBytes;
    this.xrefEntries = xrefEntries;
    this.docId = `${THREAD_ID}_${++_objectCacheDocIdCounter}`;
    /** @type {Map<number, string>} */
    this.textCache = new Map();
    this.textCacheChars = 0;
    /** @type {Map<number, { text: string, bytes: Uint8Array }>} */
    this.syntheticObjects = new Map();
    /** @type {Map<number, Map<number, string>>} */
    this.objStmCache = new Map();
    this.objStmCacheChars = 0;
    /** @type {Map<number, *>} */
    this.fontCache = new Map();
    /** @type {Map<number, { familyName: string, usesPUA: boolean, cmapType: string|null, cidCollisions: Set<number>|null, fontMatrix: number[]|null, allGlyphsEmpty?: boolean }>} */
    this.fontConversionCache = new Map();
    /** @type {Map<string, import('./fonts/parsePdfFonts.js').ToUnicodeMap>} */
    this.toUnicodeCMapCache = new Map();
    /** @type {Map<number, { bytes: ArrayBuffer, kind: 'original'|'rebuilt'|'type3', glyphs?: Array<{ name: string, codes: number[], text: ?string, pathHash: ?string, hasOutline: boolean }> }>} */
    this.fontBytesCache = new Map();
    /** @type {Map<number, Uint8Array>} */
    this.streamBytesCache = new Map();
    this.streamBytesCacheBytes = 0;
    /** @type {Map<string, { bitmap: *, maxW: number, maxH: number, bytes: number, decodeMs: number }>} */
    this.decodedImageCache = new Map();
    this.decodedImageCacheBytes = 0;
    /** @type {?number} */
    this.decodedImageCacheBudget = null;
    /** @type {Map<string, *>} */
    this.type3GlyphBitmapCache = new Map();
    this.type3GlyphBitmapCacheBytes = 0;
    /** @type {Map<number, {gamma: number[], matrix: number[]}|null>} */
    this.iccProfileCache = new Map();
    /** @type {Uint8Array|null} */
    this.encryptionKey = null;
    this.encryptObjNum = 0;
    this.cipherMode = 'RC4';
    /** @type {Set<string>} */
    this.filtersUsed = new Set();
    /** @type {Set<string>} */
    this.unsupportedFilters = new Set();
    /** @type {Set<number>} */
    this.recoveredStreamObjs = new Set();
    /** @type {boolean[]} */
    this.lastContentStreamsRecovered = [];
    this.xrefSeverelyCorrupt = false;
    /** @type {Set<number>|null} */
    this._offOCGs = null;
    this._xrefRepaired = false;
    // Checked eagerly because encrypted-page rendering reads `xrefSeverelyCorrupt` before any lookup miss triggers `_repairXref`.
    const fileLen = this.pdfBytes.length;
    for (const entry of Object.values(this.xrefEntries)) {
      if (entry.type === 1 && entry.offset >= fileLen) { this.xrefSeverelyCorrupt = true; break; }
    }
    setupEncryption(this);
  }

  /**
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

    const scanIndex = {};
    let pos = 0;
    while (pos < len) {
      while (pos < len && !isAsciiDigit(bytes[pos])) pos++;
      if (pos >= len) break;
      if (pos > 0 && isAsciiDigit(bytes[pos - 1])) {
        while (pos < len && isAsciiDigit(bytes[pos])) pos++;
        continue;
      }
      const numStart = pos;
      let objNum = 0;
      while (pos < len && isAsciiDigit(bytes[pos])) {
        objNum = objNum * 10 + (bytes[pos] - 0x30);
        pos++;
      }
      // Rewind to numStart + 1 on failure because a failed match like "7\n4 " in "%PDF-1.7\n4 0 obj" has already consumed the next header's object number.
      if (pos >= len || !isPdfWhitespace(bytes[pos])) { pos = numStart + 1; continue; }
      while (pos < len && isPdfWhitespace(bytes[pos])) pos++;
      if (pos >= len || !isAsciiDigit(bytes[pos])) { pos = numStart + 1; continue; }
      while (pos < len && isAsciiDigit(bytes[pos])) pos++;
      if (pos >= len || !isPdfWhitespace(bytes[pos])) { pos = numStart + 1; continue; }
      while (pos < len && isPdfWhitespace(bytes[pos])) pos++;
      if (!bytesEqualAt(bytes, pos, 'obj')) { pos = numStart + 1; continue; }
      const after = pos + 3;
      if (after < len) {
        const c = bytes[after];
        if (isAsciiDigit(c) || (c >= 0x41 && c <= 0x5A) || (c >= 0x61 && c <= 0x7A) || c === 0x5F) {
          pos = numStart + 1;
          continue;
        }
      }
      scanIndex[objNum] = numStart;
      pos = after;
    }

    for (const objNumStr of Object.keys(scanIndex)) {
      const objNum = Number(objNumStr);
      const scannedOffset = scanIndex[objNum];
      const entry = this.xrefEntries[objNum];
      if (!entry || entry.type === 0) {
        // Broken xrefs sometimes mark live, referenced objects free (type 0).
        this.xrefEntries[objNum] = { type: 1, offset: scannedOffset };
      } else if (entry.type === 1) {
        if (!matchesObjMarker(bytes, entry.offset, objNum)) entry.offset = scannedOffset;
      }
    }

    for (const objNumStr of Object.keys(this.xrefEntries)) {
      const objNum = Number(objNumStr);
      const entry = this.xrefEntries[objNum];
      if (entry && entry.type === 1 && !scanIndex[objNum]) {
        if (!matchesObjMarker(bytes, entry.offset, objNum)) delete this.xrefEntries[objNum];
      }
    }

    if (this.xrefSeverelyCorrupt) {
      let anyStillBad = false;
      for (const objNumStr of Object.keys(this.xrefEntries)) {
        const objNum = Number(objNumStr);
        const entry = this.xrefEntries[objNum];
        if (!entry || entry.type !== 1) continue;
        if (entry.offset >= len || !matchesObjMarker(bytes, entry.offset, objNum)) {
          anyStillBad = true;
          break;
        }
      }
      if (!anyStillBad) this.xrefSeverelyCorrupt = false;
    }
  }

  /**
   * Get an object's dictionary or value text, without the `N G obj` / `endobj` wrapper or stream.
   * @param {number} objNum
   * @returns {string|null}
   */
  getObjectText(objNum) {
    const synthetic = this.syntheticObjects.get(objNum);
    if (synthetic !== undefined) return synthetic.text;
    const cached = this.textCache.get(objNum);
    if (cached !== undefined) return cached;

    let content = this._readObjectTextDirect(objNum);
    if (content === null && !this._xrefRepaired) {
      this.ensureXrefRepaired();
      content = this._readObjectTextDirect(objNum);
    }
    if (content !== null) this._putText(objNum, content);
    return content;
  }

  ensureXrefRepaired() {
    if (this._xrefRepaired) return;
    this._xrefRepaired = true;
    this._repairXref();
  }

  /**
   * @param {number} objNum
   * @returns {string|null}
   */
  _readObjectTextDirect(objNum) {
    const bytes = this.pdfBytes;
    const entry = this.xrefEntries[objNum];
    if (!entry) return null;
    if (entry.type === 1) {
      const offset = entry.offset;
      if (!matchesObjMarker(bytes, offset, objNum)) return null;
      const endObj = byteIndexOf(bytes, 'endobj', offset);
      if (endObj === -1) return null;
      const objStart = byteIndexOf(bytes, 'obj', offset);
      if (objStart === -1 || objStart >= endObj) return null;
      return bytesToLatin1(bytes, objStart + 3, objTextEnd(bytes, objStart, endObj)).trim();
    }
    if (entry.type === 2) {
      this.decompressObjStm(entry.objStmNum);
      const cachedStm = this.objStmCache.get(entry.objStmNum);
      const stmText = cachedStm ? cachedStm.get(objNum) : undefined;
      if (stmText !== undefined) return stmText;
    }
    return null;
  }

  /**
   * Get the OCG object numbers hidden for on-screen viewing.
   * @returns {Set<number>}
   */
  getOffOCGs() {
    if (this._offOCGs !== null) return this._offOCGs;
    /** @type {Set<number>} */
    const off = new Set();
    const rootObjNum = findRootObjNum(this.pdfBytes);
    if (rootObjNum != null) {
      const catText = this.getObjectText(rootObjNum);
      if (catText) {
        const ocpText = resolveDictValue(catText, 'OCProperties', this);
        if (ocpText) {
          const dText = resolveDictValue(ocpText, 'D', this) || ocpText;
          const offContent = resolveArrayValue(dText, 'OFF', this);
          if (offContent != null) {
            for (const m of offContent.matchAll(/(\d+)\s+\d+\s+R/g)) off.add(Number(m[1]));
          }
          const asBody = resolveArrayValue(dText, 'AS', this);
          if (asBody != null) {
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
              const ocgsContent = resolveArrayValue(entry, 'OCGs', this);
              if (ocgsContent == null) continue;
              for (const m of ocgsContent.matchAll(/(\d+)\s+\d+\s+R/g)) {
                const ocgNum = Number(m[1]);
                const ocgText = this.getObjectText(ocgNum);
                if (!ocgText) continue;
                const usageText = resolveDictValue(ocgText, 'Usage', this);
                const viewText = usageText && resolveDictValue(usageText, 'View', this);
                if (viewText && /\/ViewState\s*\/OFF\b/.test(viewText)) off.add(ocgNum);
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
   * Get the decoded stream bytes for a stream object.
   * @param {number} objNum
   * @returns {Uint8Array|null}
   */
  getStreamBytes(objNum) {
    const synthetic = this.syntheticObjects.get(objNum);
    if (synthetic !== undefined) return synthetic.bytes;
    const cached = this.streamBytesCache.get(objNum);
    if (cached !== undefined) return cached;

    const bytes = this.pdfBytes;
    let entry = this.xrefEntries[objNum];
    if (!this._xrefRepaired && (!entry || entry.type === 0 || (entry.type === 1 && !matchesObjMarker(bytes, entry.offset, objNum)))) {
      this.ensureXrefRepaired();
      entry = this.xrefEntries[objNum];
    }
    let result = null;
    if (entry && entry.type === 1 && matchesObjMarker(bytes, entry.offset, objNum)) {
      result = extractStream(bytes, entry.offset, this, objNum);
    }

    if (result !== null) this._putStreamBytes(objNum, result);
    return result;
  }

  /**
   * Register an in-memory object served ahead of `xrefEntries`.
   * @param {number} objNum
   * @param {string} text - Dictionary or value text.
   * @param {Uint8Array} bytes - Decoded stream bytes.
   */
  addSyntheticObject(objNum, text, bytes) {
    this.syntheticObjects.set(objNum, { text, bytes });
  }

  /**
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
   * @param {number} objStmNum
   */
  decompressObjStm(objStmNum) {
    if (this.objStmCache.has(objStmNum)) return;

    /** @type {Map<number, string>} */
    const stmEntries = new Map();
    // Seeded up front so failed decompressions stay cached as empty and re-entrant lookups from extractStream cannot recurse.
    this.objStmCache.set(objStmNum, stmEntries);

    const bytes = this.pdfBytes;
    const entry = this.xrefEntries[objStmNum];
    if (!entry || entry.type !== 1) return;

    const offset = entry.offset;
    let endObj = byteIndexOf(bytes, 'endobj', offset);
    if (endObj === -1) endObj = Math.min(offset + 100000, bytes.length);
    const objText = bytesToLatin1(bytes, offset, objTextEnd(bytes, offset, endObj));

    const objStmInt = (key) => {
      const direct = resolveIntValue(objText, key, null, -1);
      if (direct !== -1) return direct;
      const ref = new RegExp(`/${key}\\s+(\\d+)\\s+\\d+\\s+R(?![0-9A-Za-z])`).exec(objText);
      const target = ref && this.xrefEntries[Number(ref[1])];
      // A ref into an object stream would recurse into this decompression.
      if (!target || target.type !== 1) return -1;
      return resolveIntValue(objText, key, this, -1);
    };
    const n = objStmInt('N');
    const first = objStmInt('First');
    if (n < 0 || first < 0) return;

    const streamData = extractStream(bytes, offset, this, objStmNum);
    if (!streamData) return;

    const streamText = bytesToLatin1(streamData);

    const headerPart = streamText.substring(0, first).trim();
    const headerNums = headerPart.split(/\s+/).map(Number);

    let addedChars = 0;
    for (let i = 0; i < n; i++) {
      const objNum = headerNums[i * 2];
      const objOffset = headerNums[i * 2 + 1];
      const startPos = first + objOffset;
      const nextObjOffset = (i + 1 < n) ? first + headerNums[(i + 1) * 2 + 1] : streamText.length;
      const content = streamText.substring(startPos, nextObjOffset).trim();
      stmEntries.set(objNum, content);
      addedChars += content.length;
    }
    this.objStmCacheChars += addedChars;
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
   * Decrypt a direct object's string bytes.
   * @param {Uint8Array} encryptedBytes
   * @param {number} objNum
   * @param {number} [genNum]
   * @returns {Uint8Array}
   */
  decryptStringBytes(encryptedBytes, objNum, genNum) {
    if (!this.encryptionKey || objNum === this.encryptObjNum) return encryptedBytes;
    const gen = genNum !== undefined ? genNum : (this.xrefEntries[objNum]?.gen ?? 0);
    if (this.cipherMode === 'AESV3') {
      return aesDecrypt(this.encryptionKey, encryptedBytes);
    }
    if (this.cipherMode === 'AESV2') {
      const objKey = computeObjectKey(this.encryptionKey, objNum, gen, true);
      return aesDecrypt(objKey, encryptedBytes);
    }
    const objKey = computeObjectKey(this.encryptionKey, objNum, gen, false);
    return rc4(objKey, encryptedBytes);
  }

  /**
   * Decrypt string bytes read from an object's body.
   * @param {Uint8Array|null} bytes
   * @param {number|null} objNum
   * @returns {Uint8Array|null}
   */
  decryptObjectStringBytes(bytes, objNum) {
    if (!bytes || !this.encryptionKey || objNum == null) return bytes;
    const entry = this.xrefEntries[objNum];
    // Type-2 (ObjStm) strings are already decrypted with their enclosing stream, so decrypting again corrupts them.
    if (entry && entry.type === 1) return this.decryptStringBytes(bytes, objNum);
    return bytes;
  }

  /**
   * Find and decrypt a string entry in a direct object's dictionary.
   * @param {number} objNum
   * @param {string} keyName - Key without leading slash.
   * @returns {string|null}
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
    let stringObjNum = objNum;
    if (bytes[pos] === 0x28) {
      rawBytes = parsePdfLiteralString(bytes, pos).value;
    } else if (bytes[pos] === 0x3C && pos + 1 < endIdx && bytes[pos + 1] !== 0x3C) {
      rawBytes = parsePdfHexString(bytes, pos).value;
    } else if (isAsciiDigit(bytes[pos])) {
      const refM = /^(\d+)\s+\d+\s+R/.exec(bytesToLatin1(bytes, pos, Math.min(pos + 32, endIdx)));
      const target = refM && this.xrefEntries[Number(refM[1])];
      if (!target || target.type !== 1) return null;
      const objKw = byteIndexOf(bytes, 'obj', target.offset);
      if (objKw === -1) return null;
      let sPos = objKw + 3;
      while (sPos < bytes.length && isPdfWhitespace(bytes[sPos])) sPos++;
      if (bytes[sPos] === 0x28) rawBytes = parsePdfLiteralString(bytes, sPos).value;
      else if (bytes[sPos] === 0x3C && bytes[sPos + 1] !== 0x3C) rawBytes = parsePdfHexString(bytes, sPos).value;
      else return null;
      stringObjNum = Number(refM[1]);
    } else {
      return null;
    }

    const decrypted = this.decryptStringBytes(rawBytes, stringObjNum);
    let result = '';
    for (let i = 0; i < decrypted.length; i++) result += String.fromCharCode(decrypted[i]);
    return result;
  }
}
