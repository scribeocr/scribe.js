import {
  getPageContentStreams, findFormXObjects,
} from '../../pdf/parsePdfUtils.js';
import {
  bytesToLatin1, extractDict,
  resolveNumArray, parseDictEntries, matMul, decodeTextCodes,
} from '../../pdf/pdfPrimitives.js';
import {
  tokenizeContentStream, formatPdfNumber,
} from '../../pdf/contentStream.js';
import { parsePageFonts } from '../../pdf/fonts/parsePdfFonts.js';
import { encodeStreamObject } from './writePdfStreams.js';
import opentype from '../../font-parser/src/index.js';
import { standardNames } from '../../font-parser/src/encoding.js';
import { parseCFFSummary } from '../../font-parser/src/cff.js';

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
 *            cmap?: { glyphIndexMap: Record<number, number>, byteToGlyphIndex?: number[], platformID?: number, encodingID?: number } | null,
 *            nameToGid?: Map<string, number> | null,
 *            cffCharCodeToGid?: Map<number, number> | null,
 *            cffCidToGid?: Map<number, number> | null } | null}
 */
function loadGlyphsForOutlines(fontFile) {
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
      const ttUpem = head.unitsPerEm > 0 ? head.unitsPerEm : 1000;
      return {
        glyphs: shell.glyphs,
        unitsPerEm: ttUpem,
        fontMatrix: [1 / ttUpem, 0, 0, 1 / ttUpem, 0, 0],
        fontType: 'truetype',
        cmap,
        nameToGid,
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
 * Build a Form XObject for a single (font, glyphIndex) pair.
 * The /Matrix maps the glyph commands' coordinate space to text-space ems,
 * so the caller's `cm` is `Tm x [fontSize 0 0 fontSize 0 0]`.
 *
 * @param {number} xobjObjNum
 * @param {Array<any>} pathCommands
 * @param {number[]} formMatrix - six-number affine matrix
 * @param {{xMin: number, yMin: number, xMax: number, yMax: number}} bbox
 * @param {boolean} humanReadable
 * @param {{paintMode?: string, evenOdd?: boolean, lineWidth?: number, dashArray?: number[], dashPhase?: number}} [paintOpts]
 */
async function buildGlyphFormXObject(xobjObjNum, pathCommands, formMatrix, bbox, humanReadable, paintOpts) {
  const paintMode = paintOpts?.paintMode || 'fill';
  const evenOdd = !!paintOpts?.evenOdd;
  const lineWidth = typeof paintOpts?.lineWidth === 'number' ? paintOpts.lineWidth : 1;
  const dashArray = Array.isArray(paintOpts?.dashArray) ? paintOpts.dashArray : [];
  const dashPhase = typeof paintOpts?.dashPhase === 'number' ? paintOpts.dashPhase : 0;
  let paintOp;
  if (paintMode === 'stroke') paintOp = 'S';
  else if (paintMode === 'fillStroke') paintOp = evenOdd ? 'B*' : 'B';
  else paintOp = evenOdd ? 'f*' : 'f';
  const needsStrokeState = paintMode === 'stroke' || paintMode === 'fillStroke';
  let prelude = '';
  if (needsStrokeState) {
    prelude += `${fmt(lineWidth)} w\n`;
    if (dashArray.length > 0) {
      prelude += `[${dashArray.map((n) => fmt(n)).join(' ')}] ${fmt(dashPhase)} d\n`;
    }
  }
  const body = `${prelude}${pathCommandsToOps(pathCommands)}${paintOp}\n`;
  const fmHigh = (n) => {
    if (!Number.isFinite(n)) return '0';
    if (Number.isInteger(n)) return String(n);
    return n.toFixed(8).replace(/0+$/, '').replace(/\.$/, '');
  };
  const m = formMatrix && formMatrix.length === 6 ? formMatrix : [0.001, 0, 0, 0.001, 0, 0];
  // Without explicit /Resources, forms inherit from the parent per PDF spec §7.8.3.
  // Our renderer materializes that inheritance on every Do call.
  // With thousands of glyph-form invocations that costs O(callers × parent-xobjects).
  // These forms reference nothing, so emit empty /Resources.
  const dictExtras = '/Subtype/Form'
    + `/BBox[${fmt(bbox.xMin)} ${fmt(bbox.yMin)} ${fmt(bbox.xMax)} ${fmt(bbox.yMax)}]`
    + `/Matrix[${fmHigh(m[0])} ${fmHigh(m[1])} ${fmHigh(m[2])} ${fmHigh(m[3])} ${fmHigh(m[4])} ${fmHigh(m[5])}]`
    + '/Resources<<>>';
  return encodeStreamObject(xobjObjNum, body, { humanReadable, dictExtras });
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
 * Rewrite a page content stream replacing per-glyph text-show operations
 * inside the supplied bboxes with `q cm /XObj Do Q` calls.
 *
 * @param {string} streamText
 * @param {Map<string, FontBinding>} fontsByTag
 * @param {ReadonlyArray<ReadonlyArray<number>>} bboxes - Page-relative user-space bboxes [x0,y0,x1,y1]
 * @param {GlyphResolver} resolver
 * @param {{ initialCtm?: number[], parentXobjects?: Map<string, number> | null }} [opts]
 *   - `initialCtm`: starting CTM (defaults to identity). Used when recursing into
 *     a Form XObject so the form's content is hit-tested in page user space.
 *   - `parentXobjects`: in-scope Form XObject names → objNum, used to identify Do
 *     calls that target a Form XObject for recursive conversion. Records appear
 *     in `formInvocations` on the return value.
 * @returns {{ ok: true, text: string, changed: boolean,
 *   usedXobj: Map<string, {fontObjNum: number, glyphIndex: number,
 *     bbox: {xMin: number, yMin: number, xMax: number, yMax: number},
 *     formMatrix: number[], pathCommands: Array<any>,
 *     paintMode: string, evenOdd: boolean, lineWidth: number, dashArray: number[], dashPhase: number}>,
 *   skipped: Array<{fontObjNum: number, charCode: number, reason: string}>,
 *   formInvocations: Array<{name: string, formObjNum: number, ctm: number[]}> }
 *   | { ok: false, reason: string }}
 *
 * @typedef {{ fontObjNum: number, widths: Map<number, number>, defaultWidth: number,
 *   verticalMode: boolean, codespaceRanges: ReadonlyArray<{bytes: number, low: number, high: number}> | null,
 *   charCodeToCID: Map<number, number> | null, isType0: boolean }} FontBinding
 *
 * @typedef {(arg: { fontObjNum: number, charCode: number }) => { glyphIndex: number, formMatrix: number[],
 *   pathCommands: Array<any>, bbox: {xMin: number, yMin: number, xMax: number, yMax: number} } | { error: string }} GlyphResolver
 */
export function rewritePageContentForRegions(streamText, fontsByTag, bboxes, resolver, opts = {}) {
  const initialCtm = opts.initialCtm || [1, 0, 0, 1, 0, 0];
  const parentXobjects = opts.parentXobjects || null;
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
  let tm = [1, 0, 0, 1, 0, 0];
  let tlm = [1, 0, 0, 1, 0, 0];
  let tc = 0;
  let tw = 0;
  let tz = 100;
  let tl = 0;
  let tr = 0;
  let ts = 0;
  let currentFontTag = null;
  let currentFontSize = 0;
  let ctm = initialCtm.slice();

  /** @type {Array<{tc: number, tw: number, tz: number, tl: number, tr: number, ts: number, fontTag: string|null, fontSize: number, ctm: number[]}>} */
  const gsStack = [];

  /**
   * Form XObject Do calls deferred to the next ET or graphics-state op.
   * Each entry carries the cm captured at its original text-show.
   * Emitted as q cm /XObj Do Q outside BT.
   * Glyphs are non-overlapping, so the z-order shift vs interleaved text-show is acceptable.
   * @type {Array<{xobjTag: string, M: number[]}>}
   */
  let pendingConverts = [];

  /**
   * @type {Map<string, {fontObjNum: number, glyphIndex: number,
   *   bbox: {xMin: number, yMin: number, xMax: number, yMax: number}, formMatrix: number[],
   *   pathCommands: Array<any>, paintMode: string, evenOdd: boolean, lineWidth: number,
   *   dashArray: number[], dashPhase: number}>}
   */
  const usedXobj = new Map();
  /** @type {Array<{fontObjNum: number, charCode: number, reason: string}>} */
  const skipped = [];
  /** @type {Array<{name: string, formObjNum: number, ctm: number[]}>} */
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

  /** @type {number[]|null} CTM at the last flushed convert; used for delta-cm */
  let lastConvertM = null;

  /** @param {number[]} M */
  function emitConvertCm(M) {
    if (!lastConvertM) {
      out.push(`${fmt(M[0], PDF_MATRIX_DECIMALS)} ${fmt(M[1], PDF_MATRIX_DECIMALS)} ${fmt(M[2], PDF_MATRIX_DECIMALS)} ${fmt(M[3], PDF_MATRIX_DECIMALS)} ${fmt(M[4], PDF_MATRIX_DECIMALS)} ${fmt(M[5], PDF_MATRIX_DECIMALS)} cm `);
      return;
    }
    const [a, b, c, d, e, f] = lastConvertM;
    const det = a * d - b * c;
    if (!det || !Number.isFinite(det)) {
      out.push(`${fmt(M[0], PDF_MATRIX_DECIMALS)} ${fmt(M[1], PDF_MATRIX_DECIMALS)} ${fmt(M[2], PDF_MATRIX_DECIMALS)} ${fmt(M[3], PDF_MATRIX_DECIMALS)} ${fmt(M[4], PDF_MATRIX_DECIMALS)} ${fmt(M[5], PDF_MATRIX_DECIMALS)} cm `);
      return;
    }
    const ia = d / det;
    const ib = -b / det;
    const ic = -c / det;
    const id = a / det;
    const ie = (c * f - d * e) / det;
    const jf = (b * e - a * f) / det;
    /** @param {number} x */
    const snap = (x) => {
      if (Math.abs(x) < 1e-9) return 0;
      if (Math.abs(x - 1) < 1e-9) return 1;
      if (Math.abs(x + 1) < 1e-9) return -1;
      return x;
    };
    const m0 = snap(M[0] * ia + M[1] * ic);
    const m1 = snap(M[0] * ib + M[1] * id);
    const m2 = snap(M[2] * ia + M[3] * ic);
    const m3 = snap(M[2] * ib + M[3] * id);
    const m4 = M[4] * ia + M[5] * ic + ie;
    const m5 = M[4] * ib + M[5] * id + jf;
    out.push(`${fmt(m0, PDF_MATRIX_DECIMALS)} ${fmt(m1, PDF_MATRIX_DECIMALS)} ${fmt(m2, PDF_MATRIX_DECIMALS)} ${fmt(m3, PDF_MATRIX_DECIMALS)} ${fmt(m4, PDF_MATRIX_DECIMALS)} ${fmt(m5, PDF_MATRIX_DECIMALS)} cm `);
  }

  /**
   * Emit pending converted glyphs as a single `q ... Q` block of cm/Do pairs.
   * Called at ET (so we are outside BT) or before any graphics-state change.
   * Re-establishes the q/Q boundary each call so subsequent text rendering
   * inside a later BT is unaffected.
   */
  function flushPendingConverts() {
    if (pendingConverts.length === 0) return;
    out.push('q\n');
    lastConvertM = null;
    for (const c of pendingConverts) {
      emitConvertCm(c.M);
      out.push(`/${c.xobjTag} Do\n`);
      lastConvertM = c.M;
    }
    out.push('Q\n');
    pendingConverts = [];
    lastConvertM = null;
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
   * Numeric TJ spacer that displaces tm by the same amount a glyph of the given
   * code would. tlm is unaffected, so subsequent Td/Tm computations match the
   * unconverted original. Derivation: equate glyph advance
   * `(W/1000 * fontSize + tc + tw_if_space) * tz/100`  with TJ spacer advance
   * `-s/1000 * fontSize * tz/100`. The tz factor cancels.
   * @param {FontBinding} binding
   * @param {number} code
   * @param {number} numBytes
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

    if (op === 'q') {
      flushPendingConverts();
      gsStack.push({
        tc, tw, tz, tl, tr, ts, fontTag: currentFontTag, fontSize: currentFontSize, ctm: ctm.slice(),
      });
      emitVerbatim(op);
      continue;
    }
    if (op === 'Q') {
      flushPendingConverts();
      const s = gsStack.pop();
      if (s) {
        tc = s.tc; tw = s.tw; tz = s.tz; tl = s.tl; tr = s.tr; ts = s.ts;
        currentFontTag = s.fontTag; currentFontSize = s.fontSize;
        ctm = s.ctm;
      }
      emitVerbatim(op);
      continue;
    }
    if (op === 'cm') {
      flushPendingConverts();
      if (operandBuf.length >= 6) {
        const m = operandBuf.slice(operandBuf.length - 6).map((t) => t.value);
        ctm = matMul(m, ctm);
      }
      emitVerbatim(op);
      continue;
    }

    if (op === 'BT') {
      inBT = true;
      tm = [1, 0, 0, 1, 0, 0];
      tlm = [1, 0, 0, 1, 0, 0];
      emitVerbatim(op);
      continue;
    }
    if (op === 'ET') {
      inBT = false;
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
            formInvocations.push({ name: nameTok.value, formObjNum, ctm: ctm.slice() });
          }
        }
      }
      emitVerbatim(op);
      continue;
    }

    const isTextShow = op === 'Tj' || op === 'TJ' || op === "'" || op === '"';
    if (!isTextShow) {
      emitVerbatim(op);
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
    // Only Tr=0 (fill) is safe to convert: glyph forms always paint with `f`.
    // Tr=1 (stroke), Tr=2 (fill+stroke), Tr=3 (invisible), Tr>=4 (clipping)
    // would render incorrectly if replaced with a filled path. Leave verbatim.
    if (!binding || !operand || tr !== 0) {
      // Verbatim text still advances the text matrix. Replay its advance onto tm
      // so a later converted run in the same BT lands after the kept text instead of overlapping it.
      if (binding && operand) {
        const vcs = binding.codespaceRanges || (binding.isType0 ? [{ bytes: 2, low: 0, high: 0xFFFF }] : null);
        for (const elem of flattenTextOperandTyped(operand, op === '"' ? 'Tj' : op, vcs)) {
          if (elem.type === 'spacer') applySpacerToMatrix(tm, binding, elem.value);
          else advanceMatrixForGlyph(tm, binding, elem.value, elem.numBytes);
        }
      }
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
    // Snapshot tm before iterating glyphs.
    // The ET/BT bounce we may emit below restores tlm with `Tm tlm`,
    // but BT clears the position tm carried from earlier text-show ops in the same BT block
    // (e.g. a literal-text Tj before a converted CID Tj).
    // Recover that by prepending a TJ spacer for the tlm -> tmStart user-space delta.
    const tmStart = tm.slice();

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
      if (inBbox) {
        const res = resolver({ fontObjNum: binding.fontObjNum, charCode: code });
        if ('error' in res) {
          if (res.error === 'empty-path') {
            // Invisible glyph (word space etc): emit a numeric spacer that
            // matches its advance. Drops the residual selectable-whitespace
            // a viewer would otherwise extract from this TJ.
            didConvert = true;
            outputElems.push({ kind: 'spacer', value: spacerForGlyphMimic(binding, code, numBytes) });
            anyConvert = true;
          } else {
            skipped.push({ fontObjNum: binding.fontObjNum, charCode: code, reason: res.error });
          }
        } else {
          didConvert = true;
          const xobjTag = `TGP${binding.fontObjNum}g${res.glyphIndex}`;
          if (!usedXobj.has(xobjTag)) {
            usedXobj.set(xobjTag, {
              fontObjNum: binding.fontObjNum,
              glyphIndex: res.glyphIndex,
              bbox: res.bbox,
              formMatrix: res.formMatrix,
              pathCommands: res.pathCommands,
              paintMode: res.paintMode || 'fill',
              evenOdd: !!res.evenOdd,
              lineWidth: typeof res.lineWidth === 'number' ? res.lineWidth : 1,
              dashArray: Array.isArray(res.dashArray) ? res.dashArray : [],
              dashPhase: typeof res.dashPhase === 'number' ? res.dashPhase : 0,
            });
          }
          const M = matMul(trmPrefix, tm);
          pendingConverts.push({ xobjTag, M });
          outputElems.push({ kind: 'spacer', value: spacerForGlyphMimic(binding, code, numBytes) });
          anyConvert = true;
        }
      }

      if (!didConvert) {
        outputElems.push({ kind: 'glyph', code, numBytes });
      }
      advanceMatrixForGlyph(tm, binding, code, numBytes);
    }

    if (!anyConvert) {
      emitVerbatim(op);
      continue;
    }
    changed = true;

    // BT clears text state, so re-emit Tm to restore tlm after the ET/BT bounce.
    // " sets Tw/Tc implicitly, so re-emit those when the original op was ".
    // TJ rather than Tj lets us interleave numeric spacers between kept glyphs.
    out.push('ET\n');
    inBT = false;
    flushPendingConverts();

    out.push('BT\n');
    inBT = true;
    if (op === '"' && aw !== null && ac !== null) {
      out.push(`${fmt(aw)} Tw\n`);
      out.push(`${fmt(ac)} Tc\n`);
    }
    out.push(`${fmt(tlm[0])} ${fmt(tlm[1])} ${fmt(tlm[2])} ${fmt(tlm[3])} ${fmt(tlm[4])} ${fmt(tlm[5])} Tm\n`);

    const deltaUx = tmStart[4] - tlm[4];
    const deltaUy = tmStart[5] - tlm[5];
    if (Math.abs(deltaUx) > 1e-6 || Math.abs(deltaUy) > 1e-6) {
      const det = tlm[0] * tlm[3] - tlm[1] * tlm[2];
      const fontScale = currentFontSize * tz / 100;
      if (Math.abs(det) > 1e-9 && fontScale > 0) {
        const textDx = (deltaUx * tlm[3] - deltaUy * tlm[2]) / det;
        const textDy = (-deltaUx * tlm[1] + deltaUy * tlm[0]) / det;
        const leadAxis = binding.verticalMode ? textDy : textDx;
        const offAxis = binding.verticalMode ? textDx : textDy;
        if (Math.abs(offAxis) < 1e-6 && Math.abs(leadAxis) > 1e-6) {
          const spacer = -leadAxis * 1000 / fontScale;
          outputElems.unshift({ kind: 'spacer', value: spacer });
        }
      }
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
function charCodeToGlyphIndex(fontInfo, charCode, loaded) {
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
 * @property {Map<string, number>} formXobjByKey
 *   Per-glyph Form XObject dedup, keyed by `TGP{font}g{gid}`.
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
    formXobjByKey: new Map(),
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
        return { error: 'type3-no-commands' };
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
      state.fontGlyphsCache.set(fontObjNum, loaded);
    }
    if (!loaded) return { error: 'font-not-embedded-or-unsupported' };
    const glyphIndex = charCodeToGlyphIndex(fi, charCode, loaded);
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
    return {
      glyphIndex,
      formMatrix,
      pathCommands: commands,
      bbox: bboxFromCommands(commands),
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
    });
    if (!fontInfoByObjNum.has(fi.fontObjNum)) fontInfoByObjNum.set(fi.fontObjNum, fi);
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
 * @param {ReturnType<typeof createConversionState>} params.state
 * @param {import('../../pdf/objectCache.js').ObjectCache} params.objCache
 * @param {() => number} params.allocObjNum
 * @param {(obj: {objNum: number, content: any}) => void} params.pushObj
 * @param {boolean} params.humanReadable
 * @param {string | null} [params.parentResourcesText] - The enclosing scope's /Resources dict text,
 *   which this form inherits when it has none of its own.
 * @returns {Promise<{ changed: boolean, cloneObjNum: number,
 *   skipped: Array<{fontObjNum: number, charCode: number, reason: string}> }>}
 */
async function rewriteFormContentForRegions({
  formObjNum, ctm, parentFontsByTag, fontInfoByObjNum, resolver,
  bboxes, state, objCache, allocObjNum, pushObj, humanReadable, parentResourcesText = null,
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
    }

    const formXobjectsByName = new Map();
    for (const [name, info] of findFormXObjects(formObjText, objCache)) {
      formXobjectsByName.set(name, info.objNum);
    }

    const smResult = rewritePageContentForRegions(streamText, fontsByTag, bboxes, resolver, {
      initialCtm: effectiveCtm,
      parentXobjects: formXobjectsByName,
    });
    if (!smResult.ok) {
      return { changed: false, cloneObjNum: formObjNum, skipped: [] };
    }

    /** @type {Map<string, number>} */
    const nestedFormClones = new Map();
    const seenInvocations = new Set();
    const skipped = smResult.skipped.slice();
    for (const inv of smResult.formInvocations) {
      if (seenInvocations.has(inv.name)) continue;
      seenInvocations.add(inv.name);
      const r = await rewriteFormContentForRegions({
        formObjNum: inv.formObjNum,
        ctm: inv.ctm,
        parentFontsByTag: fontsByTag,
        fontInfoByObjNum,
        resolver,
        bboxes,
        state,
        objCache,
        allocObjNum,
        pushObj,
        humanReadable,
        parentResourcesText: effectiveResources,
      });
      if (r.skipped && r.skipped.length > 0) skipped.push(...r.skipped);
      if (r.changed && r.cloneObjNum !== inv.formObjNum) {
        nestedFormClones.set(inv.name, r.cloneObjNum);
      }
    }

    if (!smResult.changed && nestedFormClones.size === 0) {
      return { changed: false, cloneObjNum: formObjNum, skipped };
    }

    /** @type {Map<string, number>} */
    const perGlyphEntries = new Map();
    for (const [xobjTag, info] of smResult.usedXobj) {
      let on = state.formXobjByKey.get(xobjTag);
      if (on == null) {
        on = allocObjNum();
        const content = await buildGlyphFormXObject(
          on, info.pathCommands, info.formMatrix, info.bbox, humanReadable,
          {
            paintMode: info.paintMode,
            evenOdd: info.evenOdd,
            lineWidth: info.lineWidth,
            dashArray: info.dashArray,
            dashPhase: info.dashPhase,
          },
        );
        pushObj({ objNum: on, content });
        state.formXobjByKey.set(xobjTag, on);
      }
      perGlyphEntries.set(xobjTag, on);
    }

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
}) {
  if (!bboxes || bboxes.length === 0) return { changed: false };

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

  const smResult = rewritePageContentForRegions(streamText, fontsByTag, bboxes, resolver, {
    parentXobjects: pageXobjectsByName,
  });
  if (!smResult.ok) return { changed: false };

  /** @type {Map<string, number>} */
  const formClones = new Map();
  const seenInvocations = new Set();
  const skipped = smResult.skipped.slice();
  for (const inv of smResult.formInvocations) {
    if (seenInvocations.has(inv.name)) continue;
    seenInvocations.add(inv.name);
    const r = await rewriteFormContentForRegions({
      formObjNum: inv.formObjNum,
      ctm: inv.ctm,
      parentFontsByTag: fontsByTag,
      fontInfoByObjNum,
      resolver,
      bboxes,
      state,
      objCache,
      allocObjNum,
      pushObj,
      humanReadable,
      parentResourcesText: pageResourcesText,
    });
    if (r.skipped && r.skipped.length > 0) skipped.push(...r.skipped);
    if (r.changed && r.cloneObjNum !== inv.formObjNum) {
      formClones.set(inv.name, r.cloneObjNum);
    }
  }

  if (!smResult.changed && formClones.size === 0) {
    return { changed: false, skipped };
  }

  /** @type {Map<string, number>} */
  const xobjEntries = new Map();
  for (const [xobjTag, info] of smResult.usedXobj) {
    let objNum = state.formXobjByKey.get(xobjTag);
    if (objNum == null) {
      objNum = allocObjNum();
      const content = await buildGlyphFormXObject(
        objNum, info.pathCommands, info.formMatrix, info.bbox, humanReadable,
        {
          paintMode: info.paintMode,
          evenOdd: info.evenOdd,
          lineWidth: info.lineWidth,
          dashArray: info.dashArray,
          dashPhase: info.dashPhase,
        },
      );
      pushObj({ objNum, content });
      state.formXobjByKey.set(xobjTag, objNum);
    }
    xobjEntries.set(xobjTag, objNum);
  }

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
