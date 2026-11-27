import ocr from '../../objects/ocrObjects.js';
import opentype from '../../font-parser/src/index.js';
import {
  findXrefOffset, parseXref,
} from '../parsePdfUtils.js';
import {
  extractDict, resolveIntValue, resolveNumValue, resolveArrayValue, resolveDictValue, decodePdfName, scopeDictKeys,
} from '../pdfPrimitives.js';
import { ObjectCache } from '../objectCache.js';
import {
  win1252Chars, macRomanChars, aglLookup, unicodeToAGL, wingdingsToUnicode, symbolToUnicode, dingbatsGlyphMap, dingbatsEncoding,
} from './standardEncodings.js';
import { applyStandardFontWidths, getDingbatsGlyphWidth, getStandardLigatureWidth } from './standardFontMetrics.js';
import { cffCharsetNamesToUnicode } from './convertFontToOTF.js';
import { parseCFFSummary } from '../../font-parser/src/cff.js';
import { getCIDToUnicodeMap } from './cidToUnicode.js';
import { cffStandardEncoding, standardNames } from '../../font-parser/src/encoding.js';
import { determineSansSerif } from '../../utils/miscUtils.js';

/**
 * @param {string} [name]
 */
export const normalizeFamilyForMatch = (name = '') => name.toLowerCase().replace(/psmt$|ps$|mt$/, '');
/**
 * Whether two normalized family names count as one family.
 * @param {string} a
 * @param {string} b
 */
export const familiesCompatible = (a, b) => {
  if (!a || !b) return false;
  return a === b || a.startsWith(b) || b.startsWith(a);
};

const identityShiftChecked = new WeakSet();

const LAZY_BFRANGE_MIN = 4096;

const TOUNICODE_CMAP_CACHE_MAX = 64;

/**
 * A font's code-to-text map.
 * `delete` does not remove codes defined by `addRange`.
 * @extends {Map<number, string>}
 */
export class ToUnicodeMap extends Map {
  /** @type {Array<{ start: number, end: number, valueAt: (code: number) => (string|undefined), definedCount: number, keysBefore: number, values: Array<string|null|undefined> }>} */
  #ranges = [];

  /**
   * Add a lazy code range when it overlaps no existing entry or range.
   * @param {number} start
   * @param {number} end
   * @param {(code: number) => (string|undefined)} valueAt
   * @param {number} definedCount
   * @returns {boolean} Whether the range was added.
   */
  addRange(start, end, valueAt, definedCount) {
    // Reads prefer explicit entries and earlier ranges over this one, but eager expansion would let this range overwrite them, so an overlapping range must be expanded instead.
    for (const k of super.keys()) if (k >= start && k <= end) return false;
    for (const r of this.#ranges) if (start <= r.end && end >= r.start) return false;
    this.#ranges.push({
      start, end, valueAt, definedCount, keysBefore: super.size, values: new Array(end - start + 1),
    });
    return true;
  }

  /**
   * @param {{ start: number, valueAt: (code: number) => (string|undefined), values: Array<string|null|undefined> }} r
   * @param {number} code
   * @returns {string|null}
   */
  static #valueOf(r, code) {
    let v = r.values[code - r.start];
    if (v === undefined) {
      v = r.valueAt(code) ?? null;
      r.values[code - r.start] = v;
    }
    return v;
  }

  /**
   * Look up `code` across lazy ranges.
   * @param {number} code
   * @returns {string|null|undefined} The mapped string, `null` for an unmapped slot inside a range, or `undefined` outside all ranges.
   */
  #rangeValue(code) {
    for (let i = 0; i < this.#ranges.length; i++) {
      const r = this.#ranges[i];
      if (code >= r.start && code <= r.end) return ToUnicodeMap.#valueOf(r, code);
    }
    return undefined;
  }

  /** @param {number} code */
  get(code) {
    const own = super.get(code);
    return own !== undefined ? own : (this.#rangeValue(code) ?? undefined);
  }

  /** @param {number} code */
  has(code) {
    return super.has(code) || typeof this.#rangeValue(code) === 'string';
  }

  get size() {
    if (this.#ranges.length === 0) return super.size;
    let n = super.size;
    for (const r of this.#ranges) n += r.definedCount;
    for (const k of super.keys()) if (typeof this.#rangeValue(k) === 'string') n--;
    return n;
  }

  /** Entries in first-insertion order. */
  * entries() {
    if (this.#ranges.length === 0) { yield* super.entries(); return; }
    const explicit = [...super.entries()];
    let ei = 0;
    const overridden = explicit.length > 0;
    for (const r of this.#ranges) {
      for (; ei < r.keysBefore; ei++) if (typeof this.#rangeValue(explicit[ei][0]) !== 'string') yield explicit[ei];
      for (let code = r.start; code <= r.end; code++) {
        const v = ToUnicodeMap.#valueOf(r, code);
        if (v === null) continue;
        const own = overridden ? super.get(code) : undefined;
        yield /** @type {[number, string]} */ ([code, own !== undefined ? own : v]);
      }
    }
    for (; ei < explicit.length; ei++) if (typeof this.#rangeValue(explicit[ei][0]) !== 'string') yield explicit[ei];
  }

  * keys() {
    if (this.#ranges.length === 0) { yield* super.keys(); return; }
    for (const [k] of this.entries()) yield k;
  }

  * values() { for (const [, v] of this.entries()) yield v; }

  [Symbol.iterator]() { return this.entries(); }

  /**
   * @param {(value: string, key: number, map: Map<number, string>) => void} cb
   * @param {any} [thisArg]
   */
  forEach(cb, thisArg) { for (const [k, v] of this.entries()) cb.call(thisArg, v, k, this); }

  /** A copy with its own explicit entries that shares this map's ranges and their value caches. */
  clone() {
    const copy = new ToUnicodeMap();
    copy.#ranges = this.#ranges.slice();
    for (const [k, v] of super.entries()) copy.set(k, v);
    return copy;
  }

  clear() {
    super.clear(); this.#ranges = [];
  }
}

/**
 * The parsed form of a ToUnicode CMap, cached per document.
 * @param {string} cmapText
 * @param {import('../objectCache.js').ObjectCache} objCache
 * @returns {ToUnicodeMap} Shared by every font using this CMap, so a caller takes a `clone()` and never writes to it.
 */
function parsedToUnicodeCMap(cmapText, objCache) {
  const cache = objCache.toUnicodeCMapCache;
  let parsed = cache.get(cmapText);
  if (parsed === undefined) {
    parsed = new ToUnicodeMap();
    parseToUnicodeCMap(cmapText, parsed);
    if (cache.size >= TOUNICODE_CMAP_CACHE_MAX) cache.delete(cache.keys().next().value);
    cache.set(cmapText, parsed);
  }
  return parsed;
}

// Half-font-unit counts per em (2 * unitsPerEm) for standard font grids (2048, 1000, 256, 1024, 512, 4096).
// Scaling to their LCM (1024000) turns a coordinate snapped to any of those grids into the same integer regardless of unitsPerEm.
const GLYPH_LATTICES = [4096, 2000, 512, 2048, 1024, 8192];
const GLYPH_LATTICE_LCM = 1024000;

/**
 * Stable hex hash of a parsed Type3 glyph outline.
 * One outline hashes alike wherever it appears, across fonts, pages, and documents.
 * @param {Array<{ type: string, x?: number, y?: number, x1?: number, y1?: number, x2?: number, y2?: number }>} commands
 * @param {number[]} fontMatrix
 */
export function hashGlyphCommands(commands, fontMatrix) {
  const [ma, mb, mc, md, me, mf] = fontMatrix;
  /** Interleaved em-space x and y coordinates in command order. */
  const coords = [];
  const types = [];
  for (let i = 0; i < commands.length; i++) {
    const c = commands[i];
    types.push(c.type.charCodeAt(0));
    const pairs = c.type === 'C' ? [[c.x1, c.y1], [c.x2, c.y2], [c.x, c.y]] : c.x === undefined ? [] : [[c.x, c.y]];
    for (const [x, y] of pairs) {
      coords.push(ma * x + mc * y + me, mb * x + md * y + mf);
    }
  }
  let lattice = GLYPH_LATTICES[0];
  let bestResidual = Infinity;
  for (const u of GLYPH_LATTICES) {
    let residual = 0;
    for (let i = 0; i < coords.length; i++) {
      const v = coords[i] * u;
      residual += Math.abs(v - Math.round(v)) / u;
    }
    if (residual < bestResidual) { bestResidual = residual; lattice = u; }
  }
  const scale = GLYPH_LATTICE_LCM / lattice;
  let h1 = 0x811c9dc5 >>> 0;
  let h2 = 0xcbf29ce4 >>> 0;
  const mix = (b) => {
    h1 = Math.imul(h1 ^ (b & 0xff), 16777619) >>> 0;
    h2 = Math.imul(h2 ^ ((b >>> 8) & 0xff), 16777619) >>> 0;
  };
  for (let i = 0; i < types.length; i++) mix(types[i]);
  for (let i = 0; i < coords.length; i++) {
    const n = (Math.round(coords[i] * lattice) * scale) | 0;
    mix(n);
    mix(n >>> 8);
    mix(n >>> 16);
    mix(n >>> 24);
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

/**
 * Resolve a CIDFont's embedded TrueType program bytes from its FontDescriptor.
 * @param {string} fdText
 * @param {ObjectCache} objCache
 * @returns {Uint8Array | null}
 */
function resolveCidTrueTypeProgram(fdText, objCache) {
  let ffRefMatch = /\/FontFile2\s+(\d+)\s+\d+\s+R/.exec(fdText);
  // Some producers store a TrueType sfnt stream under /FontFile instead of /FontFile2.
  if (!ffRefMatch) {
    const ff1RefMatch = /\/FontFile\s+(\d+)\s+\d+\s+R/.exec(fdText);
    if (ff1RefMatch) {
      const probe = objCache.getStreamBytes(Number(ff1RefMatch[1]));
      const magic = probe && probe.length >= 4
        ? ((probe[0] << 24) | (probe[1] << 16) | (probe[2] << 8) | probe[3]) >>> 0 : 0;
      if (magic === 0x00010000 || magic === 0x74727565) ffRefMatch = ff1RefMatch;
    }
  }
  if (!ffRefMatch) return null;
  return objCache.getStreamBytes(Number(ffRefMatch[1]));
}

/**
 * Parse a TrueType font's `cmap` table into a reverse GID -> Unicode map.
 * @param {Uint8Array} fontFile
 */
function buildGidToUnicodeFromTrueType(fontFile) {
  try {
    const data = new DataView(fontFile.buffer, fontFile.byteOffset, fontFile.byteLength);
    const cmapEntry = opentype.readSfntTableDirectory(data).cmap;
    if (!cmapEntry) return null;
    const cmap = opentype.parseCmapTable(data, cmapEntry.offset);
    if (!cmap || !cmap.glyphIndexMap) return null;
    const gidToUnicode = new Map();
    for (const [unicodeStr, gid] of Object.entries(cmap.glyphIndexMap)) {
      if (gid > 0 && !gidToUnicode.has(gid)) {
        gidToUnicode.set(gid, Number(unicodeStr));
      }
    }
    return gidToUnicode;
  } catch (e) {
    return null;
  }
}

/**
 * Parse the plaintext `/Encoding ... dup N /glyphname put ...` block at the start of a Type1 PFA.
 * @param {Uint8Array} fontFile
 * @returns {Map<number, string>|null}
 */
function parseType1PFAEncoding(fontFile) {
  try {
    const sampleLen = Math.min(fontFile.length, 16384);
    let txt = '';
    for (let i = 0; i < sampleLen; i++) txt += String.fromCharCode(fontFile[i]);
    const start = txt.indexOf('/Encoding');
    if (start < 0) return null;
    const end = txt.indexOf('currentfile eexec', start);
    const block = end > 0 ? txt.substring(start, end) : txt.substring(start);
    const map = new Map();
    for (const m of block.matchAll(/dup\s+(\d+)\s+\/([^\s/<>[\]]+)\s+put/g)) {
      const code = Number(m[1]);
      if (Number.isInteger(code) && code >= 0 && code <= 255) {
        map.set(code, m[2]);
      }
    }
    return map.size > 0 ? map : null;
  } catch (e) {
    return null;
  }
}

/**
 * @param {Uint8Array} fontFile
 */
function buildEmptyGlyphSetFromTrueType(fontFile) {
  try {
    const data = new DataView(fontFile.buffer, fontFile.byteOffset, fontFile.byteLength);
    const dir = opentype.readSfntTableDirectory(data);
    if (!dir.glyf || !dir.loca || !dir.head || !dir.maxp) return null;
    const locaOff = dir.loca.offset;
    const idxFmt = data.getUint16(dir.head.offset + 50);
    const numGlyphs = data.getUint16(dir.maxp.offset + 4);
    const empty = new Set();
    for (let gid = 0; gid < numGlyphs; gid++) {
      const start = idxFmt === 0
        ? data.getUint16(locaOff + gid * 2) * 2
        : data.getUint32(locaOff + gid * 4);
      const end = idxFmt === 0
        ? data.getUint16(locaOff + (gid + 1) * 2) * 2
        : data.getUint32(locaOff + (gid + 1) * 4);
      if (end === start) empty.add(gid);
    }
    return empty;
  } catch (e) {
    return null;
  }
}

/** Per-font TrueType outline readers, built on first use. */
const glyphInkReaders = new WeakMap();

/**
 * Read a glyph's outline bounding box from the embedded TrueType `glyf` table.
 * Coordinates are in em units, with `x` from the pen origin and `y` upward from the baseline.
 * @param {Object} fontInfo
 * @param {number} charCode
 * @returns {?{left: number, right: number, yMin: number, yMax: number}} `null` when no non-empty TrueType outline is available.
 */
export function glyphInkBox(fontInfo, charCode) {
  let reader = glyphInkReaders.get(fontInfo);
  if (reader === undefined) {
    reader = null;
    const program = fontInfo.type0?.fontFile || fontInfo.type1?.fontFile;
    const sfntTrueType = program && program.length > 4
      && ((program[0] === 0 && program[1] === 1 && program[2] === 0 && program[3] === 0)
        || (program[0] === 0x74 && program[1] === 0x72 && program[2] === 0x75 && program[3] === 0x65));
    if (sfntTrueType) {
      try {
        const data = new DataView(program.buffer, program.byteOffset, program.byteLength);
        const dir = opentype.readSfntTableDirectory(data);
        const unitsPerEm = dir.head ? data.getUint16(dir.head.offset + 18) : 0;
        if (dir.glyf && dir.loca && dir.maxp && unitsPerEm > 0) {
          let codeToGid = null;
          let symbolCmap = false;
          if (!fontInfo.type0 && dir.cmap) {
            const cmap = opentype.parseCmapTable(data, dir.cmap.offset);
            codeToGid = cmap?.glyphIndexMap || null;
            symbolCmap = cmap?.platformID === 3 && cmap?.encodingID === 0;
          }
          reader = {
            data,
            glyfOffset: dir.glyf.offset,
            locaOffset: dir.loca.offset,
            longLoca: data.getUint16(dir.head.offset + 50) !== 0,
            numGlyphs: data.getUint16(dir.maxp.offset + 4),
            unitsPerEm,
            codeToGid,
            symbolCmap,
          };
        }
      } catch {
        reader = null;
      }
    }
    glyphInkReaders.set(fontInfo, reader);
  }
  if (!reader) return null;

  let gid = -1;
  if (fontInfo.type0) {
    const cid = fontInfo.charCodeToCID?.get(charCode) ?? charCode;
    const cidToGid = fontInfo.type0.cidToGidMap;
    if (cidToGid instanceof Uint8Array) {
      gid = cid * 2 + 1 < cidToGid.length ? (cidToGid[cid * 2] << 8) | cidToGid[cid * 2 + 1] : -1;
    } else {
      gid = cid;
    }
  } else if (reader.codeToGid) {
    const symbolGid = reader.symbolCmap ? reader.codeToGid[0xF000 | charCode] : undefined;
    gid = symbolGid ?? reader.codeToGid[charCode] ?? -1;
  }
  if (!(gid >= 0) || gid >= reader.numGlyphs) return null;

  const { data } = reader;
  const start = reader.longLoca
    ? data.getUint32(reader.locaOffset + gid * 4)
    : data.getUint16(reader.locaOffset + gid * 2) * 2;
  const end = reader.longLoca
    ? data.getUint32(reader.locaOffset + (gid + 1) * 4)
    : data.getUint16(reader.locaOffset + (gid + 1) * 2) * 2;
  if (end - start < 10 || reader.glyfOffset + end > data.byteLength) return null;
  const entry = reader.glyfOffset + start;
  const upem = reader.unitsPerEm;
  return {
    left: data.getInt16(entry + 2) / upem,
    yMin: data.getInt16(entry + 4) / upem,
    right: data.getInt16(entry + 6) / upem,
    yMax: data.getInt16(entry + 8) / upem,
  };
}

/**
 * Decide whether an embedded TrueType subset's high-byte encoding is MacRoman or Win1252 by comparing `/Widths` against standard AFM widths.
 * @param {Map<number, number>} widths
 * @param {string} baseName
 */
function disambiguateMacWinByWidths(widths, baseName) {
  const stdWidths = new Map();
  applyStandardFontWidths(baseName, stdWidths);
  if (stdWidths.size === 0) return null;
  const winAnsiCharToCC = new Map();
  for (let cc = 32; cc <= 255; cc++) {
    const ch = win1252Chars[cc - 32];
    if (ch) winAnsiCharToCC.set(ch, cc);
  }
  let macVotes = 0;
  let winVotes = 0;
  for (let cc = 0x80; cc <= 0xFF; cc++) {
    const actual = widths.get(cc);
    if (!actual) continue;
    const macChar = macRomanChars[cc - 32];
    const winChar = win1252Chars[cc - 32];
    if (!macChar || !winChar || macChar === winChar) continue;
    const macAFMcc = winAnsiCharToCC.get(macChar);
    if (macAFMcc == null) continue;
    const macExpected = stdWidths.get(macAFMcc);
    const winExpected = stdWidths.get(cc);
    if (!macExpected || !winExpected || macExpected === winExpected) continue;
    const macDiff = Math.abs(actual - macExpected);
    const winDiff = Math.abs(actual - winExpected);
    if (macDiff < winDiff) macVotes++;
    else if (winDiff < macDiff) winVotes++;
  }
  if (macVotes >= 2 && macVotes > winVotes * 2) return 'MacRoman';
  if (winVotes >= 2 && winVotes > macVotes * 2) return 'Win1252';
  return null;
}

/**
 * Whether a PDF `BaseFont` or `FontName` is a generic placeholder like `F1` or `CIDFont+F1`.
 * @param {string} name
 */
function isPlaceholderFontName(name) {
  return /^CIDFont(?:[+\- ]F?\d+)?$/i.test(name)
    || /^Font(?:[+\- ]?F?\d+)$/i.test(name)
    || /^F\d+$/i.test(name);
}

/**
 * @typedef {{
 *   fontMatrix: number[],
 *   fontBBox: number[],
 *   name: string|null,
 *   encoding: { [charCode: number]: string },
 *   glyphs: { [glyphName: string]: GlyphInfo },
 *   charProcObjNums: { [glyphName: string]: number }
 * }} FontInfo
 *
 * @typedef {{
 *   bbox: { x0: number, y0: number, x1: number, y1: number } | null,
 *   advanceWidth: number,
 *   placeholderD1?: boolean,
 * }} GlyphInfo
 */

/**
 * Extract Type3 font glyph bounding boxes directly from raw PDF bytes.
 * @param {Uint8Array} pdfBytes
 * @returns {{ [fontObjNum: number]: FontInfo }}
 */
export function extractType3GlyphBBoxes(pdfBytes) {
  const xrefOffset = findXrefOffset(pdfBytes);
  const xrefEntries = parseXref(pdfBytes, xrefOffset);
  const objCache = new ObjectCache(pdfBytes, xrefEntries);
  // Doc-wide object enumeration below needs the complete xref, so finish the deferred repair.
  objCache.ensureXrefRepaired();

  const result = {};
  for (const [objNum, entry] of Object.entries(xrefEntries)) {
    const objText = objCache.getObjectText(Number(objNum));
    if (!objText) continue;
    if (!objText.includes('/Subtype') || !objText.includes('/Type3')) continue;
    if (!/\/Subtype\s*\/Type3/.test(objText)) continue;

    const fontInfo = parseType3Font(objText, objCache);
    if (fontInfo) {
      result[Number(objNum)] = fontInfo;
    }
  }

  return result;
}

/**
 * Enumerate every visible Type3 glyph in a PDF, deduplicated by path-content hash.
 * @param {Uint8Array} pdfBytes
 * @returns {Array<{
 *   pathHash: string,
 *   commands: any[],
 *   bbox: { x0: number, y0: number, x1: number, y1: number },
 *   advanceWidth: number,
 *   fontMatrix: number[],
 *   fontBBox: number[],
 *   exampleCharCode: number,
 *   exampleGlyphName: string,
 *   exampleFontObjNum: number,
 * }>}
 */
export function extractType3DistinctGlyphs(pdfBytes) {
  const xrefOffset = findXrefOffset(pdfBytes);
  const xrefEntries = parseXref(pdfBytes, xrefOffset);
  const objCache = new ObjectCache(pdfBytes, xrefEntries);

  const seen = new Map();
  for (const [objNum, fontInfo] of enumerateType3Fonts(objCache)) {
    for (const [charCodeStr, glyphName] of Object.entries(fontInfo.encoding)) {
      const glyph = fontInfo.glyphs[glyphName];
      if (!glyph || !glyph.pathHash) continue;
      if (!glyph.bbox) continue;
      if (seen.has(glyph.pathHash)) continue;
      seen.set(glyph.pathHash, {
        pathHash: glyph.pathHash,
        commands: glyph.commands,
        bbox: glyph.bbox,
        advanceWidth: glyph.advanceWidth,
        fontMatrix: fontInfo.fontMatrix,
        fontBBox: fontInfo.fontBBox,
        exampleCharCode: Number(charCodeStr),
        exampleGlyphName: glyphName,
        exampleFontObjNum: objNum,
      });
    }
  }
  return [...seen.values()];
}

/**
 * Every Type 3 font object in the file, parsed.
 * @param {ObjectCache} objCache
 * @returns {Array<[number, NonNullable<ReturnType<typeof parseType3Font>>]>} `[objNum, fontInfo]` pairs.
 */
export function enumerateType3Fonts(objCache) {
  // Doc-wide object enumeration needs the complete xref, so finish the deferred repair.
  objCache.ensureXrefRepaired();
  const fonts = [];
  for (const objNumStr of Object.keys(objCache.xrefEntries)) {
    const objNum = Number(objNumStr);
    const objText = objCache.getObjectText(objNum);
    if (!objText || !/\/Subtype\s*\/Type3/.test(objText)) continue;
    const fontInfo = parseType3Font(objText, objCache);
    if (fontInfo) fonts.push([objNum, fontInfo]);
  }
  return fonts;
}

// Bare `d` also covers `d0` and `d1`, whose digits the `[a-zA-Z*]+` token scan strips.
// Path-construction operators are omitted so a CharProc whose path failed to parse is not marked empty.
const NON_MARKING_CHARPROC_OPS = new Set([
  'd0', 'd1', 'd',
  'q', 'Q', 'cm', 'gs',
  'w', 'J', 'j', 'M', 'ri', 'i',
  'g', 'G', 'rg', 'RG', 'k', 'K', 'cs', 'CS', 'sc', 'SC', 'scn', 'SCN',
  'W', 'W*', 'n',
  'BMC', 'BDC', 'EMC', 'MP', 'DP', 'BX', 'EX',
]);

/**
 * Parse a Type3 font object and extract glyph bounding boxes.
 * @param {string} objText
 * @param {ObjectCache} objCache
 */
export function parseType3Font(objText, objCache) {
  const fmStr = resolveArrayValue(objText, 'FontMatrix', objCache);
  const fontMatrix = fmStr ? fmStr.split(/\s+/).map(Number) : [0.001, 0, 0, 0.001, 0, 0];

  const fbStr = resolveArrayValue(objText, 'FontBBox', objCache);
  const fontBBox = fbStr ? fbStr.split(/\s+/).map(Number) : [0, 0, 0, 0];

  const nameMatch = /\/Name\s*\/([^\s/]+)/.exec(objText);
  const name = nameMatch ? nameMatch[1] : null;

  const encoding = {};
  const encRefMatch = /\/Encoding\s+(\d+)\s+\d+\s+R/.exec(objText);
  let encText = objText;
  if (encRefMatch) {
    const encObj = objCache.getObjectText(Number(encRefMatch[1]));
    if (encObj) encText = encObj;
  }
  const diffStr = resolveArrayValue(encText, 'Differences', objCache);
  if (diffStr) {
    const diffContent = diffStr;
    const tokens = diffContent.match(/\/[^\s/]+|\d+/g);
    if (tokens) {
      let charCode = 0;
      for (const tok of tokens) {
        if (tok.startsWith('/')) {
          encoding[charCode] = tok.substring(1);
          charCode++;
        } else {
          charCode = Number(tok);
        }
      }
    }
  }

  const charProcsStart = objText.indexOf('/CharProcs');
  if (charProcsStart === -1) return null;

  let charProcsDict;
  const charProcsAfter = objText.substring(charProcsStart + 10).trim();
  if (charProcsAfter.startsWith('<<')) {
    charProcsDict = extractDict(objText, charProcsStart + 10 + (objText.substring(charProcsStart + 10).indexOf('<<')));
  } else {
    const cpRefMatch = /^(\d+)\s+\d+\s+R/.exec(charProcsAfter);
    if (!cpRefMatch) return null;
    const cpObjText = objCache.getObjectText(Number(cpRefMatch[1]));
    if (!cpObjText) return null;
    charProcsDict = cpObjText;
  }

  const glyphs = {};
  /** @type {{ [glyphName: string]: number }} */
  const charProcObjNums = {};
  const charProcRegex = /\/(\S+?)\s+(\d+)\s+\d+\s+R/g;
  let match;
  while ((match = charProcRegex.exec(charProcsDict)) !== null) {
    const glyphName = match[1];
    const streamObjNum = Number(match[2]);
    charProcObjNums[glyphName] = streamObjNum;

    const streamBytes = objCache.getStreamBytes(streamObjNum);
    if (!streamBytes) {
      glyphs[glyphName] = { bbox: null, advanceWidth: 0, provablyEmpty: false };
      continue;
    }

    const streamText = new TextDecoder('latin1').decode(streamBytes);
    const parsed = parseGlyphStream(streamText);
    const pathData = parseGlyphStreamPaths(streamText);
    // Bitmaps, Do, nested text, and shadings paint with zero path commands, so emptiness requires every operator to be non-marking.
    let provablyEmpty = true;
    for (const op of streamText.replace(/%[^\r\n]*/g, '').match(/[a-zA-Z*]+/g) || []) {
      if (!NON_MARKING_CHARPROC_OPS.has(op)) { provablyEmpty = false; break; }
    }
    glyphs[glyphName] = {
      ...parsed,
      commands: pathData.commands,
      pathHash: pathData.commands && pathData.commands.length
        ? hashGlyphCommands(pathData.commands, fontMatrix) : null,
      paintMode: pathData.paintMode,
      evenOdd: pathData.evenOdd,
      lineWidth: pathData.lineWidth,
      dashArray: pathData.dashArray,
      dashPhase: pathData.dashPhase,
      isD0: pathData.isD0,
      isD1: pathData.isD1,
      provablyEmpty,
    };
  }

  /** @type {{ [name: string]: number }} */
  const xobjectResources = {};
  const resIdx = objText.indexOf('/Resources');
  if (resIdx !== -1) {
    let resText = objText;
    const resRefMatch = /\/Resources\s+(\d+)\s+\d+\s+R/.exec(objText);
    if (resRefMatch) {
      const rObj = objCache.getObjectText(Number(resRefMatch[1]));
      if (rObj) resText = rObj;
    }
    const xobjIdx = resText.indexOf('/XObject');
    if (xobjIdx !== -1) {
      const afterXObj = resText.substring(xobjIdx + 8).trim();
      let xobjDict = '';
      if (afterXObj.startsWith('<<')) {
        xobjDict = extractDict(resText, xobjIdx + 8 + resText.substring(xobjIdx + 8).indexOf('<<')) || '';
      } else {
        const xobjRefMatch = /^(\d+)\s+\d+\s+R/.exec(afterXObj);
        if (xobjRefMatch) {
          const xo = objCache.getObjectText(Number(xobjRefMatch[1]));
          if (xo) xobjDict = xo;
        }
      }
      for (const xm of xobjDict.matchAll(/\/([^\s/]+)\s+(\d+)\s+\d+\s+R/g)) {
        xobjectResources[xm[1]] = Number(xm[2]);
      }
    }
  }

  return {
    fontMatrix, fontBBox, name, encoding, glyphs, charProcObjNums, xobjectResources,
  };
}

/**
 * Parse a Type3 glyph stream and compute its bounding box.
 * @param {string} streamText
 * @returns {GlyphInfo}
 */
function parseGlyphStream(streamText) {
  let advanceWidth = 0;
  let placeholderD1 = false;
  const d1Match = /([\d.-]+)\s+([\d.-]+)\s+([\d.-]+)\s+([\d.-]+)\s+([\d.-]+)\s+([\d.-]+)\s+d1/.exec(streamText);
  if (d1Match) {
    advanceWidth = Number(d1Match[1]);
    const llx = Number(d1Match[3]);
    const lly = Number(d1Match[4]);
    const urx = Number(d1Match[5]);
    const ury = Number(d1Match[6]);
    placeholderD1 = Math.abs(llx + 10) < 1e-6 && Math.abs(lly + 10) < 1e-6
      && Math.abs(urx - 10) < 1e-6 && Math.abs(ury - 10) < 1e-6;
  } else {
    const d0Match = /([\d.-]+)\s+([\d.-]+)\s+d0(?![\dA-Za-z])/.exec(streamText);
    if (d0Match) advanceWidth = Number(d0Match[1]);
  }

  let tx = 0;
  let ty = 0;
  const cmMatch = /q\s+[\d.-]+\s+[\d.-]+\s+[\d.-]+\s+[\d.-]+\s+([\d.-]+)\s+([\d.-]+)\s+cm/.exec(streamText);
  if (cmMatch) {
    tx = Number(cmMatch[1]);
    ty = Number(cmMatch[2]);
  }

  const points = [];

  const drawingStart = cmMatch ? streamText.indexOf('cm', cmMatch.index) + 2 : 0;
  const drawingPart = streamText.substring(drawingStart);

  const tokens = drawingPart.match(/[+-]?(?:\d+\.?\d*|\.\d+)|[a-zA-Z]+/g);
  if (!tokens) return { bbox: null, advanceWidth };

  const numStack = [];
  for (const tok of tokens) {
    const num = Number(tok);
    if (!Number.isNaN(num) && /^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(tok)) {
      numStack.push(num);
    } else {
      switch (tok) {
        case 'm':
          if (numStack.length >= 2) {
            const y = numStack.pop();
            const x = numStack.pop();
            points.push(x + tx, y + ty);
          }
          numStack.length = 0;
          break;
        case 'l':
          if (numStack.length >= 2) {
            const y = numStack.pop();
            const x = numStack.pop();
            points.push(x + tx, y + ty);
          }
          numStack.length = 0;
          break;
        case 'c':
          if (numStack.length >= 6) {
            const y3 = numStack.pop();
            const x3 = numStack.pop();
            const y2 = numStack.pop();
            const x2 = numStack.pop();
            const y1 = numStack.pop();
            const x1 = numStack.pop();
            points.push(x1 + tx, y1 + ty, x2 + tx, y2 + ty, x3 + tx, y3 + ty);
          }
          numStack.length = 0;
          break;
        case 're':
          if (numStack.length >= 4) {
            const h = numStack.pop();
            const w = numStack.pop();
            const y = numStack.pop();
            const x = numStack.pop();
            points.push(x + tx, y + ty, x + w + tx, y + h + ty);
          }
          numStack.length = 0;
          break;
        default:
          numStack.length = 0;
          break;
      }
    }
  }

  if (points.length === 0) {
    // Non-path glyphs (inline images, XObjects) produce no points, so fall back to a non-empty d1 bbox.
    if (d1Match) {
      const llx = Number(d1Match[3]);
      const lly = Number(d1Match[4]);
      const urx = Number(d1Match[5]);
      const ury = Number(d1Match[6]);
      if (placeholderD1) {
        return { bbox: null, advanceWidth, placeholderD1 };
      }
      if (urx > llx || ury > lly) {
        return {
          bbox: {
            x0: llx, y0: lly, x1: urx, y1: ury,
          },
          advanceWidth,
          placeholderD1,
        };
      }
    }
    return { bbox: null, advanceWidth, placeholderD1 };
  }

  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (let i = 0; i < points.length; i += 2) {
    const x = points[i];
    const y = points[i + 1];
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
  }

  return {
    bbox: {
      x0, y0, x1, y1,
    },
    advanceWidth,
    placeholderD1,
  };
}

/**
 * Parse fonts from a page's Resources dictionary.
 * @param {string} pageObjText
 * @param {ObjectCache} objCache
 * @param {Map<string, string>} [type3GlyphMappings] - Optional `pathHash -> unicode` overrides for unmapped Type3 glyphs.
 */
export function parsePageFonts(pageObjText, objCache, type3GlyphMappings) {
  const fonts = new Map();

  const resourcesText = resolveDictValue(scopeDictKeys(pageObjText).keyText('Resources'), 'Resources', objCache);
  const fontDictText = resourcesText && resolveDictValue(scopeDictKeys(resourcesText).keyText('Font'), 'Font', objCache);
  if (!fontDictText) return fonts;

  const fontEntryPairs = [];
  const fontEntryRegex = /\/([^\s/]+)\s+(\d+)\s+\d+\s+R/g;
  for (const match of fontDictText.matchAll(fontEntryRegex)) {
    const fontObjNum = Number(match[2]);
    const fontObjText = objCache.getObjectText(fontObjNum);
    const fontTag = decodePdfName(match[1]);
    if (fontObjText) fontEntryPairs.push([fontTag, fontObjText, fontObjNum]);
  }
  {
    let depth = 0;
    for (let i = 0; i < fontDictText.length; i++) {
      if (fontDictText[i] === '<' && fontDictText[i + 1] === '<') {
        depth++;
        i++;
      } else if (fontDictText[i] === '>' && fontDictText[i + 1] === '>') {
        depth--;
        i++;
      } else if (depth === 1 && fontDictText[i] === '/') {
        const nameMatch = /^\/([^\s/<>[\]]+)/.exec(fontDictText.substring(i));
        if (nameMatch) {
          const tag = decodePdfName(nameMatch[1]);
          const afterIdx = i + nameMatch[0].length;
          const afterName = fontDictText.substring(afterIdx).trimStart();
          if (afterName.startsWith('<<') && !fontEntryPairs.some(([t]) => t === tag)) {
            const dictPos = afterIdx + fontDictText.substring(afterIdx).indexOf('<<');
            const fontObjText = extractDict(fontDictText, dictPos);
            if (fontObjText) {
              fontEntryPairs.push([tag, fontObjText, null]);
              i = dictPos + fontObjText.length - 1;
            }
          }
        }
      }
    }
  }
  // Include inner fonts from each Type3 font's own /Resources /Font so nested BT/ET text in CharProcs can resolve and render them.
  const type3FontObjTexts = fontEntryPairs
    .filter(([, obj]) => /\/Subtype\s*\/Type3/.test(obj))
    .map(([, obj]) => obj);
  for (const t3Obj of type3FontObjTexts) {
    let t3ResText = t3Obj;
    const t3ResRef = /\/Resources\s+(\d+)\s+\d+\s+R/.exec(t3Obj);
    if (t3ResRef) {
      const resObj = objCache.getObjectText(Number(t3ResRef[1]));
      if (resObj) t3ResText = resObj;
    }
    const t3FontDict = resolveDictValue(t3ResText, 'Font', objCache);
    if (!t3FontDict) continue;
    for (const m of t3FontDict.matchAll(/\/([^\s/]+)\s+(\d+)\s+\d+\s+R/g)) {
      const innerTag = decodePdfName(m[1]);
      if (fontEntryPairs.some(([t]) => t === innerTag)) continue;
      const innerObjNum = Number(m[2]);
      const innerObjText = objCache.getObjectText(innerObjNum);
      if (innerObjText) fontEntryPairs.push([innerTag, innerObjText, innerObjNum]);
    }
  }
  for (const [fontTag, fontObj, fontObjNum] of fontEntryPairs) {
    if (fontObjNum !== null) {
      const cachedFont = objCache.fontCache.get(fontObjNum);
      if (cachedFont !== undefined) {
        fonts.set(fontTag, cachedFont);
        continue;
      }
    }
    let baseNameMatch = /\/BaseFont\s*\/([^\s/<>[\]]+)/.exec(fontObj);
    let baseNameHexMatch = !baseNameMatch && /\/BaseFont\s*<([0-9A-Fa-f\s]+)>/.exec(fontObj);
    if (!baseNameMatch && !baseNameHexMatch) {
      const bfRef = /\/BaseFont\s+(\d+)\s+\d+\s+R\b/.exec(fontObj);
      const bfBody = bfRef ? (objCache.getObjectText(Number(bfRef[1])) || '').trim() : '';
      baseNameMatch = /^\/([^\s/<>[\]]+)/.exec(bfBody);
      baseNameHexMatch = !baseNameMatch && /^<([0-9A-Fa-f\s]+)>/.exec(bfBody);
    }
    const nameMatch = /\/Name\s*\/([^\s/<>[\]]+)/.exec(fontObj);
    let baseNameRaw;
    if (baseNameMatch) {
      baseNameRaw = baseNameMatch[1].replace(/^[A-Z]{6}\+/, '');
    } else if (baseNameHexMatch) {
      const hex = baseNameHexMatch[1].replace(/\s+/g, '');
      const bytes = [];
      for (let hi = 0; hi < hex.length; hi += 2) bytes.push(parseInt(hex.substring(hi, hi + 2), 16));
      if (bytes.length >= 2 && bytes[0] === 0xFE && bytes[1] === 0xFF) {
        let decoded = '';
        for (let bi = 2; bi < bytes.length - 1; bi += 2) {
          const cp = (bytes[bi] << 8) | bytes[bi + 1];
          if (cp > 0) decoded += String.fromCharCode(cp);
        }
        baseNameRaw = decoded.replace(/^[A-Z]{6}\+/, '');
      } else {
        baseNameRaw = String.fromCharCode(...bytes).replace(/^[A-Z]{6}\+/, '');
      }
    } else {
      baseNameRaw = nameMatch ? nameMatch[1] : 'Unknown';
    }
    let baseName = baseNameRaw.replace(/#([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));

    let bold = /Bold|Black/i.test(baseName);
    let italic = /italic/i.test(baseName) || /-\w*ital/i.test(baseName) || /-it$/i.test(baseName) || /oblique/i.test(baseName);
    const smallCaps = /(small\W?cap)|(sc(?=[-+]|$))|(caps(?=[-+]|$))/i.test(baseName);
    let familyName = baseName.replace(/-.+/, '').replace(/,.*/, '');
    let serifFlag = false;
    let symbolicFlag = false;
    let italicAngleDeg = null;
    let capHeightPdf = null;
    let xHeightPdf = null;
    let stemV = null;

    let toUnicode = new ToUnicodeMap();
    let toUnicodeIsIdentity = false;
    const touRefMatch = /\/ToUnicode\s+(\d+)\s+\d+\s+R/.exec(fontObj);
    const touNameMatch = !touRefMatch && /\/ToUnicode\s*\/Identity-H/.exec(fontObj);
    if (touRefMatch) {
      const cmapBytes = objCache.getStreamBytes(Number(touRefMatch[1]));
      if (cmapBytes) {
        const cmapText = new TextDecoder('latin1').decode(cmapBytes);
        toUnicode = parsedToUnicodeCMap(cmapText, objCache).clone();
      }
    } else if (touNameMatch) {
      toUnicodeIsIdentity = true;
    }

    let charCodeToCID = null;
    /** @type {Array<{bytes: number, low: number, high: number}>|null} */
    let codespaceRanges = null;
    const encCMapRefMatch = /\/Encoding\s+(\d+)\s+\d+\s+R/.exec(fontObj);
    if (encCMapRefMatch && /\/DescendantFonts/.test(fontObj)) {
      const cmapBytes = objCache.getStreamBytes(Number(encCMapRefMatch[1]));
      if (cmapBytes) {
        const cmapText = new TextDecoder('latin1').decode(cmapBytes);
        if (/begincidrange|begincidchar|beginbfchar|beginbfrange/.test(cmapText)) {
          charCodeToCID = new Map();
          parseCIDEncodingCMap(cmapText, charCodeToCID);
          codespaceRanges = parseCIDCodespaceRanges(cmapText);
        }
      }
    }

    let predefinedCJKCMap = false;

    let fontObjEnc = fontObj;
    {
      const encRefM = /\/Encoding\s+(\d+)\s+\d+\s+R\b/.exec(fontObj);
      if (encRefM) {
        const encBody = (objCache.getObjectText(Number(encRefM[1])) || '').trim();
        if (encBody.startsWith('/')) fontObjEnc = `${fontObj} /Encoding ${encBody}`;
      }
    }

    if (toUnicode.size === 0 && /\/DescendantFonts/.test(fontObj)) {
      const rksjMatch = /\/Encoding\s*\/([\w-]*RKSJ[\w-]*)/.exec(fontObjEnc);
      if (rksjMatch) {
        predefinedCJKCMap = true;
        codespaceRanges = [
          { bytes: 1, low: 0x00, high: 0x80 },
          { bytes: 1, low: 0xA0, high: 0xDF },
          { bytes: 1, low: 0xFD, high: 0xFF },
          { bytes: 2, low: 0x8140, high: 0x9FFC },
          { bytes: 2, low: 0xE040, high: 0xFCFC },
        ];
        // Adding ASCII charCodes 0x20-0x7E here would make rebuildFontFromGlyphs treat them as non-PUA and skip its embedded-cmap fallback.
        try {
          const decoder = new TextDecoder('shift_jis');
          for (let hi = 0x81; hi <= 0xFC; hi++) {
            if (hi >= 0xA0 && hi <= 0xDF) continue;
            for (let lo = 0x40; lo <= 0xFC; lo++) {
              if (lo === 0x7F) continue;
              const charCode = (hi << 8) | lo;
              const unicode = decoder.decode(new Uint8Array([hi, lo]));
              if (unicode && unicode !== '\uFFFD') {
                toUnicode.set(charCode, unicode);
              }
            }
          }
        } catch (_e) { /* encoding unavailable */ }
      }
    }

    if (toUnicode.size === 0 && /\/DescendantFonts/.test(fontObj)) {
      const gbkMatch = /\/Encoding\s*\/([\w-]*(?:GBK|GB-EUC|GBpc-EUC)[\w-]*)/.exec(fontObjEnc);
      if (gbkMatch) {
        predefinedCJKCMap = true;
        codespaceRanges = [
          { bytes: 1, low: 0x00, high: 0x80 },
          { bytes: 2, low: 0x8140, high: 0xFEFE },
        ];
        // Adding ASCII charCodes here would make rebuildFontFromGlyphs skip its embedded-cmap fallback.
        try {
          const decoder = new TextDecoder('gbk');
          for (let hi = 0x81; hi <= 0xFE; hi++) {
            for (let lo = 0x40; lo <= 0xFE; lo++) {
              if (lo === 0x7F) continue;
              const charCode = (hi << 8) | lo;
              const unicode = decoder.decode(new Uint8Array([hi, lo]));
              if (unicode && unicode !== '\uFFFD') {
                toUnicode.set(charCode, unicode);
              }
            }
          }
        } catch (_e) { /* encoding unavailable */ }
      }
    }

    if (toUnicode.size === 0 && /\/DescendantFonts/.test(String(fontObj))) {
      const b5Match = /\/Encoding\s*\/(B5[\w-]*|ETen[\w-]*|ETenms[\w-]*|HKscs[\w-]*)/.exec(fontObjEnc);
      if (b5Match) {
        predefinedCJKCMap = true;
        codespaceRanges = [
          { bytes: 1, low: 0x00, high: 0x80 },
          { bytes: 2, low: 0xA140, high: 0xFEFE },
        ];
        try {
          const decoder = new TextDecoder('big5');
          for (let hi = 0xA1; hi <= 0xFE; hi++) {
            for (let lo = 0x40; lo <= 0xFE; lo++) {
              if (lo === 0x7F) continue;
              const charCode = (hi << 8) | lo;
              const unicode = decoder.decode(new Uint8Array([hi, lo]));
              if (unicode && unicode !== '�') {
                toUnicode.set(charCode, unicode);
              }
            }
          }
        } catch (_e) { /* encoding unavailable */ }
        // ETen-B5-H maps single-byte ASCII 0x20-0x7E to the Adobe-CNS1 half-width Latin block starting at CID 13648.
        if (!charCodeToCID) charCodeToCID = new Map();
        for (let code = 0x20; code <= 0x7E; code++) {
          if (!charCodeToCID.has(code)) charCodeToCID.set(code, 13616 + code);
          if (code > 0x20 && !toUnicode.has(code)) toUnicode.set(code, String.fromCharCode(code));
        }
      }
    }

    if (toUnicode.size === 0 && /\/DescendantFonts/.test(String(fontObj))) {
      const kscMatch = /\/Encoding\s*\/(KSC[\w-]*|UniKS[\w-]*)/.exec(fontObjEnc);
      if (kscMatch && !/UCS2|UTF16/.test(kscMatch[1])) {
        predefinedCJKCMap = true;
        codespaceRanges = [
          { bytes: 1, low: 0x00, high: 0x80 },
          { bytes: 2, low: 0x8141, high: 0xFDFE },
        ];
        try {
          const decoder = new TextDecoder('euc-kr');
          for (let hi = 0x81; hi <= 0xFD; hi++) {
            for (let lo = 0x41; lo <= 0xFE; lo++) {
              if (lo === 0x7F) continue;
              const charCode = (hi << 8) | lo;
              const unicode = decoder.decode(new Uint8Array([hi, lo]));
              if (unicode && unicode !== '�') {
                toUnicode.set(charCode, unicode);
              }
            }
          }
        } catch (_e) { /* encoding unavailable */ }
      }
    }

    const hasAuthoritativeToUnicode = toUnicode.size > 0 || toUnicodeIsIdentity;

    let encodingText = fontObj;
    {
      const encRefMatch = /\/Encoding\s+(\d+)\s+\d+\s+R/.exec(fontObj);
      if (encRefMatch) {
        const encObj = objCache.getObjectText(Number(encRefMatch[1]));
        if (encObj) encodingText = encObj;
      }
    }
    let descriptorText = fontObj;
    {
      const descRefMatch = /\/FontDescriptor\s+(\d+)\s+\d+\s+R/.exec(fontObj);
      if (descRefMatch) {
        const dt = objCache.getObjectText(Number(descRefMatch[1]));
        if (dt) descriptorText = dt;
      }
    }
    const baseChars = (/\/Encoding\s*\/MacRomanEncoding/.test(fontObj) || /\/BaseEncoding\s*\/MacRomanEncoding/.test(encodingText)) ? macRomanChars
      : (/\/Encoding\s*\/WinAnsiEncoding/.test(fontObj) || /\/BaseEncoding\s*\/WinAnsiEncoding/.test(encodingText) ? win1252Chars : null);
    const descFlags = resolveIntValue(String(descriptorText), 'Flags', objCache, Number.NaN);
    const isSymbolicByFlag = Number.isNaN(descFlags) ? false : (descFlags & 4) !== 0;
    // Per PDF spec 9.6.6.4, a named /Encoding is authoritative when the Symbolic flag is clear.
    // Quartz re-encodes Symbol and Wingdings subsets to MacRoman and clears Symbolic, so the built-in symbol tables below must not override it.
    const namedEncodingAuthoritative = !!baseChars && !isSymbolicByFlag;

    // Producers often embed a broken ToUnicode CMap that runs Wingdings charCodes through Latin-1 or MacRoman instead of mapping them to the symbol characters.
    if (!namedEncodingAuthoritative && /^(?:.*\+)?Wingdings(?:-\w+)?$/i.test(baseName)) {
      for (const [cid, ch] of toUnicode) {
        const cp = ch.codePointAt(0);
        // Subset fonts re-index charCodes to 1..N while mapping them to valid >0xFF symbols, so only remap `cid` when `ch` looks decoded as text.
        const wrongEncodingArtifact = ch === String.fromCharCode(cid)
          || (cid >= 32 && cid <= 255 && (ch === win1252Chars[cid - 32] || ch === macRomanChars[cid - 32]));
        if (cp !== undefined && cp >= 0xF000 && cp <= 0xF0FF && wingdingsToUnicode[cp & 0xFF] !== undefined) {
          toUnicode.set(cid, String.fromCodePoint(wingdingsToUnicode[cp & 0xFF]));
        } else if (cp !== undefined && cp <= 0xFF && wingdingsToUnicode[cp] !== undefined) {
          toUnicode.set(cid, String.fromCodePoint(wingdingsToUnicode[cp]));
        } else if (wrongEncodingArtifact && wingdingsToUnicode[cid] !== undefined) {
          toUnicode.set(cid, String.fromCodePoint(wingdingsToUnicode[cid]));
        }
      }
      for (const [ccStr, unicode] of Object.entries(wingdingsToUnicode)) {
        const cc = Number(ccStr);
        if (!toUnicode.has(cc)) toUnicode.set(cc, String.fromCodePoint(unicode));
      }
    }

    if (!namedEncodingAuthoritative && /^Symbol(?:[-,]\w+|[A-Za-z\d]*)$/i.test(baseName)) {
      const broken = toUnicode.size > 0 && toUnicode.get(65) === 'A';
      if (broken || toUnicode.size === 0) {
        for (const [ccStr, unicode] of Object.entries(symbolToUnicode)) {
          toUnicode.set(Number(ccStr), String.fromCodePoint(unicode));
        }
      } else {
        for (const [cid, ch] of toUnicode) {
          const cp = ch.codePointAt(0);
          if (cp !== undefined && cp >= 0xF000 && cp <= 0xF0FF && symbolToUnicode[cp & 0xFF] !== undefined) {
            toUnicode.set(cid, String.fromCodePoint(symbolToUnicode[cp & 0xFF]));
          }
        }
      }
    }

    /** @type {{ [charCode: number]: string }|null} */
    let differences = null;
    // charCode -> Unicode from /Encoding, which selects the rendered glyph when /ToUnicode differs.
    const encodingUnicode = new Map();
    // Kept separate from toUnicode because the two legitimately disagree, e.g. TeX charCode 0x27 draws 'quoteright' while ToUnicode reports U+0027.
    // convertType1ToOTFNew needs the encoding's glyph, not the extracted char.
    const charCodeToGlyphName = new Map();
    let hasFontFile = false;
    let hasFontFile2 = false;
    let hasFontFile3 = false;
    {
      if (baseChars) {
        for (let code = 32; code <= 255; code++) {
          const ch = baseChars[code - 32];
          if (ch) {
            encodingUnicode.set(code, ch);
            const glyphName = unicodeToAGL(ch.codePointAt(0));
            if (glyphName) charCodeToGlyphName.set(code, glyphName);
          }
        }
        if (toUnicode.size === 0) {
          for (const [code, ch] of encodingUnicode) toUnicode.set(code, ch);
        }
      }

      // Embedded CFF (/FontFile3) is excluded because buildFontFromCFF resolves those charCodes through its own PUA cmap, which StandardEncoding entries would conflict with.
      hasFontFile = /\/FontFile\s+\d+\s+\d+\s+R/.test(String(descriptorText));
      hasFontFile2 = /\/FontFile2\s+\d+\s+\d+\s+R/.test(String(descriptorText));
      hasFontFile3 = /\/FontFile3\s+\d+\s+\d+\s+R/.test(String(descriptorText));
      const isType0 = /\/Subtype\s*\/Type0/.test(String(fontObj));
      const isType1Subtype = /\/Subtype\s*\/Type1\b/.test(String(fontObj));
      const isStd14Type1 = /^(Helvetica|Courier|Times-)/i.test(baseName);
      // Embedded fonts bypass the Symbolic check because many normal serif fonts ship with the flag set.
      const eligibleForStdEnc = hasFontFile || isStd14Type1 || !isSymbolicByFlag;
      if (!baseChars && !isType0 && isType1Subtype && !hasFontFile2 && !hasFontFile3 && eligibleForStdEnc && !/ZapfDingbats|Symbol|Wingdings/i.test(baseName)) {
        // When /BaseEncoding is missing, the spec's implicit base is the font's own built-in encoding, not StandardEncoding.
        /** @type {Map<number, string>|null} */
        let baseEnc = null;
        if (hasFontFile) {
          const ffMatch = /\/FontFile\s+(\d+)\s+\d+\s+R/.exec(String(descriptorText));
          if (ffMatch) {
            const fontFile = objCache.getStreamBytes(Number(ffMatch[1]));
            if (fontFile) baseEnc = parseType1PFAEncoding(fontFile);
          }
        }
        if (!baseEnc) {
          baseEnc = new Map();
          for (let code = 32; code < cffStandardEncoding.length; code++) {
            if (cffStandardEncoding[code]) baseEnc.set(code, cffStandardEncoding[code]);
          }
        }
        if (baseEnc) {
          for (const [code, glyphName] of baseEnc) {
            charCodeToGlyphName.set(code, glyphName);
            const ch = aglLookup(glyphName);
            if (ch) encodingUnicode.set(code, ch);
          }
          if (toUnicode.size === 0) {
            for (const [code, ch] of encodingUnicode) toUnicode.set(code, ch);
          }
        }
      }

      if (!baseChars && /ZapfDingbats/i.test(baseName)) {
        for (const [code, glyphName] of Object.entries(dingbatsEncoding)) {
          charCodeToGlyphName.set(Number(code), glyphName);
          const cp = dingbatsGlyphMap[glyphName];
          if (cp !== undefined) {
            const ch = String.fromCodePoint(cp);
            encodingUnicode.set(Number(code), ch);
          }
        }
        if (toUnicode.size === 0) {
          for (const [code, ch] of encodingUnicode) toUnicode.set(code, ch);
        }
      }

      const diffContent = resolveArrayValue(encodingText, 'Differences', objCache);
      if (diffContent) {
        differences = {};
        const tokens = [...diffContent.matchAll(/(\d+)|(\/[^\s/<>[\]]+)/g)];
        // A numeric glyph name like /67 can be the rendered char's byte value or just a glyph index unrelated to Unicode.
        // A glyph index tracks charCode closely, so large |name - charCode| offsets across the array mark the byte-value convention.
        let prescanCharCode = 0;
        let numericCount = 0;
        let largeOffsetCount = 0;
        // Subsetting producers re-index charCodes 1..N while keeping the original byte in the glyph name's hex suffix, so /G46 is the glyph for 0x46.
        let gHexCount = 0;
        let gHexWin1252Count = 0;
        let gHexExtendedCount = 0;
        let gHexNonDecimalCount = 0;
        let gDec3Count = 0;
        // The decimal reading of a C-name only resolves from /C32 up, so names in the control-code slots prove the slot-index convention.
        let cDecCount = 0;
        let cDecSlotNameCount = 0;
        let cDecControlCount = 0;
        // A letter-bearing 4-hex name like /006e proves the font names glyphs by Unicode codepoint, so digit-only siblings like /0054 are hex positions too, not decimal byte values.
        // TeX-shaped names like /a224 are valid 4-hex strings and must not count as proof.
        let hex4LetterCount = 0;
        for (const tok of tokens) {
          if (tok[1]) {
            prescanCharCode = Number(tok[1]);
          } else if (tok[2]) {
            const gn = tok[2].slice(1).replace(/#([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
            if (/^\d+$/.test(gn)) {
              numericCount++;
              if (Math.abs(Number(gn) - prescanCharCode) > 3) largeOffsetCount++;
            }
            if (/^[0-9a-fA-F]{4}$/.test(gn) && /[a-fA-F]/.test(gn) && !/^a\d{3}$/.test(gn)) hex4LetterCount++;
            const gHexMatch = /^G([0-9a-fA-F]{2})$/.exec(gn);
            if (gHexMatch) {
              gHexCount++;
              const hexCode = parseInt(gHexMatch[1], 16);
              if (hexCode >= 0x20 && hexCode <= 0xFF && win1252Chars[hexCode - 0x20]) {
                gHexWin1252Count++;
              }
              if (hexCode >= 0x80) gHexExtendedCount++;
              if (/[a-fA-F]/.test(gHexMatch[1])) gHexNonDecimalCount++;
            }
            // A 3-digit G-name (G100-G255) cannot be a 2-hex-digit identity name, so its presence rules out the hex-identity reading.
            const gDec3Match = /^G(\d{3,})$/.exec(gn);
            if (gDec3Match && Number(gDec3Match[1]) <= 0xFF) gDec3Count++;
            const cDecMatch = /^C(\d{1,5})$/.exec(gn);
            if (cDecMatch) {
              cDecCount++;
              if (Number(cDecMatch[1]) === prescanCharCode) cDecSlotNameCount++;
              if (Number(cDecMatch[1]) < 0x20) cDecControlCount++;
            }
            prescanCharCode++;
          }
        }
        const useNumericNameAsAscii = numericCount >= 2 && largeOffsetCount * 2 >= numericCount && hex4LetterCount === 0;
        const cNamesAreSlotIndices = cDecCount > 0 && cDecSlotNameCount === cDecCount && cDecControlCount > 0;
        const useGHexAsIdentity = gHexCount > 0
          && gHexWin1252Count === gHexCount
          && (gHexNonDecimalCount > 0 || gHexExtendedCount > 0)
          && gDec3Count === 0;
        let charCode = 0;
        for (const tok of tokens) {
          if (tok[1]) {
            charCode = Number(tok[1]);
          } else if (tok[2]) {
            const glyphName = tok[2].slice(1).replace(/#([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
            differences[charCode] = glyphName;
            charCodeToGlyphName.set(charCode, glyphName);
            let unicodeStr = aglLookup(glyphName);
            // Ordered before the TeX fallback below, which would read "a36" as decimal 36 and yield U+0024 instead of the Dingbats glyph.
            if (!unicodeStr && /ZapfDingbats/i.test(baseName)) {
              const zdCp = dingbatsGlyphMap[glyphName];
              if (zdCp !== undefined) unicodeStr = String.fromCodePoint(zdCp);
            }
            if (!unicodeStr) {
              const texMatch = /^a(\d+)$/.exec(glyphName);
              if (texMatch) {
                const cp = Number(texMatch[1]);
                if (cp > 0 && cp <= 0xFFFF) unicodeStr = String.fromCodePoint(cp);
              }
            }
            // Clear the decimal codepoint `aglLookup` assigned to `/C<n>` when `/C<n>` is just a slot index.
            if (cNamesAreSlotIndices && /^C[0-9a-fA-F]{1,5}$/.test(glyphName)) {
              unicodeStr = null;
            } else {
              // A Cnnnn glyph name is ambiguous between two producer conventions: decimal (/C0097 is 'a') and hex identity (/C75 at charCode 117 is that charCode).
              // aglLookup already read it as decimal, so replace that when the hex reading equals the charCode.
              const cMatch = /^C([0-9a-fA-F]{1,5})$/.exec(glyphName);
              if (cMatch) {
                const hexCode = parseInt(cMatch[1], 16);
                if (hexCode === charCode && hexCode >= 0x20 && hexCode <= 0x7E) {
                  unicodeStr = String.fromCodePoint(hexCode);
                }
              }
            }
            if (!unicodeStr) {
              const gHexMatch = /^G([0-9a-fA-F]{2})$/.exec(glyphName);
              if (gHexMatch) {
                const hexCode = parseInt(gHexMatch[1], 16);
                const hexAsWin1252 = hexCode >= 0x20 && hexCode <= 0xFF
                  ? win1252Chars[hexCode - 0x20]
                  : undefined;
                if (hexAsWin1252 && (hexCode === charCode || useGHexAsIdentity)) {
                  unicodeStr = hexAsWin1252;
                }
              }
            }
            if (!unicodeStr) {
              const gMatch = /^G(\d+)$/.exec(glyphName);
              if (gMatch) {
                const cp = Number(gMatch[1]);
                if (cp >= 0x20 && cp <= 0xFF) {
                  const ch = win1252Chars[cp - 0x20];
                  if (ch) unicodeStr = ch;
                }
              }
            }
            if (!unicodeStr && useNumericNameAsAscii) {
              // Decimal byte values never need more than 3 digits, so a 4-digit name is a zero-padded hex codepoint even when it happens to be all digits.
              const nMatch = /^(\d{1,3})$/.exec(glyphName);
              if (nMatch) {
                const cp = Number(nMatch[1]);
                if (cp >= 0x20 && cp <= 0xFF) {
                  const ch = win1252Chars[cp - 0x20];
                  if (ch) unicodeStr = ch;
                }
              }
            }
            if (!unicodeStr) {
              const kMatch = /^K([0-9A-Fa-f]{2})$/.exec(glyphName);
              if (kMatch) {
                const cp = parseInt(kMatch[1], 16);
                if (cp >= 0x20 && cp <= 0x7E) unicodeStr = String.fromCodePoint(cp);
              }
            }

            if (unicodeStr) {
              const existingUnicode = toUnicode.get(charCode);

              const shouldOverrideFallbackToUnicode = !hasAuthoritativeToUnicode
                && existingUnicode !== undefined
                && existingUnicode !== unicodeStr;

              const shouldOverrideWithGHex = /^G[0-9a-fA-F]{2}$/.test(glyphName)
                && useGHexAsIdentity
                && existingUnicode !== undefined
                && existingUnicode !== unicodeStr;

              const existingCp = existingUnicode ? existingUnicode.codePointAt(0) : undefined;
              const resolvedCp = unicodeStr.codePointAt(0);
              const existingIsPUA = existingCp !== undefined
                && ((existingCp >= 0xE000 && existingCp <= 0xF8FF)
                  || (existingCp >= 0xF0000 && existingCp <= 0xFFFFD)
                  || (existingCp >= 0x100000 && existingCp <= 0x10FFFD));
              const resolvedIsPUA = resolvedCp !== undefined
                && ((resolvedCp >= 0xE000 && resolvedCp <= 0xF8FF)
                  || (resolvedCp >= 0xF0000 && resolvedCp <= 0xFFFFD)
                  || (resolvedCp >= 0x100000 && resolvedCp <= 0x10FFFD));
              const shouldOverrideBrokenPUA = hasAuthoritativeToUnicode
                && existingUnicode !== undefined
                && existingUnicode !== unicodeStr
                && existingIsPUA
                && !resolvedIsPUA;

              if (!toUnicode.has(charCode)
                || shouldOverrideFallbackToUnicode
                || shouldOverrideWithGHex
                || shouldOverrideBrokenPUA) {
                toUnicode.set(charCode, unicodeStr);
              }
              encodingUnicode.set(charCode, unicodeStr);
            }
            charCode++;
          }
        }
      }
    }

    /** @type {Record<string, string>} */
    const LIGATURE_DECOMP = {
      fi: 'fi', fl: 'fl', ff: 'ff', ffi: 'ffi', ffl: 'ffl',
    };
    if (charCodeToGlyphName.size > 0) {
      for (const [charCode, glyphName] of charCodeToGlyphName) {
        const decomp = LIGATURE_DECOMP[glyphName];
        if (!decomp) continue;
        const tu = toUnicode.get(charCode);
        if (tu === decomp) continue;
        const tuFirstCp = tu ? tu.codePointAt(0) : undefined;
        const isFirstLetterOnly = tu !== undefined && [...tu].length === 1
          && tuFirstCp === decomp.codePointAt(0);
        const isLigatureCp = tu !== undefined && [...tu].length === 1
          && tuFirstCp >= 0xFB00 && tuFirstCp <= 0xFB04;
        const isMissing = tu === undefined;
        if (isFirstLetterOnly || isLigatureCp || isMissing) {
          toUnicode.set(charCode, decomp);
        }
      }
    }

    if (toUnicode.size > 0 && encodingUnicode.size > 0) {
      for (const [cc, tu] of toUnicode) {
        if (tu.length !== 1) continue;
        const tuCp = tu.codePointAt(0);
        if (tuCp >= 0x20 || tuCp === 0x09 || tuCp === 0x0A || tuCp === 0x0D) continue;
        const eu = encodingUnicode.get(cc);
        if (!eu || eu.length !== 1) continue;
        const euCp = eu.codePointAt(0);
        if (euCp < 0x20) continue;
        toUnicode.set(cc, eu);
      }
    }

    // Symbolic Wingdings fonts often still declare /WinAnsiEncoding or /MacRomanEncoding, filling encodingUnicode with Latin characters instead of Wingdings symbols.
    if (!namedEncodingAuthoritative && /^(?:.*\+)?Wingdings(?:-\w+)?$/i.test(baseName)) {
      for (const [cid, ch] of encodingUnicode) {
        const cp = ch.codePointAt(0);
        if (cp !== undefined && cp <= 0xFF && wingdingsToUnicode[cp] !== undefined) {
          encodingUnicode.set(cid, String.fromCodePoint(wingdingsToUnicode[cp]));
        } else if (wingdingsToUnicode[cid] !== undefined) {
          encodingUnicode.set(cid, String.fromCodePoint(wingdingsToUnicode[cid]));
        }
      }
      for (const [ccStr, unicode] of Object.entries(wingdingsToUnicode)) {
        const cc = Number(ccStr);
        if (!encodingUnicode.has(cc)) encodingUnicode.set(cc, String.fromCodePoint(unicode));
      }
    }

    let defaultWidth = 1000;
    const widths = new Map();
    /** @type {Map<number, number> | null} */
    let glyphVisualWidths = null;
    let ascent = 800;
    let descent = -200;
    // Cambria Math's genuine 3117 ascent is the largest real value seen across 5,400 real PDFs, so tightening this toward the usual 1000-unit em square would reject real metrics.
    const DESCRIPTOR_METRIC_MAX = 5000;

    const firstChar = resolveIntValue(fontObj, 'FirstChar', objCache);
    const widthsArrayText = resolveArrayValue(fontObj, 'Widths', objCache);
    if (widthsArrayText) {
      const widthValues = widthsArrayText.trim().split(/\s+/).map(Number);
      // /FirstChar is required by the spec, but some generators omit it while still supplying /Widths and /LastChar.
      let baseCode = firstChar;
      if (!/\/FirstChar\s/.test(fontObj)) {
        const lastChar = resolveIntValue(fontObj, 'LastChar', objCache);
        baseCode = Number.isFinite(lastChar) ? Math.max(0, lastChar - widthValues.length + 1) : 0;
      }
      for (let j = 0; j < widthValues.length; j++) {
        widths.set(baseCode + j, widthValues[j]);
      }
      if (widthValues.length > 0) {
        defaultWidth = widthValues.reduce((a, b) => a + b, 0) / widthValues.length;
      }
    }

    // Type0 fonts populate `widths` by CID from `/W` and `/DW` below, so filling WinAnsi codes 32-255 here would corrupt those CID widths.
    const isType0Font = /\/Subtype\s*\/Type0/.test(fontObj);
    if (widths.size === 0 && !isType0Font) {
      const avgWidth = applyStandardFontWidths(baseName, widths);
      if (avgWidth !== null) defaultWidth = avgWidth;

      const isMacRoman = /\/Encoding\s*\/MacRomanEncoding/.test(fontObj);
      if (isMacRoman && widths.size > 0) {
        const unicodeToWidth = new Map();
        for (let code = 32; code <= 255; code++) {
          const w = widths.get(code);
          if (w !== undefined) {
            const ch = win1252Chars[code - 32];
            if (ch) unicodeToWidth.set(ch, w);
          }
        }
        for (let code = 128; code <= 255; code++) {
          const macChar = macRomanChars[code - 32];
          if (macChar) {
            const w = unicodeToWidth.get(macChar);
            if (w !== undefined) widths.set(code, w);
            else widths.delete(code);
          }
        }
      }

      if (differences && widths.size > 0) {
        const unicodeToWidth = new Map();
        for (let code = 32; code <= 255; code++) {
          const w = widths.get(code);
          if (w !== undefined) {
            const ch = win1252Chars[code - 32];
            if (ch) unicodeToWidth.set(ch, w);
          }
        }
        for (const [codeStr, glyphName] of Object.entries(differences)) {
          const code = Number(codeStr);
          const unicodeStr = aglLookup(glyphName);
          if (unicodeStr) {
            const w = unicodeToWidth.get(unicodeStr.charAt(0));
            if (w !== undefined) widths.set(code, w);
          }
        }
      }

      // WinAnsi omits the fi/fl ligatures, so the Win1252-keyed width tables above have no entry for codes mapped to them.
      if (avgWidth !== null) {
        for (const [code, glyphName] of charCodeToGlyphName) {
          const w = getStandardLigatureWidth(baseName, glyphName);
          if (w !== undefined) widths.set(code, w);
        }
      }
    }

    // Dingbats /Differences typically remap charCodes below 32, which applyStandardFontWidths (keyed from code 32 up) leaves without widths.
    if (/ZapfDingbats/i.test(baseName) && differences) {
      for (const codeStr of Object.keys(differences)) {
        const code = Number(codeStr);
        if (!widths.has(code)) {
          const w = getDingbatsGlyphWidth(differences[codeStr]);
          if (w !== undefined) widths.set(code, w);
        }
      }
      if (widths.size > 0 && defaultWidth === 1000) {
        defaultWidth = [...widths.values()].reduce((a, b) => a + b, 0) / widths.size;
      }
    }

    /** @type {{ fontFile: Uint8Array|null, cidToGidMap: Uint8Array|string|null, unicodeCMap?: boolean }|null} */
    let type0Info = null;
    let type0ProgramIsTrueType = false;
    const descInlineMatch = /\/DescendantFonts\s*\[\s*(\d+)\s+\d+\s+R/.exec(fontObj);
    const descIndirectMatch = !descInlineMatch && /\/DescendantFonts\s+(\d+)\s+\d+\s+R/.exec(fontObj);
    let cidFontObjNum = descInlineMatch ? Number(descInlineMatch[1]) : null;
    let cidFontText = null;
    if (!cidFontObjNum && descIndirectMatch) {
      const arrayText = objCache.getObjectText(Number(descIndirectMatch[1]));
      if (arrayText) {
        const innerRef = /(\d+)\s+\d+\s+R/.exec(arrayText);
        if (innerRef) cidFontObjNum = Number(innerRef[1]);
      }
    }
    if (!cidFontObjNum && !descIndirectMatch) {
      const descStart = fontObj.indexOf('/DescendantFonts');
      if (descStart !== -1) {
        const afterDesc = fontObj.substring(descStart + 16);
        const bracketIdx = afterDesc.indexOf('[');
        if (bracketIdx !== -1) {
          const afterBracket = afterDesc.substring(bracketIdx + 1).trim();
          if (afterBracket.startsWith('<<')) {
            cidFontText = extractDict(fontObj, descStart + 16 + bracketIdx + 1 + (afterDesc.substring(bracketIdx + 1).indexOf('<<')));
          }
        }
      }
    }
    if (cidFontObjNum) {
      cidFontText = objCache.getObjectText(cidFontObjNum);
    }
    if (cidFontText) {
      const dwVal = resolveIntValue(cidFontText, 'DW', objCache);
      if (dwVal || /\/DW\s/.test(cidFontText)) defaultWidth = dwVal;

      let wArrayContent = null;
      const wRefMatch = /\/W\s+(\d+)\s+\d+\s+R/.exec(cidFontText);
      if (wRefMatch) {
        const wArrayText = objCache.getObjectText(Number(wRefMatch[1]));
        if (wArrayText) {
          const ob = wArrayText.indexOf('[');
          const cb = wArrayText.lastIndexOf(']');
          wArrayContent = (ob !== -1 && cb !== -1 && cb > ob) ? wArrayText.substring(ob + 1, cb) : wArrayText;
        }
      } else {
        const wPos = cidFontText.indexOf('/W');
        if (wPos !== -1) {
          const bracketPos = cidFontText.indexOf('[', wPos);
          if (bracketPos !== -1) {
            let depth = 0;
            let bracketEndPos = -1;
            for (let j = bracketPos; j < cidFontText.length; j++) {
              if (cidFontText[j] === '[') depth++;
              else if (cidFontText[j] === ']') { depth--; if (depth === 0) { bracketEndPos = j; break; } }
            }
            if (bracketEndPos !== -1) {
              wArrayContent = cidFontText.substring(bracketPos + 1, bracketEndPos);
            }
          }
        }
      }
      if (wArrayContent !== null) {
        const refPattern = /(\d+)\s+\d+\s+R/g;
        const replacements = [];
        for (let refMatch = refPattern.exec(wArrayContent); refMatch !== null; refMatch = refPattern.exec(wArrayContent)) {
          const refText = objCache.getObjectText(Number(refMatch[1]));
          if (refText) replacements.push({ start: refMatch.index, end: refMatch.index + refMatch[0].length, text: refText.trim() });
        }
        for (let r = replacements.length - 1; r >= 0; r--) {
          wArrayContent = wArrayContent.substring(0, replacements[r].start) + replacements[r].text + wArrayContent.substring(replacements[r].end);
        }
        parseCIDWidths(`/W [${wArrayContent}]`, widths);
      }

      const fdRefMatch = /\/FontDescriptor\s+(\d+)\s+\d+\s+R/.exec(cidFontText);
      let fdText = null;
      if (fdRefMatch) {
        fdText = objCache.getObjectText(Number(fdRefMatch[1]));
      } else if (/\/Type\s*\/FontDescriptor/.test(cidFontText)) {
        fdText = cidFontText;
      } else {
        const fdInlineIdx = cidFontText.indexOf('/FontDescriptor');
        if (fdInlineIdx !== -1) {
          const afterFdCid = cidFontText.substring(fdInlineIdx + 15).trim();
          if (afterFdCid.startsWith('<<')) {
            fdText = extractDict(cidFontText, fdInlineIdx + 15 + cidFontText.substring(fdInlineIdx + 15).indexOf('<<'));
          }
        }
      }
      if (fdText) {
        const ascentVal = resolveNumValue(fdText, 'Ascent', objCache);
        const descentVal = resolveNumValue(fdText, 'Descent', objCache);
        if (ascentVal !== 0 && Math.abs(ascentVal) <= DESCRIPTOR_METRIC_MAX) ascent = ascentVal;
        // Skia and Aspose write /Descent as a positive magnitude instead of negative, so negate |descentVal|.
        if (descentVal !== 0 && Math.abs(descentVal) <= DESCRIPTOR_METRIC_MAX) descent = -Math.abs(descentVal);

        const fontFlags = resolveIntValue(fdText, 'Flags', objCache);
        if (!bold) {
          const weight = resolveIntValue(fdText, 'FontWeight', objCache);
          if ((weight >= 700) || (fontFlags & 262144)) bold = true;
        }
        if (!italic) {
          const angle = resolveNumValue(fdText, 'ItalicAngle', objCache);
          // Some producers write bogus angles like 180 on upright fonts.
          if ((Math.abs(angle) > 0 && Math.abs(angle) < 45) || (fontFlags & 64)) italic = true;
        }
        if (fontFlags & 2) serifFlag = true;
        if (fontFlags & 4) symbolicFlag = true;
        const descAngle = resolveNumValue(fdText, 'ItalicAngle', objCache);
        if (descAngle && Math.abs(descAngle) < 45) italicAngleDeg = descAngle;
        const descCapH = resolveNumValue(fdText, 'CapHeight', objCache);
        if (descCapH > 0 && descCapH <= DESCRIPTOR_METRIC_MAX) capHeightPdf = descCapH;
        const descXH = resolveNumValue(fdText, 'XHeight', objCache);
        if (descXH > 0 && descXH <= DESCRIPTOR_METRIC_MAX) xHeightPdf = descXH;
        const descStemV = resolveNumValue(fdText, 'StemV', objCache);
        if (descStemV > 0) stemV = descStemV;

        // Some producers declare /CIDFontType0 over a TrueType program, so the program is read whatever subtype the descendant declares.
        const trueTypeProgram = resolveCidTrueTypeProgram(fdText, objCache);
        if (trueTypeProgram) {
          if (isPlaceholderFontName(baseName)) {
            const dv = new DataView(trueTypeProgram.buffer, trueTypeProgram.byteOffset, trueTypeProgram.byteLength);
            const nameEntry = opentype.readSfntTableDirectory(dv).name;
            if (nameEntry) {
              const names = /** @type {Object<string, Object<string, string>>} */ (
                opentype.parseNameTable(dv, nameEntry.offset, undefined, nameEntry.length));
              const psRaw = ((names.postScriptName && names.postScriptName.en)
                || (names.fullName && names.fullName.en) || '').replace(/^[A-Z]{6}\+/, '');
              if (psRaw) {
                baseName = psRaw;
                familyName = ((names.preferredFamily && names.preferredFamily.en)
                  || (names.fontFamily && names.fontFamily.en)
                  || baseName.replace(/-.+/, '').replace(/,.*/, '')).replace(/^[A-Z]{6}\+/, '');
              }
              const subfamily = ((names.preferredSubfamily && names.preferredSubfamily.en)
                || (names.fontSubfamily && names.fontSubfamily.en) || '').toLowerCase();
              if (/italic|oblique/.test(subfamily) || /italic|oblique/i.test(baseName)) italic = true;
              if (/bold|black/i.test(baseName)) bold = true;
            }
          }
          let cidToGidMap = 'identity';
          if (!/\/CIDToGIDMap\s*\/Identity/.test(cidFontText)) {
            const gidMapRef = /\/CIDToGIDMap\s+(\d+)\s+\d+\s+R/.exec(cidFontText);
            if (gidMapRef) {
              const mapBytes = objCache.getStreamBytes(Number(gidMapRef[1]));
              if (mapBytes) cidToGidMap = mapBytes;
            }
          }
          type0Info = { fontFile: trueTypeProgram, cidToGidMap };
          type0ProgramIsTrueType = true;
        }

        if (!type0Info) {
          const ff3RefMatch = /\/FontFile3\s+(\d+)\s+\d+\s+R/.exec(fdText);
          if (ff3RefMatch) {
            const fontFile = objCache.getStreamBytes(Number(ff3RefMatch[1]));
            if (fontFile) {
              type0Info = { fontFile, cidToGidMap: 'identity' };
            }
          }
        }
      }
    }

    // Predefined CJK CMaps omit half-width ASCII from /W, which would otherwise fall back to the full-width /DW (1000).
    if (predefinedCJKCMap) {
      for (let cc = 0x20; cc <= 0x7E; cc++) {
        if (!widths.has(cc)) widths.set(cc, 500);
      }
    }

    let validCIDs = null;
    let cffSummary = null;
    if (type0Info && type0Info.fontFile) {
      const summary = parseCFFSummary(type0Info.fontFile);
      cffSummary = summary;
      if (summary.ok) {
        if (summary.isCID) {
          // CID 0 (.notdef) is implicit and omitted from the charset, so add it back.
          validCIDs = new Set([0, ...(summary.cidToGID?.keys() ?? [])]);
        } else if (!summary.predefinedCharset) {
          for (const [gid, unicode] of cffCharsetNamesToUnicode(summary.charsetNames)) {
            if (!toUnicode.has(gid)) toUnicode.set(gid, unicode);
          }
        }
      }
    }

    if (toUnicodeIsIdentity && toUnicode.size === 0 && charCodeToCID) {
      for (const [charCode, cid] of charCodeToCID) {
        if (charCode > 0 && charCode <= 0x10FFFF) {
          toUnicode.set(cid, String.fromCodePoint(charCode));
        }
      }
    }

    if (cidFontText && /\/Encoding\s*\/Identity-H/.test(fontObjEnc)) {
      let cidSysText = cidFontText;
      const cidSysRef = /\/CIDSystemInfo\s+(\d+)\s+\d+\s+R/.exec(cidFontText);
      if (cidSysRef) {
        const sysObj = objCache.getObjectText(Number(cidSysRef[1]));
        if (sysObj) cidSysText = sysObj;
      }
      const readCidString = (/** @type {string} */ key) => {
        const refM = new RegExp(`/${key}\\s+(\\d+)\\s+\\d+\\s+R`).exec(cidSysText);
        const src = refM ? (objCache.getObjectText(Number(refM[1])) || '') : cidSysText;
        const m = refM ? /\(([^)]*)\)/.exec(src) : new RegExp(`/${key}\\s*\\(([^)]*)\\)`).exec(src);
        return m ? m[1] : '';
      };
      let registry = readCidString('Registry');
      let ordering = readCidString('Ordering');

      if (objCache.encryptionKey && registry !== 'Adobe') {
        const sysObjNum = cidSysRef ? Number(cidSysRef[1]) : cidFontObjNum;
        if (sysObjNum) {
          const decRegistry = objCache.decryptDictString(sysObjNum, 'Registry');
          const decOrdering = objCache.decryptDictString(sysObjNum, 'Ordering');
          if (decRegistry) registry = decRegistry;
          if (decOrdering) ordering = decOrdering;
        }
      }

      if (registry === 'Adobe' && ordering === 'Identity') {
        const isCIDType2 = type0ProgramIsTrueType || (cidFontText && /\/Subtype\s*\/CIDFontType2/.test(cidFontText));
        let gidMap = null;
        if (isCIDType2) {
          if (type0Info && type0Info.fontFile) {
            gidMap = buildGidToUnicodeFromTrueType(type0Info.fontFile);
          }
          if (!gidMap) {
            const strippedBase = baseName.replace(/^[A-Z]{6}\+/, '');
            for (const [sibTag, sibObj] of fontEntryPairs) {
              if (sibTag === fontTag) continue;
              let sibBaseMatch = /\/BaseFont\s*\/([^\s/<>[\]]+)/.exec(sibObj);
              if (!sibBaseMatch) {
                const sibRef = /\/BaseFont\s+(\d+)\s+\d+\s+R\b/.exec(sibObj);
                const sibBody = sibRef ? (objCache.getObjectText(Number(sibRef[1])) || '').trim() : '';
                sibBaseMatch = /^\/([^\s/<>[\]]+)/.exec(sibBody);
              }
              if (!sibBaseMatch) continue;
              const sibBase = sibBaseMatch[1].replace(/^[A-Z]{6}\+/, '');
              if (sibBase !== strippedBase) continue;
              const sibFdRef = /\/FontDescriptor\s+(\d+)\s+\d+\s+R/.exec(sibObj);
              if (!sibFdRef) continue;
              const sibFdText = objCache.getObjectText(Number(sibFdRef[1]));
              if (!sibFdText) continue;
              const sibFontFile = resolveCidTrueTypeProgram(sibFdText, objCache);
              if (!sibFontFile) continue;
              gidMap = buildGidToUnicodeFromTrueType(sibFontFile);
              if (gidMap) break;
            }
          }
        }
        /** @param {number} cid */
        const isOverridable = (cid) => {
          const existing = toUnicode.get(cid);
          if (existing === undefined) return true;
          if (existing.length !== 1) return false;
          const cp = existing.codePointAt(0);
          return cp < 0x20 && cp !== 0x09 && cp !== 0x0A && cp !== 0x0D;
        };
        if (gidMap && gidMap.size > 0) {
          const cidSet = validCIDs || new Set(widths.keys());
          for (const cid of cidSet) {
            if (!isOverridable(cid)) continue;
            const unicode = gidMap.get(cid);
            if (unicode && unicode > 0) toUnicode.set(cid, String.fromCodePoint(unicode));
          }
        } else if (validCIDs) {
          for (const cid of validCIDs) {
            if (!isOverridable(cid)) continue;
            if (cid > 0 && cid <= 0xFFFF) toUnicode.set(cid, String.fromCodePoint(cid));
          }
        } else if (isCIDType2 && !(type0Info && type0Info.fontFile)) {
          // Most TrueType fonts keep low GIDs in Macintosh standard glyph order, giving a best-effort fallback when no program is embedded.
          for (const cid of widths.keys()) {
            if (!isOverridable(cid)) continue;
            const glyphName = standardNames[cid];
            if (!glyphName || glyphName[0] === '.') continue;
            const u = aglLookup(glyphName);
            if (u) toUnicode.set(cid, u);
          }
        }

        if (isCIDType2 && type0Info?.fontFile) {
          const candidates = [];
          for (const [cid, existing] of toUnicode) {
            if (existing.length !== 1) continue;
            const cp = existing.codePointAt(0);
            if (cp >= 0x20 || cp === 0x09 || cp === 0x0A || cp === 0x0D) continue;
            const w = widths.get(cid);
            if (!w || w <= 0) continue;
            candidates.push(cid);
          }
          if (candidates.length > 0) {
            const emptyGlyphs = buildEmptyGlyphSetFromTrueType(type0Info.fontFile);
            if (emptyGlyphs) {
              for (const cid of candidates) {
                if (emptyGlyphs.has(cid)) toUnicode.set(cid, ' ');
              }
            }
          }
        }
      } else if (registry === 'Adobe') {
        const cidMap = getCIDToUnicodeMap(ordering);
        if (cidMap) {
          const isEmbedded = type0Info && type0Info.fontFile;
          const cidSet = validCIDs || (isEmbedded ? new Set(widths.keys()) : null);
          /** @param {number} cid */
          const isOverridable = (cid) => {
            const existing = toUnicode.get(cid);
            if (existing === undefined) return true;
            if (existing.length !== 1) return false;
            const cp = existing.codePointAt(0);
            return cp < 0x20 && cp !== 0x09 && cp !== 0x0A && cp !== 0x0D;
          };
          // Normalize Kangxi radicals (U+2F00-U+2FD5) and CJK Compatibility Ideographs (U+F900-U+FAD9) via NFKC to CJK Unified codepoints present in substitute fonts.
          // Unconditional NFKC would also collapse Fullwidth Forms (U+FF00-U+FFEF) to halfwidth ASCII.
          /** @param {number} cp */
          const isCJKVariant = (cp) => (cp >= 0x2F00 && cp <= 0x2FD5) || (cp >= 0xF900 && cp <= 0xFAD9);
          if (cidSet) {
            for (const cid of cidSet) {
              if (!isOverridable(cid)) continue;
              if (cid > 0 && cid < cidMap.length && cidMap[cid] !== 0) {
                const cp = cidMap[cid];
                const ch = String.fromCodePoint(cp);
                toUnicode.set(cid, isCJKVariant(cp) ? ch.normalize('NFKC') : ch);
              }
            }
          } else {
            for (let cid = 1; cid < cidMap.length; cid++) {
              if (!isOverridable(cid)) continue;
              if (cidMap[cid] !== 0) {
                const cp = cidMap[cid];
                const ch = String.fromCodePoint(cp);
                toUnicode.set(cid, isCJKVariant(cp) ? ch.normalize('NFKC') : ch);
              }
            }
          }
        }
      }
    }

    let type3Info = null;
    let type1Info = null;
    let detectedMacRomanCmap = false;
    const isType3 = /\/Subtype\s*\/Type3/.test(fontObj);
    if (!cidFontObjNum && !cidFontText) {
      const fdRefMatchDirect = /\/FontDescriptor\s+(\d+)\s+\d+\s+R/.exec(fontObj);
      let fdText = null;
      if (fdRefMatchDirect) {
        fdText = objCache.getObjectText(Number(fdRefMatchDirect[1]));
      } else {
        const fdInlineStart = fontObj.indexOf('/FontDescriptor');
        if (fdInlineStart !== -1) {
          const afterFd = fontObj.substring(fdInlineStart + 15).trim();
          if (afterFd.startsWith('<<')) {
            fdText = extractDict(fontObj, fdInlineStart + 15 + fontObj.substring(fdInlineStart + 15).indexOf('<<'));
          }
        }
      }
      if (fdText) {
        const ascentVal = resolveNumValue(fdText, 'Ascent', objCache);
        const descentVal = resolveNumValue(fdText, 'Descent', objCache);
        if (ascentVal !== 0 && Math.abs(ascentVal) <= DESCRIPTOR_METRIC_MAX) ascent = ascentVal;
        // Skia and Aspose write /Descent as a positive magnitude instead of negative, so negate |descentVal|.
        if (descentVal !== 0 && Math.abs(descentVal) <= DESCRIPTOR_METRIC_MAX) descent = -Math.abs(descentVal);

        const fontFlags = resolveIntValue(fdText, 'Flags', objCache);
        if (!bold) {
          const weight = resolveIntValue(fdText, 'FontWeight', objCache);
          if ((weight >= 700) || (fontFlags & 262144)) bold = true;
        }
        if (!italic) {
          const angle = resolveNumValue(fdText, 'ItalicAngle', objCache);
          if ((Math.abs(angle) > 0 && Math.abs(angle) < 45) || (fontFlags & 64)) italic = true;
        }
        if (fontFlags & 2) serifFlag = true;
        if (fontFlags & 4) symbolicFlag = true;
        const descAngle = resolveNumValue(fdText, 'ItalicAngle', objCache);
        if (descAngle && Math.abs(descAngle) < 45) italicAngleDeg = descAngle;
        const descCapH = resolveNumValue(fdText, 'CapHeight', objCache);
        if (descCapH > 0 && descCapH <= DESCRIPTOR_METRIC_MAX) capHeightPdf = descCapH;
        const descXH = resolveNumValue(fdText, 'XHeight', objCache);
        if (descXH > 0 && descXH <= DESCRIPTOR_METRIC_MAX) xHeightPdf = descXH;
        const descStemV = resolveNumValue(fdText, 'StemV', objCache);
        if (descStemV > 0) stemV = descStemV;

        // Per PDF spec 9.6.2, a FontDescriptor's /MissingWidth defaults to 0 for codes outside /Widths, overriding the /Widths average above.
        if (widths.size > 0) {
          const mw = resolveNumValue(fdText, 'MissingWidth', objCache);
          defaultWidth = mw || 0;
        }

        if (!isType3) {
          const ff1Match = /\/FontFile\s+(\d+)\s+\d+\s+R/.exec(fdText);
          const ff2Match = /\/FontFile2\s+(\d+)\s+\d+\s+R/.exec(fdText);
          const ff3Match = /\/FontFile3\s+(\d+)\s+\d+\s+R/.exec(fdText);
          const ffMatch = ff2Match || ff3Match || ff1Match;
          if (ffMatch) {
            const fontFile = objCache.getStreamBytes(Number(ffMatch[1]));
            if (fontFile) type1Info = { fontFile };

            // Some subsetters emit zero or missing /Widths for drawn CFF glyphs, which parseDrawOps skips unless backfilled from the charstrings.
            const widthsSparse = [...widths.values()].some((w) => !w)
              || (differences && Object.keys(differences).some((k) => widths.get(Number(k)) === undefined));
            if (fontFile && fontFile[0] === 1 && fontFile[1] === 0 && widthsSparse) {
              try {
                const dv = new DataView(fontFile.buffer, fontFile.byteOffset, fontFile.byteLength);
                const shell = {
                  tables: {}, encoding: null, isCIDFont: false, unitsPerEm: 1000,
                };
                opentype.parseCFFTable(dv, 0, shell);
                const charset = shell.tables.cff?.charset;
                if (!shell.isCIDFont && charset) {
                  const fmScale = shell.tables.cff.topDict.fontMatrix?.[0];
                  const upm = fmScale > 0 && fmScale < 1 ? Math.round(1 / fmScale) : 1000;
                  const builtinEnc = (shell.cffEncoding || shell.encoding)?.encoding;
                  const codes = new Set(widths.keys());
                  if (differences) for (const k of Object.keys(differences)) codes.add(Number(k));
                  if (builtinEnc) for (const k of Object.keys(builtinEnc)) codes.add(Number(k));
                  for (const code of codes) {
                    if (widths.get(code)) continue;
                    let gid;
                    const diffName = differences && differences[code];
                    if (diffName) {
                      const i = charset.indexOf(diffName);
                      if (i > 0) gid = i;
                    } else if (builtinEnc && builtinEnc[code] !== undefined) {
                      gid = builtinEnc[code] + 1;
                    }
                    if (!gid || gid <= 0 || gid >= shell.nGlyphs) continue;
                    const glyph = shell.glyphs.get(gid);
                    // Reading the lazy `path` getter parses the charstring, which populates advanceWidth.
                    const { commands } = glyph.path;
                    if (!commands.length) continue;
                    let adv = Math.round((glyph.advanceWidth || 0) / upm * 1000);
                    if (adv <= 0) adv = Math.round((glyph.getBoundingBox().x2 || 0) / upm * 1000);
                    if (adv > 0) widths.set(code, adv);
                  }
                }
              } catch { /* on any parse or glyph error, leave widths as-is */ }
            }
          }

          if (ff2Match && type1Info?.fontFile && toUnicode.size === 0 && encodingUnicode.size === 0) {
            const fb = type1Info.fontFile;
            if (fb.length >= 12) {
              const nT = (fb[4] << 8) | fb[5];
              let hasMacRomanCmap = false;
              let hasPlatform3 = false;
              for (let ti = 0; ti < nT && 12 + (ti + 1) * 16 <= fb.length; ti++) {
                const te = 12 + ti * 16;
                if (fb[te] === 0x63 && fb[te + 1] === 0x6D && fb[te + 2] === 0x61 && fb[te + 3] === 0x70) {
                  const cmapOff = (fb[te + 8] << 24) | (fb[te + 9] << 16) | (fb[te + 10] << 8) | fb[te + 11];
                  if (cmapOff + 4 <= fb.length) {
                    const numSub = (fb[cmapOff + 2] << 8) | fb[cmapOff + 3];
                    for (let si = 0; si < numSub; si++) {
                      const se = cmapOff + 4 + si * 8;
                      if (se + 8 > fb.length) break;
                      const platform = (fb[se] << 8) | fb[se + 1];
                      const encoding = (fb[se + 2] << 8) | fb[se + 3];
                      if (platform === 1 && encoding === 0) hasMacRomanCmap = true;
                      if (platform === 3) hasPlatform3 = true;
                    }
                  }
                  break;
                }
              }
              if (hasMacRomanCmap && !hasPlatform3) {
                detectedMacRomanCmap = true;
                for (let code = 0x80; code <= 0xFF; code++) {
                  const macChar = macRomanChars[code - 32];
                  if (macChar && macChar !== String.fromCharCode(code)) {
                    toUnicode.set(code, macChar);
                  }
                }
              } else if (hasMacRomanCmap && disambiguateMacWinByWidths(widths, baseName) === 'MacRoman') {
                detectedMacRomanCmap = true;
                for (let code = 0x80; code <= 0xFF; code++) {
                  const macChar = macRomanChars[code - 32];
                  if (macChar && macChar !== String.fromCharCode(code)) {
                    toUnicode.set(code, macChar);
                  }
                }
              }
            }
          }

          if (ff2Match && !detectedMacRomanCmap && toUnicode.size === 0 && encodingUnicode.size === 0
              && !/ZapfDingbats|Symbol|Wingdings/i.test(baseName)) {
            for (let code = 32; code <= 255; code++) {
              const ch = win1252Chars[code - 32];
              if (ch) {
                encodingUnicode.set(code, ch);
                toUnicode.set(code, ch);
              }
            }
          }
        }
      }

      // showType1Literal requires a non-null `type1` object even when a Type1 or TrueType font has no embedded program and renders via CSS fallback.
      if (!type1Info && !isType3 && (/\/Subtype\s*\/Type1/.test(fontObj) || /\/Subtype\s*\/TrueType/.test(fontObj))) {
        type1Info = { fontFile: null };
      }

      // Exclude CMSY (math symbols) and CMEX (math extensions), which do not use TeX's OT1 ligature slots 11-15.
      if (/^(cm|CM)/i.test(baseName) && !/CMSY|CMEX/i.test(baseName) && !isType3) {
        const texOT1Ligatures = [
          [11, '\uFB00'],
          [12, '\uFB01'],
          [13, '\uFB02'],
          [14, '\uFB03'],
          [15, '\uFB04'],
        ];
        for (const [code, ch] of texOT1Ligatures) {
          if (!toUnicode.has(code)) {
            toUnicode.set(code, ch);
            encodingUnicode.set(code, ch);
          }
        }
      }

      // Some generators emit sparse /Differences arrays or omit /ToUnicode entries, relying on the embedded CFF's built-in encoding for the remaining charCodes.
      if (type1Info?.fontFile) {
        try {
          const summary = parseCFFSummary(type1Info.fontFile);
          cffSummary = summary;
          if (summary.ok && !summary.isCID && !summary.predefinedCharset) {
            const cffEnc = summary.cffEncoding?.encoding;
            if (Array.isArray(cffEnc)) {
              for (let code = 0; code < cffEnc.length; code++) {
                const glyphName = cffEnc[code];
                if (typeof glyphName !== 'string' || !glyphName) continue;
                if (toUnicode.has(code) || encodingUnicode.has(code)) continue;
                const uni = aglLookup(glyphName);
                if (uni) {
                  toUnicode.set(code, uni);
                  encodingUnicode.set(code, uni);
                }
              }
            } else if (cffEnc && typeof cffEnc === 'object') {
              const glyphToUnicode = cffCharsetNamesToUnicode(summary.charsetNames);
              const isSymbolCffByName = determineSansSerif(baseName) === 'SymbolDefault'
                || determineSansSerif(familyName) === 'SymbolDefault'
                || /sym|ding|wing/i.test(baseName)
                || /sym|ding|wing/i.test(familyName);
              // GID is the encoding position plus one because GID 0 is .notdef and has no encoding entry.
              // Symbol and decoration fonts often reuse Latin glyph names for bullets, so their ASCII codepoints are skipped rather than extracted as letters.
              for (const [codeStr, encVal] of Object.entries(cffEnc)) {
                const code = Number(codeStr);
                if (!Number.isInteger(code) || code < 0 || code > 255) continue;
                if (toUnicode.has(code) || encodingUnicode.has(code)) continue;
                if (typeof encVal !== 'number') continue;
                const gid = encVal + 1;
                const uni = glyphToUnicode.get(gid);
                if (!uni) continue;
                if (uni.length === 1) {
                  const cp = uni.codePointAt(0);
                  if (cp <= 0x1F || cp === 0x7F) continue;
                  if (isSymbolCffByName && cp <= 0x7F) continue;
                }
                toUnicode.set(code, uni);
                encodingUnicode.set(code, uni);
              }
            }
          }
        } catch (_e) { /* ignore malformed CFF */ }
      }

      if (isType3) {
        type3Info = parseType3Font(fontObj, objCache);
        if (type3Info) {
          for (const [charCodeStr, glyphName] of Object.entries(type3Info.encoding)) {
            const glyph = type3Info.glyphs[glyphName];
            if (glyph && glyph.advanceWidth > 0) {
              const charCode = Number(charCodeStr);
              widths.set(charCode, glyph.advanceWidth * type3Info.fontMatrix[0] * 1000);
              if (glyph.placeholderD1 && glyph.bbox && glyph.bbox.x1 > 0) {
                if (!glyphVisualWidths) glyphVisualWidths = new Map();
                glyphVisualWidths.set(charCode, glyph.bbox.x1 * type3Info.fontMatrix[0] * 1000);
              }
              if (!toUnicode.has(charCode)) {
                if (glyph.bbox === null) {
                  toUnicode.set(charCode, ' ');
                } else {
                  const userMapping = glyph.pathHash && type3GlyphMappings
                    ? type3GlyphMappings.get(glyph.pathHash) : undefined;
                  if (userMapping !== undefined) {
                    toUnicode.set(charCode, userMapping);
                  } else {
                    // PUA placeholder so charCodes like 32 are not mistaken for spaces by the str[i] fallback in showLiteralString.
                    toUnicode.set(charCode, String.fromCodePoint(0xE000 + charCode));
                  }
                }
              }
            }
          }
          // A Type3 character outside the encoding has no glyph, so it advances nothing rather than the average glyph width.
          defaultWidth = 0;

          // Some Type3 fonts carry a placeholder FontBBox that would inflate the metrics and collapse line grouping.
          const fb = type3Info.fontBBox;
          const fm3 = type3Info.fontMatrix[3];
          if (fb && Number.isFinite(fm3)) {
            const emHeight = Math.abs((fb[3] - fb[1]) * fm3);
            if (Number.isFinite(emHeight) && emHeight > 0.2 && emHeight < 3) {
              ascent = fb[3] * fm3 * 1000;
              descent = fb[1] * fm3 * 1000;
            }
          }
        }
      }
    }

    if (/\/DescendantFonts/.test(fontObj)) {
      const utf16Match = /\/Encoding\s*\/([\w-]*(?:UTF16|UCS2)[\w-]*)/.exec(fontObjEnc);
      if (utf16Match) {
        codespaceRanges = codespaceRanges || [{ bytes: 2, low: 0, high: 0xFFFF }];
        if (!type0Info) type0Info = { fontFile: null, cidToGidMap: 'identity' };
        // Marks the font so the renderer's embedded-glyph-unavailable guard does not drop text it can still draw from the charCode alone.
        type0Info.unicodeCMap = true;
        // Every Adobe CJK collection maps printable ASCII to CIDs 1-95.
        // Without the mapping, width lookups key on the charCode, miss the half-width /W entries and fall back to the full-width /DW.
        if (!charCodeToCID) {
          charCodeToCID = new Map();
          for (let u = 0x0020; u <= 0x007E; u++) {
            charCodeToCID.set(u, u - 0x1F);
          }
        }
      }
    }

    const verticalMode = /\/Encoding\s*\/[\w-]+-V\b/.test(fontObjEnc);

    let preferEncodingCase = false;
    if (!cidFontText && !type3Info && toUnicode.size > 0 && encodingUnicode.size > 0) {
      let caseConflictCount = 0;
      let directionConsistent = true;
      let direction = 0;
      for (let code = 65; code <= 122; code++) {
        if (code > 90 && code < 97) continue;
        const tu = toUnicode.get(code);
        const eu = encodingUnicode.get(code);
        if (!tu || !eu || tu.length !== 1 || eu.length !== 1) continue;
        if (!/[A-Za-z]/.test(tu) || !/[A-Za-z]/.test(eu)) continue;
        if (tu !== eu && tu.toLowerCase() === eu.toLowerCase()) {
          caseConflictCount++;
          const d = tu === tu.toLowerCase() ? -1 : 1;
          if (direction === 0) direction = d;
          else if (direction !== d) directionConsistent = false;
        }
      }
      preferEncodingCase = caseConflictCount >= 2 && directionConsistent;
    }

    /** @type {Map<number, { encoding: string, toUnicode: string }>|null} */
    let encodingToUnicodeConflicts = null;
    if (encodingUnicode.size > 0 && toUnicode.size > 0) {
      /** @type {Record<string, string>} */
      const LIGATURE_PRECOMPOSED_TO_DECOMP = {
        ﬀ: 'ff', ﬁ: 'fi', ﬂ: 'fl', ﬃ: 'ffi', ﬄ: 'ffl',
      };
      for (const [code, eu] of encodingUnicode) {
        const tu = toUnicode.get(code);
        if (tu === undefined || tu === eu) continue;
        if (LIGATURE_PRECOMPOSED_TO_DECOMP[eu] === tu) continue;
        if (!encodingToUnicodeConflicts) encodingToUnicodeConflicts = new Map();
        encodingToUnicodeConflicts.set(code, { encoding: eu, toUnicode: tu });
      }
    }

    // Corrupt /Widths entries (e.g. 32-bit packed values like 0x00020002) blow up glyph bboxes and overflow uint16 hmtx tables during OTF rebuild.
    // Type3 is exempt because a non-standard FontMatrix (compensated by Tf) can put d1 * fontMatrix[0] * 1000 legitimately past 4000.
    if (!type3Info) {
      const SANE_MAX_WIDTH = 4000;
      let saneSum = 0; let saneCount = 0;
      for (const w of widths.values()) {
        if (Number.isFinite(w) && w >= 0 && w <= SANE_MAX_WIDTH) { saneSum += w; saneCount++; }
      }
      const saneFallback = saneCount > 0 ? Math.round(saneSum / saneCount) : 1000;
      let widthsClamped = false;
      for (const [cc, w] of widths) {
        if (!(Number.isFinite(w) && w >= 0 && w <= SANE_MAX_WIDTH)) {
          widths.set(cc, saneFallback);
          widthsClamped = true;
        }
      }
      if (widthsClamped && (!Number.isFinite(defaultWidth) || defaultWidth < 0 || defaultWidth > SANE_MAX_WIDTH)) {
        defaultWidth = saneFallback;
      }
    }

    let widthsUnreliable = false;
    const embedded = !!(type1Info?.fontFile || type0Info?.fontFile || type3Info);
    if (!embedded && !symbolicFlag) {
      /** @type {Map<number, number>} */
      const refWidths = new Map();
      applyStandardFontWidths(baseName, refWidths);
      let sampled = 0;
      let firstWidth = 0;
      let anyFar = false;
      let allEqual = true;
      for (const [code, w] of widths) {
        if (!(w > 0)) continue;
        let cp = code;
        if (cidFontText) {
          const u = toUnicode.get(code);
          if (!u || u.length !== 1) continue;
          cp = u.codePointAt(0);
        } else if (differences && differences[code] !== undefined) {
          continue;
        }
        if (cp < 33 || cp > 126) continue;
        const ref = refWidths.get(cp);
        if (!(ref > 0)) continue;
        if (sampled === 0) firstWidth = w;
        else if (w !== firstWidth) allEqual = false;
        sampled++;
        if (w > ref * 2 || w < ref / 2) anyFar = true;
      }
      // An all-equal sample is a monospace claim, not a scramble, and those fonts need the squeeze into their constant cell to render acceptably.
      widthsUnreliable = sampled >= 8 && anyFar && !allEqual;
    }

    // Never clear `bold` from the embedded program, because subsetters often leave "Regular" or weight 400 in a bold face's tables.
    const programFile = type0Info?.fontFile || type1Info?.fontFile;
    if (!bold && programFile && programFile.length >= 4) {
      const b = programFile;
      const boldWeightRe = /bold|black|heavy/i;
      try {
        if (b[0] === 1 && b[1] === 0) {
          const summary = cffSummary && cffSummary.ok ? cffSummary : parseCFFSummary(b);
          if (summary.ok && boldWeightRe.test(summary.weight || '')) bold = true;
        } else if ((b[0] === 0x25 && b[1] === 0x21) || b[0] === 0x80) {
          let txt = '';
          const n = Math.min(b.length, 16384);
          for (let i = 0; i < n; i++) txt += String.fromCharCode(b[i]);
          const end = txt.indexOf('currentfile eexec');
          const m = /\/Weight\s*\(([^)]*)\)/.exec(end > 0 ? txt.slice(0, end) : txt);
          if (m && boldWeightRe.test(m[1])) bold = true;
        } else {
          const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
          const dir = opentype.readSfntTableDirectory(dv);
          if (dir['OS/2']) {
            const os2 = opentype.parseOS2Table(dv, dir['OS/2'].offset);
            if (os2.usWeightClass >= 700 || (os2.fsSelection & 0x20)) bold = true;
          }
          if (dir.head && (opentype.parseHeadTable(dv, dir.head.offset).macStyle & 1)) bold = true;
          if (dir.name) {
            const names = opentype.parseNameTable(dv, dir.name.offset, undefined, dir.name.length);
            const subfamily = (names.preferredSubfamily && names.preferredSubfamily.en) || (names.fontSubfamily && names.fontSubfamily.en) || '';
            if (boldWeightRe.test(subfamily)) bold = true;
          }
          if (dir['CFF ']) {
            const summary = parseCFFSummary(b.subarray(dir['CFF '].offset, dir['CFF '].offset + dir['CFF '].length));
            if (summary.ok && boldWeightRe.test(summary.weight || '')) bold = true;
          }
        }
      } catch { /* an unreadable program declares nothing */ }
    }

    const fontInfo = {
      baseName,
      toUnicode,
      widths,
      widthsUnreliable,
      glyphVisualWidths,
      defaultWidth,
      ascent,
      descent,
      bold,
      italic,
      smallCaps,
      familyName,
      type3: type3Info ? {
        fontMatrix: type3Info.fontMatrix,
        fontBBox: type3Info.fontBBox,
        encoding: type3Info.encoding,
        glyphs: type3Info.glyphs,
        charProcObjNums: type3Info.charProcObjNums,
        xobjectResources: type3Info.xobjectResources,
      } : null,
      type0: type0Info,
      type1: type1Info,
      isCIDFont: !!cidFontText,
      validCIDs,
      differences,
      encodingUnicode,
      charCodeToGlyphName: charCodeToGlyphName.size > 0 ? charCodeToGlyphName : null,
      encodingToUnicodeConflicts,
      macRomanCmap: detectedMacRomanCmap,
      charCodeToCID,
      codespaceRanges,
      hasOwnToUnicode: toUnicode.size > 0,
      serifFlag,
      symbolicFlag,
      italicAngleDeg,
      capHeightPdf,
      xHeightPdf,
      stemV,
      verticalMode,
      preferEncodingCase,
      fontObjNum,
    };
    fonts.set(fontTag, fontInfo);
    if (fontObjNum !== null) objCache.fontCache.set(fontObjNum, fontInfo);
  }

  const type0StyleKey = (baseName = '') => {
    const clean = baseName.replace(/^[A-Z]{6}\+/, '');
    const parts = clean.split('-').filter(Boolean);
    if (parts.length >= 2) return `${parts[0]}-${parts[1]}`.toLowerCase();
    return clean.toLowerCase();
  };
  const codespaceMatches = (a, b) => JSON.stringify(a || null) === JSON.stringify(b || null);
  const widthCompatibility = (target, donor) => {
    let overlap = 0;
    let equal = 0;
    for (const [cid, width] of target.widths) {
      const donorWidth = donor.widths.get(cid);
      if (donorWidth === undefined) continue;
      overlap++;
      if (Math.abs(donorWidth - width) < 0.01) equal++;
    }
    return { overlap, ratio: overlap > 0 ? equal / overlap : 0 };
  };

  // Some producers write identity-mapped ToUnicode entries where glyph-name lookup failed, even when the rest of the CMap follows a consistent non-zero shift.
  for (const [, font] of fonts) {
    // `fonts` includes `ObjectCache.fontCache` hits, and rescanning a shared 65,536-entry CMap on every page or XObject would dominate parsing.
    if (identityShiftChecked.has(font)) continue;
    identityShiftChecked.add(font);
    if (font.toUnicode.size < 10) continue;
    if (font.type1 || font.type3) continue;
    /** @type {Array<[number, number]>} */
    const singles = [];
    for (const [cc, str] of font.toUnicode) {
      if (typeof str !== 'string' || str.length === 0) continue;
      if ([...str].length !== 1) continue;
      const cp = str.codePointAt(0);
      if (cp === undefined) continue;
      singles.push([cc, cp]);
    }
    if (singles.length < 10) continue;
    const globalOffsetCounts = new Map();
    for (const [cc, cp] of singles) {
      const off = cp - cc;
      globalOffsetCounts.set(off, (globalOffsetCounts.get(off) || 0) + 1);
    }
    let globalDominantOffset = 0;
    let globalDominantCount = 0;
    for (const [o, c] of globalOffsetCounts) {
      if (c > globalDominantCount) {
        globalDominantCount = c;
        globalDominantOffset = o;
      }
    }
    if (globalDominantOffset === 0) continue;
    if (globalDominantCount / singles.length < 0.8) continue;
    /** @type {Array<[number, string]>} */
    const fixes = [];
    for (const [cc, cp] of singles) {
      if (cp !== cc) continue;
      const corrected = cc + globalDominantOffset;
      if (corrected < 0x20 || corrected > 0x10FFFF) continue;
      fixes.push([cc, String.fromCodePoint(corrected)]);
    }
    for (const [cc, str] of fixes) font.toUnicode.set(cc, str);
  }

  // Some producers emit a ToUnicode CMap for only some subset or style variants of a family, so a font without one inherits from a sibling.
  for (const [, font] of fonts) {
    if (font.toUnicode.size > 0 || font.type1 || font.type3) continue;
    const normFamily = normalizeFamilyForMatch(font.familyName);
    /** @type {Array<any>} */
    const familyDonors = [];
    for (const [, sibling] of fonts) {
      if (sibling === font || sibling.toUnicode.size === 0) continue;
      const sibNorm = normalizeFamilyForMatch(sibling.familyName);
      if (!familiesCompatible(normFamily, sibNorm)) continue;
      familyDonors.push(sibling);
    }
    if (familyDonors.length === 0) continue;

    if (!font.type0) {
      for (const sibling of familyDonors) {
        for (const [cid, uni] of sibling.toUnicode) {
          if (!font.toUnicode.has(cid)) font.toUnicode.set(cid, uni);
        }
      }
      continue;
    }

    // Type0 subsets of one family can assign different CIDs, so require matching codespaces and compatible widths.
    let bestDonor = null;
    let bestRatio = 0;
    let bestOverlap = 0;
    for (const sibling of familyDonors) {
      if (!sibling.type0) continue;
      if (!codespaceMatches(font.codespaceRanges, sibling.codespaceRanges)) continue;
      const { overlap, ratio } = widthCompatibility(font, sibling);
      if (overlap < 64 || ratio < 0.98) continue;
      if (ratio > bestRatio || (ratio === bestRatio && overlap > bestOverlap)) {
        bestDonor = sibling;
        bestRatio = ratio;
        bestOverlap = overlap;
      }
    }
    if (!bestDonor) {
      const targetStyleKey = type0StyleKey(font.baseName);
      const fallbackCandidates = familyDonors.filter((sibling) => {
        if (!sibling.type0) return false;
        if (!codespaceMatches(font.codespaceRanges, sibling.codespaceRanges)) return false;
        if (type0StyleKey(sibling.baseName) !== targetStyleKey) return false;
        if (font.widths.size === 0 || sibling.widths.size === 0) return false;
        let overlap = 0;
        for (const cid of font.widths.keys()) {
          if (sibling.widths.has(cid)) overlap++;
        }
        const targetCoverage = overlap / font.widths.size;
        const donorCoverage = overlap / sibling.widths.size;
        return targetCoverage >= 0.95 && donorCoverage >= 0.95;
      });
      if (fallbackCandidates.length === 0) continue;
      const ref = fallbackCandidates[0];
      let consistent = true;
      for (let i = 1; i < fallbackCandidates.length && consistent; i++) {
        const sibling = fallbackCandidates[i];
        let overlap = 0;
        let conflicts = 0;
        for (const [cid, uni] of ref.toUnicode) {
          const siblingUni = sibling.toUnicode.get(cid);
          if (siblingUni === undefined) continue;
          overlap++;
          if (siblingUni !== uni) conflicts++;
        }
        if (overlap >= 64 && conflicts / overlap > 0.02) consistent = false;
      }
      if (!consistent) continue;
      bestDonor = fallbackCandidates[0];
    }

    for (const [cid, uni] of bestDonor.toUnicode) {
      if (!font.toUnicode.has(cid)) font.toUnicode.set(cid, uni);
    }
  }

  return fonts;
}

/**
 * Parse a ToUnicode CMap stream text and populate the map.
 * @param {string} cmapText
 * @param {Map<number, string>} map
 */
export function parseToUnicodeCMap(cmapText, map) {
  const isOnlyReplacementChars = (s) => {
    if (s.length === 0) return false;
    for (let i = 0; i < s.length; i++) {
      if (s.charCodeAt(i) !== 0xFFFD) return false;
    }
    return true;
  };
  // A value code unit in U+0080-U+009F is a Windows-1252 byte written as a codepoint, so it decodes through that table.
  // The five bytes CP1252 leaves undefined stay as written, since the table holds placeholders there.
  const decodeC1 = (s) => {
    let out = '';
    for (let i = 0; i < s.length; i++) {
      const cu = s.charCodeAt(i);
      if (cu >= 0x80 && cu <= 0x9F && cu !== 0x81 && cu !== 0x8D && cu !== 0x8F && cu !== 0x90 && cu !== 0x9D) {
        out += win1252Chars[cu - 0x20];
      } else {
        out += s[i];
      }
    }
    return out;
  };

  const usecmapMatch = /\/Adobe-(Japan1|Korea1|GB1|CNS1)-UCS2\s+usecmap/.exec(cmapText);
  if (usecmapMatch) {
    const cidMap = getCIDToUnicodeMap(usecmapMatch[1]);
    if (cidMap) {
      for (let cid = 0; cid < cidMap.length; cid++) {
        const cp = cidMap[cid];
        if (cp !== 0) map.set(cid, String.fromCodePoint(cp));
      }
    }
  }

  const bfcharRegex = /beginbfchar\s*([\s\S]*?)endbfchar/g;
  const bfcharMatches = [...cmapText.matchAll(bfcharRegex)];
  for (const m of bfcharMatches) {
    const entries = [...m[1].matchAll(/<([0-9A-Fa-f\s]+)>\s*<([0-9A-Fa-f\s]+)>/g)];
    for (const entry of entries) {
      const cid = parseInt(entry[1].replace(/\s+/g, ''), 16);
      const unicode = hexToUnicode(entry[2]);
      if (isOnlyReplacementChars(unicode)) continue;
      map.set(cid, decodeC1(unicode));
    }
  }

  /**
   * Add one run of `<start> <end> <dst>` entries to `map`.
   * @param {number} cidStart
   * @param {number} cidEnd
   * @param {string} prefix
   * @param {number} firstCp
   */
  const emitRun = (cidStart, cidEnd, prefix, firstCp) => {
    const rangeLen = cidEnd - cidStart + 1;
    if (rangeLen > LAZY_BFRANGE_MIN && map instanceof ToUnicodeMap) {
      const valueAt = (/** @type {number} */ cid) => {
        const cp = firstCp + (cid - cidStart);
        if (cp > 0x10FFFF || cp === 0xFFFD) return undefined;
        return decodeC1(prefix + String.fromCodePoint(cp));
      };
      const lastValid = Math.min(firstCp + rangeLen - 1, 0x10FFFF);
      let definedCount = Math.max(0, lastValid - firstCp + 1);
      if (firstCp <= 0xFFFD && lastValid >= 0xFFFD) definedCount--;
      if (map.addRange(cidStart, cidEnd, valueAt, definedCount)) return;
    }
    let lastCp = firstCp;
    for (let cid = cidStart; cid <= cidEnd; cid++) {
      if (lastCp <= 0x10FFFF && lastCp !== 0xFFFD) {
        map.set(cid, decodeC1(prefix + String.fromCodePoint(lastCp)));
      }
      lastCp++;
    }
  };

  // Entries that continue the previous one merge into one run because Acrobat writes an identity map as 256 ranges of 256 codes, each too short to be kept as a range on its own.
  /** @type {?{ start: number, end: number, prefix: string, firstCp: number }} */
  let run = null;
  const flushRun = () => {
    if (run) emitRun(run.start, run.end, run.prefix, run.firstCp);
    run = null;
  };

  const bfrangeRegex = /beginbfrange\s*([\s\S]*?)endbfrange/g;
  const bfrangeMatches = [...cmapText.matchAll(bfrangeRegex)];
  for (const bfm of bfrangeMatches) {
    const entryRegex = /<([0-9A-Fa-f\s]+)>\s*<([0-9A-Fa-f\s]+)>\s*(?:\[([\s\S]*?)\]|<([0-9A-Fa-f\s]+)>)/g;
    const entries = [...bfm[1].matchAll(entryRegex)];
    for (const entry of entries) {
      const cidStart = parseInt(entry[1].replace(/\s+/g, ''), 16);
      const cidEnd = parseInt(entry[2].replace(/\s+/g, ''), 16);
      if (entry[4] !== undefined) {
        // Split by code point (`[...dstStr]`) so UTF-16BE surrogate pairs (e.g. <D835DC34> = U+1D434) are not torn across prefix and firstCp.
        const dstStr = hexToUnicode(entry[4]);
        if (dstStr.length > 0 && !isOnlyReplacementChars(dstStr)) {
          const dstCps = [...dstStr];
          const prefix = dstCps.slice(0, -1).join('');
          const firstCp = dstCps[dstCps.length - 1].codePointAt(0) ?? 0;
          if (run && run.prefix === prefix && cidStart === run.end + 1 && firstCp === run.firstCp + (run.end - run.start + 1)) {
            run.end = cidEnd;
            continue;
          }
          flushRun();
          run = {
            start: cidStart, end: cidEnd, prefix, firstCp,
          };
        } else {
          flushRun();
        }
      } else if (entry[3] !== undefined) {
        flushRun();
        // An empty string still holds its code's position in the array, so the token list keeps it.
        const arrayTokens = [...entry[3].matchAll(/<([0-9A-Fa-f\s]*)>/g)];
        for (let idx = 0; idx < arrayTokens.length && cidStart + idx <= cidEnd; idx++) {
          const unicode = hexToUnicode(arrayTokens[idx][1]);
          if (unicode.length === 0 || isOnlyReplacementChars(unicode)) continue;
          map.set(cidStart + idx, decodeC1(unicode));
        }
      }
    }
  }
  flushRun();
}

/**
 * Parse a CID encoding CMap and populate a charCode -> CID map.
 * @param {string} cmapText
 * @param {Map<number, number>} map
 */
function parseCIDEncodingCMap(cmapText, map) {
  const cidcharRegex = /begincidchar\s*([\s\S]*?)endcidchar/g;
  for (const m of cmapText.matchAll(cidcharRegex)) {
    for (const entry of m[1].matchAll(/<([0-9A-Fa-f\s]+)>\s+(\d+)/g)) {
      map.set(parseInt(entry[1].replace(/\s+/g, ''), 16), parseInt(entry[2], 10));
    }
  }

  const cidrangeRegex = /begincidrange\s*([\s\S]*?)endcidrange/g;
  for (const m of cmapText.matchAll(cidrangeRegex)) {
    for (const entry of m[1].matchAll(/<([0-9A-Fa-f\s]+)>\s*<([0-9A-Fa-f\s]+)>\s+(\d+)/g)) {
      const start = parseInt(entry[1].replace(/\s+/g, ''), 16);
      const end = parseInt(entry[2].replace(/\s+/g, ''), 16);
      let cidStart = parseInt(entry[3], 10);
      for (let code = start; code <= end; code++) {
        map.set(code, cidStart++);
      }
    }
  }

  // Some PDFs use bfchar/bfrange syntax in encoding CMaps where both values are hex.
  const bfcharRegex = /beginbfchar\s*([\s\S]*?)endbfchar/g;
  for (const m of cmapText.matchAll(bfcharRegex)) {
    for (const entry of m[1].matchAll(/<([0-9A-Fa-f\s]+)>\s*<([0-9A-Fa-f\s]+)>/g)) {
      map.set(parseInt(entry[1].replace(/\s+/g, ''), 16), parseInt(entry[2].replace(/\s+/g, ''), 16));
    }
  }

  const bfrangeRegex = /beginbfrange\s*([\s\S]*?)endbfrange/g;
  for (const m of cmapText.matchAll(bfrangeRegex)) {
    for (const entry of m[1].matchAll(/<([0-9A-Fa-f\s]+)>\s*<([0-9A-Fa-f\s]+)>\s*<([0-9A-Fa-f\s]+)>/g)) {
      const start = parseInt(entry[1].replace(/\s+/g, ''), 16);
      const end = parseInt(entry[2].replace(/\s+/g, ''), 16);
      let cidStart = parseInt(entry[3].replace(/\s+/g, ''), 16);
      for (let code = start; code <= end; code++) {
        map.set(code, cidStart++);
      }
    }
  }
}

/**
 * Parse character-code byte-width ranges from a CMap's `codespacerange` blocks.
 * @param {string} cmapText
 * @returns {Array<{bytes: number, low: number, high: number}>|null} `null` when no codespace is declared or all ranges are 2-byte.
 */
function parseCIDCodespaceRanges(cmapText) {
  const ranges = [];
  const csRegex = /begincodespacerange\s*([\s\S]*?)endcodespacerange/g;
  for (const m of cmapText.matchAll(csRegex)) {
    for (const entry of m[1].matchAll(/<([0-9A-Fa-f\s]+)>\s*<([0-9A-Fa-f\s]+)>/g)) {
      const low = entry[1].replace(/\s+/g, '');
      const numBytes = Math.ceil(low.length / 2);
      ranges.push({ bytes: numBytes, low: parseInt(low, 16), high: parseInt(entry[2].replace(/\s+/g, ''), 16) });
    }
  }
  ranges.sort((a, b) => a.bytes - b.bytes);
  // A uniform 1-byte CMap must still return ranges, so this cannot collapse into an all-widths-equal check.
  if (ranges.length === 0) return null;
  if (ranges[0].bytes === 2 && ranges[ranges.length - 1].bytes === 2) return null;
  return ranges;
}

/**
 * Convert a hex string to a Unicode string.
 * @param {string} hex
 */
function hexToUnicode(hex) {
  hex = hex.replace(/\s+/g, '');
  let str = '';
  for (let i = 0; i < hex.length; i += 4) {
    const cp = parseInt(hex.substring(i, i + 4), 16);
    if (cp <= 0x10FFFF) str += String.fromCodePoint(cp);
  }
  return str;
}

/**
 * Parse a CIDFont `/W` array into a `CID -> width` map.
 * @param {string} cidFontText
 * @param {Map<number, number>} widths
 */
function parseCIDWidths(cidFontText, widths) {
  const wStart = cidFontText.indexOf('/W');
  if (wStart === -1) return;
  const bracketStart = cidFontText.indexOf('[', wStart);
  if (bracketStart === -1) return;

  let depth = 0;
  let bracketEnd = -1;
  for (let j = bracketStart; j < cidFontText.length; j++) {
    if (cidFontText[j] === '[') depth++;
    else if (cidFontText[j] === ']') {
      depth--;
      if (depth === 0) { bracketEnd = j; break; }
    }
  }
  if (bracketEnd === -1) return;

  const wContent = cidFontText.substring(bracketStart + 1, bracketEnd);
  const tokens = [];
  let i = 0;
  while (i < wContent.length) {
    if (wContent[i] === '[') {
      const end = wContent.indexOf(']', i);
      if (end === -1) break;
      const inner = wContent.substring(i + 1, end).trim().split(/\s+/).map(Number);
      tokens.push(inner);
      i = end + 1;
    } else if (/[\d-]/.test(wContent[i])) {
      const numMatch = /^[\d.+-]+/.exec(wContent.substring(i));
      if (numMatch) {
        tokens.push(Number(numMatch[0]));
        i += numMatch[0].length;
      } else {
        i++;
      }
    } else {
      i++;
    }
  }

  i = 0;
  while (i < tokens.length) {
    if (typeof tokens[i] === 'number' && i + 1 < tokens.length && Array.isArray(tokens[i + 1])) {
      const startCID = /** @type {number} */ (tokens[i]);
      const ws = /** @type {number[]} */ (tokens[i + 1]);
      for (let j = 0; j < ws.length; j++) {
        widths.set(startCID + j, ws[j]);
      }
      i += 2;
    } else if (typeof tokens[i] === 'number' && typeof tokens[i + 1] === 'number' && typeof tokens[i + 2] === 'number') {
      const cidStart = /** @type {number} */ (tokens[i]);
      const cidEnd = /** @type {number} */ (tokens[i + 1]);
      const w = /** @type {number} */ (tokens[i + 2]);
      for (let cid = cidStart; cid <= cidEnd; cid++) {
        widths.set(cid, w);
      }
      i += 3;
    } else {
      i++;
    }
  }
}

/**
 * @typedef {{
 *   fontName: string,
 *   fontFile: Uint8Array,
 * }} Type0FontInfo
 */

/**
 * Extract the TrueType programs of Type0 fonts directly from raw PDF bytes.
 * @param {Uint8Array} pdfBytes
 * @returns {{ [fontObjNum: number]: Type0FontInfo }}
 */
export function extractType0Fonts(pdfBytes) {
  const xrefOffset = findXrefOffset(pdfBytes);
  const xrefEntries = parseXref(pdfBytes, xrefOffset);
  const objCache = new ObjectCache(pdfBytes, xrefEntries);
  // Doc-wide object enumeration below needs the complete xref, so finish the deferred repair.
  objCache.ensureXrefRepaired();

  const result = {};
  for (const objNum of Object.keys(xrefEntries)) {
    const objText = objCache.getObjectText(Number(objNum));
    if (!objText) continue;
    if (!objText.includes('/Subtype') || !objText.includes('/Type0')) continue;
    if (!/\/Subtype\s*\/Type0/.test(objText)) continue;

    const fontInfo = extractType0FontFile(objText, objCache);
    if (fontInfo) {
      result[Number(objNum)] = fontInfo;
    }
  }

  return result;
}

/**
 * Extract the TrueType font file for a single Type0 font object.
 * @param {string} fontObjText
 * @param {ObjectCache} objCache
 * @returns {Type0FontInfo|null}
 */
function extractType0FontFile(fontObjText, objCache) {
  let baseNameMatch = /\/BaseFont\s*\/([^\s/<>[\]]+)/.exec(fontObjText);
  let baseNameHexMatch2 = !baseNameMatch && /\/BaseFont\s*<([0-9A-Fa-f\s]+)>/.exec(fontObjText);
  if (!baseNameMatch && !baseNameHexMatch2) {
    const bfRef = /\/BaseFont\s+(\d+)\s+\d+\s+R\b/.exec(fontObjText);
    const bfBody = bfRef ? (objCache.getObjectText(Number(bfRef[1])) || '').trim() : '';
    baseNameMatch = /^\/([^\s/<>[\]]+)/.exec(bfBody);
    baseNameHexMatch2 = !baseNameMatch && /^<([0-9A-Fa-f\s]+)>/.exec(bfBody);
  }
  let fontName;
  if (baseNameMatch) {
    fontName = baseNameMatch[1].replace(/^[A-Z]{6}\+/, '');
  } else if (baseNameHexMatch2) {
    const hex = baseNameHexMatch2[1].replace(/\s+/g, '');
    const bytes = [];
    for (let hi = 0; hi < hex.length; hi += 2) bytes.push(parseInt(hex.substring(hi, hi + 2), 16));
    if (bytes.length >= 2 && bytes[0] === 0xFE && bytes[1] === 0xFF) {
      let decoded = '';
      for (let bi = 2; bi < bytes.length - 1; bi += 2) {
        const cp = (bytes[bi] << 8) | bytes[bi + 1];
        if (cp > 0) decoded += String.fromCharCode(cp);
      }
      fontName = decoded.replace(/^[A-Z]{6}\+/, '');
    } else {
      fontName = String.fromCharCode(...bytes).replace(/^[A-Z]{6}\+/, '');
    }
  } else {
    fontName = 'Unknown';
  }

  const descInline = /\/DescendantFonts\s*\[\s*(\d+)\s+\d+\s+R/.exec(fontObjText);
  const descIndirect = !descInline && /\/DescendantFonts\s+(\d+)\s+\d+\s+R/.exec(fontObjText);
  let cidFontNum = descInline ? Number(descInline[1]) : null;
  if (!cidFontNum && descIndirect) {
    const arrayText = objCache.getObjectText(Number(descIndirect[1]));
    if (arrayText) {
      const innerRef = /(\d+)\s+\d+\s+R/.exec(arrayText);
      if (innerRef) cidFontNum = Number(innerRef[1]);
    }
  }
  if (!cidFontNum) return null;

  const cidFontText = objCache.getObjectText(cidFontNum);
  if (!cidFontText) return null;

  const fdRefMatch = /\/FontDescriptor\s+(\d+)\s+\d+\s+R/.exec(cidFontText);
  if (!fdRefMatch) return null;

  const fdText = objCache.getObjectText(Number(fdRefMatch[1]));
  if (!fdText) return null;

  const fontFile = resolveCidTrueTypeProgram(fdText, objCache);
  if (!fontFile) return null;

  return { fontName, fontFile };
}

/**
 * @typedef {{
 *   type: 'M', x: number, y: number
 * } | {
 *   type: 'L', x: number, y: number
 * } | {
 *   type: 'C', x1: number, y1: number, x2: number, y2: number, x: number, y: number
 * } | {
 *   type: 'Z'
 * }} PathCommand
 */

/**
 * Parse a Type3 glyph stream and extract path commands with coordinates.
 * @param {string} streamText
 * @returns {{ commands: PathCommand[], advanceWidth: number, inlineImage?: any,
 * doXObject?: { name: string, cm: number[] }, paintMode?: string, evenOdd?: boolean,
 * lineWidth?: number, dashArray?: number[], dashPhase?: number,
 * isD0?: boolean, isD1?: boolean }}
 */
export function parseGlyphStreamPaths(streamText) {
  let advanceWidth = 0;
  const d1Match = /([\d.+-]+)\s+([\d.+-]+)\s+([\d.+-]+)\s+([\d.+-]+)\s+([\d.+-]+)\s+([\d.+-]+)\s+d1/.exec(streamText);
  const d0Match = /([\d.+-]+)\s+([\d.+-]+)\s+d0/.exec(streamText);
  const isD1 = !!d1Match;
  const isD0 = !!d0Match && !d1Match;
  if (d1Match) advanceWidth = Number(d1Match[1]);
  else if (d0Match) advanceWidth = Number(d0Match[1]);

  let glyphLineWidth = 1;
  const wMatch = /([\d.+-]+)\s+w(?:\s|$)/m.exec(streamText);
  if (wMatch) glyphLineWidth = Number(wMatch[1]);

  let dashArray = [];
  let dashPhase = 0;
  const dashOpMatch = /\[\s*([\d.\s]*)\s*\]\s*([\d.+-]+)\s+d(?:\s|$)/m.exec(streamText);
  if (dashOpMatch) {
    dashArray = dashOpMatch[1].trim() ? dashOpMatch[1].trim().split(/\s+/).map(Number) : [];
    dashPhase = Number(dashOpMatch[2]);
  }

  // Inline-image binary data can contain bytes resembling ` cm`, so only the region before BI is scanned.
  let cmA = 1;
  let cmB = 0;
  let cmC = 0;
  let cmD = 1;
  let cmTx = 0;
  let cmTy = 0;
  const biCmCut = /BI[\s/]/.exec(streamText);
  const cmRegion = biCmCut ? streamText.substring(0, biCmCut.index) : streamText;
  const cmRegex = /([\d.+-]+)\s+([\d.+-]+)\s+([\d.+-]+)\s+([\d.+-]+)\s+([\d.+-]+)\s+([\d.+-]+)\s+cm(?:\s|$)/g;
  for (const m of cmRegion.matchAll(cmRegex)) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    const c = Number(m[3]);
    const d = Number(m[4]);
    const tx = Number(m[5]);
    const ty = Number(m[6]);
    const nA = a * cmA + b * cmC;
    const nB = a * cmB + b * cmD;
    const nC = c * cmA + d * cmC;
    const nD = c * cmB + d * cmD;
    const nTx = tx * cmA + ty * cmC + cmTx;
    const nTy = tx * cmB + ty * cmD + cmTy;
    cmA = nA;
    cmB = nB;
    cmC = nC;
    cmD = nD;
    cmTx = nTx;
    cmTy = nTy;
  }

  // Track a live `q`/`Q`/`cm` CTM for vector paths, which can interleave transforms with drawing (unlike regex-extracted `BI`/`Do` above).
  let lcA = 1;
  let lcB = 0;
  let lcC = 0;
  let lcD = 1;
  let lcTx = 0;
  let lcTy = 0;
  /** @type {number[][]} */
  const ctmStack = [];
  /**
   * Apply the live CTM to a point.
   * @param {number} x
   * @param {number} y
   */
  function transform(x, y) {
    return { x: lcA * x + lcC * y + lcTx, y: lcB * x + lcD * y + lcTy };
  }

  // BI can be followed directly by a name delimiter, so `BI/W` with no space is valid.
  let inlineImage = null;
  const biMatch = /BI[\s/]/.exec(streamText);
  if (biMatch) {
    const biIdx2 = biMatch.index;
    const idMatch = /[\s\]>)]ID[\s]/.exec(streamText.substring(biIdx2));
    if (idMatch) {
      const idPos = biIdx2 + idMatch.index;
      const dictText = streamText.substring(biIdx2 + 2, idPos + 1).trim();
      const dataStart = idPos + idMatch[0].length;
      // Searched backwards because binary image data can contain EI bytes, and the real EI sits at the end.
      const afterData = streamText.substring(dataStart);
      let eiPos = -1;
      for (let ei = afterData.length - 2; ei >= 0; ei--) {
        if (afterData.charCodeAt(ei) === 0x45 && afterData.charCodeAt(ei + 1) === 0x49) {
          if (ei + 2 >= afterData.length || afterData.charCodeAt(ei + 2) <= 0x20) {
            eiPos = ei;
            break;
          }
        }
      }
      if (eiPos !== -1) {
        const imageData = streamText.substring(dataStart, dataStart + eiPos);
        inlineImage = {
          dictText,
          imageData,
          cm: [cmA, cmB, cmC, cmD, cmTx, cmTy],
        };
      }
    }
  }

  let doXObject = null;
  const doMatch = /\/(\S+)\s+Do/.exec(streamText);
  if (doMatch) {
    doXObject = {
      name: doMatch[1],
      cm: [cmA, cmB, cmC, cmD, cmTx, cmTy],
    };
  }

  let nestedText = null;
  const ntRegex = /BT\s*\/(\S+)\s+([\d.+-]+)\s+Tf\s*(?:([\d.+-]+)\s+([\d.+-]+)\s+([\d.+-]+)\s+([\d.+-]+)\s+([\d.+-]+)\s+([\d.+-]+)\s+Tm\s*)?\(((?:[^()\\]|\\.)*)\)\s*Tj\s*ET/;
  const ntMatch = ntRegex.exec(streamText);
  if (ntMatch) {
    const rawText = ntMatch[9]
      .replace(/\\\(/g, '(')
      .replace(/\\\)/g, ')')
      .replace(/\\\\/g, '\\');
    nestedText = {
      fontName: decodePdfName(ntMatch[1]),
      fontSize: Number(ntMatch[2]),
      tm: ntMatch[3] !== undefined
        ? [Number(ntMatch[3]), Number(ntMatch[4]), Number(ntMatch[5]), Number(ntMatch[6]), Number(ntMatch[7]), Number(ntMatch[8])]
        : [1, 0, 0, 1, 0, 0],
      text: rawText,
      cm: [cmA, cmB, cmC, cmD, cmTx, cmTy],
    };
  }

  let paintMode = 'fill';
  let evenOdd = false;
  let glyphStrokeColor = null;
  let glyphFillColor = null;

  /** @type {PathCommand[]} */
  const commands = [];
  const drawingStart = d1Match ? d1Match.index + d1Match[0].length
    : (d0Match ? d0Match.index + d0Match[0].length : 0);
  const drawingPart = streamText.substring(drawingStart);

  const uncommented = drawingPart.replace(/%[^\r\n]*/g, '');
  const tokens = uncommented.match(/[+-]?(?:\d+\.?\d*|\.\d+)|[a-zA-Z*]+/g);
  if (!tokens) {
    return {
      commands, advanceWidth, doXObject: doXObject || undefined, nestedText: nestedText || undefined,
    };
  }

  const numStack = [];
  let inTextBlock = false;
  // Tracks where the unpainted path begins so `n` can drop its commands instead of leaving them to be filled with the painted paths.
  let unpaintedStart = commands.length;
  let curX = 0;
  let curY = 0;
  let startX = 0;
  let startY = 0;
  for (const tok of tokens) {
    // Font names tokenize into letters, so a name like `/FType3B` would otherwise be read as the `B` paint operator.
    if (inTextBlock) {
      if (tok === 'ET') inTextBlock = false;
      continue;
    }
    const num = Number(tok);
    if (!Number.isNaN(num) && /^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(tok)) {
      numStack.push(num);
    } else {
      switch (tok) {
        case 'm': {
          if (numStack.length >= 2) {
            const n = numStack.length;
            const p = transform(numStack[n - 2], numStack[n - 1]);
            commands.push({ type: 'M', x: p.x, y: p.y });
            curX = p.x;
            curY = p.y;
            startX = p.x;
            startY = p.y;
          }
          numStack.length = 0;
          break;
        }
        case 'l': {
          if (numStack.length >= 2) {
            const n = numStack.length;
            const p = transform(numStack[n - 2], numStack[n - 1]);
            commands.push({ type: 'L', x: p.x, y: p.y });
            curX = p.x;
            curY = p.y;
          }
          numStack.length = 0;
          break;
        }
        case 'c': {
          if (numStack.length >= 6) {
            const n = numStack.length;
            const p1 = transform(numStack[n - 6], numStack[n - 5]);
            const p2 = transform(numStack[n - 4], numStack[n - 3]);
            const p3 = transform(numStack[n - 2], numStack[n - 1]);
            commands.push({
              type: 'C', x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, x: p3.x, y: p3.y,
            });
            curX = p3.x; curY = p3.y;
          }
          numStack.length = 0;
          break;
        }
        case 'v': {
          if (numStack.length >= 4) {
            const n = numStack.length;
            const p2 = transform(numStack[n - 4], numStack[n - 3]);
            const p3 = transform(numStack[n - 2], numStack[n - 1]);
            commands.push({
              type: 'C', x1: curX, y1: curY, x2: p2.x, y2: p2.y, x: p3.x, y: p3.y,
            });
            curX = p3.x; curY = p3.y;
          }
          numStack.length = 0;
          break;
        }
        case 'y': {
          if (numStack.length >= 4) {
            const n = numStack.length;
            const p1 = transform(numStack[n - 4], numStack[n - 3]);
            const p3 = transform(numStack[n - 2], numStack[n - 1]);
            commands.push({
              type: 'C', x1: p1.x, y1: p1.y, x2: p3.x, y2: p3.y, x: p3.x, y: p3.y,
            });
            curX = p3.x; curY = p3.y;
          }
          numStack.length = 0;
          break;
        }
        case 're': {
          if (numStack.length >= 4) {
            const n = numStack.length;
            const x = numStack[n - 4];
            const y = numStack[n - 3];
            const w = numStack[n - 2];
            const h = numStack[n - 1];
            const p1 = transform(x, y);
            const p2 = transform(x + w, y);
            const p3 = transform(x + w, y + h);
            const p4 = transform(x, y + h);
            commands.push({ type: 'M', x: p1.x, y: p1.y });
            commands.push({ type: 'L', x: p2.x, y: p2.y });
            commands.push({ type: 'L', x: p3.x, y: p3.y });
            commands.push({ type: 'L', x: p4.x, y: p4.y });
            commands.push({ type: 'Z' });
            // After re the current point is the rectangle origin (PDF spec 8.5.2.1).
            curX = p1.x;
            curY = p1.y;
            startX = p1.x;
            startY = p1.y;
          }
          numStack.length = 0;
          break;
        }
        case 'h':
          commands.push({ type: 'Z' });
          curX = startX;
          curY = startY;
          numStack.length = 0;
          break;
        case 'n':
          commands.length = unpaintedStart;
          numStack.length = 0;
          break;
        case 'f':
        case 'F':
          paintMode = 'fill';
          if (commands.length > 0 && commands[commands.length - 1].type !== 'Z') {
            commands.push({ type: 'Z' });
          }
          unpaintedStart = commands.length;
          numStack.length = 0;
          break;
        case 'f*':
          paintMode = 'fill';
          evenOdd = true;
          if (commands.length > 0 && commands[commands.length - 1].type !== 'Z') {
            commands.push({ type: 'Z' });
          }
          unpaintedStart = commands.length;
          numStack.length = 0;
          break;
        case 'S':
        case 's':
          paintMode = 'stroke';
          if (commands.length > 0 && commands[commands.length - 1].type !== 'Z') {
            commands.push({ type: 'Z' });
          }
          unpaintedStart = commands.length;
          numStack.length = 0;
          break;
        case 'B':
        case 'b':
          paintMode = 'fillStroke';
          if (commands.length > 0 && commands[commands.length - 1].type !== 'Z') {
            commands.push({ type: 'Z' });
          }
          unpaintedStart = commands.length;
          numStack.length = 0;
          break;
        case 'B*':
        case 'b*':
          paintMode = 'fillStroke';
          evenOdd = true;
          if (commands.length > 0 && commands[commands.length - 1].type !== 'Z') {
            commands.push({ type: 'Z' });
          }
          unpaintedStart = commands.length;
          numStack.length = 0;
          break;
        case 'BT':
          inTextBlock = true;
          numStack.length = 0;
          break;
        case 'RG':
          if (numStack.length >= 3) {
            const n = numStack.length;
            glyphStrokeColor = `rgb(${Math.round(numStack[n - 3] * 255)},${Math.round(numStack[n - 2] * 255)},${Math.round(numStack[n - 1] * 255)})`;
          }
          numStack.length = 0;
          break;
        case 'rg':
          if (numStack.length >= 3) {
            const n = numStack.length;
            glyphFillColor = `rgb(${Math.round(numStack[n - 3] * 255)},${Math.round(numStack[n - 2] * 255)},${Math.round(numStack[n - 1] * 255)})`;
          }
          numStack.length = 0;
          break;
        case 'G':
          if (numStack.length >= 1) {
            const v = Math.round(numStack[numStack.length - 1] * 255);
            glyphStrokeColor = `rgb(${v},${v},${v})`;
          }
          numStack.length = 0;
          break;
        case 'g':
          if (numStack.length >= 1) {
            const v = Math.round(numStack[numStack.length - 1] * 255);
            glyphFillColor = `rgb(${v},${v},${v})`;
          }
          numStack.length = 0;
          break;
        case 'q':
          ctmStack.push([lcA, lcB, lcC, lcD, lcTx, lcTy]);
          numStack.length = 0;
          break;
        case 'Q': {
          const s = ctmStack.pop();
          if (s) [lcA, lcB, lcC, lcD, lcTx, lcTy] = s;
          numStack.length = 0;
          break;
        }
        case 'cm':
          if (numStack.length >= 6) {
            const n = numStack.length;
            const a = numStack[n - 6];
            const b = numStack[n - 5];
            const c = numStack[n - 4];
            const d = numStack[n - 3];
            const tx = numStack[n - 2];
            const ty = numStack[n - 1];
            const nA = a * lcA + b * lcC;
            const nB = a * lcB + b * lcD;
            const nC = c * lcA + d * lcC;
            const nD = c * lcB + d * lcD;
            const nTx = tx * lcA + ty * lcC + lcTx;
            const nTy = tx * lcB + ty * lcD + lcTy;
            lcA = nA;
            lcB = nB;
            lcC = nC;
            lcD = nD;
            lcTx = nTx;
            lcTy = nTy;
          }
          numStack.length = 0;
          break;
        default:
          numStack.length = 0;
          break;
      }
    }
  }

  return {
    commands,
    advanceWidth,
    inlineImage,
    doXObject: doXObject || undefined,
    nestedText: nestedText || undefined,
    paintMode,
    evenOdd,
    isD0,
    isD1,
    lineWidth: glyphLineWidth,
    dashArray,
    dashPhase,
    strokeColor: glyphStrokeColor,
    fillColor: glyphFillColor,
  };
}

/**
 * Extract Type3 font glyphs and build OpenType.js-compatible font files.
 * @param {Uint8Array} pdfBytes
 * @returns {{ [fontObjNum: number]: Type0FontInfo }}
 */
export function extractType3Fonts(pdfBytes) {
  const xrefOffset = findXrefOffset(pdfBytes);
  const xrefEntries = parseXref(pdfBytes, xrefOffset);
  const objCache = new ObjectCache(pdfBytes, xrefEntries);
  // Doc-wide object enumeration below needs the complete xref, so finish the deferred repair.
  objCache.ensureXrefRepaired();

  const result = {};
  for (const objNum of Object.keys(xrefEntries)) {
    const objText = objCache.getObjectText(Number(objNum));
    if (!objText) continue;
    if (!objText.includes('/Subtype') || !objText.includes('/Type3')) continue;
    if (!/\/Subtype\s*\/Type3/.test(objText)) continue;

    const fontData = buildType3OpentypeFont(objText, objCache);
    if (fontData) {
      result[Number(objNum)] = fontData;
    }
  }

  return result;
}

/**
 * Build an OpenType.js font from a Type3 font object.
 * @param {string} objText
 * @param {ObjectCache} objCache
 * @param {?Map<string, { unicodes: number[], advanceWidth: number }>} [glyphOverrides] - Per-CharProc Unicode code points and glyph-space advance width.
 *   Defaults to sequential PUA code points in CharProcs order and each CharProc's declared advance.
 * @returns {Type0FontInfo|null}
 */
export function buildType3OpentypeFont(objText, objCache, glyphOverrides = null) {
  const fmStr = resolveArrayValue(objText, 'FontMatrix', objCache);
  const fontMatrix = fmStr ? fmStr.split(/\s+/).map(Number) : [0.001, 0, 0, 0.001, 0, 0];

  const fbStr = resolveArrayValue(objText, 'FontBBox', objCache);
  const fontBBox = fbStr ? fbStr.split(/\s+/).map(Number) : [0, 0, 0, 0];

  const nameMatch = /\/Name\s*\/([^\s/]+)/.exec(objText);
  const fontName = nameMatch ? nameMatch[1] : 'Type3Font';

  const unitsPerEm = 1000;
  const scaleX = fontMatrix[0] * unitsPerEm;
  const scaleY = fontMatrix[3] * unitsPerEm;

  const isPlaceholderBBox = fontBBox[0] === -10 && fontBBox[1] === -10 && fontBBox[2] === 10 && fontBBox[3] === 10;
  const ascender = isPlaceholderBBox ? Math.round(unitsPerEm * 0.8) : Math.round(fontBBox[3] * scaleY);
  const descender = isPlaceholderBBox ? Math.round(-unitsPerEm * 0.2) : Math.round(fontBBox[1] * scaleY);

  const charProcsStart = objText.indexOf('/CharProcs');
  if (charProcsStart === -1) return null;

  let charProcsDict;
  const charProcsAfter = objText.substring(charProcsStart + 10).trim();
  if (charProcsAfter.startsWith('<<')) {
    charProcsDict = extractDict(objText, charProcsStart + 10 + (objText.substring(charProcsStart + 10).indexOf('<<')));
  } else {
    const cpRefMatch = /^(\d+)\s+\d+\s+R/.exec(charProcsAfter);
    if (!cpRefMatch) return null;
    const cpObjText = objCache.getObjectText(Number(cpRefMatch[1]));
    if (!cpObjText) return null;
    charProcsDict = cpObjText;
  }

  const notdefGlyph = new opentype.Glyph({
    name: '.notdef',
    unicode: 0,
    advanceWidth: Math.round(unitsPerEm / 2),
    path: new opentype.Path(),
  });

  const glyphs = [notdefGlyph];
  let unicodeCounter = 0xE000;

  const charProcMatches = [...charProcsDict.matchAll(/\/(\S+?)\s+(\d+)\s+\d+\s+R/g)];
  for (const match of charProcMatches) {
    const glyphName = match[1];
    const streamObjNum = Number(match[2]);

    const streamBytes = objCache.getStreamBytes(streamObjNum);
    if (!streamBytes) continue;

    const streamText = new TextDecoder('latin1').decode(streamBytes);
    const pathData = parseGlyphStreamPaths(streamText);

    const opPath = new opentype.Path();
    for (const cmd of pathData.commands) {
      switch (cmd.type) {
        case 'M':
          opPath.moveTo(Math.round(cmd.x * scaleX), Math.round(cmd.y * scaleY));
          break;
        case 'L':
          opPath.lineTo(Math.round(cmd.x * scaleX), Math.round(cmd.y * scaleY));
          break;
        case 'C':
          opPath.curveTo(
            Math.round(cmd.x1 * scaleX), Math.round(cmd.y1 * scaleY),
            Math.round(cmd.x2 * scaleX), Math.round(cmd.y2 * scaleY),
            Math.round(cmd.x * scaleX), Math.round(cmd.y * scaleY),
          );
          break;
        case 'Z':
          opPath.close();
          break;
        // no default
      }
    }

    const override = glyphOverrides ? glyphOverrides.get(glyphName) : undefined;
    const glyph = new opentype.Glyph({
      name: glyphName,
      unicode: override ? undefined : unicodeCounter,
      unicodes: override ? override.unicodes : [unicodeCounter],
      advanceWidth: Math.round((override ? override.advanceWidth : pathData.advanceWidth) * scaleX),
      path: opPath,
    });
    glyphs.push(glyph);
    unicodeCounter++;
  }

  if (glyphs.length <= 1) return null;

  const font = new opentype.Font({
    familyName: fontName,
    styleName: 'Regular',
    unitsPerEm,
    ascender,
    descender,
    glyphs,
  });

  const fontFile = new Uint8Array(font.toArrayBuffer());
  return { fontName, fontFile };
}

/**
 * Correct character bounding boxes for Type3 fonts in parsed OCR pages.
 * @param {Array<import('../../objects/ocrObjects.js').OcrPage>} pages
 * @param {{ [fontObjNum: number]: FontInfo }} type3Fonts
 */
export function correctType3CharBBoxes(pages, type3Fonts) {
  /** @type {{ [fontName: string]: FontInfo }} */
  const fontsByName = {};
  for (const font of Object.values(type3Fonts)) {
    if (font.name) fontsByName[font.name] = font;
  }

  if (Object.keys(fontsByName).length === 0) return;

  for (const page of pages) {
    if (!page) continue;
    for (const line of page.lines) {
      let lineModified = false;
      for (const word of line.words) {
        const fontName = word.style?.font;
        const fontInfo = fontName ? fontsByName[fontName] : null;
        if (!fontInfo || !word.chars || word.chars.length === 0) continue;

        let wordModified = false;
        for (const char of word.chars) {
          let charCode = char.text.charCodeAt(0);
          // Text decoding replaces original NUL byte 0 with U+FFFD.
          if (charCode === 0xFFFD) charCode = 0;
          // Undo the U+E000 + charCode placeholder assigned to unmapped Type3 glyphs in parsePageFonts.
          if (charCode >= 0xE000 && charCode <= 0xE0FF) charCode -= 0xE000;

          const glyphName = fontInfo.encoding[charCode];
          if (!glyphName) continue;

          const glyph = fontInfo.glyphs[glyphName];
          if (!glyph || !glyph.bbox || glyph.advanceWidth === 0) continue;

          // Placeholder-FontBBox Type3 fonts keep default ascent 800 and descent -200, so `char.bbox` spans 1 em with the baseline 0.2 em above `bottom`.
          const emHeightPx = char.bbox.bottom - char.bbox.top;
          if (emHeightPx <= 0) continue;
          const scaleX = emHeightPx * fontInfo.fontMatrix[0];
          const scaleY = emHeightPx * fontInfo.fontMatrix[3];
          const baselineY = char.bbox.bottom - 0.2 * emHeightPx;

          const originX = char.bbox.left;
          char.bbox.left = Math.round(originX + glyph.bbox.x0 * scaleX);
          char.bbox.right = Math.round(originX + glyph.bbox.x1 * scaleX);
          char.bbox.top = Math.round(baselineY - glyph.bbox.y1 * scaleY);
          char.bbox.bottom = Math.round(baselineY - glyph.bbox.y0 * scaleY);

          wordModified = true;
        }

        if (wordModified) {
          ocr.calcWordBbox(word);
          lineModified = true;
        }
      }

      if (lineModified) {
        ocr.updateLineBbox(line);
      }
    }
  }
}
