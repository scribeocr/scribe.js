import {
  byteIndexOf, bytesEqualAt, bytesToLatin1, isAsciiDigit, isPdfWhitespace, matchesObjMarker,
  objTextEnd, parsePdfHexString, parsePdfLiteralString,
} from './pdfPrimitives.js';
import {
  aesDecrypt, computeObjectKey, rc4, setupEncryption,
} from './pdfCrypto.js';
import {
  extractStream, findRootObjNum,
} from './parsePdfUtils.js';

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
     * Synthetic objects injected at runtime (e.g. appearance streams generated for form fields that have a value but no /AP).
     * Keyed by a synthetic objNum, each holds the object's dict text and its uncompressed stream bytes.
     * Checked before the real xref in `getObjectText`/`getStreamBytes` and never evicted.
     * @type {Map<number, { text: string, bytes: Uint8Array }>}
     */
    this.syntheticObjects = new Map();
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
     * Doc-wide cache of decoded image bitmaps, keyed by the string from `decodedImageKey`
     * (`objNum` for plain images, `objNum|fillColor` for masks that bake in the fill colour).
     * Stores the JPX/CMYK-JPEG/CCITT/... -> ImageBitmap decode result,
     * so an image drawn on many pages (logos, letterheads, repeated figures) is decoded once instead of once per page render.
     * The bitmap lifecycle and value/byte-aware eviction are owned by renderPdfPage.js.
     * @type {Map<string, { bitmap: *, maxW: number, maxH: number, bytes: number, decodeMs: number }>}
     */
    this.decodedImageCache = new Map();
    /** @type {number} Total bytes across all entries in `decodedImageCache`. */
    this.decodedImageCacheBytes = 0;
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
    /** @type {Set<number>} Object numbers whose stream only decoded via partial-recovery inflate (known-corrupt) */
    this.recoveredStreamObjs = new Set();
    /** @type {boolean[]} Per-stream recovery flags from the most recent `getPageContentStreams` call, index-aligned with its return. */
    this.lastContentStreamsRecovered = [];
    /** @type {boolean} True if xref had entries with offsets beyond file size (severe corruption) */
    this.xrefSeverelyCorrupt = false;
    /** @type {Set<number>|null} Lazily-computed set of OCGs hidden in View mode */
    this._offOCGs = null;
    /**
     * Whether the lazy full-file xref repair scan has run.
     * @type {boolean}
     */
    this._xrefRepaired = false;
    // Eagerly flag offsets past EOF (severe corruption). Cheap O(objects), kept eager
    // because the one reader of the flag (encrypted-doc rendering) can run before any lookup misses.
    const fileLen = this.pdfBytes.length;
    for (const entry of Object.values(this.xrefEntries)) {
      if (entry.type === 1 && entry.offset >= fileLen) { this.xrefSeverelyCorrupt = true; break; }
    }
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
      // On failure, rewind to numStart+1 (not pos) so a real `N M obj` header
      // overlapping what we just consumed still gets matched — e.g. on input
      // `%PDF-1.7\n\n4 0 obj`, the `7 4 ...` attempt fails at `obj`, and we
      // need to retry from `\n\n4 0 obj` rather than skipping past the `4`.
      if (pos >= len || !isPdfWhitespace(bytes[pos])) { pos = numStart + 1; continue; }
      while (pos < len && isPdfWhitespace(bytes[pos])) pos++;
      if (pos >= len || !isAsciiDigit(bytes[pos])) { pos = numStart + 1; continue; }
      while (pos < len && isAsciiDigit(bytes[pos])) pos++;
      if (pos >= len || !isPdfWhitespace(bytes[pos])) { pos = numStart + 1; continue; }
      while (pos < len && isPdfWhitespace(bytes[pos])) pos++;
      // Required: 'obj' followed by a non-word character (regex's `\b`).
      if (!bytesEqualAt(bytes, pos, 'obj')) { pos = numStart + 1; continue; }
      const after = pos + 3;
      if (after < len) {
        const c = bytes[after];
        if (isAsciiDigit(c) || (c >= 0x41 && c <= 0x5A) || (c >= 0x61 && c <= 0x7A) || c === 0x5F) {
          pos = numStart + 1;
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
      if (!entry || entry.type === 0) {
        // Either no entry at all, or xref marks the slot free even though the
        // file contains a live "objNum 0 obj" header. Trust the file, since
        // pages frequently reference such "free" objects.
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

    // Encrypted-PDF callers return blank when this flag is set.
    // Clear it if repair has left every entry pointing at a real object header.
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
   * Get the text content of an object (the dictionary/value part, not including "N 0 obj").
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
      // The xref as parsed had no usable entry for this object.
      // Repair it once by scanning the whole file, then retry.
      // A broken xref pays that scan a single time instead of once per missing object,
      // and a valid xref never reaches here.
      this.ensureXrefRepaired();
      content = this._readObjectTextDirect(objNum);
    }
    if (content !== null) this._putText(objNum, content);
    return content;
  }

  /**
   * Ensure the full-file xref repair scan has run.
   */
  ensureXrefRepaired() {
    if (this._xrefRepaired) return;
    this._xrefRepaired = true;
    this._repairXref();
  }

  /**
   * Reads an object's dictionary text directly from its xref entry.
   * Unlike `getObjectText`, it does not cache the result and does not trigger a lazy xref repair.
   * Returns null when the entry is missing or free, when a type-1 offset does not point at the object's
   * "N G obj" header, or when a compressed object is absent from its object stream.
   * @param {number} objNum
   * @returns {string|null}
   */
  _readObjectTextDirect(objNum) {
    const bytes = this.pdfBytes;
    const entry = this.xrefEntries[objNum];
    if (!entry) return null;
    if (entry.type === 1) {
      const offset = entry.offset;
      // Validate the offset points at this object's header.
      // A stale offset (e.g. an xref not updated after an incremental save)
      // would otherwise read a different object verbatim.
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
    // type 0 (free) or unrecognized: a miss, so the caller can fall back to a lazy repair.
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
    const synthetic = this.syntheticObjects.get(objNum);
    if (synthetic !== undefined) return synthetic.bytes;
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
   * Add object lacking an /AP in the input (certain form fields).
   * @param {number} objNum
   * @param {string} text - The object's dict text (e.g. a Form XObject dictionary).
   * @param {Uint8Array} bytes - The object's uncompressed content stream.
   */
  addSyntheticObject(objNum, text, bytes) {
    this.syntheticObjects.set(objNum, { text, bytes });
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
    // Only /N and /First are read here, so the conversion is bounded to the dictionary.
    const objText = bytesToLatin1(bytes, offset, objTextEnd(bytes, offset, endObj));

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
   * @param {number} [genNum] - Generation number; when omitted, looked up from xref entries.
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
   * Decrypt the bytes of a string value read from an object's body.
   * @param {Uint8Array|null} bytes - Raw string bytes extracted from the object body
   * @param {number|null} objNum - Object number the string was read from
   * @returns {Uint8Array|null} the decrypted bytes, or `bytes` unchanged when decryption does not apply
   */
  decryptObjectStringBytes(bytes, objNum) {
    if (!bytes || !this.encryptionKey || objNum == null) return bytes;
    const entry = this.xrefEntries[objNum];
    // Only a directly-stored (type-1) object's strings carry a per-object key (spec Algorithm 3.1).
    // A type-2 object-stream string is already plaintext from the stream decrypt, so re-decrypting corrupts it.
    if (entry && entry.type === 1) return this.decryptStringBytes(bytes, objNum);
    return bytes;
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
