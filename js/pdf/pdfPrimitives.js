// Low-level PDF parsing primitives. No dependencies on other PDF modules.

/** @typedef {import('./objectCache.js').ObjectCache} ObjectCache */

/**
 * Multiply two 6-element PDF affine matrices `[a, b, c, d, e, f]`, returning `m1 · m2`.
 * @param {number[]} m1
 * @param {number[]} m2
 * @returns {number[]}
 */
export function matMul(m1, m2) {
  return [
    m1[0] * m2[0] + m1[1] * m2[2],
    m1[0] * m2[1] + m1[1] * m2[3],
    m1[2] * m2[0] + m1[3] * m2[2],
    m1[2] * m2[1] + m1[3] * m2[3],
    m1[4] * m2[0] + m1[5] * m2[2] + m2[4],
    m1[4] * m2[1] + m1[5] * m2[3] + m2[5],
  ];
}

/**
 * Decode a show-text operand into character codes using a font's codespace ranges.
 *
 * PDF show-text strings are byte sequences whose grouping into character codes is
 * governed by the font's CMap codespace ranges. Simple fonts are 1 byte/code;
 * Type0/CID fonts are usually 2 bytes/code; predefined mixed-width CMaps (e.g.
 * `83pv-RKSJ-H`) mix 1-byte ASCII with 2-byte codes, so the ranges must be honored
 * or ASCII gets mis-decoded as CJK.
 *
 * Yields `{ charCode, numBytes }` per code, in order. Operates on a Latin-1 byte
 * string (`charCodeAt(i)` ∈ [0, 255]); hex operands must be converted to bytes first.
 *
 * @param {string} bytes - the operand as a Latin-1 byte string
 * @param {ReadonlyArray<{bytes: number, low: number, high: number}> | null | undefined} csRanges
 *   the font's codespace ranges, or null/undefined to use `defaultBytes` for every code
 * @param {number} [defaultBytes] - byte width when `csRanges` is absent: 1 emits one code
 *   per byte (simple fonts); 2 reads code pairs and drops a trailing odd byte (CID fonts)
 * @returns {Generator<{charCode: number, numBytes: number}>}
 */
export function* decodeTextCodes(bytes, csRanges, defaultBytes = 1) {
  const len = bytes.length;
  let i = 0;
  while (i < len) {
    const b0 = bytes.charCodeAt(i);
    let charCode = b0;
    let numBytes = 1;
    if (csRanges) {
      let matched = false;
      for (let r = 0; r < csRanges.length; r++) {
        const range = csRanges[r];
        if (range.bytes === 1) {
          if (b0 >= range.low && b0 <= range.high) {
            charCode = b0;
            numBytes = 1;
            matched = true;
            break;
          }
        } else if (range.bytes === 2 && i + 1 < len) {
          const code2 = (b0 << 8) | bytes.charCodeAt(i + 1);
          if (code2 >= range.low && code2 <= range.high) {
            charCode = code2;
            numBytes = 2;
            matched = true;
            break;
          }
        }
      }
      if (!matched) {
        // Unmatched within a codespace: assume 2 bytes when a second byte exists, else 1.
        if (i + 1 < len) {
          charCode = (b0 << 8) | bytes.charCodeAt(i + 1);
          numBytes = 2;
        } else {
          charCode = b0;
          numBytes = 1;
        }
      }
    } else if (defaultBytes === 2) {
      // No ranges, 2-byte font: read pairs, drop a trailing single byte.
      if (i + 1 >= len) break;
      charCode = (b0 << 8) | bytes.charCodeAt(i + 1);
      numBytes = 2;
    } else {
      charCode = b0;
      numBytes = 1;
    }
    i += numBytes;
    yield { charCode, numBytes };
  }
}

/**
 * Find the byte offset of `needle` (an ASCII string) inside `bytes`, scanning forward from `from`.
 * Returns -1 if not found.
 * @param {Uint8Array} bytes
 * @param {string} needle - ASCII only
 * @param {number} [from=0]
 * @param {number} [end=bytes.length] - a match must start at or before `end - needle.length`
 */
export function byteIndexOf(bytes, needle, from = 0, end = bytes.length) {
  const nLen = needle.length;
  if (nLen === 0) return from;
  const c0 = needle.charCodeAt(0);
  const last = Math.min(bytes.length, end) - nLen;
  if (nLen === 1) {
    const idx = bytes.indexOf(c0, from);
    return (idx === -1 || idx > last) ? -1 : idx;
  }
  let i = from;
  // Jump to each occurrence of the first byte via native `indexOf`, then verify the rest in JS.
  // Faster than a plain byte-by-byte loop, especially for sparse needles.
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
 * Calculates the byte offset at which to stop converting an object to text.
 * For a stream object this is the end of the `stream` keyword, otherwise `endObj`.
 * @param {Uint8Array} bytes
 * @param {number} objStart - byte offset at or before the object's dictionary
 * @param {number} endObj - byte offset of the trailing `endobj`
 * @returns {number}
 */
export function objTextEnd(bytes, objStart, endObj) {
  // Find the object's dictionary opening '<<'.
  // A non-dict object (array, number, string) has none before endobj, so its text runs to endObj.
  const dictStart = byteIndexOf(bytes, '<<', objStart);
  if (dictStart === -1 || dictStart >= endObj) return endObj;

  // Balance-scan to the dictionary's own closing '>>'.
  // A naive "first >>" stops at the inner '>>' of a nested dict (e.g. /MK<<>> in a Widget annotation),
  // truncating the object early.
  // Literal strings '(...)' and hex strings '<...>' are skipped so a '<<'/'>>' inside a value (e.g. /V(...)) counts as data.
  let depth = 0;
  let i = dictStart;
  let dictEnd = -1;
  const limit = Math.min(endObj, bytes.length);
  while (i < limit) {
    const c = bytes[i];
    if (c === 0x28) {
      // Literal string: skip to its matching ')', honoring escapes and nesting.
      i++;
      let strDepth = 1;
      while (i < limit && strDepth > 0) {
        const sc = bytes[i];
        if (sc === 0x5C) { i += 2; continue; }
        if (sc === 0x28) strDepth++;
        else if (sc === 0x29) strDepth--;
        i++;
      }
    } else if (c === 0x3C && bytes[i + 1] === 0x3C) {
      depth++;
      i += 2;
    } else if (c === 0x3C) {
      // Hex string '<...>': skip to its closing '>' so its bytes are not misread as dict delimiters.
      i++;
      while (i < limit && bytes[i] !== 0x3E) i++;
      i++;
    } else if (c === 0x3E && bytes[i + 1] === 0x3E) {
      depth--;
      i += 2;
      if (depth === 0) { dictEnd = i; break; }
    } else {
      i++;
    }
  }
  if (dictEnd === -1) return endObj;

  // A stream object's `stream` keyword immediately follows the dict (whitespace only).
  // Checking the next token avoids matching the substring 'stream' inside a string value (e.g. the word "upstream").
  let p = dictEnd;
  while (p < limit && isPdfWhitespace(bytes[p])) p++;
  if (bytesEqualAt(bytes, p, 'stream')) return p + 'stream'.length;
  return endObj;
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
 * Extract a balanced << ... >> dictionary string directly from PDF bytes.
 * @param {Uint8Array} bytes
 * @param {number} start - byte offset of the first '<' of '<<'
 */
export function extractDictFromBytes(bytes, start) {
  let depth = 0;
  let i = start;
  const len = bytes.length;
  while (i < len) {
    if (bytes[i] === 0x28) {
      // Literal string '(...)': skip to its matching ')'
      // so that '<<'/'>>' bytes inside it count as string data, not dict delimiters.
      // A binary string value (e.g. an XRef stream dict's /ID[(...>>...)]) can hold a raw '>>'
      // which would otherwise decrement the dict depth to zero and return a dict truncated at that stray '>>',
      // before its real closing '>>'. Parentheses nest and may be backslash-escaped.
      i++;
      let strDepth = 1;
      while (i < len && strDepth > 0) {
        const c = bytes[i];
        if (c === 0x5C) { i += 2; continue; }
        if (c === 0x28) strDepth++;
        else if (c === 0x29) strDepth--;
        i++;
      }
    } else if (bytes[i] === 0x3C && i + 1 < len && bytes[i + 1] === 0x3C) {
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
 * Returns true if the bytes at `pos` look like "<digits> <digits> obj".
 * @param {Uint8Array} bytes
 * @param {number} pos
 */
export function matchesObjHeader(bytes, pos) {
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
export function matchesObjMarker(bytes, pos, objNum) {
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
export function matchesBareXrefEntry(bytes, pos) {
  if (pos + 18 >= bytes.length) return false;
  for (let j = 0; j < 10; j++) if (!isAsciiDigit(bytes[pos + j])) return false;
  if (bytes[pos + 10] !== 0x20) return false;
  for (let j = 11; j < 16; j++) if (!isAsciiDigit(bytes[pos + j])) return false;
  if (bytes[pos + 16] !== 0x20) return false;
  return bytes[pos + 17] === 0x66 || bytes[pos + 17] === 0x6E; // 'f' or 'n'
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
    if (text[i] === '(') {
      // Literal string '(...)': skip to its matching ')' so '<<'/'>>' bytes inside it count as string data,
      // not dict delimiters (e.g. a binary /ID holding a raw '>>' would otherwise close the dict early).
      // Parentheses nest and may be backslash-escaped.
      i++;
      let strDepth = 1;
      while (i < text.length && strDepth > 0) {
        const c = text[i];
        if (c === '\\') { i += 2; continue; }
        if (c === '(') strDepth++;
        else if (c === ')') strDepth--;
        i++;
      }
    } else if (text[i] === '<' && text[i + 1] === '<') {
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
 * Find a key (PDF name like '/Resources') at the top level of a dict body,
 * skipping over nested dicts, arrays, strings, and comments.
 * Naive `indexOf` matches nested occurrences (e.g. `/ExtGState` inside a marked-content
 * `/Properties` entry's own sub-dict), which produces incorrect splice points.
 *
 * @param {string} dictBody - Dict text WITHOUT outer `<<` / `>>` wrapper.
 *   (Pass `extractDict(text, start).slice(2, -2)` to get the body.)
 * @param {string} key - Name including leading slash, e.g. `/Resources`.
 * @returns {number} Index of the key's leading `/` in `dictBody`, or -1.
 */
export function findTopLevelKeyIndex(dictBody, key) {
  let depth = 0;
  let i = 0;
  const len = dictBody.length;
  while (i < len) {
    const c = dictBody.charCodeAt(i);
    if (c === 0x3C && dictBody.charCodeAt(i + 1) === 0x3C) { depth++; i += 2; continue; }
    if (c === 0x3E && dictBody.charCodeAt(i + 1) === 0x3E) { depth--; i += 2; continue; }
    if (c === 0x5B) { depth++; i++; continue; }
    if (c === 0x5D) { depth--; i++; continue; }
    if (c === 0x28) {
      let parenDepth = 1;
      i++;
      while (i < len && parenDepth > 0) {
        const sc = dictBody.charCodeAt(i);
        if (sc === 0x5C) { i += 2; continue; }
        if (sc === 0x28) parenDepth++;
        else if (sc === 0x29) parenDepth--;
        i++;
      }
      continue;
    }
    if (c === 0x3C) {
      const end = dictBody.indexOf('>', i);
      i = end < 0 ? len : end + 1;
      continue;
    }
    if (c === 0x25) {
      while (i < len) {
        const cc = dictBody.charCodeAt(i);
        if (cc === 0x0A || cc === 0x0D) break;
        i++;
      }
      continue;
    }
    if (depth === 0 && c === 0x2F && dictBody.startsWith(key, i)) {
      const after = dictBody.charCodeAt(i + key.length);
      // PDF name terminates on whitespace or a delimiter (one of /()<>[]{}%).
      if (Number.isNaN(after)
          || after === 0x20 || after === 0x09 || after === 0x0A || after === 0x0D || after === 0x0C
          || after === 0x2F || after === 0x28 || after === 0x29 || after === 0x3C || after === 0x3E
          || after === 0x5B || after === 0x5D || after === 0x7B || after === 0x7D || after === 0x25) {
        return i;
      }
    }
    i++;
  }
  return -1;
}

/**
 * Iterate the top-level name→value entries of a PDF dict body.
 * Walks the body character-by-character with proper handling of nested dicts,
 * arrays, strings, hex strings, name values, and indirect references.
 * Returns each entry as a `{ name, valueText }` pair where `valueText` is the literal source text
 * of the value (including outer brackets for arrays/dicts).
 *
 * @param {string} dictBody - Dict text WITHOUT outer `<<` / `>>` wrapper.
 * @returns {Array<{name: string, valueText: string}>}
 */
export function parseDictEntries(dictBody) {
  const entries = [];
  const len = dictBody.length;
  let i = 0;

  while (i < len) {
    while (i < len && /\s/.test(dictBody[i])) i++;
    if (i >= len) break;
    if (dictBody[i] !== '/') { i++; continue; }
    i++;
    let name = '';
    while (i < len && !/[\s/<>[\](){}%]/.test(dictBody[i])) { name += dictBody[i]; i++; }
    while (i < len && /\s/.test(dictBody[i])) i++;
    if (i >= len) break;

    const valueStart = i;
    const ch = dictBody[i];
    if (ch === '<' && dictBody[i + 1] === '<') {
      const sub = extractDict(dictBody, i);
      i += sub.length;
    } else if (ch === '[') {
      let depth = 1; i++;
      while (i < len && depth > 0) {
        if (dictBody[i] === '[') depth++;
        else if (dictBody[i] === ']') depth--;
        i++;
      }
    } else if (ch === '(') {
      let depth = 1; i++;
      while (i < len && depth > 0) {
        if (dictBody[i] === '\\') { i += 2; continue; }
        if (dictBody[i] === '(') depth++;
        else if (dictBody[i] === ')') depth--;
        i++;
      }
    } else if (ch === '<') {
      while (i < len && dictBody[i] !== '>') i++;
      if (i < len) i++;
    } else if (ch === '/') {
      i++;
      while (i < len && !/[\s/<>[\](){}%]/.test(dictBody[i])) i++;
    } else {
      const indirectMatch = /^(\d+)\s+(\d+)\s+R/.exec(dictBody.slice(i));
      if (indirectMatch) {
        i += indirectMatch[0].length;
      } else {
        while (i < len && !/[\s/<>[\]]/.test(dictBody[i])) i++;
      }
    }
    entries.push({ name, valueText: dictBody.slice(valueStart, i) });
  }

  return entries;
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
  let content = null;
  // PDF names end at whitespace or a delimiter: a bare indexOf would let the key match a longer name's prefix
  // (e.g. /C matching inside /Contents).
  const needle = `/${key}`;
  let keyIdx = -1;
  for (let idx = dictText.indexOf(needle); idx !== -1; idx = dictText.indexOf(needle, idx + 1)) {
    const nextCh = dictText[idx + needle.length];
    if (nextCh === undefined || /[\s()<>[\]{}/%]/.test(nextCh)) {
      keyIdx = idx;
      break;
    }
  }
  if (keyIdx !== -1) {
    const after = dictText.substring(keyIdx + key.length + 1).trimStart();
    if (after[0] === '[') {
      let depth = 0;
      for (let k = 0; k < after.length; k++) {
        if (after[k] === '[') depth++;
        else if (after[k] === ']') {
          depth--;
          if (depth === 0) {
            content = after.substring(1, k).trim();
            break;
          }
        }
      }
    }
  }
  if (content === null && objCache) {
    const refMatch = new RegExp(`/${key}\\s+(\\d+)\\s+\\d+\\s+R`).exec(dictText);
    if (refMatch) {
      const objText = objCache.getObjectText(Number(refMatch[1]));
      if (objText) {
        const arr = /\[\s*([\s\S]*?)\s*\]/.exec(stripObjWrapper(objText));
        if (arr) content = arr[1].trim();
      }
    }
  }
  if (content === null) return null;
  // Resolve element-level indirect references.
  if (objCache && /\d+\s+\d+\s+R/.test(content)) {
    content = content.replace(/(\d+)\s+\d+\s+R/g, (whole, num) => {
      const refText = objCache.getObjectText(Number(num));
      const v = refText != null ? /(-?[\d.]+)/.exec(stripObjWrapper(refText)) : null;
      return v ? v[1] : whole;
    });
  }
  return content;
}

/**
 * Resolve a /Key array of numbers from a PDF dict, handling indirect refs.
 * Returns an array of numbers or `defaultValue` if the key is absent or unparseable.
 * @param {string} dictText
 * @param {string} key
 * @param {ObjectCache|null} objCache
 * @param {number[]|null} [defaultValue=null]
 */
export function resolveNumArray(dictText, key, objCache, defaultValue = null) {
  const arrStr = resolveArrayValue(dictText, key, objCache);
  if (arrStr === null) return defaultValue;
  const nums = arrStr.split(/\s+/).filter((s) => s.length > 0).map(Number);
  if (nums.some(Number.isNaN)) return defaultValue;
  return nums;
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
 * Decode `#XX` hex escapes in a PDF name (e.g. `Foo#3A1` -> `Foo:1`).
 * @param {string} name - Name with the leading slash already stripped.
 */
export function decodePdfName(name) {
  return name.replace(/#([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

/**
 * PDF whitespace bytes per spec §3.1.1: NUL, HT, LF, FF, CR, SP.
 * @param {number} b
 */
export function isPdfWhitespace(b) {
  return b === 0x20 || b === 0x09 || b === 0x0A || b === 0x0D || b === 0x0C || b === 0x00;
}

/**
 * ASCII digit byte (0-9).
 * @param {number} b
 */
export function isAsciiDigit(b) {
  return b >= 0x30 && b <= 0x39;
}

/**
 * Parse a PDF literal string from raw bytes, handling escape sequences.
 * @param {Uint8Array} bytes - PDF file bytes
 * @param {number} start - Offset of the opening '(' character
 * @returns {{ value: Uint8Array, end: number }} Decoded bytes and offset past closing ')'
 */
export function parsePdfLiteralString(bytes, start) {
  const result = [];
  let depth = 1;
  let i = start + 1; // skip opening '('
  while (i < bytes.length && depth > 0) {
    const b = bytes[i];
    if (b === 0x5C) { // backslash
      i++;
      const next = bytes[i];
      const escapes = {
        0x6E: 0x0A, 0x72: 0x0D, 0x74: 0x09, 0x62: 0x08, 0x66: 0x0C, 0x28: 0x28, 0x29: 0x29, 0x5C: 0x5C,
      };
      if (escapes[next] !== undefined) {
        result.push(escapes[next]);
        i++;
      } else if (next >= 0x30 && next <= 0x37) { // octal \ddd
        let octal = next - 0x30;
        if (i + 1 < bytes.length && bytes[i + 1] >= 0x30 && bytes[i + 1] <= 0x37) {
          octal = octal * 8 + (bytes[++i] - 0x30);
          if (i + 1 < bytes.length && bytes[i + 1] >= 0x30 && bytes[i + 1] <= 0x37) {
            octal = octal * 8 + (bytes[++i] - 0x30);
          }
        }
        result.push(octal & 0xFF);
        i++;
      } else if (next === 0x0D || next === 0x0A) { // line continuation
        i++;
        if (next === 0x0D && i < bytes.length && bytes[i] === 0x0A) i++;
      } else {
        result.push(next);
        i++;
      }
    } else if (b === 0x28) { // (
      depth++;
      result.push(b);
      i++;
    } else if (b === 0x29) { // )
      depth--;
      if (depth > 0) result.push(b);
      i++;
    } else {
      result.push(b);
      i++;
    }
  }
  return { value: new Uint8Array(result), end: i };
}

/**
 * Parse a PDF hex string from raw bytes.
 * @param {Uint8Array} bytes - PDF file bytes
 * @param {number} start - Offset of the opening '<' character
 */
export function parsePdfHexString(bytes, start) {
  let hex = '';
  let i = start + 1; // skip opening '<'
  while (i < bytes.length && bytes[i] !== 0x3E) { // '>'
    const ch = bytes[i];
    if ((ch >= 0x30 && ch <= 0x39) || (ch >= 0x41 && ch <= 0x46) || (ch >= 0x61 && ch <= 0x66)) {
      hex += String.fromCharCode(ch);
    }
    i++;
  }
  if (hex.length % 2 !== 0) hex += '0'; // pad odd-length hex strings
  const result = new Uint8Array(hex.length / 2);
  for (let j = 0; j < result.length; j++) {
    result[j] = parseInt(hex.substring(j * 2, j * 2 + 2), 16);
  }
  return { value: result, end: i + 1 };
}

/**
 * Encode a JS string as a BOM-prefixed UTF-16BE hex string (no `<...>` wrapper), so any Unicode renders in every PDF viewer.
 * @param {string} str
 * @returns {string}
 */
export function toUtf16BeHex(str) {
  let hexStr = 'FEFF';
  for (let ci = 0; ci < str.length; ci++) {
    hexStr += str.charCodeAt(ci).toString(16).toUpperCase().padStart(4, '0');
  }
  return hexStr;
}

/**
 * Unescape a PDF literal string body (the text inside the outer parentheses): standard backslash escapes, 1-3 digit octal codes, and backslash line-continuation.
 * @param {string} body
 * @returns {string}
 */
function unescapePdfLiteral(body) {
  return body.replace(/\\(\r\n|\n|\r|[0-7]{1,3}|.)/g, (_m, e) => {
    switch (e) {
      case 'n': return '\n';
      case 'r': return '\r';
      case 't': return '\t';
      case 'b': return '\b';
      case 'f': return '\f';
      case '(': return '(';
      case ')': return ')';
      case '\\': return '\\';
      default:
        if (/^[0-7]{1,3}$/.test(e)) return String.fromCharCode(parseInt(e, 8) & 0xFF);
        if (e === '\n' || e === '\r' || e === '\r\n') return ''; // escaped newline = line continuation
        return e; // unknown escape: drop the backslash, keep the character
    }
  });
}

// PDFDocEncoding -> Unicode for the bytes that differ from Latin-1 (PDF 32000 Annex D.2).
// A byte absent from this map decodes as itself.
const PDF_DOC_ENCODING_DELTA = new Map([
  [0x18, 0x02D8], [0x19, 0x02C7], [0x1A, 0x02C6], [0x1B, 0x02D9], [0x1C, 0x02DD], [0x1D, 0x02DB], [0x1E, 0x02DA], [0x1F, 0x02DC],
  [0x80, 0x2022], [0x81, 0x2020], [0x82, 0x2021], [0x83, 0x2026], [0x84, 0x2014], [0x85, 0x2013], [0x86, 0x0192], [0x87, 0x2044],
  [0x88, 0x2039], [0x89, 0x203A], [0x8A, 0x2212], [0x8B, 0x2030], [0x8C, 0x201E], [0x8D, 0x201C], [0x8E, 0x201D], [0x8F, 0x2018],
  [0x90, 0x2019], [0x91, 0x201A], [0x92, 0x2122], [0x93, 0xFB01], [0x94, 0xFB02], [0x95, 0x0141], [0x96, 0x0152], [0x97, 0x0160],
  [0x98, 0x0178], [0x99, 0x017D], [0x9A, 0x0131], [0x9B, 0x0142], [0x9C, 0x0153], [0x9D, 0x0161], [0x9E, 0x017E], [0xA0, 0x20AC],
]);

/**
 * Decode the raw bytes of a PDF text string.
 * Input is a Latin-1 byte string: each char code is one byte.
 * @param {string} bytes
 * @returns {string}
 */
function decodeTextStringBytes(bytes) {
  let out;
  if (bytes.length >= 2 && bytes.charCodeAt(0) === 0xFE && bytes.charCodeAt(1) === 0xFF) {
    out = '';
    for (let i = 2; i + 1 < bytes.length; i += 2) out += String.fromCharCode((bytes.charCodeAt(i) << 8) | bytes.charCodeAt(i + 1));
  } else if (bytes.length >= 3 && bytes.charCodeAt(0) === 0xEF && bytes.charCodeAt(1) === 0xBB && bytes.charCodeAt(2) === 0xBF) {
    const arr = new Uint8Array(bytes.length - 3);
    for (let i = 3; i < bytes.length; i++) arr[i - 3] = bytes.charCodeAt(i);
    out = new TextDecoder().decode(arr);
  } else {
    out = '';
    for (let i = 0; i < bytes.length; i++) {
      const u = PDF_DOC_ENCODING_DELTA.get(bytes.charCodeAt(i));
      out += u === undefined ? bytes[i] : String.fromCharCode(u);
    }
  }
  // Some producers NUL-terminate the string. A trailing U+0000 is never displayable text.
  let end = out.length;
  while (end > 0 && out.charCodeAt(end - 1) === 0) end -= 1;
  return out.slice(0, end);
}

/**
 * Decode a PDF string token, delimiters included, to a JS string: hex `<...>` or literal `(...)`.
 * @param {string} token
 * @returns {string}
 */
export function decodePdfString(token) {
  if (typeof token !== 'string' || token.length === 0) return '';
  const t = token.trim();
  if (t[0] === '<') {
    let hex = t.replace(/^</, '').replace(/>$/, '').replace(/\s+/g, '');
    if (hex.length % 2 === 1) hex += '0'; // PDF pads a final odd nibble with 0
    let bytes = '';
    for (let i = 0; i + 1 < hex.length; i += 2) bytes += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
    return decodeTextStringBytes(bytes);
  }
  if (t[0] === '(') return decodeTextStringBytes(unescapePdfLiteral(t.slice(1, -1)));
  return t;
}

/**
 * Parse a PDF date string to a UTC ISO-8601 string.
 * Feed it the output of `decodePdfString`, not a raw PDF string token.
 * @param {string} str
 * @returns {?string}
 */
export function parsePdfDate(str) {
  if (typeof str !== 'string') return null;
  const m = /D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?(?:([+\-Z])(\d{2})?'?(\d{2})?'?)?/.exec(str);
  if (!m) return null;
  const [, y, mo = '01', d = '01', h = '00', mi = '00', s = '00', rel, oh = '00', om = '00'] = m;
  const offsetMin = (rel === '+' || rel === '-') ? (rel === '-' ? -1 : 1) * (Number(oh) * 60 + Number(om)) : 0;
  const utcMs = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)) - offsetMin * 60000;
  const date = new Date(utcMs);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

/**
 * Format an ISO-8601 string (or Date) as a PDF date string in UTC: `D:YYYYMMDDHHmmSS+00'00'`. Returns null on an invalid date.
 * @param {string|Date} iso
 * @returns {?string}
 */
export function formatPdfDate(iso) {
  const date = iso instanceof Date ? iso : new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const p = (/** @type {number} */ n) => String(n).padStart(2, '0');
  return `D:${date.getUTCFullYear()}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}`
    + `${p(date.getUTCHours())}${p(date.getUTCMinutes())}${p(date.getUTCSeconds())}+00'00'`;
}
