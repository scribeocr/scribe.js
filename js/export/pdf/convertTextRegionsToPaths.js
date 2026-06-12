import {
  getPageContentStreams, findFormXObjects, parseHiddenOCMCNames, isFormOCHidden,
} from '../../pdf/parsePdfUtils.js';
import {
  bytesToLatin1, extractDict,
  resolveNumArray, parseDictEntries, matMul, decodeTextCodes,
} from '../../pdf/pdfPrimitives.js';
import {
  tokenizeContentStream, formatPdfNumber,
} from '../../pdf/contentStream.js';
import { parsePageFonts } from '../../pdf/fonts/parsePdfFonts.js';
import { aglLookup } from '../../pdf/fonts/standardEncodings.js';
import { encodeStreamObject } from './writePdfStreams.js';
import opentype from '../../font-parser/src/index.js';
import { standardNames } from '../../font-parser/src/encoding.js';
import { parseCFFSummary } from '../../font-parser/src/cff.js';
import { loadBuiltInFontsRaw, loadDingbatsFont, loadSymbolFont } from '../../fontContainerMain.js';
import { GlobalFonts } from '../../containers/fontContainer.js';
import {
  base14ToBundledFont, cssFamilyToBundledFont, genericToBundledFont, cssGenericForFontObj,
} from '../../pdf/fonts/base14Substitution.js';
import { standardFontToCSS } from '../../pdf/fonts/standardFontMetrics.js';

/**
 * Return the loaded supplemental opentype font backing a Base14 symbol family, or null.
 * The renderer substitutes ZapfDingbats with the bundled Dingbats face and Symbol with StandardSymbolsPS.
 * @param {string} family
 * @returns {opentypeFont | null}
 */
function bundledSuppFontFor(family) {
  if (family === 'Dingbats') return GlobalFonts.supp?.dingbats?.opentype || null;
  if (family === 'StandardSymbolsPS') return GlobalFonts.supp?.symbol?.opentype || null;
  return null;
}

/**
 * Preload the bundled symbol substitute faces a set of fonts will need, so the (synchronous) glyph resolver can read them from `GlobalFonts.supp`.
 * @param {Iterable<any>} fontInfos
 */
async function preloadSymbolSubstituteFonts(fontInfos) {
  let needDingbats = false;
  let needSymbol = false;
  for (const fi of fontInfos) {
    if (!fi || (fi.type0?.fontFile || fi.type1?.fontFile)) continue; // embedded: not substituted
    if (!(fi.type1 || fi.type0)) continue;
    const sub = base14ToBundledFont(fi.baseName, { bold: !!fi.bold, italic: !!fi.italic });
    if (sub?.family === 'Dingbats') needDingbats = true;
    else if (sub?.family === 'StandardSymbolsPS') needSymbol = true;
  }
  const jobs = [];
  if (needDingbats && !GlobalFonts.supp?.dingbats) jobs.push(loadDingbatsFont().catch(() => {}));
  if (needSymbol && !GlobalFonts.supp?.symbol) jobs.push(loadSymbolFont().catch(() => {}));
  if (jobs.length > 0) await Promise.all(jobs);
}

/**
 * Re-serialize a PDF content-stream operand token back to its source form.
 * @param {{type: string, value: any}} t
 */
function serializeOperand(t) {
  if (t.type === 'name') return `/${t.value}`;
  if (t.type === 'number') return formatPdfNumber(t.value);
  if (t.type === 'hexstring') return `<${t.value}>`;
  if (t.type === 'dict') return t.value;
  if (t.type === 'string') {
    let out = '(';
    for (let i = 0; i < t.value.length; i++) {
      const c = t.value.charCodeAt(i);
      if (c === 0x28 || c === 0x29 || c === 0x5C) {
        out += `\\${t.value[i]}`;
      } else if (c < 0x20 || c > 0x7E) {
        out += `\\${c.toString(8).padStart(3, '0')}`;
      } else {
        out += t.value[i];
      }
    }
    return `${out})`;
  }
  if (t.type === 'array') return `[${t.value.map(serializeOperand).join(' ')}]`;
  if (t.type === 'boolean') return t.value ? 'true' : 'false';
  if (t.type === 'null') return 'null';
  if (t.type === 'inlineImage') return `BI\n${t.value.dictText}\nID\n${t.value.imageData}\nEI`;
  return '';
}

// Ops that change how queued converted glyphs would paint (colour/alpha via gs, dash, miter, join/cap).
// Arriving inside a text object with converts pending, they force a bounce-flush so the glyphs keep their show-time paint state.
// `w` is exempt: queued stroke widths are carried per entry.
const PAINT_STATE_OPS = new Set(['g', 'G', 'rg', 'RG', 'k', 'K', 'sc', 'SC', 'scn', 'SCN', 'cs', 'CS', 'gs', 'd', 'M', 'j', 'J']);

const PDF_PATH_DECIMALS = 3;
// Transformation-matrix components need more decimals than path coordinates.
// A glyph `cm` inside a 0.001-milliscaled form has scale ~0.0154, and 3-decimal rounding (0.015)
// is a 2.5% error that the renderer's accumulated relative-`cm` chain drifts across a converted line.
const PDF_MATRIX_DECIMALS = 8;

/**
 * Format a number for PDF output, stripping trailing zeros.
 * @param {number} n
 * @param {number} [decimals] Fixed decimal places (default `PDF_PATH_DECIMALS`).
 */
function fmt(n, decimals = PDF_PATH_DECIMALS) {
  if (!Number.isFinite(n)) return '0';
  if (Number.isInteger(n)) return String(n);
  const r = n.toFixed(decimals);
  return r.replace(/\.?0+$/, '');
}

/**
 * Format a value with no decimal places.
 *
 * @param {number|undefined} n
 */
function fmtInt(n) {
  if (n == null || !Number.isFinite(n)) return '0';
  return String(Math.round(n));
}

/**
 * Detect font file type from the first few bytes.
 * @param {Uint8Array} fontFile
 * @returns {'truetype' | 'cff' | 'type1' | null}
 */
function detectFontFileType(fontFile) {
  if (!fontFile || fontFile.length < 4) return null;
  const b0 = fontFile[0];
  const b1 = fontFile[1];
  const b2 = fontFile[2];
  const b3 = fontFile[3];
  if (b0 === 0x00 && b1 === 0x01 && b2 === 0x00 && b3 === 0x00) return 'truetype';
  if (b0 === 0x74 && b1 === 0x72 && b2 === 0x75 && b3 === 0x65) return 'truetype';
  if (b0 === 0x4F && b1 === 0x54 && b2 === 0x54 && b3 === 0x4F) return 'cff';
  if (b0 === 0x25 && b1 === 0x21) return 'type1';
  if (b0 === 0x80) return 'type1';
  if (b0 === 0x01) return 'cff';
  return null;
}

/**
 * Load a glyph set + units-per-em + cmap glyph-index-map for an embedded font.
 * Returns null when the font cannot be loaded.
 *
 * @param {Uint8Array} fontFile
 * @returns {{ glyphs: any, unitsPerEm: number, fontType: string,
 *            fontMatrix?: number[],
 *            cmap?: { glyphIndexMap: Record<number, number>, byteToGlyphIndex?: number[], platformID?: number, encodingID?: number } | null,
 *            nameToGid?: Map<string, number> | null,
 *            unicodeToGid?: Map<number, number> | null,
 *            cffCharCodeToGid?: Map<number, number> | null,
 *            cffCidToGid?: Map<number, number> | null,
 *            substituteFont?: any } | null}
 */
export function loadGlyphsForOutlines(fontFile) {
  const fontType = detectFontFileType(fontFile);
  if (fontType === 'truetype') {
    try {
      const buf = fontFile.buffer.slice(fontFile.byteOffset, fontFile.byteOffset + fontFile.byteLength);
      const data = new DataView(buf);
      const bytes = new Uint8Array(buf);
      const numTables = data.getUint16(4);
      const dir = {};
      for (let i = 0; i < numTables; i++) {
        const off = 12 + i * 16;
        const tag = String.fromCharCode(bytes[off], bytes[off + 1], bytes[off + 2], bytes[off + 3]);
        dir[tag.trim()] = { offset: data.getUint32(off + 8), length: data.getUint32(off + 12) };
      }
      if (!dir.head || !dir.maxp || !dir.loca || !dir.glyf) return null;
      const head = opentype.parseHeadTable(data, dir.head.offset);
      const maxp = opentype.parseMaxpTable(data, dir.maxp.offset);
      const loca = opentype.parseLocaTable(data, dir.loca.offset, maxp.numGlyphs, head.indexToLocFormat === 0);
      const shell = { unitsPerEm: head.unitsPerEm, numGlyphs: maxp.numGlyphs, tables: {} };
      shell.glyphs = opentype.parseGlyfTable(data, dir.glyf.offset, loca, shell);
      let cmap = null;
      if (dir.cmap) {
        try {
          cmap = opentype.parseCmapTable(data, dir.cmap.offset);
        } catch {
          cmap = null;
        }
      }
      // Build nameToGid from /post so PDFs that drive TrueType fonts via custom
      // /Differences (charCode -> glyph name) can resolve names without falling
      // back to cmap (which would interpret the charCode as a Unicode codepoint
      // and pick a glyph from a totally different position in the font).
      let nameToGid = null;
      const postEntry = /** @type {{offset: number}|undefined} */ (/** @type {any} */ (dir).post);
      if (postEntry) {
        try {
          const post = opentype.parsePostTable(data, postEntry.offset);
          if (post.glyphNameIndex) {
            nameToGid = new Map();
            for (let gid = 0; gid < post.glyphNameIndex.length; gid++) {
              const nameIdx = post.glyphNameIndex[gid];
              const name = nameIdx < standardNames.length
                ? standardNames[nameIdx]
                : post.names[nameIdx - standardNames.length];
              if (typeof name === 'string' && name && !nameToGid.has(name)) nameToGid.set(name, gid);
            }
          }
        } catch {
          nameToGid = null;
        }
      }
      // Build a Unicode -> GID map from the /post glyph names: look up each name's codepoint in the Adobe Glyph List and key its GID by that codepoint.
      // This lets a code resolve to a glyph by its /ToUnicode value when the PDF gives no /Differences glyph name,
      // instead of falling back to a (1,0) Mac cmap that would map the raw byte to an unrelated Mac-Roman glyph.
      // If several names share a codepoint, the first (lowest) GID wins.
      let unicodeToGid = null;
      if (nameToGid) {
        unicodeToGid = new Map();
        for (const [name, gid] of nameToGid) {
          const uni = aglLookup(name);
          if (uni && uni.length > 0) {
            const cp = uni.codePointAt(0);
            if (cp != null && !unicodeToGid.has(cp)) unicodeToGid.set(cp, gid);
          }
        }
      }
      const ttUpem = head.unitsPerEm > 0 ? head.unitsPerEm : 1000;
      return {
        glyphs: shell.glyphs,
        unitsPerEm: ttUpem,
        fontMatrix: [1 / ttUpem, 0, 0, 1 / ttUpem, 0, 0],
        fontType: 'truetype',
        cmap,
        nameToGid,
        unicodeToGid,
      };
    } catch {
      return null;
    }
  }
  if (fontType === 'cff') {
    try {
      const buf = fontFile.buffer.slice(fontFile.byteOffset, fontFile.byteOffset + fontFile.byteLength);
      const dv = new DataView(buf);
      /** @type {{tables: any, encoding: any, isCIDFont: boolean, unitsPerEm: number, cffEncoding?: any, glyphs?: any}} */
      const shell = {
        tables: {}, encoding: null, isCIDFont: false, unitsPerEm: 1000,
      };
      opentype.parseCFFTable(dv, 0, shell);
      const top = shell.tables.cff?.topDict;
      const fm = top?.fontMatrix;
      const fdArr = top?._fdArray;
      const fdFm = (shell.isCIDFont && fdArr && fdArr.length > 0) ? fdArr[0].fontMatrix : null;
      const effFm = (fdFm && fdFm[0] > 0 && fdFm[0] < 1) ? fdFm : fm;
      const upem = effFm && effFm[0] > 0 && effFm[0] < 1 ? Math.round(1 / effFm[0]) : 1000;
      shell.unitsPerEm = upem;
      // Preserve the full FontMatrix, including any shear (italic CFF fonts encode the slant as fm[2]).
      // Using a uniform-diagonal `[1/upem 0 0 1/upem 0 0]` would re-emit italic glyphs as upright.
      const fontMatrix = (Array.isArray(effFm) && effFm.length === 6)
        ? effFm.slice() : [1 / upem, 0, 0, 1 / upem, 0, 0];
      let nameToGid = null;
      const charset = shell.tables.cff?.charset;
      if (Array.isArray(charset)) {
        nameToGid = new Map();
        for (let gid = 0; gid < charset.length; gid++) {
          if (charset[gid] && !nameToGid.has(charset[gid])) nameToGid.set(charset[gid], gid);
        }
      }
      // parsePdfFonts skips its StandardEncoding fallback for FontFile3 fonts
      // when /Encoding is absent, leaving charCodeToGlyphName empty.
      // Derive the map from the CFF encoding here.
      // For format-0/1 encodings, encoding[code] is the encoded-glyph index where 0 = first non-.notdef glyph, so add 1 to get the GID.
      let cffCharCodeToGid = null;
      const cffEnc = shell.cffEncoding;
      if (cffEnc && cffEnc.encoding && Array.isArray(charset)) {
        cffCharCodeToGid = new Map();
        for (let code = 0; code < 256; code++) {
          const v = cffEnc.encoding[code];
          if (typeof v === 'number') {
            cffCharCodeToGid.set(code, v + 1);
          } else if (typeof v === 'string' && v) {
            const gid = charset.indexOf(v);
            if (gid >= 0) cffCharCodeToGid.set(code, gid);
          }
        }
      }
      // For CID-keyed CFF (CIDFontType0C) the charset above is unusable.
      // Its SIDs are actually CIDs, not standard-string indices, so the names it produced are wrong.
      let cffCidToGid = null;
      if (shell.isCIDFont) {
        const m = parseCFFSummary(fontFile).cidToGID;
        if (m && m.size > 0) cffCidToGid = m;
      }
      return {
        glyphs: shell.glyphs,
        unitsPerEm: upem,
        fontMatrix,
        fontType: 'cff',
        cmap: null,
        nameToGid,
        cffCharCodeToGid,
        cffCidToGid,
      };
    } catch {
      return null;
    }
  }
  if (fontType === 'type1') {
    try {
      const parsed = opentype.parseType1Font(fontFile);
      if (!parsed || !parsed.glyphs || parsed.glyphs.size === 0) return null;
      const fm = parsed.fontMatrix;
      if (!fm || fm.length !== 6 || !(fm[0] > 0) || !(fm[3] > 0)) return null;
      const upem = Math.round(1 / fm[0]);
      // Italic Type1 fonts encode the slant in `fm[2]` (the c element of the affine matrix).
      // Carry the full FontMatrix through so the emitted Form XObject's /Matrix preserves the shear.
      // Re-emitting as `[1/upem 0 0 1/upem 0 0]` would render italic glyphs upright.
      const fontMatrix = fm.slice();
      /** @type {Array<any>} */
      const glyphsArr = [];
      const nameToGid = new Map();
      const notdef = parsed.glyphs.get('.notdef') || { path: { commands: [] } };
      glyphsArr.push(notdef);
      nameToGid.set('.notdef', 0);
      for (const [name, glyph] of parsed.glyphs) {
        if (name === '.notdef') continue;
        nameToGid.set(name, glyphsArr.length);
        glyphsArr.push(glyph);
      }
      return {
        glyphs: { get: (i) => glyphsArr[i], length: glyphsArr.length },
        unitsPerEm: upem,
        fontMatrix,
        fontType: 'type1',
        cmap: null,
        nameToGid,
      };
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Convert font-parser Path commands (font-unit space, Y up) to a PDF path operator string.
 * Quadratic Bézier commands are expanded to cubic via midpoint conversion
 * (PDF has no native quadratic operator).
 *
 * @param {Array<{type: string, x?: number, y?: number, x1?: number, y1?: number, x2?: number, y2?: number}>} commands
 */
function pathCommandsToOps(commands) {
  let out = '';
  let cx = 0;
  let cy = 0;
  let startX = 0;
  let startY = 0;
  // Default to integer coords (compact, and TrueType/CFF glyphs are in integer font units).
  // Type3 coords can be fractional (< 1), where integer rounding would wipe the path, so use decimals there.
  let needsFraction = false;
  for (let i = 0; i < commands.length && !needsFraction; i++) {
    const c = commands[i];
    if (c.type === 'M' || c.type === 'L') {
      if ((c.x !== 0 && Math.abs(c.x) < 1) || (c.y !== 0 && Math.abs(c.y) < 1)) needsFraction = true;
    } else if (c.type === 'C') {
      const vs = [c.x1, c.y1, c.x2, c.y2, c.x, c.y];
      for (const v of vs) if (v !== 0 && Math.abs(v) < 1) { needsFraction = true; break; }
    } else if (c.type === 'Q') {
      const vs = [c.x1, c.y1, c.x, c.y];
      for (const v of vs) if (v !== 0 && Math.abs(v) < 1) { needsFraction = true; break; }
    }
  }
  const f = needsFraction ? fmt : fmtInt;
  for (let i = 0; i < commands.length; i++) {
    const c = commands[i];
    if (c.type === 'M') {
      out += `${f(c.x)} ${f(c.y)} m\n`;
      cx = c.x; cy = c.y;
      startX = c.x; startY = c.y;
    } else if (c.type === 'L') {
      out += `${f(c.x)} ${f(c.y)} l\n`;
      cx = c.x; cy = c.y;
    } else if (c.type === 'C') {
      out += `${f(c.x1)} ${f(c.y1)} ${f(c.x2)} ${f(c.y2)} ${f(c.x)} ${f(c.y)} c\n`;
      cx = c.x; cy = c.y;
    } else if (c.type === 'Q') {
      const c1x = cx + (2 / 3) * (c.x1 - cx);
      const c1y = cy + (2 / 3) * (c.y1 - cy);
      const c2x = c.x + (2 / 3) * (c.x1 - c.x);
      const c2y = c.y + (2 / 3) * (c.y1 - c.y);
      out += `${f(c1x)} ${f(c1y)} ${f(c2x)} ${f(c2y)} ${f(c.x)} ${f(c.y)} c\n`;
      cx = c.x; cy = c.y;
    } else if (c.type === 'Z') {
      out += 'h\n';
      cx = startX; cy = startY;
    }
  }
  return out;
}

/**
 * True when a text-show operand carries at least one string byte.
 * @param {{type: string, value: any} | undefined} operand
 * @returns {boolean}
 */
function operandHasBytes(operand) {
  if (!operand) return false;
  if (operand.type === 'string' || operand.type === 'hexstring') return operand.value.length > 0;
  if (operand.type === 'array') {
    return operand.value.some((/** @type {{type: string, value: any}} */ t) => (t.type === 'string' || t.type === 'hexstring') && t.value.length > 0);
  }
  return false;
}

/**
 * Flatten a text-show operand into an ordered list of byte-codes and TJ
 * spacers. For Type 0/CID fonts with custom codespace ranges, byte groups are
 * decoded via the codespace; otherwise one entry per byte.
 *
 * @param {{type: string, value: any}} operand
 * @param {string} op - 'Tj' | 'TJ' | "'" | '"' (the last two flatten like Tj)
 * @param {ReadonlyArray<{bytes: number, low: number, high: number}> | null} codespaceRanges
 * @returns {Array<{type: 'code', value: number, numBytes: number} | {type: 'spacer', value: number}>}
 */
function flattenTextOperandTyped(operand, op, codespaceRanges) {
  /** @type {Array<{type: 'code', value: number, numBytes: number} | {type: 'spacer', value: number}>} */
  const out = [];
  const consumeBytes = (bytes) => {
    for (const { charCode, numBytes } of decodeTextCodes(bytes, codespaceRanges, 1)) {
      out.push({ type: 'code', value: charCode, numBytes });
    }
  };
  if (op === 'TJ') {
    if (operand.type !== 'array') return out;
    for (const elem of operand.value) {
      if (elem.type === 'number') {
        out.push({ type: 'spacer', value: elem.value });
      } else if (elem.type === 'hexstring') {
        let bytes = '';
        for (let j = 0; j + 1 < elem.value.length; j += 2) {
          bytes += String.fromCharCode(parseInt(elem.value.substr(j, 2), 16));
        }
        consumeBytes(bytes);
      } else if (elem.type === 'string') {
        consumeBytes(elem.value);
      }
    }
  } else if (operand.type === 'hexstring') {
    let bytes = '';
    for (let j = 0; j + 1 < operand.value.length; j += 2) {
      bytes += String.fromCharCode(parseInt(operand.value.substr(j, 2), 16));
    }
    consumeBytes(bytes);
  } else if (operand.type === 'string') {
    consumeBytes(operand.value);
  }
  return out;
}

/**
 * Encode a code value back to a PDF hexstring fragment (2 hex chars per byte).
 * @param {number} code
 * @param {number} numBytes
 */
function codeToHex(code, numBytes) {
  if (numBytes === 1) return (code & 0xFF).toString(16).padStart(2, '0').toUpperCase();
  return ((code >> 8) & 0xFF).toString(16).padStart(2, '0').toUpperCase()
    + (code & 0xFF).toString(16).padStart(2, '0').toUpperCase();
}

/**
 * Rewrite a page content stream replacing per-glyph text-show operations inside the supplied bboxes with inline outline fills (`q cm cm <ops> f Q`),
 * grouped by glyph shape so the content-stream Flate filter dedups the repeats.
 *
 * A text object whose every show converted (or carried no string bytes) is removed wholly:
 * no BT/ET, no text state or positioning ops, no spacer TJs.
 * Only the inline outline blocks remain, plus any ops whose effect persists past ET and corrective setters for text-state drift.
 * Text objects that keep any bytes (region miss, gated Tr mode, unresolvable glyph, invisible-text layers) retain the full skeleton so the kept shows stay positioned.
 *
 * @param {string} streamText
 * @param {Map<string, FontBinding>} fontsByTag
 * @param {ReadonlyArray<ReadonlyArray<number>>} bboxes - Page-relative user-space bboxes [x0,y0,x1,y1]
 * @param {GlyphResolver} resolver
 * @param {{ initialCtm?: number[], parentXobjects?: Map<string, number> | null,
 *   targetFontObjNums?: Set<number> | null,
 *   initialLineWidth?: number | null, initialDashActive?: boolean, initialMiterLimit?: number | null,
 *   extGStates?: Map<string, {lw?: number, dash?: boolean, ml?: number}> | null,
 *   initialTextState?: {tc: number, tw: number, tz: number, tl: number, tr: number, ts: number} | null,
 *   hiddenOCMCNames?: Set<string> | null, humanReadable?: boolean }} [opts]
 *   - `initialCtm`: starting CTM (defaults to identity). Used when recursing into
 *     a Form XObject so the form's content is hit-tested in page user space.
 *   - `parentXobjects`: in-scope Form XObject names → objNum, used to identify Do
 *     calls that target a Form XObject for recursive conversion. Records appear
 *     in `formInvocations` on the return value.
 *   - `targetFontObjNums`: font object numbers whose glyphs are always converted
 *     (broken-Type3 fonts), independent of `bboxes`.
 *   - `initialLineWidth`/`initialDashActive`/`initialMiterLimit`: pen state at
 *     stream start. Page streams start from the spec defaults (1 / false / 10);
 *     a recursed form inherits its caller's state as recorded at the Do site,
 *     with null meaning unknown (Tr 1/2 shows then stay verbatim).
 *   - `extGStates`: in-scope /ExtGState name → stroke-relevant params, applied
 *     by `gs` ops. An unknown name degrades the pen state to unknown.
 * @returns {{ ok: true, text: string, changed: boolean,
 *   usedXobj: Map<string, {fontObjNum: number, glyphIndex: number,
 *     bbox: {xMin: number, yMin: number, xMax: number, yMax: number},
 *     formMatrix: number[], pathCommands: Array<any>,
 *     paintMode: string, evenOdd: boolean}>,
 *   skipped: Array<{fontObjNum: number, charCode: number, reason: string}>,
 *   formInvocations: Array<{name: string, formObjNum: number, ctm: number[],
 *     lw: number | null, dashActive: boolean, ml: number | null,
 *     textState: {tc: number, tw: number, tz: number, tl: number, tr: number, ts: number}}> }
 *   | { ok: false, reason: string }}
 *
 * @typedef {{ fontObjNum: number, widths: Map<number, number>, defaultWidth: number,
 *   verticalMode: boolean, codespaceRanges: ReadonlyArray<{bytes: number, low: number, high: number}> | null,
 *   charCodeToCID: Map<number, number> | null, isType0: boolean, isType3?: boolean }} FontBinding
 *
 * @typedef {(arg: { fontObjNum: number, charCode: number }) => { glyphIndex: number, formMatrix: number[],
 *   pathCommands: Array<any>, bbox: {xMin: number, yMin: number, xMax: number, yMax: number},
 *   paintMode?: string, evenOdd?: boolean, subAdvanceEm?: number } | { error: string }} GlyphResolver
 */
export function rewritePageContentForRegions(streamText, fontsByTag, bboxes, resolver, opts = {}) {
  const initialCtm = opts.initialCtm || [1, 0, 0, 1, 0, 0];
  const parentXobjects = opts.parentXobjects || null;
  // Broken-Type3 font object numbers: glyphs drawn by these fonts are converted to paths regardless of bbox,
  // so their gibberish PUA text stops being selectable.
  const targetFontObjNums = opts.targetFontObjNums || null;
  const extGStates = opts.extGStates || null;
  // Glyph-identifying `%tag` comments are a debug/traceability aid (they let tests and a human reader see which (font, glyph) each inline block draws).
  // Emit them only in human-readable (uncompressed) output, never in production streams, where they would be dead weight.
  const commentGlyphs = !!opts.humanReadable;
  // Fast path: a stream with no text-show ops AND no Do ops cannot contribute to the output.
  // Skip tokenizing multi-MB image-heavy pages.
  if (!/\bT[jJ]\b|\bDo\b/.test(streamText)) {
    return {
      ok: true,
      text: streamText,
      changed: false,
      usedXobj: new Map(),
      skipped: [],
      formInvocations: [],
    };
  }
  const tokens = tokenizeContentStream(streamText);
  /** @type {Array<{type: string, value: any}>} */
  const operandBuf = [];
  /** @type {string[]} */
  const out = [];

  let inBT = false;
  // Track text-object removal: when every show in a BT..ET converted or carried no string bytes, drop the whole skeleton at ET.
  // Only ops whose effect persists past ET survive (graphics/colour state, marked content, flushed convert blocks),
  // plus corrective setters for the text-state drift Tc/Tw/Tz/TL/Tf/Tr/Ts leave across text objects.
  // btStart: index in `out` where the current BT was pushed (-1 = none).
  // btPersist: [start, end) ranges in `out` retained when removing the object.
  // btKept: a show in this object kept selectable/visible bytes (not removed).
  let btStart = -1;
  /** @type {Array<[number, number]>} */
  let btPersist = [];
  let btKept = false;
  let btSnap = {
    tc: 0, tw: 0, tz: 100, tl: 0, tr: 0, ts: 0, fontTag: /** @type {string | null} */ (null), fontSize: 0,
  };
  let tm = [1, 0, 0, 1, 0, 0];
  let tlm = [1, 0, 0, 1, 0, 0];
  // Text state. Defaults to the spec initial values, or inherits the caller's values when recursing into a Form XObject
  // (forms inherit text state at the Do site, section 9.3.1).
  // Without this, a form that relies on an inherited leading collapses every T*/'/" line break onto one baseline.
  const its = opts.initialTextState || null;
  let tc = its ? its.tc : 0;
  let tw = its ? its.tw : 0;
  let tz = its ? its.tz : 100;
  let tl = its ? its.tl : 0;
  let tr = its ? its.tr : 0;
  let ts = its ? its.ts : 0;
  // Optional-content (OCG) visibility.
  // `/<name>` in hiddenOCMCNames marks a marked-content block (`/OC /<name> BDC ... EMC`) whose group is OFF.
  // Its text must stay hidden, so it is left verbatim (the renderer hides it) rather than converted to always-visible paths.
  // Mirrors the renderer's mcStack/ocHidden.
  const hiddenOCMCNames = opts.hiddenOCMCNames || null;
  /** @type {boolean[]} one entry per open BDC/BMC; value = that block's hidden state */
  const mcHiddenStack = [];
  let ocHidden = false;
  /** @type {string | null} */
  let currentFontTag = null;
  let currentFontSize = 0;
  let ctm = initialCtm.slice();
  // Pen state for Tr 1/2 conversion.
  // null = unknown (inherited from an unresolvable gs or an unrecorded caller), which blocks stroke conversion until an explicit `w`/`M` restores knowledge.
  /** @type {number | null} */
  let lw = opts.initialLineWidth === undefined ? 1 : opts.initialLineWidth;
  let dashActive = !!opts.initialDashActive;
  /** @type {number | null} */
  let ml = opts.initialMiterLimit === undefined ? 10 : opts.initialMiterLimit;

  /**
   * @type {Array<{tc: number, tw: number, tz: number, tl: number, tr: number, ts: number,
   *   fontTag: string|null, fontSize: number, ctm: number[], lw: number|null, dashActive: boolean, ml: number|null}>}
   */
  const gsStack = [];

  /**
   * Converted glyphs deferred to the next ET or graphics-state op, then emitted as inline outline fills.
   * Each entry carries the placement matrix `M` captured at its original text-show.
   * Stroke-mode entries also carry the glyph-space pen width to emit as `w` (computed at queue time, so a later `w` op in the source cannot skew it).
   * Glyphs are non-overlapping, so the z-order shift vs interleaved text-show (and the shape-grouped reorder the flush applies) is acceptable.
   * @type {Array<{xobjTag: string, M: number[], strokeW?: number}>}
   */
  let pendingConverts = [];

  /**
   * @type {Map<string, {fontObjNum: number, glyphIndex: number,
   *   bbox: {xMin: number, yMin: number, xMax: number, yMax: number}, formMatrix: number[],
   *   pathCommands: Array<any>, paintMode: string, evenOdd: boolean}>}
   */
  const usedXobj = new Map();
  /**
   * Inline outline body (`pathCommandsToOps` output + the paint operator) per shape tag,
   * computed once and reused for every placement of that glyph.
   * @type {Map<string, string>}
   */
  const inlineBodyByTag = new Map();
  /** @type {Array<{fontObjNum: number, charCode: number, reason: string}>} */
  const skipped = [];

  /**
   * @type {Array<{name: string, formObjNum: number, ctm: number[], lw: number|null,
   *   dashActive: boolean, ml: number|null,
   *   textState: {tc: number, tw: number, tz: number, tl: number, tr: number, ts: number}}>}
   */
  const formInvocations = [];
  let changed = false;

  function emitVerbatim(opVal) {
    for (let i = 0; i < operandBuf.length; i++) {
      out.push(serializeOperand(operandBuf[i]));
      out.push(i + 1 < operandBuf.length ? ' ' : '\n');
    }
    if (operandBuf.length === 0 || !out[out.length - 1].endsWith('\n')) {
      if (operandBuf.length > 0) out[out.length - 1] = ' ';
    }
    out.push(opVal);
    out.push('\n');
    operandBuf.length = 0;
  }

  /**
   * Emit an op verbatim and, inside a text object, record its output range so text-object removal retains it:
   * these are ops whose effect outlives ET (colour, general graphics state, marked content, Do), unlike text ops.
   * @param {string} opVal
   */
  function emitPersistVerbatim(opVal) {
    const s = out.length;
    emitVerbatim(opVal);
    if (inBT && btStart >= 0) btPersist.push([s, out.length]);
  }

  /**
   * Emit the queued converted glyphs as inline outline fills, grouped by shape.
   *
   * Each glyph is placed by its own `q <M> cm <fontMatrix> cm <ops> <paint> Q` block:
   * `M` carries the precision-critical fontSize*Tm placement at full PDF_MATRIX_DECIMALS, the font matrix rides a second per-shape cm,
   * and the per-glyph q/Q resets the CTM so placement stays absolute with no cm drift across the run.
   *
   * Glyphs are grouped by shape tag so the byte-identical outline ops (plus the per-shape font-matrix cm and `%tag` comment) sit adjacent,
   * letting the stream's FlateDecode collapse every repeat after the first to a short back-reference.
   * Reordering among the queued glyphs is safe: they are non-overlapping and share one colour within a flush (any colour op bounce-flushes first).
   *
   * Called at ET (outside BT) or before any graphics-state change.
   */
  function flushPendingConverts() {
    if (pendingConverts.length === 0) return;
    const persistStart = out.length;
    // Bucket by shape tag, preserving first-seen order, so identical outlines
    // are emitted back-to-back for the deflate window to dedup.
    /** @type {string[]} */
    const order = [];
    /** @type {Map<string, Array<{xobjTag: string, M: number[], strokeW?: number}>>} */
    const buckets = new Map();
    for (const c of pendingConverts) {
      let bucket = buckets.get(c.xobjTag);
      if (!bucket) { bucket = []; buckets.set(c.xobjTag, bucket); order.push(c.xobjTag); }
      bucket.push(c);
    }
    for (const tag of order) {
      const info = usedXobj.get(tag);
      if (!info) continue;
      const fm = (Array.isArray(info.formMatrix) && info.formMatrix.length === 6)
        ? info.formMatrix : [0.001, 0, 0, 0.001, 0, 0];
      const fmCm = `${fmt(fm[0], PDF_MATRIX_DECIMALS)} ${fmt(fm[1], PDF_MATRIX_DECIMALS)} ${fmt(fm[2], PDF_MATRIX_DECIMALS)} ${fmt(fm[3], PDF_MATRIX_DECIMALS)} ${fmt(fm[4], PDF_MATRIX_DECIMALS)} ${fmt(fm[5], PDF_MATRIX_DECIMALS)} cm\n`;
      let body = inlineBodyByTag.get(tag);
      if (body === undefined) {
        const pm = info.paintMode || 'fill';
        let paintOp;
        if (pm === 'stroke') paintOp = 'S';
        else if (pm === 'fillStroke') paintOp = info.evenOdd ? 'B*' : 'B';
        else paintOp = info.evenOdd ? 'f*' : 'f';
        body = `${pathCommandsToOps(info.pathCommands)}${paintOp}\n`;
        inlineBodyByTag.set(tag, body);
      }
      for (const c of buckets.get(tag)) {
        if (commentGlyphs) out.push(`%${tag}\n`);
        out.push('q\n');
        // Stroke pen width is glyph-space and was computed at queue time.
        // Scope it inside this q...Q so it cannot leak to the next glyph.
        if (c.strokeW !== undefined) out.push(`${fmt(c.strokeW, PDF_MATRIX_DECIMALS)} w\n`);
        const M = c.M;
        out.push(`${fmt(M[0], PDF_MATRIX_DECIMALS)} ${fmt(M[1], PDF_MATRIX_DECIMALS)} ${fmt(M[2], PDF_MATRIX_DECIMALS)} ${fmt(M[3], PDF_MATRIX_DECIMALS)} ${fmt(M[4], PDF_MATRIX_DECIMALS)} ${fmt(M[5], PDF_MATRIX_DECIMALS)} cm\n`);
        out.push(fmCm);
        out.push(body);
        out.push('Q\n');
      }
    }
    pendingConverts = [];
    // A flush inside BT (bounceFlushInBT, or a tolerated q/Q/cm/Do mid-object) is painted output, not text skeleton.
    // Removal must keep it.
    if (inBT && btStart >= 0) btPersist.push([persistStart, out.length]);
  }

  /**
   * Flush pending glyph converts from inside a text object, pinning them to the current colour/stroke state.
   * `Do` is illegal inside BT/ET, so close the object, flush, reopen, and restore the matrices:
   * re-emit `Tm` for the line matrix, then a numeric TJ moves tm back to the mid-line position without touching tlm.
   * An off-axis displacement has no TJ equivalent and is skipped.
   */
  function bounceFlushInBT() {
    out.push('ET\n');
    flushPendingConverts();
    out.push('BT\n');
    out.push(`${fmt(tlm[0], PDF_MATRIX_DECIMALS)} ${fmt(tlm[1], PDF_MATRIX_DECIMALS)} ${fmt(tlm[2], PDF_MATRIX_DECIMALS)} ${fmt(tlm[3], PDF_MATRIX_DECIMALS)} ${fmt(tlm[4], PDF_MATRIX_DECIMALS)} ${fmt(tlm[5], PDF_MATRIX_DECIMALS)} Tm\n`);
    const deltaUx = tm[4] - tlm[4];
    const deltaUy = tm[5] - tlm[5];
    if (Math.abs(deltaUx) > 1e-6 || Math.abs(deltaUy) > 1e-6) {
      const det = tlm[0] * tlm[3] - tlm[1] * tlm[2];
      const fontScale = currentFontSize * tz / 100;
      if (Math.abs(det) > 1e-9 && fontScale > 0) {
        const textDx = (deltaUx * tlm[3] - deltaUy * tlm[2]) / det;
        const textDy = (-deltaUx * tlm[1] + deltaUy * tlm[0]) / det;
        const binding = currentFontTag ? fontsByTag.get(currentFontTag) : null;
        const leadAxis = binding && binding.verticalMode ? textDy : textDx;
        const offAxis = binding && binding.verticalMode ? textDx : textDy;
        if (Math.abs(offAxis) < 1e-6 && Math.abs(leadAxis) > 1e-6) {
          out.push(`[${fmt(-leadAxis * 1000 / fontScale)}] TJ\n`);
        }
      }
    }
  }

  /**
   * @param {number[]} mat
   * @param {FontBinding} binding
   * @param {number} code
   * @param {number} numBytes
   */
  function advanceMatrixForGlyph(mat, binding, code, numBytes) {
    const widthSrc = binding.isType0 && binding.charCodeToCID
      ? (binding.charCodeToCID.get(code) ?? code)
      : code;
    const rawWidth = binding.widths.get(widthSrc) ?? binding.defaultWidth;
    const glyphWidth = rawWidth / 1000 * currentFontSize;
    const isWordSpace = numBytes === 1 && code === 0x20;
    if (binding.verticalMode) {
      const vAdvance = (-currentFontSize + tc + (isWordSpace ? tw : 0)) * tz / 100;
      mat[4] += vAdvance * mat[2];
      mat[5] += vAdvance * mat[3];
    } else {
      const advance = (glyphWidth + tc + (isWordSpace ? tw : 0)) * tz / 100;
      mat[4] += advance * mat[0];
      mat[5] += advance * mat[1];
    }
  }
  /**
   * @param {number[]} mat
   * @param {FontBinding} binding
   * @param {number} value
   */
  function applySpacerToMatrix(mat, binding, value) {
    const adj = value / 1000 * currentFontSize * tz / 100;
    if (binding.verticalMode) {
      mat[4] -= adj * mat[2];
      mat[5] -= adj * mat[3];
    } else {
      mat[4] -= adj * mat[0];
      mat[5] -= adj * mat[1];
    }
  }

  /**
   * Numeric TJ spacer that displaces tm by the same amount a glyph of the given code would.
   * tlm is unaffected, so subsequent Td/Tm computations match the unconverted original.
   * Derivation: equate glyph advance `(W/1000 * fontSize + tc + tw_if_space) * tz/100` with TJ spacer advance `-s/1000 * fontSize * tz/100`.
   * The tz factor cancels.
   * @param {FontBinding} binding
   * @param {number} code
   * @param {number} numBytes
   * @returns {number}
   */
  function spacerForGlyphMimic(binding, code, numBytes) {
    if (currentFontSize === 0) return 0;
    const isWordSpace = numBytes === 1 && code === 0x20;
    if (binding.verticalMode) {
      return (currentFontSize - tc - (isWordSpace ? tw : 0)) * 1000 / currentFontSize;
    }
    const widthSrc = binding.isType0 && binding.charCodeToCID
      ? (binding.charCodeToCID.get(code) ?? code)
      : code;
    const W = binding.widths.get(widthSrc) ?? binding.defaultWidth;
    const tcTwAdd = tc + (isWordSpace ? tw : 0);
    return -W - 1000 * tcTwAdd / currentFontSize;
  }

  for (const tok of tokens) {
    if (tok.type !== 'operator') {
      operandBuf.push(tok);
      continue;
    }
    const op = tok.value;

    // Paint-state change with converts queued inside a text object: bounce-flush first so the queued glyphs paint with their show-time state.
    // (Outside BT, pendingConverts is always empty because ET flushes.)
    if (inBT && pendingConverts.length > 0 && PAINT_STATE_OPS.has(op)) bounceFlushInBT();

    if (op === 'q') {
      flushPendingConverts();
      gsStack.push({
        tc, tw, tz, tl, tr, ts, fontTag: currentFontTag, fontSize: currentFontSize, ctm: ctm.slice(), lw, dashActive, ml,
      });
      emitPersistVerbatim(op);
      continue;
    }
    if (op === 'Q') {
      flushPendingConverts();
      const s = gsStack.pop();
      if (s) {
        tc = s.tc; tw = s.tw; tz = s.tz; tl = s.tl; tr = s.tr; ts = s.ts;
        currentFontTag = s.fontTag; currentFontSize = s.fontSize;
        ctm = s.ctm;
        lw = s.lw; dashActive = s.dashActive; ml = s.ml;
      }
      emitPersistVerbatim(op);
      continue;
    }
    if (op === 'cm') {
      flushPendingConverts();
      if (operandBuf.length >= 6) {
        const m = operandBuf.slice(operandBuf.length - 6).map((t) => t.value);
        ctm = matMul(m, ctm);
      }
      emitPersistVerbatim(op);
      continue;
    }

    // Pen-state ops, tracked for Tr 1/2 conversion.
    // No flush: queued stroke entries carry their width from queue time, and colour-class state was never flushed on (pre-existing, shared with the fill path).
    if (op === 'w') {
      const v = operandBuf.length >= 1 && operandBuf[operandBuf.length - 1].type === 'number'
        ? operandBuf[operandBuf.length - 1].value : NaN;
      lw = Number.isFinite(v) && v >= 0 ? v : null;
      emitPersistVerbatim(op);
      continue;
    }
    if (op === 'd') {
      if (operandBuf.length >= 2 && operandBuf[operandBuf.length - 2].type === 'array') {
        dashActive = operandBuf[operandBuf.length - 2].value.length > 0;
      }
      emitPersistVerbatim(op);
      continue;
    }
    if (op === 'M') {
      const v = operandBuf.length >= 1 && operandBuf[operandBuf.length - 1].type === 'number'
        ? operandBuf[operandBuf.length - 1].value : NaN;
      ml = Number.isFinite(v) ? v : null;
      emitPersistVerbatim(op);
      continue;
    }
    if (op === 'gs') {
      // A known ExtGState applies only the stroke-relevant keys it sets.
      // An unknown one degrades the pen state to unknown, so Tr 1/2 shows stay verbatim until an explicit `w` restores knowledge.
      const nameTok = operandBuf.length >= 1 ? operandBuf[operandBuf.length - 1] : null;
      if (nameTok && nameTok.type === 'name') {
        const known = extGStates ? extGStates.get(nameTok.value) : undefined;
        if (known) {
          if (typeof known.lw === 'number') lw = known.lw;
          if (typeof known.ml === 'number') ml = known.ml;
          if (typeof known.dash === 'boolean') dashActive = known.dash;
        } else {
          lw = null;
          ml = null;
        }
      }
      emitPersistVerbatim(op);
      continue;
    }

    if (op === 'BT') {
      inBT = true;
      tm = [1, 0, 0, 1, 0, 0];
      tlm = [1, 0, 0, 1, 0, 0];
      btStart = out.length;
      btPersist = [];
      btKept = false;
      btSnap = {
        tc, tw, tz, tl, tr, ts, fontTag: currentFontTag, fontSize: currentFontSize,
      };
      emitVerbatim(op);
      continue;
    }
    if (op === 'ET') {
      inBT = false;
      if (btStart >= 0 && !btKept) {
        // No show in this text object kept any bytes: drop the whole text skeleton.
        // Re-push the ops that persist past ET, then corrective setters for text-state drift:
        // later text objects inherit Tc/Tw/Tz/TL/Tf/Tr/Ts, so a dropped setter must be replayed.
        // Positioning state (tm/tlm) dies at ET and needs no replay.
        const dropped = out.length - btStart;
        /** @type {string[]} */
        const persistOps = [];
        for (const [s, e] of btPersist) { for (let i = s; i < e; i++) persistOps.push(out[i]); }
        out.length = btStart;
        for (const p of persistOps) out.push(p);
        if (tc !== btSnap.tc) out.push(`${fmt(tc)} Tc\n`);
        if (tw !== btSnap.tw) out.push(`${fmt(tw)} Tw\n`);
        if (tz !== btSnap.tz) out.push(`${fmt(tz)} Tz\n`);
        if (tl !== btSnap.tl) out.push(`${fmt(tl)} TL\n`);
        if (ts !== btSnap.ts) out.push(`${fmt(ts)} Ts\n`);
        if (tr !== btSnap.tr) out.push(`${tr} Tr\n`);
        if ((currentFontTag !== btSnap.fontTag || currentFontSize !== btSnap.fontSize) && currentFontTag) {
          out.push(`/${currentFontTag} ${fmt(currentFontSize)} Tf\n`);
        }
        // dropped === 2 is a bare `BT` push (empty object): removing the pair changes no semantics,
        // so it alone does not force a rewrite.
        if (dropped > 2) changed = true;
        operandBuf.length = 0;
        btStart = -1;
        btPersist = [];
        flushPendingConverts();
        continue;
      }
      btStart = -1;
      btPersist = [];
      btKept = false;
      emitVerbatim(op);
      flushPendingConverts();
      continue;
    }

    if (op === 'Tf') {
      if (operandBuf.length >= 2) {
        const nameTok = operandBuf[operandBuf.length - 2];
        const sizeTok = operandBuf[operandBuf.length - 1];
        if (nameTok && nameTok.type === 'name') currentFontTag = nameTok.value;
        if (sizeTok && sizeTok.type === 'number') currentFontSize = sizeTok.value;
      }
      emitVerbatim(op);
      continue;
    }
    if (op === 'Tc') {
      if (operandBuf.length >= 1 && operandBuf[operandBuf.length - 1].type === 'number') tc = operandBuf[operandBuf.length - 1].value;
      emitVerbatim(op);
      continue;
    }
    if (op === 'Tw') {
      if (operandBuf.length >= 1 && operandBuf[operandBuf.length - 1].type === 'number') tw = operandBuf[operandBuf.length - 1].value;
      emitVerbatim(op);
      continue;
    }
    if (op === 'Tz') {
      if (operandBuf.length >= 1 && operandBuf[operandBuf.length - 1].type === 'number') tz = operandBuf[operandBuf.length - 1].value;
      emitVerbatim(op);
      continue;
    }
    if (op === 'TL') {
      if (operandBuf.length >= 1 && operandBuf[operandBuf.length - 1].type === 'number') tl = operandBuf[operandBuf.length - 1].value;
      emitVerbatim(op);
      continue;
    }
    if (op === 'Tr') {
      if (operandBuf.length >= 1 && operandBuf[operandBuf.length - 1].type === 'number') tr = operandBuf[operandBuf.length - 1].value;
      emitVerbatim(op);
      continue;
    }
    if (op === 'Ts') {
      if (operandBuf.length >= 1 && operandBuf[operandBuf.length - 1].type === 'number') ts = operandBuf[operandBuf.length - 1].value;
      emitVerbatim(op);
      continue;
    }
    if (op === 'Tm') {
      if (operandBuf.length >= 6) {
        tm = operandBuf.slice(operandBuf.length - 6).map((t) => t.value);
        tlm = tm.slice();
      }
      emitVerbatim(op);
      continue;
    }
    if (op === 'Td') {
      if (operandBuf.length >= 2) {
        const tx = operandBuf[operandBuf.length - 2].value;
        const ty = operandBuf[operandBuf.length - 1].value;
        tlm = [tlm[0], tlm[1], tlm[2], tlm[3],
          tx * tlm[0] + ty * tlm[2] + tlm[4],
          tx * tlm[1] + ty * tlm[3] + tlm[5]];
        tm = tlm.slice();
      }
      emitVerbatim(op);
      continue;
    }
    if (op === 'TD') {
      if (operandBuf.length >= 2) {
        const tx = operandBuf[operandBuf.length - 2].value;
        const ty = operandBuf[operandBuf.length - 1].value;
        tl = -ty;
        tlm = [tlm[0], tlm[1], tlm[2], tlm[3],
          tx * tlm[0] + ty * tlm[2] + tlm[4],
          tx * tlm[1] + ty * tlm[3] + tlm[5]];
        tm = tlm.slice();
      }
      emitVerbatim(op);
      continue;
    }
    if (op === 'T*') {
      const tx = 0;
      const ty = -tl;
      tlm = [tlm[0], tlm[1], tlm[2], tlm[3],
        tx * tlm[0] + ty * tlm[2] + tlm[4],
        tx * tlm[1] + ty * tlm[3] + tlm[5]];
      tm = tlm.slice();
      emitVerbatim(op);
      continue;
    }

    if (op === 'Do') {
      // Record the invocation for the orchestrator to recurse into. CTM is captured before any state change.
      // The form's /Resources lookup happens in the orchestrator; we just track (name, current ctm) here.
      flushPendingConverts();
      if (parentXobjects && operandBuf.length >= 1) {
        const nameTok = operandBuf[operandBuf.length - 1];
        if (nameTok && nameTok.type === 'name') {
          const formObjNum = parentXobjects.get(nameTok.value);
          if (typeof formObjNum === 'number') {
            formInvocations.push({
              name: nameTok.value,
              formObjNum,
              ctm: ctm.slice(),
              lw,
              dashActive,
              ml,
              // Text state inherited by the form's content (section 9.3.1): a form that sets none of its own relies on these.
              // Leading (tl) is the one that bites: content breaking lines with T*/'/" collapses to one baseline without it.
              // Tm/Tlm are excluded (they reset at BT).
              textState: {
                tc,
                tw,
                tz,
                tl,
                tr,
                ts,
              },
            });
          }
        }
      }
      emitPersistVerbatim(op);
      continue;
    }

    // Marked-content nesting drives OCG visibility.
    if (op === 'BDC' || op === 'BMC') {
      /** @type {boolean} */
      let nowHidden = ocHidden;
      if (!nowHidden && op === 'BDC' && hiddenOCMCNames && hiddenOCMCNames.size > 0
          && operandBuf.length >= 2) {
        const tagTok = operandBuf[operandBuf.length - 2];
        const propTok = operandBuf[operandBuf.length - 1];
        if (tagTok && tagTok.type === 'name' && tagTok.value === 'OC'
            && propTok && propTok.type === 'name' && hiddenOCMCNames.has(propTok.value)) {
          nowHidden = true;
        }
      }
      mcHiddenStack.push(nowHidden);
      ocHidden = nowHidden;
      emitPersistVerbatim(op);
      continue;
    }
    if (op === 'EMC') {
      if (mcHiddenStack.length > 0) mcHiddenStack.pop();
      ocHidden = mcHiddenStack.length > 0 && mcHiddenStack[mcHiddenStack.length - 1];
      emitPersistVerbatim(op);
      continue;
    }

    const isTextShow = op === 'Tj' || op === 'TJ' || op === "'" || op === '"';
    if (!isTextShow) {
      // Colour, marked-content, path, and unknown ops all act on state that outlives the text object, so they survive removal.
      emitPersistVerbatim(op);
      continue;
    }

    const binding = currentFontTag ? fontsByTag.get(currentFontTag) : null;

    // '"' (and "'") move to next line before showing. '"' also sets Tw and Tc.
    let aw = null;
    let ac = null;
    if (op === '"' && operandBuf.length >= 3) {
      aw = operandBuf[operandBuf.length - 3].value;
      ac = operandBuf[operandBuf.length - 2].value;
      tw = aw;
      tc = ac;
    }
    if (op === "'" || op === '"') {
      const tx = 0;
      const ty = -tl;
      tlm = [tlm[0], tlm[1], tlm[2], tlm[3],
        tx * tlm[0] + ty * tlm[2] + tlm[4],
        tx * tlm[1] + ty * tlm[3] + tlm[5]];
      tm = tlm.slice();
    }

    const operand = operandBuf[operandBuf.length - 1];
    // Convertibility by render mode (section 9.3.6).
    // Tr=0 fills (forms paint `f`).
    // Tr=1/2 stroke or fill-then-stroke per glyph: forms paint `S`/`B` and inherit the ambient stroke/fill colours.
    // The pen width is user-space, so a compensated `w` is emitted per invocation (forms are cached across pages and cannot bake it).
    // Tr=3 is invisible (stripText's domain) and Tr>=4 adds clipping. Both stay verbatim.
    // Type3 CharProcs paint themselves (modes other than 3/7 do not stroke them), so Type3 runs under Tr 1/2 also stay verbatim.
    /** @type {'stroke' | 'fillStroke' | null} */
    let strokeMode = null;
    let verbatimReason = null;
    if (tr === 1 || tr === 2) {
      if (binding && binding.isType3) verbatimReason = 'type3-stroke-unsupported';
      else if (lw === null) verbatimReason = 'stroke-unknown-linewidth';
      else if (dashActive) verbatimReason = 'stroke-dash-unsupported';
      else strokeMode = tr === 1 ? 'stroke' : 'fillStroke';
    } else if (tr >= 4 && tr <= 7) {
      verbatimReason = `unsupported-tr-mode:${tr}`;
    }
    // `ocHidden`: this show sits in an OFF optional-content block.
    // Keep it verbatim so the renderer goes on hiding it.
    // Converting it to paths would make hidden content (e.g. alternate SAR values or print marks) always visible.
    if (!binding || !operand || ocHidden || (tr !== 0 && strokeMode === null)) {
      if (binding && operand && verbatimReason) {
        skipped.push({ fontObjNum: binding.fontObjNum, charCode: -1, reason: verbatimReason });
      }
      // Verbatim text still advances the text matrix. Replay its advance onto tm
      // so a later converted run in the same BT lands after the kept text instead of overlapping it.
      if (binding && operand) {
        const vcs = binding.codespaceRanges || (binding.isType0 ? [{ bytes: 2, low: 0, high: 0xFFFF }] : null);
        for (const elem of flattenTextOperandTyped(operand, op === '"' ? 'Tj' : op, vcs)) {
          if (elem.type === 'spacer') applySpacerToMatrix(tm, binding, elem.value);
          else advanceMatrixForGlyph(tm, binding, elem.value, elem.numBytes);
        }
      }
      // The kept bytes render and/or stay selectable (Tr 3 included: in the region flow invisible text IS the selectable layer),
      // so the enclosing text object cannot be removed.
      if (inBT && operandHasBytes(operand)) btKept = true;
      emitVerbatim(op);
      continue;
    }

    if (!inBT) {
      return { ok: false, reason: 'text-show-outside-BT' };
    }

    const csRanges = binding.codespaceRanges
      || (binding.isType0 ? [{ bytes: 2, low: 0, high: 0xFFFF }] : null);
    const flattened = flattenTextOperandTyped(operand, op === '"' ? 'Tj' : op, csRanges);
    const trmPrefix = [currentFontSize * tz / 100, 0, 0, currentFontSize, 0, ts];

    /** @type {Array<{kind: 'glyph', code: number, numBytes: number} | {kind: 'spacer', value: number}>} */
    const outputElems = [];
    let anyConvert = false;
    // Per-run stroke state, computed on the first resolved glyph:
    // the 2x2 of trmPrefix * tm is translation-invariant across the run, so k, the anisotropy ratio, and the glyph-space pen width are run constants.
    /** @type {number | null} */
    let runStrokeW = null;
    /** @type {string | null} */
    let runStrokeBad = null;
    let runStrokePad = 0;

    for (const elem of flattened) {
      if (elem.type === 'spacer') {
        outputElems.push({ kind: 'spacer', value: elem.value });
        applySpacerToMatrix(tm, binding, elem.value);
        continue;
      }
      const code = elem.value;
      const numBytes = elem.numBytes;
      const trm = matMul(trmPrefix, matMul(tm, ctm));
      const userX = trm[4];
      const userY = trm[5];

      let didConvert = false;
      let inBbox = false;
      for (const b of bboxes) {
        if (userX >= b[0] && userX <= b[2] && userY >= b[1] && userY <= b[3]) {
          inBbox = true;
          break;
        }
      }
      const fontTargeted = targetFontObjNums !== null && targetFontObjNums.has(binding.fontObjNum);
      if (inBbox || fontTargeted) {
        const res = resolver({ fontObjNum: binding.fontObjNum, charCode: code });
        if ('error' in res) {
          if (res.error === 'empty-path') {
            // Invisible glyph (word space etc): emit a numeric spacer that matches its advance,
            // dropping the residual selectable whitespace a viewer would otherwise extract from this TJ.
            // `empty-path` covers both an outline glyph with no path and a Type3 glyph with an empty CharProc.
            didConvert = true;
            outputElems.push({ kind: 'spacer', value: spacerForGlyphMimic(binding, code, numBytes) });
            anyConvert = true;
          } else {
            skipped.push({ fontObjNum: binding.fontObjNum, charCode: code, reason: res.error });
          }
        } else {
          /** @type {number | undefined} */
          let strokeW;
          if (strokeMode) {
            if (runStrokeW === null && runStrokeBad === null) {
              const gm = (Array.isArray(res.formMatrix) && res.formMatrix.length === 6)
                ? res.formMatrix : [0.001, 0, 0, 0.001, 0, 0];
              const fm = matMul(gm, matMul(trmPrefix, tm));
              const det = fm[0] * fm[3] - fm[1] * fm[2];
              const k = Math.sqrt(Math.abs(det));
              // Singular values of the 2x2: sigma^2 = (t +/- sqrt(t^2 - 4*det^2))/2.
              // The pen circle is drawn in glyph space, so anisotropy (Tz, strong skew) maps it to an ellipse the original user-space pen never had.
              // Ratio > 1.4 (sigmaMax^2/sigmaMin^2 > 1.96) leaves the run verbatim.
              const t = fm[0] * fm[0] + fm[1] * fm[1] + fm[2] * fm[2] + fm[3] * fm[3];
              const disc = Math.sqrt(Math.max(0, t * t - 4 * det * det));
              runStrokePad = Math.abs(gm[0]) > 1e-12 ? 1 / Math.abs(gm[0]) : 1000;
              if (!Number.isFinite(k) || k < 1e-9 || lw === null) {
                runStrokeBad = 'stroke-degenerate-matrix';
              } else if ((t + disc) > 1.96 * (t - disc)) {
                runStrokeBad = 'stroke-anisotropic-matrix';
              } else if ((Math.max(ml ?? 10, 10) * (lw / k)) / 2 > runStrokePad) {
                // Miter spikes can reach (miterLimit*w)/2 past the outline.
                // The one-em BBox pad below must cover them, and the form is cached first-build-wins so the pad cannot grow per invocation.
                runStrokeBad = 'stroke-width-exceeds-bbox';
              } else {
                runStrokeW = lw / k;
              }
            }
            if (runStrokeBad !== null) {
              // Guard failure keeps the glyph as literal text.
              // The TJ re-emitted below still renders in mode `tr`.
              skipped.push({ fontObjNum: binding.fontObjNum, charCode: code, reason: runStrokeBad });
            } else if (runStrokeW !== null) {
              strokeW = runStrokeW;
            }
          }
          if (!strokeMode || strokeW !== undefined) {
            didConvert = true;
            const suffix = strokeMode === 'stroke' ? 's' : (strokeMode === 'fillStroke' ? 'b' : '');
            const xobjTag = `TGP${binding.fontObjNum}g${res.glyphIndex}${suffix}`;
            if (!usedXobj.has(xobjTag)) {
              // Stroke-form BBoxes get a one-em pad per side: the BBox clips form content and the pen extends past the outline.
              // Pad a copy, since res.bbox belongs to the resolver.
              const bbox = strokeMode
                ? {
                  xMin: res.bbox.xMin - runStrokePad,
                  yMin: res.bbox.yMin - runStrokePad,
                  xMax: res.bbox.xMax + runStrokePad,
                  yMax: res.bbox.yMax + runStrokePad,
                }
                : res.bbox;
              usedXobj.set(xobjTag, {
                fontObjNum: binding.fontObjNum,
                glyphIndex: res.glyphIndex,
                bbox,
                formMatrix: res.formMatrix,
                pathCommands: res.pathCommands,
                paintMode: strokeMode || res.paintMode || 'fill',
                evenOdd: !!res.evenOdd,
              });
            }
            let M = matMul(trmPrefix, tm);
            // Substitute fonts: squeeze the glyph horizontally to the PDF /Widths advance, mirroring the renderer's hScale.
            // The substitute's formMatrix is uniform-diagonal, so it commutes with an x-scale and the correction folds into M's first column (no extra cm, shape dedup preserved).
            // Cap at 2x as the renderer does for non-embedded.
            if (res.subAdvanceEm) {
              const ws = binding.isType0 && binding.charCodeToCID
                ? (binding.charCodeToCID.get(code) ?? code) : code;
              const W = binding.widths.get(ws) ?? binding.defaultWidth;
              if (W > 0) {
                let hScale = (W / 1000) / res.subAdvanceEm;
                if (hScale > 2.0) hScale = 1;
                if (Number.isFinite(hScale) && hScale > 0 && hScale !== 1) {
                  M = [M[0] * hScale, M[1] * hScale, M[2], M[3], M[4], M[5]];
                }
              }
            }
            pendingConverts.push(strokeW !== undefined ? { xobjTag, M, strokeW } : { xobjTag, M });
            outputElems.push({ kind: 'spacer', value: spacerForGlyphMimic(binding, code, numBytes) });
            anyConvert = true;
          }
        }
      }

      if (!didConvert) {
        outputElems.push({ kind: 'glyph', code, numBytes });
      }
      advanceMatrixForGlyph(tm, binding, code, numBytes);
    }

    if (!anyConvert) {
      if (operandHasBytes(operand)) btKept = true;
      emitVerbatim(op);
      continue;
    }
    changed = true;
    // A partially converted run leaves real bytes in the TJ below.
    if (outputElems.some((e) => e.kind === 'glyph')) btKept = true;

    // In-place replacement: the output position already equals this show's start (verbatim positioning ops plus advance-mimicking spacer TJs reproduce the original tm),
    // so emit the TJ directly with no ET/BT bounce or Tm re-emit.
    // ' and " advance to the next line (and " sets Tw/Tc) as part of the op being replaced, so emit those state effects explicitly.
    // Use TJ, not Tj, to interleave numeric spacers between kept glyphs.
    if (op === "'") {
      out.push('T*\n');
    } else if (op === '"' && aw !== null && ac !== null) {
      out.push(`${fmt(aw)} Tw\n`);
      out.push(`${fmt(ac)} Tc\n`);
      out.push('T*\n');
    }

    const parts = [];
    let hex = '';
    for (const e of outputElems) {
      if (e.kind === 'glyph') {
        hex += codeToHex(e.code, e.numBytes);
      } else {
        if (hex) { parts.push(`<${hex}>`); hex = ''; }
        parts.push(fmt(e.value));
      }
    }
    if (hex) parts.push(`<${hex}>`);
    if (parts.length > 0) out.push(`[${parts.join(' ')}] TJ\n`);
    operandBuf.length = 0;
  }

  flushPendingConverts();
  if (operandBuf.length > 0) {
    for (const o of operandBuf) out.push(`${serializeOperand(o)} `);
  }

  return {
    ok: true, text: changed ? out.join('') : streamText, changed, usedXobj, skipped, formInvocations,
  };
}

/**
 * Compute glyph bounding box (font-unit space) by walking path commands.
 * @param {Array<{type: string, x?: number, y?: number, x1?: number, y1?: number, x2?: number, y2?: number}>} commands
 */
function bboxFromCommands(commands) {
  let xMin = Infinity;
  let yMin = Infinity;
  let xMax = -Infinity;
  let yMax = -Infinity;
  const accept = (x, y) => {
    if (typeof x !== 'number' || typeof y !== 'number') return;
    if (x < xMin) xMin = x;
    if (x > xMax) xMax = x;
    if (y < yMin) yMin = y;
    if (y > yMax) yMax = y;
  };
  for (const c of commands) {
    if (c.type === 'M' || c.type === 'L') accept(c.x, c.y);
    else if (c.type === 'C') { accept(c.x1, c.y1); accept(c.x2, c.y2); accept(c.x, c.y); } else if (c.type === 'Q') { accept(c.x1, c.y1); accept(c.x, c.y); }
  }
  if (!Number.isFinite(xMin)) {
    return {
      xMin: 0, yMin: 0, xMax: 0, yMax: 0,
    };
  }
  return {
    xMin, yMin, xMax, yMax,
  };
}

/**
 * Resolve charCode → glyphIndex for a parsed PDF FontInfo + a font's cmap.
 *
 * @param {any} fontInfo - FontInfo from parsePageFonts
 * @param {number} charCode - the decoded code from the content stream
 * @param {{ cmap?: { glyphIndexMap: Record<number, number>, byteToGlyphIndex?: number[], platformID?: number, encodingID?: number } | null,
 *           nameToGid?: Map<string, number> | null,
 *           cffCharCodeToGid?: Map<number, number> | null,
 *           cffCidToGid?: Map<number, number> | null } | null} loaded
 * @returns {number | null}
 */
export function charCodeToGlyphIndex(fontInfo, charCode, loaded) {
  if (fontInfo.type0) {
    const cid = fontInfo.charCodeToCID
      ? (fontInfo.charCodeToCID.get(charCode) ?? charCode)
      : charCode;
    // For CIDFontType0C the CFF charset stores CIDs, not GIDs.
    // CID is not GID even when the PDF declares /Identity for CIDToGIDMap, because subsetting reorders glyphs.
    if (loaded?.cffCidToGid) {
      const gid = loaded.cffCidToGid.get(cid);
      if (gid != null) return gid;
    }
    const map = fontInfo.type0.cidToGidMap;
    if (map === 'identity' || !map) return cid;
    if (map instanceof Uint8Array) {
      const off = cid * 2;
      if (off + 1 >= map.length) return 0;
      return (map[off] << 8) | map[off + 1];
    }
    return cid;
  }
  if (loaded?.nameToGid && fontInfo.charCodeToGlyphName) {
    const gname = fontInfo.charCodeToGlyphName.get(charCode);
    if (gname) {
      const gid = loaded.nameToGid.get(gname);
      if (gid != null) return gid;
      // AGL "uniXXXX" / "uXXXXXX" names encode a Unicode codepoint directly.
      const uniMatch = /^uni([0-9A-Fa-f]{4})$/.exec(gname) || /^u([0-9A-Fa-f]{4,6})$/.exec(gname);
      if (uniMatch && loaded.cmap?.glyphIndexMap) {
        const cp = parseInt(uniMatch[1], 16);
        const g = loaded.cmap.glyphIndexMap[cp];
        if (g > 0) return g;
      }
    }
  }
  const cmap = loaded && loaded.cmap;
  // For a format-0 (single-byte) cmap, prefer the raw byteToGlyphIndex array over glyphIndexMap,
  // which re-keys its 0x80..0xFF half by Mac-Roman Unicode and maps those byte codes to the wrong glyph.
  if (cmap && Array.isArray(cmap.byteToGlyphIndex) && charCode >= 0 && charCode < 256) {
    const g = cmap.byteToGlyphIndex[charCode];
    if (g != null && g > 0) return g;
  }
  // Resolve by Unicode through the font's /post names when a unicodeToGid map exists, the code has a /ToUnicode entry, and /Differences does not name it.
  // Then the code's identity comes only from /ToUnicode, and the raw (1,0) Mac cmap below would map the byte to an unrelated Mac-Roman glyph.
  // Resolving by Unicode takes priority over that cmap[code] fallback below.
  if (loaded?.unicodeToGid && fontInfo.toUnicode && !fontInfo.charCodeToGlyphName?.get(charCode)) {
    const uniStr = fontInfo.toUnicode.get(charCode);
    if (uniStr && uniStr.length > 0) {
      const cp = uniStr.codePointAt(0);
      const gid = cp != null ? loaded.unicodeToGid.get(cp) : undefined;
      if (gid != null && gid > 0) return gid;
    }
  }
  const gim = cmap && cmap.glyphIndexMap;
  if (gim) {
    if (gim[charCode] != null && gim[charCode] > 0) return gim[charCode];
    if (gim[0xF000 | charCode] != null && gim[0xF000 | charCode] > 0) return gim[0xF000 | charCode];
    const uniStr = fontInfo.toUnicode && fontInfo.toUnicode.get(charCode);
    if (uniStr && uniStr.length > 0) {
      const cp = uniStr.codePointAt(0);
      if (cp != null && gim[cp] != null && gim[cp] > 0) return gim[cp];
    }
  }
  if (loaded?.cffCharCodeToGid) {
    const gid = loaded.cffCharCodeToGid.get(charCode);
    if (gid != null) return gid;
  }
  // Returning charCode as a GID can look correct for TrueType subsets where charCode == GID, but breaks CFF/Type1C without /Encoding.
  return null;
}

/**
 * @typedef {object} ConversionState
 * @property {Map<number, ReturnType<typeof loadGlyphsForOutlines>>} fontGlyphsCache
 *   Loaded glyph outlines, keyed by source font objNum.
 * @property {Set<number>} inProgress
 *   Form objNums currently on the recursion stack. Cycle guard.
 * @property {Map<string, number>} formCloneByKey
 *   Cloned Form XObject dedup, keyed by `${origObjNum}|${contentHash}|${redirectsHash}`.
 *   Lets pages sharing the same form with identical CTM reuse one clone object.
 * @property {Map<string, number>} type3GlyphIndexByKey
 *   Stable ordinal per Type3 (fontObjNum, glyphName)
 *   so the existing `TGP{font}g{gid}` Form-XObject dedup keys the same Type3 glyph the same way across pages.
 */

/**
 * Build a fresh document-wide cache state shared across `convertSinglePageForRegions` calls.
 * @returns {ConversionState}
 */
export function createConversionState() {
  return {
    fontGlyphsCache: new Map(),
    inProgress: new Set(),
    formCloneByKey: new Map(),
    type3GlyphIndexByKey: new Map(),
  };
}

/**
 * Build a glyph resolver closure for the conversion state.
 *
 * @param {Map<number, any>} fontInfoByObjNum - Shared map: fontObjNum -> FontInfo.
 *   Mutated as fonts from forms are encountered.
 * @param {ReturnType<typeof createConversionState>} state
 * @returns {GlyphResolver}
 */
function buildResolver(fontInfoByObjNum, state) {
  return ({ fontObjNum, charCode }) => {
    const fi = fontInfoByObjNum.get(fontObjNum);
    if (!fi) return { error: 'font-not-found' };

    if (fi.type3) {
      const glyphName = fi.type3.encoding[charCode];
      if (!glyphName) return { error: 'type3-no-encoding' };
      const glyph = fi.type3.glyphs[glyphName];
      if (!glyph) return { error: 'type3-no-glyph' };
      const commands = glyph.commands;
      if (!commands || commands.length === 0) {
        // Zero path commands is only evidence of an empty glyph when the CharProc is PROVABLY empty: every operator is non-marking (see parseType3Font).
        // Bitmap glyphs (inline ImageMask, Do), nested text, shadings, and unreadable CharProcs all parse to zero path commands while still (possibly) painting,
        // and dropping those erases the page's visible text.
        // Route them to the same skipped-bitmap bucket as the stray-token case below.
        if (!glyph.provablyEmpty) return { error: 'type3-no-moveto' };
        // A genuinely empty CharProc draws nothing, the Type3 equivalent of an outline glyph with no path.
        // Report it as `empty-path` so the caller drops it to a numeric spacer (removing the residual selectable whitespace) instead of leaving a selectable text-show op behind.
        // Producers (e.g. Adobe "Print to PDF") encode inter-word spaces this way, often with a broken oversized FontBBox,
        // so leaving them verbatim hijacks text selection.
        return { error: 'empty-path' };
      }
      // A CharProc that paints via inline image or Do (bitmapped Type3 glyphs) produces no real path data.
      // `parseGlyphStreamPaths` can still surface stray `h`/`Z` tokens from misinterpreting binary inline-image bytes,
      // so guard against converting an empty-looking path: require at least one moveto.
      if (!commands.some((c) => c.type === 'M')) {
        return { error: 'type3-no-moveto' };
      }
      // PDF 32000-2 §9.6.4: a d1 CharProc is monochromatic and takes its colour from the graphics
      // state (the fill colour at Tr=0), so a fill (`f`) inside the form picks up the caller's fill colour and round-trips.
      // Skip the cases a Form XObject Do can't reproduce: d0 (supplies its own colours, which parseGlyphStreamPaths drops)
      // and d1 + stroke/fillStroke (the form's S/B would source the caller's separate stroke colour, not d1's fill-as-stroke).
      if (!glyph.isD1) return { error: 'type3-d0-colour-not-preserved' };
      const pm = glyph.paintMode;
      if (pm === 'stroke' || pm === 'fillStroke') {
        return { error: `type3-d1-${pm}-colour-mismatch` };
      }
      const key = `${fontObjNum}|${glyphName}`;
      let glyphIndex = state.type3GlyphIndexByKey.get(key);
      if (glyphIndex == null) {
        glyphIndex = state.type3GlyphIndexByKey.size;
        state.type3GlyphIndexByKey.set(key, glyphIndex);
      }
      // Derive the bbox from the path commands, not `glyph.bbox`: the two come from different walks
      // of the CharProc (`parseGlyphStream` vs `parseGlyphStreamPaths` in `parsePdfFonts.js`) and land
      // in different coordinate spaces when the CharProc contains scaling cm ops, so they are not mixable.
      const bbox = bboxFromCommands(commands);
      return {
        glyphIndex,
        formMatrix: fi.type3.fontMatrix,
        pathCommands: commands,
        bbox,
        paintMode: 'fill',
        evenOdd: !!glyph.evenOdd,
      };
    }

    let loaded;
    if (state.fontGlyphsCache.has(fontObjNum)) {
      loaded = state.fontGlyphsCache.get(fontObjNum);
    } else {
      let fontFile = null;
      if (fi.type0 && fi.type0.fontFile) fontFile = fi.type0.fontFile;
      else if (fi.type1 && fi.type1.fontFile) fontFile = fi.type1.fontFile;
      loaded = fontFile ? loadGlyphsForOutlines(fontFile) : null;
      // Fully unembedded font (no FontFile at all): substitute with our built-in outlines, as every viewer already does.
      // An embedded-but-unparseable program has a fontFile, so it fails this gate and keeps the skip-tail behavior.
      if (!loaded && !fontFile && (fi.type1 || fi.type0) && GlobalFonts.raw) {
        // Resolve the substitute family via the same cascade the renderer uses for non-embedded fonts (registerNonEmbeddedFont), so the outlines match the baseline render.
        const hints = { bold: !!fi.bold, italic: !!fi.italic };
        // A 'cursive' generic returns null (no bundled cursive face), so that font keeps the skip-tail behavior rather than rendering wrong.
        const sub = base14ToBundledFont(fi.baseName, hints)
          || cssFamilyToBundledFont(standardFontToCSS(fi.baseName || '') || '', hints)
          || genericToBundledFont(cssGenericForFontObj(fi), hints);
        if (sub) {
          const styleKey = sub.variant === 'BoldItalic' ? 'boldItalic'
            : (sub.variant === 'Bold' ? 'bold' : (sub.variant === 'Italic' ? 'italic' : 'normal'));
          const fam = GlobalFonts.raw[sub.family];
          // The Base14 symbol faces (Dingbats, StandardSymbolsPS) live in `supp`, not `raw`, so fall back to bundledSuppFontFor below.
          let subFont = (fam?.[styleKey] || fam?.normal)?.opentype;
          if (!subFont) subFont = bundledSuppFontFor(sub.family) || undefined;
          if (subFont?.glyphs && subFont.unitsPerEm > 0) {
            loaded = {
              glyphs: subFont.glyphs,
              unitsPerEm: subFont.unitsPerEm,
              fontMatrix: [1 / subFont.unitsPerEm, 0, 0, 1 / subFont.unitsPerEm, 0, 0],
              fontType: 'substitute',
              substituteFont: subFont,
            };
          }
        }
      }
      state.fontGlyphsCache.set(fontObjNum, loaded);
    }
    if (!loaded) return { error: 'font-not-embedded-or-unsupported' };
    let glyphIndex;
    if (loaded.fontType === 'substitute') {
      // Drawing identity comes from the PDF encoding (glyph name via AGL, covering /Differences and base encodings),
      // with the encoding-derived and /ToUnicode maps as fallbacks, bridged into the substitute font's Unicode cmap.
      let uni = null;
      const gname = fi.charCodeToGlyphName ? fi.charCodeToGlyphName.get(charCode) : null;
      if (gname) {
        uni = aglLookup(gname) || null;
        if (!uni) {
          const m = /^uni([0-9A-Fa-f]{4})$/.exec(gname) || /^u([0-9A-Fa-f]{4,6})$/.exec(gname);
          if (m) uni = String.fromCodePoint(parseInt(m[1], 16));
        }
      }
      if (!uni && fi.encodingUnicode) uni = fi.encodingUnicode.get(charCode) || null;
      if (!uni && fi.toUnicode) uni = fi.toUnicode.get(charCode) || null;
      if (!uni || uni.length === 0) {
        // A control byte (C0 0x00-0x1F or DEL 0x7F) with no glyph-name/Unicode mapping paints nothing, so drop it to an advance-only spacer rather than residual selectable text.
        // Any other glyph that merely lacks Unicode keeps the skip-tail.
        if (charCode < 0x20 || charCode === 0x7f) return { error: 'empty-path' };
        return { error: 'substitute-no-unicode' };
      }
      const cp = uni.codePointAt(0);
      glyphIndex = cp != null ? loaded.substituteFont.charToGlyphIndex(String.fromCodePoint(cp)) : 0;
      if (!glyphIndex || glyphIndex <= 0) return { error: 'substitute-missing-glyph' };
    } else {
      glyphIndex = charCodeToGlyphIndex(fi, charCode, loaded);
    }
    if (glyphIndex == null || glyphIndex < 0 || glyphIndex >= loaded.glyphs.length) {
      return { error: `no-glyph-${glyphIndex}` };
    }
    let glyph;
    try {
      glyph = loaded.glyphs.get(glyphIndex);
    } catch (e) {
      return { error: `glyph-load-failed:${String(e?.message || e)}` };
    }
    if (!glyph || !glyph.path || !glyph.path.commands) {
      return { error: 'no-path-commands' };
    }
    const commands = glyph.path.commands;
    if (commands.length === 0) {
      return { error: 'empty-path' };
    }
    const upem = (typeof loaded.unitsPerEm === 'number' && loaded.unitsPerEm > 0
      && Number.isFinite(loaded.unitsPerEm)) ? loaded.unitsPerEm : 1000;
    const inv = 1 / upem;
    const formMatrix = (Array.isArray(loaded.fontMatrix) && loaded.fontMatrix.length === 6)
      ? loaded.fontMatrix : [inv, 0, 0, inv, 0, 0];
    // For a substitute (non-embedded) font, the drawn outline carries the substitute's natural advance, not the PDF's /Widths.
    // The renderer squeezes it horizontally to the specified width (renderPdfPage hScale).
    // Report the substitute glyph's natural advance (em) so the caller can do the same.
    const subAdvanceEm = (loaded.fontType === 'substitute'
      && typeof glyph.advanceWidth === 'number' && glyph.advanceWidth > 0)
      ? glyph.advanceWidth / upem : undefined;
    return {
      glyphIndex,
      formMatrix,
      pathCommands: commands,
      bbox: bboxFromCommands(commands),
      subAdvanceEm,
    };
  };
}

/**
 * Add a container's fonts (parsed from its /Resources) into the shared
 * fontInfoByObjNum and into a per-container fontsByTag map.
 *
 * @param {Map<string, any>} pdfFontInfos - Output of parsePageFonts.
 * @param {Map<string, FontBinding>} fontsByTag - Mutated: adds container fonts.
 * @param {Map<number, any>} fontInfoByObjNum - Mutated: adds container fonts.
 */
function mergeContainerFonts(pdfFontInfos, fontsByTag, fontInfoByObjNum) {
  for (const [tag, fi] of pdfFontInfos) {
    if (typeof fi.fontObjNum !== 'number') continue;
    fontsByTag.set(tag, {
      fontObjNum: fi.fontObjNum,
      widths: fi.widths,
      defaultWidth: fi.defaultWidth,
      verticalMode: !!fi.verticalMode,
      codespaceRanges: fi.codespaceRanges,
      charCodeToCID: fi.charCodeToCID,
      isType0: !!fi.isCIDFont || !!fi.type0,
      isType3: !!fi.type3,
    });
    if (!fontInfoByObjNum.has(fi.fontObjNum)) fontInfoByObjNum.set(fi.fontObjNum, fi);
  }
}

/**
 * Add to `into` the object numbers of Type3 fonts with broken ToUnicode, whose glyphs are converted to paths so their gibberish PUA text stops being selectable.
 *
 * @param {Map<number, any>} fontInfoByObjNum
 * @param {Set<number>} into - Mutated: broken-Type3 font object numbers added.
 */
function collectBrokenType3FontObjNums(fontInfoByObjNum, into) {
  const FILLER_MIN = 3;
  for (const [objNum, fi] of fontInfoByObjNum) {
    if (into.has(objNum) || !fi || !fi.type3 || !fi.toUnicode) continue;
    const enc = fi.type3.encoding || {};
    const glyphs = fi.type3.glyphs || {};
    /** @param {number} cc */
    const glyphOf = (cc) => glyphs[enc[cc]];
    // Count outline reuse so producer .notdef boxes (one outline across many slots) are not mistaken for genuinely-unresolved characters.
    const hashCount = new Map();
    for (const [cc] of fi.toUnicode) {
      const g = glyphOf(cc);
      if (g && g.pathHash) hashCount.set(g.pathHash, (hashCount.get(g.pathHash) || 0) + 1);
    }
    for (const [cc, str] of fi.toUnicode) {
      if (str == null || str === '') continue;
      const cp = str.codePointAt(0);
      if (cp === 0xFFFD) { into.add(objNum); break; }
      if (cp < 0xE000 || cp > 0xF8FF) continue;
      const g = glyphOf(cc);
      const isFiller = g && g.pathHash && (hashCount.get(g.pathHash) || 0) >= FILLER_MIN;
      if (!isFiller) { into.add(objNum); break; }
    }
  }
}

/**
 * Stable string hash (djb2). Used for clone dedup fingerprints.
 * @param {string} s
 */
function djb2(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/**
 * Build the dedup key for a cloned Form XObject. Two invocations with the same
 * key produce byte-identical clone objects, so a single clone is shared.
 *
 * @param {number} origObjNum
 * @param {string} text - Rewritten content stream text.
 * @param {Map<string, number>} xobjEntries - Per-glyph form entries this clone references.
 * @param {Map<string, number>} formClonesByName - Nested-form redirects this clone references.
 */
function makeCloneDedupKey(origObjNum, text, xobjEntries, formClonesByName) {
  const sortedX = [...xobjEntries.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`).join('\n');
  const sortedF = [...formClonesByName.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`).join('\n');
  return `${origObjNum}|${djb2(text)}|${djb2(sortedX)}|${djb2(sortedF)}`;
}

/**
 * Inline merger for the cloned form's /Resources/XObject dict.
 * PDF spec allows duplicate keys in dicts with last-entry-wins semantics,
 * so appending entries (including redirects) is sufficient.
 *
 * @param {string} resourcesDictText - The form's /Resources sub-dict as `<<...>>`.
 *   Empty string or null is treated as missing — a fresh /Resources is built.
 * @param {string} entriesStr - Newline-separated `/Name N 0 R` entries to add
 *   to /XObject.
 * @param {import('../../pdf/objectCache.js').ObjectCache} objCache - Used to
 *   resolve an indirect /XObject sub-dict if the form's Resources references one.
 */
function mergeXObjectIntoResources(resourcesDictText, entriesStr, objCache) {
  if (!entriesStr) return resourcesDictText || '<<\n>>';
  let inner = resourcesDictText && resourcesDictText.startsWith('<<')
    ? resourcesDictText.slice(2, -2).trim()
    : '';
  const xobjIdx = inner.indexOf('/XObject');
  if (xobjIdx === -1) {
    inner = `${inner}\n/XObject<<\n${entriesStr}>>`;
    return `<<${inner}\n>>`;
  }
  let p = xobjIdx + '/XObject'.length;
  while (p < inner.length && /\s/.test(inner[p])) p++;
  if (inner.startsWith('<<', p)) {
    const dict = extractDict(inner, p);
    const merged = `${dict.slice(0, -2)}\n${entriesStr}\n>>`;
    return `<<${inner.slice(0, p) + merged + inner.slice(p + dict.length)}\n>>`;
  }
  const refMatch = /^(\d+)\s+\d+\s+R/.exec(inner.slice(p));
  if (refMatch && objCache) {
    const resolved = objCache.getObjectText(Number(refMatch[1]));
    if (resolved) {
      const trimmed = resolved.trim();
      const innerBody = trimmed.startsWith('<<') && trimmed.endsWith('>>')
        ? trimmed.slice(2, -2).trim()
        : trimmed;
      const merged = `<<${innerBody}\n${entriesStr}\n>>`;
      return `<<${inner.slice(0, p) + merged + inner.slice(p + refMatch[0].length)}\n>>`;
    }
  }
  // Last-wins fallback: append a duplicate /XObject sub-dict with our entries.
  return `<<${inner}\n/XObject<<\n${entriesStr}>>\n>>`;
}

/**
 * Resolve an object's /Resources to its literal `<<...>>` dict text, following an indirect reference if present.
 * Returns null when the object has no /Resources of its own
 * (a Form XObject may omit it and inherit its parent's per PDF spec 7.8.3).
 *
 * @param {string} objText
 * @param {import('../../pdf/objectCache.js').ObjectCache} objCache
 * @returns {string | null}
 */
function resolveResourcesText(objText, objCache) {
  const idx = objText.indexOf('/Resources');
  if (idx === -1) return null;
  let p = idx + '/Resources'.length;
  while (p < objText.length && /\s/.test(objText[p])) p++;
  if (objText.startsWith('<<', p)) return extractDict(objText, p);
  const ref = /^(\d+)\s+\d+\s+R/.exec(objText.slice(p));
  if (ref) {
    const resolved = objCache.getObjectText(Number(ref[1]));
    if (resolved) {
      const t = resolved.trim();
      return t.startsWith('<<') ? t : `<<${t}>>`;
    }
  }
  return null;
}

/**
 * Extract the stroke-relevant ExtGState parameters (/LW, /ML, /D) from a resources dict text.
 *
 * @param {string | null} resourcesText
 * @param {import('../../pdf/objectCache.js').ObjectCache} objCache
 * @returns {Map<string, {lw?: number, dash?: boolean, ml?: number}>}
 */
function parseExtGStates(resourcesText, objCache) {
  /** @type {Map<string, {lw?: number, dash?: boolean, ml?: number}>} */
  const out = new Map();
  if (!resourcesText) return out;
  const idx = resourcesText.indexOf('/ExtGState');
  if (idx === -1) return out;
  let p = idx + '/ExtGState'.length;
  while (p < resourcesText.length && /\s/.test(resourcesText[p])) p++;
  let dictText = null;
  if (resourcesText.startsWith('<<', p)) {
    dictText = extractDict(resourcesText, p);
  } else {
    const ref = /^(\d+)\s+\d+\s+R/.exec(resourcesText.slice(p));
    if (ref && objCache) {
      const resolved = objCache.getObjectText(Number(ref[1]));
      if (resolved) {
        const ds = resolved.indexOf('<<');
        if (ds !== -1) dictText = extractDict(resolved, ds);
      }
    }
  }
  if (!dictText) return out;
  for (const entry of parseDictEntries(dictText.slice(2, -2))) {
    let gsText = entry.valueText;
    const ref = /^(\d+)\s+\d+\s+R$/.exec(gsText.trim());
    if (ref) {
      const resolved = objCache ? objCache.getObjectText(Number(ref[1])) : null;
      if (!resolved) continue;
      const ds = resolved.indexOf('<<');
      if (ds === -1) continue;
      gsText = extractDict(resolved, ds);
    }
    /** @type {{lw?: number, dash?: boolean, ml?: number}} */
    const rec = {};
    const lwM = /\/LW\s+([0-9.+-]+)/.exec(gsText);
    if (lwM) {
      const v = parseFloat(lwM[1]);
      if (!Number.isFinite(v) || v < 0) continue;
      rec.lw = v;
    }
    const mlM = /\/ML\s+([0-9.+-]+)/.exec(gsText);
    if (mlM) {
      const v = parseFloat(mlM[1]);
      if (Number.isFinite(v)) rec.ml = v;
    }
    const dM = /\/D\s*\[\s*\[([^\]]*)\]/.exec(gsText);
    if (dM) rec.dash = /\S/.test(dM[1]);
    out.set(entry.name, rec);
  }
  return out;
}

/**
 * Build the dict-extras string (everything between `<<` and `/Length`) for a cloned Form XObject.
 * Preserves the original dict's keys verbatim except
 * /Length and /Filter (re-emitted by `encodeStreamObject`) and /Resources
 * (rebuilt to splice in per-glyph entries and nested-form redirects).
 *
 * @param {string} originalFormObjText - `N 0 obj\n<<...>>\nstream\n...\nendobj`
 * @param {import('../../pdf/objectCache.js').ObjectCache} objCache
 * @param {Map<string, number>} perGlyphXobjEntries - tag → objNum for per-glyph forms used inside.
 * @param {Map<string, number>} nestedFormRedirects - name → cloneObjNum for nested forms invoked inside.
 * @param {string | null} inheritedResourcesText - The parent scope's /Resources dict text,
 *   used as the clone's /Resources base when the original form has none of its own.
 * @returns {string}
 */
function buildClonedFormDictExtras(originalFormObjText, objCache, perGlyphXobjEntries, nestedFormRedirects, inheritedResourcesText) {
  const dictStart = originalFormObjText.indexOf('<<');
  if (dictStart === -1) return '';
  const dictText = extractDict(originalFormObjText, dictStart);
  // Strip /Length and /Filter. encodeStreamObject re-emits both fresh.
  const dictBody = dictText.startsWith('<<') && dictText.endsWith('>>')
    ? dictText.slice(2, -2)
    : dictText;
  let body = parseDictEntries(dictBody)
    .filter((e) => e.name !== 'Length' && e.name !== 'Filter')
    .map((e) => `/${e.name} ${e.valueText}`)
    .join('\n');

  // Build the /XObject entries we need to add to /Resources.
  let entriesStr = '';
  for (const [tag, on] of perGlyphXobjEntries) entriesStr += `/${tag} ${on} 0 R\n`;
  for (const [name, on] of nestedFormRedirects) entriesStr += `/${name} ${on} 0 R\n`;

  // Locate /Resources entry; replace it (or append if missing).
  const resIdx = body.indexOf('/Resources');
  // A form that omits /Resources inherits its parent's (PDF spec 7.8.3).
  // The clone gets its own explicit /Resources, which severs that inheritance, so seed it from the inherited dict.
  // Otherwise images and fonts the form drew via inheritance drop out of the clone.
  let resourcesDictText = resIdx === -1 ? (inheritedResourcesText || '') : '';
  let beforeRes = body;
  let afterRes = '';
  if (resIdx !== -1) {
    let p = resIdx + '/Resources'.length;
    while (p < body.length && /\s/.test(body[p])) p++;
    if (body.startsWith('<<', p)) {
      const sub = extractDict(body, p);
      resourcesDictText = sub;
      beforeRes = body.slice(0, resIdx).trimEnd();
      afterRes = body.slice(p + sub.length);
    } else {
      const refMatch = /^(\d+)\s+\d+\s+R/.exec(body.slice(p));
      if (refMatch) {
        const resolved = objCache.getObjectText(Number(refMatch[1]));
        if (resolved) {
          const trimmed = resolved.trim();
          resourcesDictText = trimmed.startsWith('<<') ? trimmed : `<<${trimmed}>>`;
        }
        beforeRes = body.slice(0, resIdx).trimEnd();
        afterRes = body.slice(p + refMatch[0].length);
      }
    }
  }
  const mergedResources = mergeXObjectIntoResources(resourcesDictText, entriesStr, objCache);
  body = `${beforeRes}\n/Resources ${mergedResources}\n${afterRes.trimStart()}`;

  return body.trim();
}

/**
 * Recursively rewrite a Form XObject's content stream for path conversion.
 *
 * If the form has no convertible glyphs, returns the original objNum unchanged.
 * If the form has changes, allocates a clone (deduped via state.formCloneByKey)
 * and returns the clone's objNum.
 *
 * @param {object} params
 * @param {number} params.formObjNum
 * @param {number[]} params.ctm - CTM at the time of the Do call.
 * @param {Map<string, FontBinding>} params.parentFontsByTag - Caller's font scope.
 * @param {Map<number, any>} params.fontInfoByObjNum - Shared font info map.
 * @param {GlyphResolver} params.resolver
 * @param {ReadonlyArray<ReadonlyArray<number>>} params.bboxes
 * @param {Set<number> | null} [params.targetFontObjNums] - Broken-Type3 font object numbers,
 *   extended with this form's fonts so glyphs drawn inside it convert too.
 * @param {ReturnType<typeof createConversionState>} params.state
 * @param {import('../../pdf/objectCache.js').ObjectCache} params.objCache
 * @param {() => number} params.allocObjNum
 * @param {(obj: {objNum: number, content: any}) => void} params.pushObj
 * @param {boolean} params.humanReadable
 * @param {string | null} [params.parentResourcesText] - The enclosing scope's /Resources dict text,
 *   which this form inherits when it has none of its own.
 * @param {number | null} [params.initialLineWidth] - Pen width at the recorded Do site
 *   (null = unknown; Tr 1/2 shows inside then stay verbatim).
 * @param {boolean} [params.initialDashActive]
 * @param {number | null} [params.initialMiterLimit]
 * @param {{tc: number, tw: number, tz: number, tl: number, tr: number, ts: number} | null} [params.initialTextState]
 *   - Text state (incl. leading) inherited from the Do site,
 *     so the form's line breaks and glyph advances match the original.
 * @returns {Promise<{ changed: boolean, cloneObjNum: number,
 *   skipped: Array<{fontObjNum: number, charCode: number, reason: string}> }>}
 */
async function rewriteFormContentForRegions({
  formObjNum, ctm, parentFontsByTag, fontInfoByObjNum, resolver,
  bboxes, targetFontObjNums = null, state, objCache, allocObjNum, pushObj, humanReadable,
  parentResourcesText = null, initialLineWidth = null, initialDashActive = false, initialMiterLimit = null,
  initialTextState = null,
}) {
  if (state.inProgress.has(formObjNum)) {
    return { changed: false, cloneObjNum: formObjNum, skipped: [] };
  }
  state.inProgress.add(formObjNum);
  try {
    const formObjText = objCache.getObjectText(formObjNum);
    if (!formObjText || !/\/Subtype\s*\/Form\b/.test(formObjText)) {
      return { changed: false, cloneObjNum: formObjNum, skipped: [] };
    }

    // A Form whose own /OC group is OFF is never painted (the renderer skips its Do entirely).
    // Leave it unconverted so its text stays hidden, not pathed.
    const offOCGs = typeof objCache.getOffOCGs === 'function' ? objCache.getOffOCGs() : new Set();
    if (offOCGs.size > 0 && isFormOCHidden(formObjText, offOCGs, objCache)) {
      return { changed: false, cloneObjNum: formObjNum, skipped: [] };
    }

    // Resources this form's content can see: its own when present, else what it inherits from the enclosing scope.
    // Nested forms inherit this same effective dict.
    const effectiveResources = resolveResourcesText(formObjText, objCache) || parentResourcesText;

    let formMatrix = [1, 0, 0, 1, 0, 0];
    const nums = resolveNumArray(formObjText, 'Matrix', objCache);
    if (nums && nums.length === 6 && nums.every(Number.isFinite)) formMatrix = nums;
    const effectiveCtm = matMul(formMatrix, ctm);

    let streamBytes;
    try { streamBytes = objCache.getStreamBytes(formObjNum); } catch { streamBytes = null; }
    if (!streamBytes) return { changed: false, cloneObjNum: formObjNum, skipped: [] };
    const streamText = bytesToLatin1(streamBytes);

    const fontsByTag = new Map(parentFontsByTag);
    let formFontInfos;
    try {
      formFontInfos = parsePageFonts(formObjText, objCache);
    } catch {
      formFontInfos = new Map();
    }
    if (formFontInfos && formFontInfos.size > 0) {
      mergeContainerFonts(formFontInfos, fontsByTag, fontInfoByObjNum);
      // Pick up any broken-Type3 fonts this form introduces (shared set).
      if (targetFontObjNums) collectBrokenType3FontObjNums(fontInfoByObjNum, targetFontObjNums);
      // Load bundled symbol faces a form-local Dingbats/Symbol font needs.
      await preloadSymbolSubstituteFonts(formFontInfos.values());
    }

    const formXobjectsByName = new Map();
    for (const [name, info] of findFormXObjects(formObjText, objCache)) {
      formXobjectsByName.set(name, info.objNum);
    }

    const smResult = rewritePageContentForRegions(streamText, fontsByTag, bboxes, resolver, {
      initialCtm: effectiveCtm,
      parentXobjects: formXobjectsByName,
      targetFontObjNums,
      initialLineWidth,
      initialDashActive,
      initialMiterLimit,
      initialTextState,
      extGStates: parseExtGStates(effectiveResources, objCache),
      hiddenOCMCNames: offOCGs.size > 0 ? parseHiddenOCMCNames(formObjText, objCache, offOCGs) : null,
      humanReadable,
    });
    if (!smResult.ok) {
      return { changed: false, cloneObjNum: formObjNum, skipped: [] };
    }

    /** @type {Map<string, number>} */
    const nestedFormClones = new Map();
    const skipped = smResult.skipped.slice();
    // One recursion per form name, like the first-ctm-wins dedup,
    // but pen state baked into the shared clone's emitted `w` values is a rendering error if invocations disagree,
    // so disagreement degrades to unknown.
    const invByName = new Map();
    for (const inv of smResult.formInvocations) {
      const prev = invByName.get(inv.name);
      if (!prev) {
        invByName.set(inv.name, {
          formObjNum: inv.formObjNum, ctm: inv.ctm, lw: inv.lw, dashActive: inv.dashActive, ml: inv.ml, textState: inv.textState,
        });
      } else if (prev.lw !== inv.lw || prev.dashActive !== inv.dashActive || prev.ml !== inv.ml) {
        prev.lw = null;
        prev.ml = null;
      }
    }
    for (const [invName, inv] of invByName) {
      const r = await rewriteFormContentForRegions({
        formObjNum: inv.formObjNum,
        ctm: inv.ctm,
        parentFontsByTag: fontsByTag,
        fontInfoByObjNum,
        resolver,
        bboxes,
        targetFontObjNums,
        state,
        objCache,
        allocObjNum,
        pushObj,
        humanReadable,
        parentResourcesText: effectiveResources,
        initialLineWidth: inv.lw,
        initialDashActive: inv.dashActive,
        initialMiterLimit: inv.ml,
        initialTextState: inv.textState,
      });
      if (r.skipped && r.skipped.length > 0) skipped.push(...r.skipped);
      if (r.changed && r.cloneObjNum !== inv.formObjNum) {
        nestedFormClones.set(invName, r.cloneObjNum);
      }
    }

    if (!smResult.changed && nestedFormClones.size === 0) {
      return { changed: false, cloneObjNum: formObjNum, skipped };
    }

    // Glyphs are inlined into smResult.text; the clone needs no per-glyph
    // /XObject entries of its own (nested-form redirects still apply below).
    /** @type {Map<string, number>} */
    const perGlyphEntries = new Map();

    const dedupKey = makeCloneDedupKey(formObjNum, smResult.text, perGlyphEntries, nestedFormClones);
    const cached = state.formCloneByKey.get(dedupKey);
    if (cached != null) {
      return { changed: true, cloneObjNum: cached, skipped };
    }
    const cloneObjNum = allocObjNum();
    const dictExtras = buildClonedFormDictExtras(formObjText, objCache, perGlyphEntries, nestedFormClones, parentResourcesText);
    const cloneContent = await encodeStreamObject(cloneObjNum, smResult.text, { humanReadable, dictExtras });
    pushObj({ objNum: cloneObjNum, content: cloneContent });
    state.formCloneByKey.set(dedupKey, cloneObjNum);
    return { changed: true, cloneObjNum, skipped };
  } finally {
    state.inProgress.delete(formObjNum);
  }
}

/**
 * Per-page conversion primitive.
 * Rewrites a single content-stream text (merged from possibly multiple original /Contents refs)
 * replacing text-show operators inside the supplied bboxes with Form XObject calls.
 * Caller is responsible for encoding the returned text into a stream object and for merging
 * `xobjEntries` and `formClones` into the page's /Resources.
 *
 * @param {object} params
 * @param {string} params.streamText - Merged content stream text for the page.
 * @param {string} params.pageObjText - The original page object text (used for parsePageFonts).
 * @param {ReadonlyArray<ReadonlyArray<number>>} params.bboxes - Page-relative user-space bboxes.
 * @param {ReturnType<typeof createConversionState>} params.state
 * @param {import('../../pdf/objectCache.js').ObjectCache} params.objCache
 * @param {() => number} params.allocObjNum
 * @param {(obj: {objNum: number, content: any}) => void} params.pushObj
 * @param {boolean} params.humanReadable
 * @param {boolean} [params.convertBrokenType3ToPaths] - When true, convert every glyph drawn by a broken-ToUnicode Type3 font to paths.
 * @returns {Promise<{
 *   changed: boolean,
 *   text?: string,
 *   xobjEntries?: Map<string, number>,
 *   formClones?: Map<string, number>,
 *   skipped?: Array<{fontObjNum: number, charCode: number, reason: string}>,
 * }>}
 */
export async function convertSinglePageForRegions({
  streamText, pageObjText, bboxes, state, objCache, allocObjNum, pushObj, humanReadable,
  convertBrokenType3ToPaths = false,
}) {
  // Bbox-driven conversion needs at least one region.
  // Broken-Type3 conversion runs font-scoped with no regions, so it relaxes the empty-bbox early-out.
  if ((!bboxes || bboxes.length === 0) && !convertBrokenType3ToPaths) return { changed: false };
  const safeBboxes = bboxes || [];

  // Unembedded fonts convert via built-in substitute outlines (see the resolver).
  // If the built-ins cannot load (e.g. a bundler stripped the font assets),
  // substitution is silently unavailable and such runs keep the skip-tail behavior instead of failing the whole export.
  await loadBuiltInFontsRaw().catch(() => {});

  /** @type {Map<string, any>} */
  let pageFontInfos;
  try {
    pageFontInfos = parsePageFonts(pageObjText, objCache);
  } catch {
    return { changed: false };
  }
  if (!pageFontInfos) pageFontInfos = new Map();

  /** @type {Map<string, FontBinding>} */
  const fontsByTag = new Map();
  /** @type {Map<number, any>} */
  const fontInfoByObjNum = new Map();
  mergeContainerFonts(pageFontInfos, fontsByTag, fontInfoByObjNum);
  // Bring in the bundled symbol faces (Dingbats/StandardSymbolsPS) this page needs before building the synchronous resolver.
  // Form-introduced symbol fonts are covered by the matching preload in rewriteFormContentForRegions.
  await preloadSymbolSubstituteFonts(fontInfoByObjNum.values());

  // Broken-Type3 target set is shared (by reference) with the form recursion,
  // so glyphs drawn inside Form XObjects are covered as each form's fonts are merged.
  /** @type {Set<number> | null} */
  const targetFontObjNums = convertBrokenType3ToPaths ? new Set() : null;
  if (targetFontObjNums) collectBrokenType3FontObjNums(fontInfoByObjNum, targetFontObjNums);

  const resolver = buildResolver(fontInfoByObjNum, state);

  /** @type {Map<string, number>} */
  const pageXobjectsByName = new Map();
  for (const [name, info] of findFormXObjects(pageObjText, objCache)) {
    pageXobjectsByName.set(name, info.objNum);
  }

  // Page-level forms that omit their own /Resources inherit the page's, so pass it down.
  const pageResourcesText = resolveResourcesText(pageObjText, objCache);

  // Page is convertible only if it has either fonts (for direct text-show
  // conversion) or Form XObjects (for recursion into form-borne text).
  if (fontsByTag.size === 0 && pageXobjectsByName.size === 0) return { changed: false };

  const offOCGs = typeof objCache.getOffOCGs === 'function' ? objCache.getOffOCGs() : new Set();
  const smResult = rewritePageContentForRegions(streamText, fontsByTag, safeBboxes, resolver, {
    parentXobjects: pageXobjectsByName,
    targetFontObjNums,
    extGStates: parseExtGStates(pageResourcesText, objCache),
    hiddenOCMCNames: offOCGs.size > 0 ? parseHiddenOCMCNames(pageObjText, objCache, offOCGs) : null,
    humanReadable,
  });
  if (!smResult.ok) return { changed: false };

  /** @type {Map<string, number>} */
  const formClones = new Map();
  const skipped = smResult.skipped.slice();
  // One recursion per form name (first-ctm-wins),
  // but pen state baked into the shared clone's emitted `w` values is a rendering error if invocations disagree,
  // so disagreement degrades to unknown.
  const invByName = new Map();
  for (const inv of smResult.formInvocations) {
    const prev = invByName.get(inv.name);
    if (!prev) {
      invByName.set(inv.name, {
        formObjNum: inv.formObjNum, ctm: inv.ctm, lw: inv.lw, dashActive: inv.dashActive, ml: inv.ml, textState: inv.textState,
      });
    } else if (prev.lw !== inv.lw || prev.dashActive !== inv.dashActive || prev.ml !== inv.ml) {
      prev.lw = null;
      prev.ml = null;
    }
  }
  for (const [invName, inv] of invByName) {
    const r = await rewriteFormContentForRegions({
      formObjNum: inv.formObjNum,
      ctm: inv.ctm,
      parentFontsByTag: fontsByTag,
      fontInfoByObjNum,
      resolver,
      bboxes: safeBboxes,
      targetFontObjNums,
      state,
      objCache,
      allocObjNum,
      pushObj,
      humanReadable,
      parentResourcesText: pageResourcesText,
      initialLineWidth: inv.lw,
      initialDashActive: inv.dashActive,
      initialMiterLimit: inv.ml,
      initialTextState: inv.textState,
    });
    if (r.skipped && r.skipped.length > 0) skipped.push(...r.skipped);
    if (r.changed && r.cloneObjNum !== inv.formObjNum) {
      formClones.set(invName, r.cloneObjNum);
    }
  }

  if (!smResult.changed && formClones.size === 0) {
    return { changed: false, skipped };
  }

  // Glyphs are inlined into smResult.text, so no per-glyph Form XObjects are emitted and the page needs no added /XObject entries.
  /** @type {Map<string, number>} */
  const xobjEntries = new Map();

  return {
    changed: true,
    text: smResult.text,
    xobjEntries,
    formClones,
    skipped,
  };
}

/**
 * Convert text inside the listed regions on each page to glyph-outline Form XObjects, emitting a page-rewrite directive per affected page.
 *
 * @param {object} params
 * @param {Array<{ objNum: number, objText: string }>} params.pages
 * @param {ReadonlyArray<number>} params.pageIndices
 * @param {Map<number, ReadonlyArray<ReadonlyArray<number>>>} params.regionsByPage
 * @param {import('../../pdf/objectCache.js').ObjectCache} params.objCache
 * @param {() => number} params.allocObjNum
 * @param {(obj: {objNum: number, content: any}) => void} params.pushObj
 * @param {boolean} params.humanReadable
 */
export async function convertTextRegionsToPaths({
  pages, pageIndices, regionsByPage, objCache, allocObjNum, pushObj, humanReadable,
}) {
  const state = createConversionState();
  /** @type {Map<number, { newContentObjNum: number, xobjEntries: Map<string, number>, formClones: Map<string, number> }>} */
  const pageRewrites = new Map();
  /** @type {Array<{pageIndex: number, items: Array<{fontObjNum: number, charCode: number, reason: string}>}>} */
  const skippedReports = [];

  for (const i of pageIndices) {
    if (i >= pages.length) continue;
    const bboxes = regionsByPage.get(i);
    if (!bboxes || bboxes.length === 0) continue;
    const pageInfo = pages[i];

    const streams = getPageContentStreams(pageInfo.objText, objCache);
    if (!streams || streams.length === 0) continue;
    const merged = streams.join('\n');

    const result = await convertSinglePageForRegions({
      streamText: merged,
      pageObjText: pageInfo.objText,
      bboxes,
      state,
      objCache,
      allocObjNum,
      pushObj,
      humanReadable,
    });
    if (result.skipped && result.skipped.length > 0) {
      skippedReports.push({ pageIndex: i, items: result.skipped });
    }
    if (!result.changed) continue;

    const newContentObjNum = allocObjNum();
    const newContent = await encodeStreamObject(newContentObjNum, result.text, { humanReadable });
    pushObj({ objNum: newContentObjNum, content: newContent });

    pageRewrites.set(pageInfo.objNum, {
      newContentObjNum,
      xobjEntries: result.xobjEntries || new Map(),
      formClones: result.formClones || new Map(),
    });
  }

  return { pageRewrites, skippedReports };
}
