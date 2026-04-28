import ocr from '../../objects/ocrObjects.js';
import opentype from '../../font-parser/src/index.js';
import {
  extractDict, ObjectCache, findXrefOffset, parseXref,
  resolveIntValue, resolveNumValue, resolveArrayValue,
} from '../parsePdfUtils.js';
import {
  win1252Chars, macRomanChars, aglLookup, wingdingsToUnicode, symbolToUnicode, dingbatsGlyphMap, dingbatsEncoding,
} from './standardEncodings.js';
import { applyStandardFontWidths, getDingbatsGlyphWidth } from './standardFontMetrics.js';
import { parseCFFCharset } from './convertFontToOTF.js';
import { getCIDToUnicodeMap } from './cidToUnicode.js';

/**
 * Parse a TrueType font file's cmap table and build a reverse GID→Unicode map.
 * Used for CIDFontType2 + Identity-H where CIDs are GIDs and we need GID→Unicode.
 * @param {Uint8Array} fontFile
 */
function buildGidToUnicodeFromTrueType(fontFile) {
  try {
    const data = new DataView(fontFile.buffer, fontFile.byteOffset, fontFile.byteLength);
    const sfVersion = data.getUint32(0);
    if (sfVersion !== 0x00010000 && sfVersion !== 0x74727565) return null;
    const numTables = data.getUint16(4);
    let cmapOffset = -1;
    for (let i = 0; i < numTables; i++) {
      const off = 12 + i * 16;
      const tag = String.fromCharCode(fontFile[off], fontFile[off + 1], fontFile[off + 2], fontFile[off + 3]);
      if (tag === 'cmap') {
        cmapOffset = data.getUint32(off + 8);
        break;
      }
    }
    if (cmapOffset === -1) return null;
    const cmap = opentype.parseCmapTable(data, cmapOffset);
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

  const result = {};
  for (const [objNum, entry] of Object.entries(xrefEntries)) {
    const objText = objCache.getObjectText(Number(objNum));
    if (!objText) continue;
    if (!objText.includes('/Subtype') || !objText.includes('/Type3')) continue;
    // Verify it's actually /Subtype /Type3 (not just containing those strings separately)
    if (!/\/Subtype\s*\/Type3/.test(objText)) continue;

    const fontInfo = parseType3Font(objText, objCache);
    if (fontInfo) {
      result[Number(objNum)] = fontInfo;
    }
  }

  return result;
}

/**
 * Parse a Type3 font object and extract glyph bounding boxes.
 * @param {string} objText
 * @param {ObjectCache} objCache
 */
function parseType3Font(objText, objCache) {
  const fmStr = resolveArrayValue(objText, 'FontMatrix', objCache);
  const fontMatrix = fmStr ? fmStr.split(/\s+/).map(Number) : [0.001, 0, 0, 0.001, 0, 0];

  const fbStr = resolveArrayValue(objText, 'FontBBox', objCache);
  const fontBBox = fbStr ? fbStr.split(/\s+/).map(Number) : [0, 0, 0, 0];

  const nameMatch = /\/Name\s*\/([^\s/]+)/.exec(objText);
  const name = nameMatch ? nameMatch[1] : null;

  const encoding = {};
  // The Encoding might be inline or a reference
  const encRefMatch = /\/Encoding\s+(\d+)\s+\d+\s+R/.exec(objText);
  let encText = objText;
  if (encRefMatch) {
    const encObj = objCache.getObjectText(Number(encRefMatch[1]));
    if (encObj) encText = encObj;
  }
  const diffStr = resolveArrayValue(encText, 'Differences', objCache);
  if (diffStr) {
    const diffContent = diffStr;
    // Tokenize: numbers and /names may be separated by whitespace or packed together (e.g. "0/0 2/1/2/3")
    // Match either integers or /name tokens
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

  // Extract CharProcs (may be inline dict or indirect reference)
  const charProcsStart = objText.indexOf('/CharProcs');
  if (charProcsStart === -1) return null;

  let charProcsDict;
  const charProcsAfter = objText.substring(charProcsStart + 10).trim();
  if (charProcsAfter.startsWith('<<')) {
    // Inline dictionary
    charProcsDict = extractDict(objText, charProcsStart + 10 + (objText.substring(charProcsStart + 10).indexOf('<<')));
  } else {
    // Indirect reference: /CharProcs N 0 R
    const cpRefMatch = /^(\d+)\s+\d+\s+R/.exec(charProcsAfter);
    if (!cpRefMatch) return null;
    const cpObjText = objCache.getObjectText(Number(cpRefMatch[1]));
    if (!cpObjText) return null;
    charProcsDict = cpObjText;
  }

  // Parse CharProcs entries: /glyphName N 0 R
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
      glyphs[glyphName] = { bbox: null, advanceWidth: 0 };
      continue;
    }

    const streamText = new TextDecoder('latin1').decode(streamBytes);
    glyphs[glyphName] = parseGlyphStream(streamText);
  }

  // Used for Type3 glyphs that paint via Do.
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
  // Parse d1 operator for advance width: wx wy llx lly urx ury d1
  let advanceWidth = 0;
  const d1Match = /([\d.-]+)\s+([\d.-]+)\s+([\d.-]+)\s+([\d.-]+)\s+([\d.-]+)\s+([\d.-]+)\s+d1/.exec(streamText);
  if (d1Match) {
    advanceWidth = Number(d1Match[1]);
  }

  // Parse cm translation: q 1 0 0 1 tx ty cm
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

  // Split into tokens (numbers and operators)
  const tokens = drawingPart.match(/[+-]?(?:\d+\.?\d*|\.\d+)|[a-zA-Z]+/g);
  if (!tokens) return { bbox: null, advanceWidth };

  const numStack = [];
  for (const tok of tokens) {
    const num = Number(tok);
    if (!Number.isNaN(num) && /^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(tok)) {
      numStack.push(num);
    } else {
      // It's an operator
      switch (tok) {
        case 'm': // moveto: x y m
          if (numStack.length >= 2) {
            const y = numStack.pop();
            const x = numStack.pop();
            points.push(x + tx, y + ty);
          }
          numStack.length = 0;
          break;
        case 'l': // lineto: x y l
          if (numStack.length >= 2) {
            const y = numStack.pop();
            const x = numStack.pop();
            points.push(x + tx, y + ty);
          }
          numStack.length = 0;
          break;
        case 'c': // curveto: x1 y1 x2 y2 x3 y3 c
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
        case 're': // rectangle: x y w h re
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
          // Other operators (f, Q, i, q, etc.) - clear the stack
          numStack.length = 0;
          break;
      }
    }
  }

  if (points.length === 0) {
    // No vector path commands found — the glyph may use inline images (BI/ID/EI)
    // or other non-path drawing. Use the d1 bbox if it specifies a non-zero area.
    if (d1Match) {
      const llx = Number(d1Match[3]);
      const lly = Number(d1Match[4]);
      const urx = Number(d1Match[5]);
      const ury = Number(d1Match[6]);
      // Type3 producers often emit a placeholder d1 bbox [-10 -10 10 10] for
      // space/empty glyphs. Treat it as non-drawing so downstream code maps the
      // glyph as whitespace instead of a visible placeholder.
      if (Math.abs(llx + 10) < 1e-6 && Math.abs(lly + 10) < 1e-6
        && Math.abs(urx - 10) < 1e-6 && Math.abs(ury - 10) < 1e-6) {
        return { bbox: null, advanceWidth };
      }
      if (urx > llx || ury > lly) {
        return {
          bbox: {
            x0: llx, y0: lly, x1: urx, y1: ury,
          },
          advanceWidth,
        };
      }
    }
    return { bbox: null, advanceWidth };
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
  };
}

/**
 * Parse fonts from a page's Resources dictionary.
 * @param {string} pageObjText
 * @param {ObjectCache} objCache
 */
export function parsePageFonts(pageObjText, objCache) {
  const fonts = new Map();

  // Find Resources — may be inline or indirect reference
  let resourcesText = pageObjText;
  const resRefMatch = /\/Resources\s+(\d+)\s+\d+\s+R/.exec(pageObjText);
  if (resRefMatch) {
    const resObj = objCache.getObjectText(Number(resRefMatch[1]));
    if (resObj) resourcesText = resObj;
  }

  // Find Font dictionary within Resources
  const fontDictStart = resourcesText.indexOf('/Font');
  if (fontDictStart === -1) return fonts;

  let fontDictText;
  const afterFont = resourcesText.substring(fontDictStart + 5).trim();
  if (afterFont.startsWith('<<')) {
    fontDictText = extractDict(resourcesText, fontDictStart + 5 + resourcesText.substring(fontDictStart + 5).indexOf('<<'));
  } else {
    const fontRefMatch = /^(\d+)\s+\d+\s+R/.exec(afterFont);
    if (fontRefMatch) {
      const fObj = objCache.getObjectText(Number(fontRefMatch[1]));
      if (fObj) fontDictText = fObj;
    }
  }
  if (!fontDictText) return fonts;

  // Extract each font entry — indirect references (/F7 N 0 R) and inline dicts (/F7 << ... >>)
  const fontEntryPairs = []; // [fontTag, fontObjText, fontObjNum|null]
  const fontEntryRegex = /\/([^\s/]+)\s+(\d+)\s+\d+\s+R/g;
  for (const match of fontDictText.matchAll(fontEntryRegex)) {
    const fontObjNum = Number(match[2]);
    const fontObjText = objCache.getObjectText(fontObjNum);
    if (fontObjText) fontEntryPairs.push([match[1], fontObjText, fontObjNum]);
  }
  // Inline font dicts: scan fontDictText at top level (depth 1) for /name << ... >>
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
          const tag = nameMatch[1];
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
  for (const [fontTag, fontObj, fontObjNum] of fontEntryPairs) {
    // Cache hit: reuse the previously-parsed FontInfo for this font object.
    // See ObjectCache.fontCache — shared across all containers in the document
    // so that documents referencing the same font from many Form XObjects
    // pay the parse cost only once.
    if (fontObjNum !== null) {
      const cachedFont = objCache.fontCache.get(fontObjNum);
      if (cachedFont !== undefined) {
        fonts.set(fontTag, cachedFont);
        continue;
      }
    }
    // Extract base font name (strip subset prefix like AAAAAA+)
    // Type3 fonts may use /Name instead of /BaseFont
    // /BaseFont can be a name (/ArialMT) or a hex string (<feff0041...> = UTF-16BE)
    const baseNameMatch = /\/BaseFont\s*\/([^\s/<>[\]]+)/.exec(fontObj);
    const baseNameHexMatch = !baseNameMatch && /\/BaseFont\s*<([0-9A-Fa-f]+)>/.exec(fontObj);
    const nameMatch = /\/Name\s*\/([^\s/<>[\]]+)/.exec(fontObj);
    let baseNameRaw;
    if (baseNameMatch) {
      baseNameRaw = baseNameMatch[1].replace(/^[A-Z]{6}\+/, '');
    } else if (baseNameHexMatch) {
      const hex = baseNameHexMatch[1];
      const bytes = [];
      for (let hi = 0; hi < hex.length; hi += 2) bytes.push(parseInt(hex.substring(hi, hi + 2), 16));
      // Check for UTF-16BE BOM (feff)
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
    // Decode PDF hex-encoded name characters (#XX → char)
    const baseName = baseNameRaw.replace(/#([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));

    // Detect bold/italic/smallCaps from name (augmented by font descriptor below)
    let bold = /Bold|Black/i.test(baseName);
    let italic = /italic/i.test(baseName) || /-\w*ital/i.test(baseName) || /-it$/i.test(baseName) || /oblique/i.test(baseName);
    const smallCaps = /(small\W?cap)|(sc(?=-|$))|(caps(?=-|$))/i.test(baseName);
    const familyName = baseName.replace(/-.+/, '').replace(/,.*/, '');
    // Serif flag from font descriptor /Flags bit 2 (PDF spec §9.8.2).
    // Used as last-resort fallback when CSS font name matching fails.
    let serifFlag = false;

    // Parse ToUnicode CMap — can be an indirect reference (N 0 R) or a name (/Identity-H)
    const toUnicode = new Map();
    let toUnicodeIsIdentity = false;
    const touRefMatch = /\/ToUnicode\s+(\d+)\s+\d+\s+R/.exec(fontObj);
    const touNameMatch = !touRefMatch && /\/ToUnicode\s*\/Identity-H/.exec(fontObj);
    if (touRefMatch) {
      const cmapBytes = objCache.getStreamBytes(Number(touRefMatch[1]));
      if (cmapBytes) {
        const cmapText = new TextDecoder('latin1').decode(cmapBytes);
        parseToUnicodeCMap(cmapText, toUnicode);
      }
    } else if (touNameMatch) {
      // /ToUnicode /Identity-H means charCodes are Unicode codepoints directly.
      toUnicodeIsIdentity = true;
    }

    // Parse encoding CMap for Type0 fonts with custom CMap encoding (not Identity-H).
    // The encoding CMap maps charCodes → CIDs; needed for width lookups and glyph rendering.
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

    // Track whether the font uses an Adobe predefined CJK CMap (GB-EUC-H, GBK-EUC-H,
    // 90pv-RKSJ-H, etc.). These predefined CMaps mix 1-byte ASCII codes (charCodes
    // 0x20-0x7E) with 2-byte CJK codes. Without a parsed codespace, the renderer
    // assumes 2-byte hex everywhere and silently drops 1-byte hex strings like <20>,
    // which causes leading-space indentation to collapse and absolute-positioned
    // characters (e.g. superscripts via Tm) to land in the wrong place.
    let predefinedCJKCMap = false;

    // Handle predefined RKSJ CMap encoding for CID fonts (e.g., /Encoding /90pv-RKSJ-H).
    // RKSJ encodes text using Shift-JIS byte sequences. When there's no ToUnicode CMap,
    // decode Shift-JIS charCodes directly to Unicode for text rendering.
    if (toUnicode.size === 0 && /\/DescendantFonts/.test(fontObj)) {
      const rksjMatch = /\/Encoding\s*\/([\w-]*RKSJ[\w-]*)/.exec(fontObj);
      if (rksjMatch) {
        predefinedCJKCMap = true;
        // Codespace ranges for RKSJ CMaps (per Adobe predefined CMap definitions):
        //   1-byte: 0x00-0x80, 0xA0-0xDF, 0xFD-0xFF
        //   2-byte: 0x8140-0x9FFC, 0xE040-0xFCFC
        codespaceRanges = [
          { bytes: 1, low: 0x00, high: 0x80 },
          { bytes: 1, low: 0xA0, high: 0xDF },
          { bytes: 1, low: 0xFD, high: 0xFF },
          { bytes: 2, low: 0x8140, high: 0x9FFC },
          { bytes: 2, low: 0xE040, high: 0xFCFC },
        ];
        // Don't add ASCII charCodes 0x20-0x7E to toUnicode — convertFontToOTF.js's
        // rebuildFontFromGlyphs would then mark them as non-PUA and skip the embedded-
        // cmap fallback (see the `claimedUnicodes.size === 0` check). The renderer
        // already falls back to String.fromCharCode(charCode) for ASCII text extraction.
        try {
          const decoder = new TextDecoder('shift_jis');
          // Build toUnicode for 2-byte Shift-JIS ranges (first byte 0x81-0x9F or 0xE0-0xFC)
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
        } catch (_e) {
          // TextDecoder('shift_jis') not available — text will fall back to raw charCodes
        }
      }
    }

    // Handle predefined GBK/GB-EUC CMap encoding for CID fonts (e.g., /Encoding /GBK-EUC-H, /GB-EUC-H).
    // GBK and GB-EUC encode Simplified Chinese text using 2-byte sequences. When there's no
    // ToUnicode CMap, decode charCodes directly to Unicode for text rendering.
    // GB-EUC-H uses GB2312/EUC-CN encoding which is a subset of GBK, so the GBK decoder handles both.
    if (toUnicode.size === 0 && /\/DescendantFonts/.test(fontObj)) {
      const gbkMatch = /\/Encoding\s*\/([\w-]*(?:GBK|GB-EUC|GBpc-EUC)[\w-]*)/.exec(fontObj);
      if (gbkMatch) {
        predefinedCJKCMap = true;
        // Codespace ranges for Adobe GB predefined CMaps:
        //   1-byte: 0x00-0x80 (covers ASCII)
        //   2-byte: 0x8140-0xFEFE (covers GBK; superset of GB-EUC's 0xA1A1-0xFEFE)
        codespaceRanges = [
          { bytes: 1, low: 0x00, high: 0x80 },
          { bytes: 2, low: 0x8140, high: 0xFEFE },
        ];
        // See the RKSJ block above for why we don't populate ASCII toUnicode entries.
        try {
          const decoder = new TextDecoder('gbk');
          // Build toUnicode for 2-byte GBK ranges (first byte 0x81-0xFE, second byte 0x40-0x7E or 0x80-0xFE)
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
        } catch (_e) {
          // TextDecoder('gbk') not available — text will fall back to raw charCodes
        }
      }
    }

    // Wingdings fonts: PDF producers often embed broken ToUnicode CMaps that map
    // charCodes to Latin-1 or MacRoman equivalents instead of the correct Wingdings
    // Unicode symbols. Two patterns exist:
    //   (A) Subset remapping: charCode 57 → U+00FC ("ü"), where 0xFC=252 is the actual
    //       Wingdings glyph position. The codepoint ≤0xFF acts as the lookup key.
    //   (B) Standard encoding: charCode 254 → U+02DB ("˛"), where the charCode itself
    //       is the Wingdings glyph position. The codepoint >0xFF can't be a lookup key.
    // Strategy: try the codepoint as Wingdings key first (handles A), fall back to
    // the charCode itself (handles B), and populate missing entries from the table.
    if (/^(?:.*\+)?Wingdings(?:-\w+)?$/i.test(baseName)) {
      for (const [cid, ch] of toUnicode) {
        const cp = ch.codePointAt(0);
        if (cp !== undefined && cp <= 0xFF && wingdingsToUnicode[cp] !== undefined) {
          // Case A: codepoint is a Latin-1 char that doubles as a Wingdings position
          toUnicode.set(cid, String.fromCodePoint(wingdingsToUnicode[cp]));
        } else if (wingdingsToUnicode[cid] !== undefined) {
          // Case B: charCode is the Wingdings position, codepoint is a wrong encoding
          toUnicode.set(cid, String.fromCodePoint(wingdingsToUnicode[cid]));
        }
      }
      // Fill in any charCodes missing from toUnicode that exist in the Wingdings table
      for (const [ccStr, unicode] of Object.entries(wingdingsToUnicode)) {
        const cc = Number(ccStr);
        if (!toUnicode.has(cc)) toUnicode.set(cc, String.fromCodePoint(unicode));
      }
    }

    // Symbol fonts: PDF producers often embed broken ToUnicode CMaps that map
    // charCodes to their MacRoman equivalents instead of the correct Symbol encoding.
    // E.g., Symbol charCode 234 (⎢ bracket extension) maps to U+0152 (Œ) instead of U+23A2.
    // Correct these by replacing the entire toUnicode with the known Symbol encoding.
    if (/^Symbol$/i.test(baseName) && toUnicode.size > 0) {
      // Detect a broken CMap: in Symbol encoding, charCode 65 is Alpha (Α U+0391),
      // but a broken MacRoman/Latin CMap maps it to 'A' (U+0041).
      const testChar = toUnicode.get(65);
      if (testChar === 'A') {
        for (const [ccStr, unicode] of Object.entries(symbolToUnicode)) {
          toUnicode.set(Number(ccStr), String.fromCodePoint(unicode));
        }
      }
    }

    // Track whether toUnicode already came from an explicit source (real ToUnicode
    // CMap or /Identity-H). When false, entries in toUnicode may come from fallback
    // base encodings and should be overridable by /Differences.
    const hasAuthoritativeToUnicode = toUnicode.size > 0 || toUnicodeIsIdentity;

    // Parse /Differences array (always needed — used by wrapCFFInOTF for PUA cmap
    // entries even when ToUnicode partially covers the font's charCodes).
    /** @type {{ [charCode: number]: string }|null} */
    let differences = null;
    // Encoding-derived Unicode map: charCode → Unicode via BaseEncoding/Differences → AGL.
    // This matches what wrapCFFInOTF builds into the OTF cmap (glyph names → AGL → Unicode),
    // so it's the correct mapping for rendering. Separate from toUnicode which is for text extraction.
    const encodingUnicode = new Map();
    // charCode → glyph name from /Encoding. Kept separate from ToUnicode because
    // they can legitimately disagree (e.g. TeX 0x27 draws 'quoteright' but ToUnicode
    // reports U+0027) — convertType1ToOTFNew needs the encoding's glyph, not the source char.
    const charCodeToGlyphName = new Map();
    let hasFontFile = false;
    let hasFontFile2 = false;
    let hasFontFile3 = false;
    {
      // Resolve the Encoding: may be a predefined name, an inline dict, or an indirect reference
      let encodingText = fontObj;
      const encRefMatch = /\/Encoding\s+(\d+)\s+\d+\s+R/.exec(fontObj);
      if (encRefMatch) {
        const encObj = objCache.getObjectText(Number(encRefMatch[1]));
        if (encObj) encodingText = encObj;
      }

      // Build encodingUnicode from base encoding (always, regardless of ToUnicode)
      const baseChars = (/\/Encoding\s*\/MacRomanEncoding/.test(fontObj) || /\/BaseEncoding\s*\/MacRomanEncoding/.test(encodingText)) ? macRomanChars
        : (/\/Encoding\s*\/WinAnsiEncoding/.test(fontObj) || /\/BaseEncoding\s*\/WinAnsiEncoding/.test(encodingText) ? win1252Chars : null);
      if (baseChars) {
        for (let code = 32; code <= 255; code++) {
          const ch = baseChars[code - 32];
          if (ch) encodingUnicode.set(code, ch);
        }
        // When no ToUnicode CMap, use encoding as toUnicode fallback
        if (toUnicode.size === 0) {
          for (const [code, ch] of encodingUnicode) toUnicode.set(code, ch);
        }
      }

      // StandardEncoding fallback: when no explicit BaseEncoding is specified, the base is
      // the font's built-in encoding (StandardEncoding for Type1). Only apply for Type1 PFA
      // fonts (/FontFile in descriptor), NOT CFF (/FontFile3) — CFF fonts handle their own
      // encoding via buildFontFromCFF's PUA cmap, and StandardEncoding entries would conflict.
      // Resolve the descriptor to check /FontFile vs /FontFile3.
      let descriptorText = fontObj;
      const descRefMatch = /\/FontDescriptor\s+(\d+)\s+\d+\s+R/.exec(fontObj);
      if (descRefMatch) {
        const dt = objCache.getObjectText(Number(descRefMatch[1]));
        if (dt) descriptorText = dt;
      }
      hasFontFile = /\/FontFile\s+\d+\s+\d+\s+R/.test(String(descriptorText));
      hasFontFile2 = /\/FontFile2\s+\d+\s+\d+\s+R/.test(String(descriptorText));
      hasFontFile3 = /\/FontFile3\s+\d+\s+\d+\s+R/.test(String(descriptorText));
      // Type0/CID fonts must be excluded: their byte→CID mapping is arbitrary
      // (especially for subsets), so StandardEncoding fallback yields garbage.
      const isType0 = /\/Subtype\s*\/Type0/.test(String(fontObj));
      const isStd14Type1 = /^(Helvetica|Courier|Times-)/i.test(baseName);
      if (!baseChars && !isType0 && (hasFontFile || isStd14Type1) && !hasFontFile3 && !/ZapfDingbats|Symbol|Wingdings/i.test(baseName)) {
        const stdEnc = [
          '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '',
          '', '', '', '', 'space', 'exclam', 'quotedbl', 'numbersign', 'dollar', 'percent', 'ampersand', 'quoteright',
          'parenleft', 'parenright', 'asterisk', 'plus', 'comma', 'hyphen', 'period', 'slash', 'zero', 'one', 'two',
          'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'colon', 'semicolon', 'less', 'equal', 'greater',
          'question', 'at', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q', 'R', 'S',
          'T', 'U', 'V', 'W', 'X', 'Y', 'Z', 'bracketleft', 'backslash', 'bracketright', 'asciicircum', 'underscore',
          'quoteleft', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm', 'n', 'o', 'p', 'q', 'r', 's', 't',
          'u', 'v', 'w', 'x', 'y', 'z', 'braceleft', 'bar', 'braceright', 'asciitilde', '', '', '', '', '', '', '', '',
          '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '',
          'exclamdown', 'cent', 'sterling', 'fraction', 'yen', 'florin', 'section', 'currency', 'quotesingle',
          'quotedblleft', 'guillemotleft', 'guilsinglleft', 'guilsinglright', 'fi', 'fl', '', 'endash', 'dagger',
          'daggerdbl', 'periodcentered', '', 'paragraph', 'bullet', 'quotesinglbase', 'quotedblbase', 'quotedblright',
          'guillemotright', 'ellipsis', 'perthousand', '', 'questiondown', '', 'grave', 'acute', 'circumflex', 'tilde',
          'macron', 'breve', 'dotaccent', 'dieresis', '', 'ring', 'cedilla', '', 'hungarumlaut', 'ogonek', 'caron',
          'emdash', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', 'AE', '', 'ordfeminine', '', '', '',
          '', 'Lslash', 'Oslash', 'OE', 'ordmasculine', '', '', '', '', '', 'ae', '', '', '', 'dotlessi', '', '',
          'lslash', 'oslash', 'oe', 'germandbls',
        ];
        for (let code = 32; code < stdEnc.length; code++) {
          const glyphName = stdEnc[code];
          if (!glyphName) continue;
          charCodeToGlyphName.set(code, glyphName);
          const ch = aglLookup(glyphName);
          if (ch) encodingUnicode.set(code, ch);
        }
        if (toUnicode.size === 0) {
          for (const [code, ch] of encodingUnicode) toUnicode.set(code, ch);
        }
      }

      // Dingbats: when no explicit BaseEncoding, use built-in encoding (PDF spec §9.6.5,
      // Table 112: for a symbolic font, the default base encoding is the font's built-in encoding).
      // The built-in encoding maps charCodes to Dingbats glyph names (e.g. 108 → 'a71' → ● U+25CF).
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

      // Apply /Differences array overrides (charCode, /glyphName, /glyphName, ..., charCode, ...)
      // Differences can be inline [232 /egrave /eacute] or an indirect reference (331 0 R)
      let diffContent = null;
      const diffInlineMatch = /\/Differences\s*\[([\s\S]*?)\]/.exec(encodingText);
      if (diffInlineMatch) {
        diffContent = diffInlineMatch[1];
      } else {
        const diffRefMatch = /\/Differences\s+(\d+)\s+\d+\s+R/.exec(encodingText);
        if (diffRefMatch) {
          const diffObj = objCache.getObjectText(Number(diffRefMatch[1]));
          if (diffObj) {
            // The resolved object is the array itself: [ 232 /egrave /eacute ]
            const arrMatch = /\[([\s\S]*)\]/.exec(diffObj);
            if (arrMatch) diffContent = arrMatch[1];
          }
        }
      }
      if (diffContent) {
        differences = {};
        // Tokenize: integers and /name tokens (names may be concatenated without whitespace)
        const tokens = [...diffContent.matchAll(/(\d+)|(\/[^\s/<>[\]]+)/g)];
        let charCode = 0;
        for (const tok of tokens) {
          if (tok[1]) {
            // Integer: set the starting charCode
            charCode = Number(tok[1]);
          } else if (tok[2]) {
            // Name token like /eacute — decode PDF #XX hex escapes (§7.3.5)
            const glyphName = tok[2].slice(1).replace(/#([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
            differences[charCode] = glyphName;
            // /Differences glyph names override BaseEncoding's glyph names at the same slot
            charCodeToGlyphName.set(charCode, glyphName);
            // Differences describe modifications from the base encoding (PDF spec §9.6.5, Table 112).
            // Use aglLookup which handles period suffixes (e.g. "one.oldstyle" → "1")
            // and underscore ligatures (e.g. "f_f_i" → "ffi").
            let unicodeStr = aglLookup(glyphName);
            // Dingbats uses its own glyph name list (e.g. "a36" → ✩ U+2729).
            // Check it before the TeX fallback, which would misinterpret "a36" as U+0024 ($).
            if (!unicodeStr && /ZapfDingbats/i.test(baseName)) {
              const zdCp = dingbatsGlyphMap[glyphName];
              if (zdCp !== undefined) unicodeStr = String.fromCodePoint(zdCp);
            }
            // TeX Type3 fonts use glyph names like "a192" where the number is the
            // Unicode code point. Fall back to this pattern when AGL lookup fails.
            if (!unicodeStr) {
              const texMatch = /^a(\d+)$/.exec(glyphName);
              if (texMatch) {
                const cp = Number(texMatch[1]);
                if (cp > 0 && cp <= 0xFFFF) unicodeStr = String.fromCodePoint(cp);
              }
            }
            // Cnnnn glyph names are ambiguous between two conventions:
            //   Decimal: /C0097 names the char whose decimal code is 97 ('a').
            //   Hex identity: /C75 at charCode 117 means parseInt('75',16)=117, the
            //     charCode itself ('u'). Used by some PDF producers as identity.
            // aglLookup resolves them unconditionally as decimal, which corrupts
            // extraction for the hex-identity convention. Here we prefer hex-identity
            // when parseInt(suffix, 16) equals charCode and lies in printable ASCII;
            // that is a strong signal that the PDF meant identity encoding.
            {
              const cMatch = /^C([0-9a-fA-F]{1,5})$/.exec(glyphName);
              if (cMatch) {
                const hexCode = parseInt(cMatch[1], 16);
                if (hexCode === charCode && hexCode >= 0x20 && hexCode <= 0x7E) {
                  unicodeStr = String.fromCodePoint(hexCode);
                }
              }
            }
            // Gnnn pattern: some PDF producers subset TrueType fonts and emit
            // glyph names of the form "G<decimal>" where the number is the
            // Windows-1252 character code of the intended character (e.g.
            // G82='R', G32=' ', G150='–'). These fonts ship with no ToUnicode
            // CMap, so without this fallback extraction produces garbage. The
            // name is not an Adobe Glyph List entry (aglLookup returns null),
            // so this fallback only fires when no standard resolution exists.
            // TODO: There likely needs to be more validation here.
            // This likely triggers in cases when it is not intended.
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

            if (unicodeStr) {
              const existingUnicode = toUnicode.get(charCode);

              // Allow /Differences to override base-encoding fallback mappings when
              // no explicit ToUnicode source exists.
              const shouldOverrideFallbackToUnicode = !hasAuthoritativeToUnicode
                && existingUnicode !== undefined
                && existingUnicode !== unicodeStr;

              // ToUnicode CMap is usually authoritative for text extraction (PDF §9.10.2),
              // but Cnnnn glyph names encode deterministic character codes directly
              // (e.g. C0097 -> "a", or /C75 @ 117 -> 'u' identity), so prefer them
              // over conflicting CMap entries. Accept both decimal and hex suffixes;
              // the resolution above chose the right interpretation for this charCode.
              const shouldOverrideWithCPrefix = /^C[0-9a-fA-F]{1,5}$/.test(glyphName)
                && existingUnicode !== undefined
                && existingUnicode !== unicodeStr;

              // Broken ToUnicode entries often use PUA codepoints (e.g. Symbol
              // copyrightserif -> U+F6D9). When Differences resolves to a standard
              // Unicode character, prefer the non-PUA mapping.
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
                || shouldOverrideWithCPrefix
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

    {
      const isEmbedded = hasFontFile || hasFontFile2 || hasFontFile3;
      let identityHighRangeCount = 0;
      if (toUnicode.size > 0) {
        for (let cc = 0x80; cc <= 0xFF; cc++) {
          const tu = toUnicode.get(cc);
          if (tu && tu.length === 1 && tu.codePointAt(0) === cc) identityHighRangeCount++;
        }
      }
      const isIdentityPlaceholder = identityHighRangeCount >= 76; // 80% of 96 high-range slots
      if (isEmbedded && isIdentityPlaceholder && encodingUnicode.size > 0) {
        for (const [cc, eu] of encodingUnicode) {
          if (cc < 0x80) continue;
          const tu = toUnicode.get(cc);
          if (tu === undefined) continue;
          const tuCp = tu.codePointAt(0);
          const euCp = eu.codePointAt(0);
          if (tu.length === 1 && tuCp === cc && euCp !== cc) {
            toUnicode.set(cc, eu);
          }
        }
      }
    }

    // Wingdings encodingUnicode correction: the base encoding (MacRoman/WinAnsi) and
    // Differences→AGL produce wrong Unicode for Wingdings glyphs in encodingUnicode.
    // Apply the same correction as the toUnicode block above so that code paths
    // which prefer encodingUnicode (e.g. parsePdfDoc text extraction) get correct values.
    if (/^(?:.*\+)?Wingdings(?:-\w+)?$/i.test(baseName)) {
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

    // Parse width info and metrics
    let defaultWidth = 1000;
    const widths = new Map();
    let ascent = 800;
    let descent = -200;

    // Parse simple font widths (/FirstChar + /Widths array)
    // This handles Type1 and TrueType non-composite fonts.
    // Type0 fonts will overwrite via parseCIDWidths; Type3 via glyph advance parsing.
    const firstChar = resolveIntValue(fontObj, 'FirstChar', objCache);
    // /Widths can be inline array or indirect reference (e.g. /Widths 217 0 R)
    const widthsArrayText = resolveArrayValue(fontObj, 'Widths', objCache);
    if (/\/FirstChar\s/.test(fontObj) && widthsArrayText) {
      const widthValues = widthsArrayText.trim().split(/\s+/).map(Number);
      for (let j = 0; j < widthValues.length; j++) {
        widths.set(firstChar + j, widthValues[j]);
      }
      if (widthValues.length > 0) {
        defaultWidth = widthValues.reduce((a, b) => a + b, 0) / widthValues.length;
      }
    }

    // If no /Widths array was found, fall back to built-in standard font metrics.
    // Skip this for Type0 (composite) fonts — their widths live on the CIDFont /W
    // array, indexed by CID. applyStandardFontWidths writes WinAnsiEncoding widths
    // at character-code positions 32-255, which collide with CID values that are
    // not in /W (e.g. CID 68 for lowercase 'a' in a subsetted Arial-BoldMT would
    // inherit Helvetica-Bold's 'D' width of 722 instead of falling through to the
    // CIDFont /DW, producing visibly wrong advances for any CID that /W omits).
    const isType0Font = /\/Subtype\s*\/Type0/.test(fontObj);
    if (widths.size === 0 && !isType0Font) {
      const avgWidth = applyStandardFontWidths(baseName, widths);
      if (avgWidth !== null) defaultWidth = avgWidth;

      // applyStandardFontWidths fills widths indexed by WinAnsiEncoding charCodes.
      // For fonts using MacRomanEncoding, charCodes 128-255 map to different glyphs
      // (e.g., 0xD1 = emdash in MacRoman vs Ntilde in WinAnsi). Remap the widths
      // so each MacRoman charCode gets the width of the correct glyph.
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

      // For standard fonts with /Differences encoding, charCodes are remapped to
      // different glyphs (e.g., charCode 8 → "A" instead of WinAnsi charCode 65 → "A").
      // Remap widths so each custom charCode gets the width of its mapped glyph.
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
    }

    // For Dingbats with /Differences, the charCodes in /Differences (e.g. 1, 2)
    // are outside the standard encoding range (32-126) so applyStandardFontWidths
    // won't cover them. Look up each glyph name's width from the AFM data.
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

    let type0Info = null;
    // /DescendantFonts can be:
    //   1. Array with indirect ref:  /DescendantFonts [ 15 0 R ]
    //   2. Indirect ref to array:    /DescendantFonts 14 0 R
    //   3. Array with inline dict:   /DescendantFonts [<< ... >>]
    const descInlineMatch = /\/DescendantFonts\s*\[\s*(\d+)\s+\d+\s+R/.exec(fontObj);
    const descIndirectMatch = !descInlineMatch && /\/DescendantFonts\s+(\d+)\s+\d+\s+R/.exec(fontObj);
    let cidFontObjNum = descInlineMatch ? Number(descInlineMatch[1]) : null;
    let cidFontText = null;
    if (!cidFontObjNum && descIndirectMatch) {
      // Resolve the indirect reference to get the array, then extract the CIDFont ref from it
      const arrayText = objCache.getObjectText(Number(descIndirectMatch[1]));
      if (arrayText) {
        const innerRef = /(\d+)\s+\d+\s+R/.exec(arrayText);
        if (innerRef) cidFontObjNum = Number(innerRef[1]);
      }
    }
    if (!cidFontObjNum && !descIndirectMatch) {
      // Check for inline CIDFont dictionary: /DescendantFonts[<< ... >>]
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

      // /W can be inline (/W [...]) or an indirect reference (/W 216 0 R).
      // It can also be inline with indirect refs inside: /W[0 169 0 R]
      // where "169 0 R" resolves to a width array [250 333 ...].
      const wRefMatch = /\/W\s+(\d+)\s+\d+\s+R/.exec(cidFontText);
      if (wRefMatch) {
        const wArrayText = objCache.getObjectText(Number(wRefMatch[1]));
        if (wArrayText) {
          parseCIDWidths(`/W ${wArrayText}`, widths);
        }
      } else {
        // Before parsing inline /W, resolve any indirect references inside it.
        // Pattern like /W[0 169 0 R] contains "169 0 R" which must be resolved.
        let resolvedCidText = cidFontText;
        const wPos = cidFontText.indexOf('/W');
        if (wPos !== -1) {
          const bracketPos = cidFontText.indexOf('[', wPos);
          if (bracketPos !== -1) {
            // Find matching ]
            let depth = 0;
            let bracketEndPos = -1;
            for (let j = bracketPos; j < cidFontText.length; j++) {
              if (cidFontText[j] === '[') depth++;
              else if (cidFontText[j] === ']') { depth--; if (depth === 0) { bracketEndPos = j; break; } }
            }
            if (bracketEndPos !== -1) {
              let wContent = cidFontText.substring(bracketPos + 1, bracketEndPos);
              // Resolve indirect references (N 0 R) inside the /W array
              const refPattern = /(\d+)\s+0\s+R/g;
              const replacements = [];
              for (let refMatch = refPattern.exec(wContent); refMatch !== null; refMatch = refPattern.exec(wContent)) {
                const refObjNum = Number(refMatch[1]);
                const refText = objCache.getObjectText(refObjNum);
                if (refText) {
                  replacements.push({ start: refMatch.index, end: refMatch.index + refMatch[0].length, text: refText.trim() });
                }
              }
              // Apply replacements in reverse order to preserve positions
              for (let r = replacements.length - 1; r >= 0; r--) {
                wContent = wContent.substring(0, replacements[r].start) + replacements[r].text + wContent.substring(replacements[r].end);
              }
              resolvedCidText = cidFontText.substring(0, bracketPos + 1) + wContent + cidFontText.substring(bracketEndPos);
            }
          }
        }
        parseCIDWidths(resolvedCidText, widths);
      }

      // Parse FontDescriptor for ascent/descent and Type0 font file
      // FontDescriptor can be inline (<< ... >>) or an indirect reference (N 0 R)
      // In some PDFs, DescendantFonts points directly to a FontDescriptor (no CIDFont layer)
      const fdRefMatch = /\/FontDescriptor\s+(\d+)\s+\d+\s+R/.exec(cidFontText);
      let fdText = null;
      if (fdRefMatch) {
        fdText = objCache.getObjectText(Number(fdRefMatch[1]));
      } else if (/\/Type\s*\/FontDescriptor/.test(cidFontText)) {
        // DescendantFonts points directly to a FontDescriptor — use it as-is
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
        if (ascentVal || /\/Ascent\s/.test(fdText)) ascent = ascentVal;
        if (descentVal || /\/Descent\s/.test(fdText)) descent = descentVal;

        // Augment bold/italic/serif from font descriptor properties
        const fontFlags = resolveIntValue(fdText, 'Flags', objCache);
        if (!bold) {
          const weight = resolveIntValue(fdText, 'FontWeight', objCache);
          if ((weight >= 700) || (fontFlags & 262144)) bold = true;
        }
        if (!italic) {
          const angle = resolveNumValue(fdText, 'ItalicAngle', objCache);
          if (Math.abs(angle) > 0 || (fontFlags & 64)) italic = true;
        }
        if (fontFlags & 2) serifFlag = true;

        // Extract FontFile2 for CIDFontType2 fonts (TrueType-based composite fonts)
        const isCIDFontType2 = /\/Subtype\s*\/CIDFontType2/.test(cidFontText);
        if (isCIDFontType2) {
          const ff2RefMatch = /\/FontFile2\s+(\d+)\s+\d+\s+R/.exec(fdText);
          if (ff2RefMatch) {
            const fontFile = objCache.getStreamBytes(Number(ff2RefMatch[1]));
            if (fontFile) {
              let cidToGidMap = 'identity';
              if (!/\/CIDToGIDMap\s*\/Identity/.test(cidFontText)) {
                const gidMapRef = /\/CIDToGIDMap\s+(\d+)\s+\d+\s+R/.exec(cidFontText);
                if (gidMapRef) {
                  const mapBytes = objCache.getStreamBytes(Number(gidMapRef[1]));
                  if (mapBytes) cidToGidMap = mapBytes;
                }
              }
              type0Info = { fontFile, cidToGidMap };
            }
          }
        }

        // Extract FontFile3 for CIDFontType0 fonts (CFF-based composite fonts)
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

    // For fonts using Adobe predefined CJK CMaps (GB-EUC-H, 90pv-RKSJ-H, etc.), assign the
    // standard Adobe ROS half-width Latin width (500) for the ASCII charCode range. The
    // CIDFont's /W array typically doesn't enumerate the half-width Latin glyphs (since
    // their widths are standardized in the corresponding Adobe ROS), so without this they
    // would fall through to /DW (typically 1000) and the leading-space indentation in
    // mixed CJK/Latin text would be roughly 2x too wide. Keys are charCodes (the renderer
    // treats charCode as CID for width lookup when no charCodeToCID map is built).
    if (predefinedCJKCMap) {
      for (let cc = 0x20; cc <= 0x7E; cc++) {
        if (!widths.has(cc)) widths.set(cc, 500);
      }
    }

    // For Type0 CFF fonts, use CFF charset to enrich toUnicode or build validCIDs
    let validCIDs = null;
    if (type0Info && type0Info.fontFile) {
      const charsetInfo = parseCFFCharset(type0Info.fontFile);
      if (charsetInfo) {
        if (!charsetInfo.isCID && charsetInfo.glyphToUnicode) {
          // Non-CID CFF: populate toUnicode from glyph names + AGL
          for (const [gid, unicode] of charsetInfo.glyphToUnicode) {
            if (!toUnicode.has(gid)) toUnicode.set(gid, unicode);
          }
        } else if (charsetInfo.isCID && charsetInfo.validCIDs) {
          // CID CFF: store valid CIDs for filtering in showHexString
          validCIDs = charsetInfo.validCIDs;
        }
      }
    }

    // /ToUnicode /Identity-H as a name: charCodes are Unicode codepoints directly.
    // Build toUnicode from charCodeToCID map: each charCode key is the Unicode value.
    if (toUnicodeIsIdentity && toUnicode.size === 0 && charCodeToCID) {
      for (const [charCode, cid] of charCodeToCID) {
        if (charCode > 0 && charCode <= 0x10FFFF) {
          toUnicode.set(cid, String.fromCodePoint(charCode));
        }
      }
    }

    // For Identity-H CID fonts with no ToUnicode CMap, build toUnicode from CIDSystemInfo.
    // For Adobe-Identity ordering, CIDs are Unicode code points directly.
    // For standard Adobe orderings (Japan1, GB1, CNS1, Korea1), use the published
    // CID→Unicode mapping tables from Adobe's cmap-resources.
    if (toUnicode.size === 0 && cidFontText && /\/Encoding\s*\/Identity-H/.test(fontObj)) {
      // Parse CIDSystemInfo — may be inline or indirect reference
      let cidSysText = cidFontText;
      const cidSysRef = /\/CIDSystemInfo\s+(\d+)\s+\d+\s+R/.exec(cidFontText);
      if (cidSysRef) {
        const sysObj = objCache.getObjectText(Number(cidSysRef[1]));
        if (sysObj) cidSysText = sysObj;
      }
      const registryMatch = /\/Registry\s*\(([^)]+)\)/.exec(cidSysText);
      const orderingMatch = /\/Ordering\s*\(([^)]+)\)/.exec(cidSysText);
      let registry = registryMatch ? registryMatch[1] : '';
      let ordering = orderingMatch ? orderingMatch[1] : '';

      // In encrypted PDFs, string values are encrypted per-object. getObjectText()
      // returns raw (encrypted) text, so Registry/Ordering may be garbled.
      // Re-extract from raw bytes and decrypt when needed.
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
        // Adobe-Identity with CIDFontType2: CIDs are GIDs in the TrueType font.
        // Use the font's cmap to reverse-map GID→Unicode.
        const isCIDType2 = cidFontText && /\/Subtype\s*\/CIDFontType2/.test(cidFontText);
        let gidMap = null;
        if (isCIDType2) {
          // Try the CIDFont's own embedded file first
          if (type0Info && type0Info.fontFile) {
            gidMap = buildGidToUnicodeFromTrueType(type0Info.fontFile);
          }
          // If no embedded file, search sibling fonts with the same BaseFont for an embedded FontFile2
          if (!gidMap) {
            const strippedBase = baseName.replace(/^[A-Z]{6}\+/, '');
            for (const [sibTag, sibObj] of fontEntryPairs) {
              if (sibTag === fontTag) continue;
              const sibBaseMatch = /\/BaseFont\s*\/([^\s/<>[\]]+)/.exec(sibObj);
              if (!sibBaseMatch) continue;
              const sibBase = sibBaseMatch[1].replace(/^[A-Z]{6}\+/, '');
              if (sibBase !== strippedBase) continue;
              // Found a sibling with the same BaseFont — look for its FontDescriptor + FontFile2
              const sibFdRef = /\/FontDescriptor\s+(\d+)\s+\d+\s+R/.exec(sibObj);
              if (!sibFdRef) continue;
              const sibFdText = objCache.getObjectText(Number(sibFdRef[1]));
              if (!sibFdText) continue;
              const sibFf2Ref = /\/FontFile2\s+(\d+)\s+\d+\s+R/.exec(sibFdText);
              if (!sibFf2Ref) continue;
              const sibFontFile = objCache.getStreamBytes(Number(sibFf2Ref[1]));
              if (!sibFontFile) continue;
              gidMap = buildGidToUnicodeFromTrueType(sibFontFile);
              if (gidMap) break;
            }
          }
        }
        if (gidMap && gidMap.size > 0) {
          // Use cmap-based GID→Unicode mapping
          const cidSet = validCIDs || new Set(widths.keys());
          for (const cid of cidSet) {
            const unicode = gidMap.get(cid);
            if (unicode && unicode > 0) toUnicode.set(cid, String.fromCodePoint(unicode));
          }
        } else if (validCIDs) {
          // Fallback for CIDFontType0 (CFF) or when no cmap available: CIDs are Unicode code points
          for (const cid of validCIDs) {
            if (cid > 0 && cid <= 0xFFFF) toUnicode.set(cid, String.fromCodePoint(cid));
          }
        }
      } else if (registry === 'Adobe') {
        const cidMap = getCIDToUnicodeMap(ordering);
        if (cidMap) {
          const isEmbedded = type0Info && type0Info.fontFile;
          const cidSet = validCIDs || (isEmbedded ? new Set(widths.keys()) : null);
          if (cidSet) {
            for (const cid of cidSet) {
              if (cid > 0 && cid < cidMap.length && cidMap[cid] !== 0) {
                // NFKC-normalize to convert Kangxi radicals (U+2F00-U+2FD5) and CJK Compatibility
                // Ideographs (U+F900-U+FAD9) to standard CJK Unified Ideographs.
                // Without this, substitute fonts lack glyphs for these variant codepoints.
                toUnicode.set(cid, String.fromCodePoint(cidMap[cid]).normalize('NFKC'));
              }
            }
          } else {
            // Non-embedded font: no charset or embedded data to determine which CIDs are used.
            // Populate all entries from the published CID→Unicode table so any CID from the
            // content stream can be mapped correctly.
            for (let cid = 1; cid < cidMap.length; cid++) {
              if (cidMap[cid] !== 0) {
                toUnicode.set(cid, String.fromCodePoint(cidMap[cid]).normalize('NFKC'));
              }
            }
          }
        }
      }
    }

    // Also check for non-composite fonts (Type1, TrueType) FontDescriptor
    let type3Info = null;
    let type1Info = null;
    let detectedMacRomanCmap = false;
    const isType3 = /\/Subtype\s*\/Type3/.test(fontObj);
    if (!cidFontObjNum && !cidFontText) {
      // FontDescriptor may be an indirect reference (N 0 R) or inline (<< ... >>)
      const fdRefMatchDirect = /\/FontDescriptor\s+(\d+)\s+\d+\s+R/.exec(fontObj);
      let fdText = null;
      if (fdRefMatchDirect) {
        fdText = objCache.getObjectText(Number(fdRefMatchDirect[1]));
      } else {
        // Inline FontDescriptor: /FontDescriptor << ... >>
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
        if (ascentVal || /\/Ascent\s/.test(fdText)) ascent = ascentVal;
        if (descentVal || /\/Descent\s/.test(fdText)) descent = descentVal;

        // Augment bold/italic/serif from font descriptor properties
        const fontFlags = resolveIntValue(fdText, 'Flags', objCache);
        if (!bold) {
          const weight = resolveIntValue(fdText, 'FontWeight', objCache);
          if ((weight >= 700) || (fontFlags & 262144)) bold = true;
        }
        if (!italic) {
          const angle = resolveNumValue(fdText, 'ItalicAngle', objCache);
          if (Math.abs(angle) > 0 || (fontFlags & 64)) italic = true;
        }
        if (fontFlags & 2) serifFlag = true;

        // Use MissingWidth from FontDescriptor as defaultWidth for charCodes
        // not covered by the /Widths array (PDF spec §9.6.2, default 0).
        if (widths.size > 0) {
          const mw = resolveNumValue(fdText, 'MissingWidth', objCache);
          defaultWidth = mw || 0;
        }

        // Extract embedded font file for Type1/TrueType rendering
        // /FontFile = Type1 font program, /FontFile2 = TrueType, /FontFile3 = CFF/OpenType
        if (!isType3) {
          const ff1Match = /\/FontFile\s+(\d+)\s+\d+\s+R/.exec(fdText);
          const ff2Match = /\/FontFile2\s+(\d+)\s+\d+\s+R/.exec(fdText);
          const ff3Match = /\/FontFile3\s+(\d+)\s+\d+\s+R/.exec(fdText);
          const ffMatch = ff2Match || ff3Match || ff1Match;
          if (ffMatch) {
            const fontFile = objCache.getStreamBytes(Number(ffMatch[1]));
            if (fontFile) type1Info = { fontFile };
          }

          // TrueType fonts with no /Encoding and empty ToUnicode: detect Mac-Roman cmap
          // in the embedded font. When detected, populate toUnicode ONLY for charCodes
          // where Mac-Roman differs from Latin-1 (0x80-0xFF). This fixes text extraction
          // (e.g., 0xA5 = bullet • not yen ¥) without affecting the renderer, which uses
          // rawCharCode path for Mac-only cmap fonts and references toUnicode only for
          // the whitespace/advance check where ASCII chars are unaffected.
          if (ff2Match && type1Info?.fontFile && toUnicode.size === 0 && encodingUnicode.size === 0) {
            const fb = type1Info.fontFile;
            if (fb.length >= 12) {
              const nT = (fb[4] << 8) | fb[5];
              let hasMacRomanCmap = false;
              let hasPlatform3 = false;
              for (let ti = 0; ti < nT && 12 + (ti + 1) * 16 <= fb.length; ti++) {
                const te = 12 + ti * 16;
                if (fb[te] === 0x63 && fb[te + 1] === 0x6D && fb[te + 2] === 0x61 && fb[te + 3] === 0x70) { // "cmap"
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
                // Only set toUnicode for charCodes 0x80-0xFF where Mac-Roman
                // and Latin-1 produce different Unicode codepoints.
                for (let code = 0x80; code <= 0xFF; code++) {
                  const macChar = macRomanChars[code - 32];
                  if (macChar && macChar !== String.fromCharCode(code)) {
                    toUnicode.set(code, macChar);
                  }
                }
              }
            }
          }
        }
      }

      // Type1/TrueType fonts without embedded font files are still renderable via CSS
      // font-family fallback (standard fonts like Helvetica → sans-serif, or non-standard
      // fonts like Computer Modern cmr12 → serif). Without type1Info set, showType1Literal
      // in the renderer skips text for these fonts entirely.
      if (!type1Info && !isType3 && (/\/Subtype\s*\/Type1/.test(fontObj) || /\/Subtype\s*\/TrueType/.test(fontObj))) {
        type1Info = { fontFile: null };
      }

      // TeX Computer Modern TEXT fonts (CMR, CMMI, CMBX, etc.) use OT1 encoding
      // where charCodes < 0x20 map to ligatures. CMSY (symbol) and CMEX (extension)
      // fonts use different encodings and must NOT get OT1 ligature mappings.
      if (/^(cm|CM)/i.test(baseName) && !/CMSY|CMEX/i.test(baseName) && !isType3) {
        const texOT1Ligatures = [
          [11, '\uFB00'], // ff
          [12, '\uFB01'], // fi
          [13, '\uFB02'], // fl
          [14, '\uFB03'], // ffi
          [15, '\uFB04'], // ffl
        ];
        for (const [code, ch] of texOT1Ligatures) {
          if (!toUnicode.has(code)) {
            toUnicode.set(code, ch);
            encodingUnicode.set(code, ch);
          }
        }
      }

      // For embedded CFF fonts, use the CFF's built-in encoding as a fallback
      // source for missing charCode→Unicode mappings. Some generators emit sparse
      // /Differences arrays (or omit /ToUnicode entries) while relying on the CFF
      // encoding for the remaining charCodes.
      if (type1Info?.fontFile) {
        try {
          const charsetInfo = parseCFFCharset(type1Info.fontFile);
          if (charsetInfo && !charsetInfo.isCID && charsetInfo.glyphToUnicode) {
            // Parse CFF encoding to map charCode → GID → Unicode
            const fontShell = {
              tables: {}, encoding: null, isCIDFont: false, unitsPerEm: 1000,
            };
            const dv = new DataView(
              type1Info.fontFile.buffer, type1Info.fontFile.byteOffset, type1Info.fontFile.byteLength,
            );
            opentype.parseCFFTable(dv, 0, fontShell);
            const cffEncObj = fontShell.cffEncoding || fontShell.encoding;
            if (cffEncObj?.encoding) {
              const cffCharset = fontShell.tables.cff.charset;
              for (const [codeStr, idx] of Object.entries(cffEncObj.encoding)) {
                const code = Number(codeStr);
                if (!Number.isFinite(code)) continue;
                const numIdx = typeof idx === 'number' ? idx : Number(idx);
                if (!Number.isFinite(numIdx)) continue;
                const glyphName = cffCharset[numIdx + 1];
                if (!glyphName || toUnicode.has(code) || encodingUnicode.has(code)) continue;
                const uni = charsetInfo.glyphToUnicode.get(numIdx + 1);
                if (uni) {
                  toUnicode.set(code, uni);
                  encodingUnicode.set(code, uni);
                }
              }
            }
          }
        } catch (_e) { /* CFF parsing failed — skip */ }
      }

      // For Type3 fonts, extract actual glyph advance widths from CharProcs streams
      if (isType3) {
        type3Info = parseType3Font(fontObj, objCache);
        if (type3Info) {
          for (const [charCodeStr, glyphName] of Object.entries(type3Info.encoding)) {
            const glyph = type3Info.glyphs[glyphName];
            if (glyph && glyph.advanceWidth > 0) {
              const charCode = Number(charCodeStr);
              // Convert glyph-space advance to standard PDF 1/1000 text-space units
              widths.set(charCode, glyph.advanceWidth * type3Info.fontMatrix[0] * 1000);
              // Only set fallback mappings for charCodes that don't already have
              // a real Unicode mapping from the /ToUnicode CMap. Overwriting CMap
              // entries with PUA placeholders breaks text extraction.
              if (!toUnicode.has(charCode)) {
                if (glyph.bbox === null) {
                  // Space glyph: no drawing commands but positive advance width
                  toUnicode.set(charCode, ' ');
                } else {
                  // Visible glyph: map to a placeholder to prevent charCodes like 32 (ASCII space)
                  // from being misidentified as spaces via the str[i] fallback in showLiteralString
                  toUnicode.set(charCode, String.fromCodePoint(0xE000 + charCode));
                }
              }
            }
          }
          // Type3 fonts: characters not in the encoding (e.g. space) should have
          // zero advance, not the average glyph width.
          defaultWidth = 0;

          // Derive ascent/descent from FontBBox only when it maps to a sane em-height.
          // Some Type3 fonts use placeholder FontBBox values (e.g. [-10 -10 10 10])
          // that would inflate metrics and collapse line grouping if applied directly.
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

    // Handle predefined Unicode CMap encodings for CID fonts. These include:
    //   - UTF-16 CMaps (e.g., /UniJIS-UTF16-H): text is UTF-16BE code units
    //   - UCS-2 CMaps (e.g., /UniGB-UCS2-H): text is UCS-2 (= UTF-16BE for BMP)
    // In both cases, 2-byte charCodes are direct Unicode codepoints for BMP characters.
    // The renderer's showType0Literal/showType0Hex falls back to String.fromCharCode()
    // when toUnicode is empty, so we just need to ensure the font uses the Type0
    // rendering path (2-byte decoding) and is not skipped as a non-embedded CID font.
    if (/\/DescendantFonts/.test(fontObj)) {
      const utf16Match = /\/Encoding\s*\/([\w-]*(?:UTF16|UCS2)[\w-]*)/.exec(fontObj);
      if (utf16Match) {
        codespaceRanges = codespaceRanges || [{ bytes: 2, low: 0, high: 0xFFFF }];
        if (!type0Info) type0Info = { fontFile: null, cidToGidMap: 'identity' };
        // Build charCodeToCID mapping for the ASCII range of predefined UTF-16 CMaps.
        // All Adobe CJK collections (GB1, Japan1, Korea1, CNS1) map ASCII printable
        // chars (U+0020-U+007E) to CIDs 1-95: CID = Unicode - 0x1F.
        // Without this, width lookups use charCode as CID, which misses /W entries
        // for CIDs 1-95 (half-width ASCII) and falls back to /DW (full-width).
        if (!charCodeToCID) {
          charCodeToCID = new Map();
          for (let u = 0x0020; u <= 0x007E; u++) {
            charCodeToCID.set(u, u - 0x1F);
          }
        }
      }
    }

    // Detect vertical writing mode from CMap encoding name suffix (-V).
    const verticalMode = /\/Encoding\s*\/[\w-]+-V\b/.test(fontObj);

    // Some broken ToUnicode CMaps map ASCII letter charCodes to the same letter
    // with the wrong case (e.g. charCode 69 -> "e" instead of "E"). Detect a
    // consistent pattern so extraction can prefer encodingUnicode case safely.
    let preferEncodingCase = false;
    if (!cidFontText && !type3Info && toUnicode.size > 0 && encodingUnicode.size > 0) {
      let caseConflictCount = 0;
      for (let code = 65; code <= 122; code++) {
        if (code > 90 && code < 97) continue;
        const tu = toUnicode.get(code);
        const eu = encodingUnicode.get(code);
        if (!tu || !eu || tu.length !== 1 || eu.length !== 1) continue;
        if (!/[A-Za-z]/.test(tu) || !/[A-Za-z]/.test(eu)) continue;
        if (tu !== eu && tu.toLowerCase() === eu.toLowerCase()) {
          caseConflictCount++;
        }
      }
      preferEncodingCase = caseConflictCount >= 4;
    }

    // Detect charCodes where the PDF's encoding-derived Unicode and the ToUnicode CMap disagree.
    /** @type {Map<number, { encoding: string, toUnicode: string }>|null} */
    let encodingToUnicodeConflicts = null;
    if (encodingUnicode.size > 0 && toUnicode.size > 0) {
      // Equivalences that aren't byte-for-byte identical but represent the same content
      // and should NOT be flagged as conflicts. Currently just precomposed ligatures
      // versus their AGL decompositions.
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

    const fontInfo = {
      baseName,
      toUnicode,
      widths,
      defaultWidth,
      ascent,
      descent,
      bold,
      italic,
      smallCaps,
      familyName,
      type3: type3Info ? {
        fontMatrix: type3Info.fontMatrix,
        encoding: type3Info.encoding,
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
      verticalMode,
      preferEncodingCase,
      fontObjNum,
    };
    fonts.set(fontTag, fontInfo);
    if (fontObjNum !== null) objCache.fontCache.set(fontObjNum, fontInfo);
  }

  const normalizeFamilyForMatch = (name = '') => name.toLowerCase().replace(/psmt$|ps$|mt$/, '');
  const familiesCompatible = (a, b) => {
    if (!a || !b) return false;
    return a === b || a.startsWith(b) || b.startsWith(a);
  };
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

  // Post-processing: inherit CID→Unicode mappings from sibling fonts when the
  // current font has no ToUnicode. This is common in producer bugs where only
  // some subset/style variants carry a ToUnicode CMap.
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

    // Existing broad fallback for non-Type0 fonts.
    if (!font.type0) {
      for (const sibling of familyDonors) {
        for (const [cid, uni] of sibling.toUnicode) {
          if (!font.toUnicode.has(cid)) font.toUnicode.set(cid, uni);
        }
      }
      continue;
    }

    // For Type0 fonts, be strict: only inherit from a sibling with near-identical
    // width table and matching codespace. This avoids overfitting across unrelated
    // CID assignments that happen to share a family name.
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
      // Ambiguity guard: if style-matched candidates disagree on CID mapping
      // substantially, don't inherit.
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
function parseToUnicodeCMap(cmapText, map) {
  const bfcharRegex = /beginbfchar\s*([\s\S]*?)endbfchar/g;
  const bfcharMatches = [...cmapText.matchAll(bfcharRegex)];
  for (const m of bfcharMatches) {
    const entries = [...m[1].matchAll(/<([0-9A-Fa-f\s]+)>\s*<([0-9A-Fa-f\s]+)>/g)];
    for (const entry of entries) {
      const cid = parseInt(entry[1], 16);
      const unicode = hexToUnicode(entry[2]);
      map.set(cid, unicode);
    }
  }

  const bfrangeRegex = /beginbfrange\s*([\s\S]*?)endbfrange/g;
  const bfrangeMatches = [...cmapText.matchAll(bfrangeRegex)];
  for (const bfm of bfrangeMatches) {
    // Match each range entry: <start> <end> <unicodeStart> OR <start> <end> [<u1> <u2> ...]
    // Use a regex per-entry to handle CMaps without newlines between entries.
    const entryRegex = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(?:\[([\s\S]*?)\]|<([0-9A-Fa-f]+)>)/g;
    const entries = [...bfm[1].matchAll(entryRegex)];
    for (const entry of entries) {
      const cidStart = parseInt(entry[1], 16);
      const cidEnd = parseInt(entry[2], 16);
      if (entry[4] !== undefined) {
        // Single start value: <start> <end> <unicodeStart>
        let unicodeStart = parseInt(entry[4], 16);
        for (let cid = cidStart; cid <= cidEnd; cid++) {
          if (unicodeStart <= 0x10FFFF) map.set(cid, String.fromCodePoint(unicodeStart));
          unicodeStart++;
        }
      } else if (entry[3] !== undefined) {
        // Array form: <start> <end> [<u1> <u2> ...]
        const arrayTokens = [...entry[3].matchAll(/<([0-9A-Fa-f]+)>/g)];
        for (let idx = 0; idx < arrayTokens.length && cidStart + idx <= cidEnd; idx++) {
          map.set(cidStart + idx, hexToUnicode(arrayTokens[idx][1]));
        }
      }
    }
  }
}

/**
 * Parse a CID encoding CMap and populate a charCode→CID map.
 * This handles the /Encoding reference in Type0 fonts when it's a CMap stream
 * (not a predefined name like /Identity-H).
 * @param {string} cmapText
 * @param {Map<number, number>} map - charCode → CID
 */
function parseCIDEncodingCMap(cmapText, map) {
  // Parse begincidchar blocks: <charCode> <CID>
  const cidcharRegex = /begincidchar\s*([\s\S]*?)endcidchar/g;
  for (const m of cmapText.matchAll(cidcharRegex)) {
    for (const entry of m[1].matchAll(/<([0-9A-Fa-f]+)>\s+(\d+)/g)) {
      map.set(parseInt(entry[1], 16), parseInt(entry[2], 10));
    }
  }

  // Parse begincidrange blocks: <start> <end> <CIDstart>
  const cidrangeRegex = /begincidrange\s*([\s\S]*?)endcidrange/g;
  for (const m of cmapText.matchAll(cidrangeRegex)) {
    for (const entry of m[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s+(\d+)/g)) {
      const start = parseInt(entry[1], 16);
      const end = parseInt(entry[2], 16);
      let cidStart = parseInt(entry[3], 10);
      for (let code = start; code <= end; code++) {
        map.set(code, cidStart++);
      }
    }
  }

  // Parse beginbfchar blocks used as encoding CMaps: <charCode> <CID_hex>
  // Some PDFs use bfchar/bfrange syntax in encoding CMaps where both values are hex.
  const bfcharRegex = /beginbfchar\s*([\s\S]*?)endbfchar/g;
  for (const m of cmapText.matchAll(bfcharRegex)) {
    for (const entry of m[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
      map.set(parseInt(entry[1], 16), parseInt(entry[2], 16));
    }
  }

  // Parse beginbfrange blocks used as encoding CMaps: <start> <end> <CIDstart_hex>
  const bfrangeRegex = /beginbfrange\s*([\s\S]*?)endbfrange/g;
  for (const m of cmapText.matchAll(bfrangeRegex)) {
    for (const entry of m[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
      const start = parseInt(entry[1], 16);
      const end = parseInt(entry[2], 16);
      let cidStart = parseInt(entry[3], 16);
      for (let code = start; code <= end; code++) {
        map.set(code, cidStart++);
      }
    }
  }
}

/**
 * Parse codespace ranges from a CMap to determine byte widths for character codes.
 * Returns null if all ranges use the same width (uniform 2-byte is the common case),
 * or a sorted array of {bytes, low, high} for mixed-width CMaps (e.g. 1-byte space + 2-byte CIDs).
 * @param {string} cmapText
 * @returns {Array<{bytes: number, low: number, high: number}>|null}
 */
function parseCIDCodespaceRanges(cmapText) {
  const ranges = [];
  const csRegex = /begincodespacerange\s*([\s\S]*?)endcodespacerange/g;
  for (const m of cmapText.matchAll(csRegex)) {
    for (const entry of m[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
      const numBytes = Math.ceil(entry[1].length / 2);
      ranges.push({ bytes: numBytes, low: parseInt(entry[1], 16), high: parseInt(entry[2], 16) });
    }
  }
  // Sort by byte length ascending so 1-byte ranges are checked first
  ranges.sort((a, b) => a.bytes - b.bytes);
  // Return null only for uniform 2-byte CMaps — that's the default code path.
  // Uniform 1-byte CMaps (e.g. OneByteIdentityH) must return ranges so callers
  // know to use 1-byte decoding instead of the default 2-byte assumption.
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
 * Parse CID font /W array for per-CID widths.
 * Format: [CID [w1 w2 ...]] (sequential) or [CID1 CID2 w] (range)
 * @param {string} cidFontText
 * @param {Map<number, number>} widths
 */
function parseCIDWidths(cidFontText, widths) {
  // Find /W array with balanced brackets (can't use simple regex due to nested arrays)
  const wStart = cidFontText.indexOf('/W');
  if (wStart === -1) return;
  const bracketStart = cidFontText.indexOf('[', wStart);
  if (bracketStart === -1) return;

  // Find the matching closing bracket
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

  // Process tokens
  i = 0;
  while (i < tokens.length) {
    if (typeof tokens[i] === 'number' && i + 1 < tokens.length && Array.isArray(tokens[i + 1])) {
      // Sequential format: CID [w1 w2 w3 ...]
      const startCID = /** @type {number} */ (tokens[i]);
      const ws = /** @type {number[]} */ (tokens[i + 1]);
      for (let j = 0; j < ws.length; j++) {
        widths.set(startCID + j, ws[j]);
      }
      i += 2;
    } else if (typeof tokens[i] === 'number' && typeof tokens[i + 1] === 'number' && typeof tokens[i + 2] === 'number') {
      // Range format: CID1 CID2 w
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
 * Extract Type0 (CIDFontType2) font files directly from raw PDF bytes.
 * @param {Uint8Array} pdfBytes
 * @returns {{ [fontObjNum: number]: Type0FontInfo }}
 */
export function extractType0Fonts(pdfBytes) {
  const xrefOffset = findXrefOffset(pdfBytes);
  const xrefEntries = parseXref(pdfBytes, xrefOffset);
  const objCache = new ObjectCache(pdfBytes, xrefEntries);

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
 * @param {string} fontObjText - The Type0 font object text
 * @param {ObjectCache} objCache
 * @returns {Type0FontInfo|null}
 */
function extractType0FontFile(fontObjText, objCache) {
  // Extract font name (strip subset prefix like AAAAAA+)
  // /BaseFont can be a name (/ArialMT) or a hex string (<feff0041...> = UTF-16BE)
  const baseNameMatch = /\/BaseFont\s*\/([^\s/<>\[\]]+)/.exec(fontObjText);
  const baseNameHexMatch2 = !baseNameMatch && /\/BaseFont\s*<([0-9A-Fa-f]+)>/.exec(fontObjText);
  let fontName;
  if (baseNameMatch) {
    fontName = baseNameMatch[1].replace(/^[A-Z]{6}\+/, '');
  } else if (baseNameHexMatch2) {
    const hex = baseNameHexMatch2[1];
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

  // Follow DescendantFonts reference to get the CIDFont object.
  // Can be inline array (/DescendantFonts [15 0 R]) or indirect (/DescendantFonts 14 0 R).
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

  // Verify this is a CIDFontType2 (TrueType-based CID font)
  if (!/\/Subtype\s*\/CIDFontType2/.test(cidFontText)) return null;

  // Follow FontDescriptor reference
  const fdRefMatch = /\/FontDescriptor\s+(\d+)\s+\d+\s+R/.exec(cidFontText);
  if (!fdRefMatch) return null;

  const fdText = objCache.getObjectText(Number(fdRefMatch[1]));
  if (!fdText) return null;

  // Follow FontFile2 reference to get the raw TrueType data
  const ff2RefMatch = /\/FontFile2\s+(\d+)\s+\d+\s+R/.exec(fdText);
  if (!ff2RefMatch) return null;

  const fontFile = objCache.getStreamBytes(Number(ff2RefMatch[1]));
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
 * Handles d0/d1 for advance width, cm transformation, and all drawing operators.
 * @param {string} streamText
 * @returns {{ commands: PathCommand[], advanceWidth: number, inlineImage?: any,
 * doXObject?: { name: string, cm: number[] }, paintMode?: string, evenOdd?: boolean,
 * lineWidth?: number, dashArray?: number[], dashPhase?: number }}
 */
export function parseGlyphStreamPaths(streamText) {
  // Parse d0/d1 for advance width
  let advanceWidth = 0;
  const d1Match = /([\d.+-]+)\s+([\d.+-]+)\s+([\d.+-]+)\s+([\d.+-]+)\s+([\d.+-]+)\s+([\d.+-]+)\s+d1/.exec(streamText);
  const d0Match = /([\d.+-]+)\s+([\d.+-]+)\s+d0/.exec(streamText);
  if (d1Match) advanceWidth = Number(d1Match[1]);
  else if (d0Match) advanceWidth = Number(d0Match[1]);

  // Parse line width (w operator)
  let glyphLineWidth = 1;
  const wMatch = /([\d.+-]+)\s+w(?:\s|$)/m.exec(streamText);
  if (wMatch) glyphLineWidth = Number(wMatch[1]);

  // Parse dash pattern (d operator): [ array ] phase d
  let dashArray = [];
  let dashPhase = 0;
  const dashOpMatch = /\[\s*([\d.\s]*)\s*\]\s*([\d.+-]+)\s+d(?:\s|$)/m.exec(streamText);
  if (dashOpMatch) {
    dashArray = dashOpMatch[1].trim() ? dashOpMatch[1].trim().split(/\s+/).map(Number) : [];
    dashPhase = Number(dashOpMatch[2]);
  }

  // Parse cm transformation: a b c d tx ty cm
  // May be preceded by q (save graphics state) or appear directly after d0/d1.
  let cmA = 1;
  let cmB = 0;
  let cmC = 0;
  let cmD = 1;
  let cmTx = 0;
  let cmTy = 0;
  const cmMatch = /(?:q|d[01])\s+([\d.+-]+)\s+([\d.+-]+)\s+([\d.+-]+)\s+([\d.+-]+)\s+([\d.+-]+)\s+([\d.+-]+)\s+cm/.exec(streamText);
  if (cmMatch) {
    cmA = Number(cmMatch[1]);
    cmB = Number(cmMatch[2]);
    cmC = Number(cmMatch[3]);
    cmD = Number(cmMatch[4]);
    cmTx = Number(cmMatch[5]);
    cmTy = Number(cmMatch[6]);
  }

  /**
   * Apply the cm affine transformation to a point.
   * @param {number} x
   * @param {number} y
   */
  function transform(x, y) {
    return { x: cmA * x + cmC * y + cmTx, y: cmB * x + cmD * y + cmTy };
  }

  // Check for inline image (BI/ID/EI) — Type3 glyphs can use bitmap images.
  // BI can be followed by any whitespace (space, \n, \r), and ID/EI can be
  // preceded by any whitespace or delimiter character.
  let inlineImage = null;
  const biMatch = /BI[\s]/.exec(streamText);
  if (biMatch) {
    const biIdx2 = biMatch.index;
    const idMatch = /[\s\]>)]ID[\s]/.exec(streamText.substring(biIdx2));
    if (idMatch) {
      const idPos = biIdx2 + idMatch.index;
      // Include the delimiter char (e.g. ']') in the dict text
      const dictText = streamText.substring(biIdx2 + 2, idPos + 1).trim();
      // Image data starts after "ID" + the single whitespace char that follows it
      const dataStart = idPos + idMatch[0].length;
      // Find EI: search backwards from end since EI is always near the end
      // of a glyph stream. This avoids false matches in binary image data.
      const afterData = streamText.substring(dataStart);
      let eiPos = -1;
      for (let ei = afterData.length - 2; ei >= 0; ei--) {
        if (afterData.charCodeAt(ei) === 0x45 && afterData.charCodeAt(ei + 1) === 0x49) {
          // Verify EI is followed by whitespace or end-of-string
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

  // Check for XObject reference (Do operator) — Type3 glyphs can paint an image via Do.
  let doXObject = null;
  const doMatch = /\/(\S+)\s+Do/.exec(streamText);
  if (doMatch) {
    doXObject = {
      name: doMatch[1],
      cm: [cmA, cmB, cmC, cmD, cmTx, cmTy],
    };
  }

  // Check for nested text pattern — a Type3 CharProc that delegates drawing to
  // another embedded font (typically a single-glyph Type1/CFF subset). This is
  // a common "glyph indirection" optimization used by some PDF producers
  // (seen e.g. in 3M's archived data sheets): each Type3 glyph wraps a Tj call
  // against a single-glyph Type1 font. Structure:
  //   {width} 0 {bbox} d1
  //   q {cm} cm BT /FontName {size} Tf {tm} Tm (char)Tj ET Q
  // Without nested-text support the vector-path parser below skips everything
  // inside BT/ET (to avoid misinterpreting font args as path ops), leaving the
  // glyph as "nothing to draw" — entire body text disappears from the page.
  let nestedText = null;
  const ntRegex = /BT\s*\/(\S+)\s+([\d.+-]+)\s+Tf\s*(?:([\d.+-]+)\s+([\d.+-]+)\s+([\d.+-]+)\s+([\d.+-]+)\s+([\d.+-]+)\s+([\d.+-]+)\s+Tm\s*)?\(((?:[^()\\]|\\.)*)\)\s*Tj\s*ET/;
  const ntMatch = ntRegex.exec(streamText);
  if (ntMatch) {
    const rawText = ntMatch[9]
      .replace(/\\\(/g, '(')
      .replace(/\\\)/g, ')')
      .replace(/\\\\/g, '\\');
    nestedText = {
      fontName: ntMatch[1],
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
  const drawingStart = cmMatch ? streamText.indexOf('cm', cmMatch.index) + 2 : 0;
  const drawingPart = streamText.substring(drawingStart);

  // Strip PDF comments (% to end of line) before tokenizing
  const uncommented = drawingPart.replace(/%[^\r\n]*/g, '');
  const tokens = uncommented.match(/[+-]?(?:\d+\.?\d*|\.\d+)|[a-zA-Z*]+/g);
  if (!tokens) {
    return {
      commands, advanceWidth, doXObject: doXObject || undefined, nestedText: nestedText || undefined,
    };
  }

  const numStack = [];
  let inTextBlock = false;
  for (const tok of tokens) {
    // Skip text block contents (BT...ET) to avoid misinterpreting
    // font names/arguments as drawing operators (e.g. 'B' in '/FType3B').
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
          }
          numStack.length = 0;
          break;
        }
        case 'l': {
          if (numStack.length >= 2) {
            const n = numStack.length;
            const p = transform(numStack[n - 2], numStack[n - 1]);
            commands.push({ type: 'L', x: p.x, y: p.y });
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
          }
          numStack.length = 0;
          break;
        }
        case 'h':
          commands.push({ type: 'Z' });
          numStack.length = 0;
          break;
        case 'f':
        case 'F':
          paintMode = 'fill';
          if (commands.length > 0 && commands[commands.length - 1].type !== 'Z') {
            commands.push({ type: 'Z' });
          }
          numStack.length = 0;
          break;
        case 'f*':
          paintMode = 'fill';
          evenOdd = true;
          if (commands.length > 0 && commands[commands.length - 1].type !== 'Z') {
            commands.push({ type: 'Z' });
          }
          numStack.length = 0;
          break;
        case 'S':
        case 's':
          paintMode = 'stroke';
          if (commands.length > 0 && commands[commands.length - 1].type !== 'Z') {
            commands.push({ type: 'Z' });
          }
          numStack.length = 0;
          break;
        case 'B':
        case 'b':
          paintMode = 'fillStroke';
          if (commands.length > 0 && commands[commands.length - 1].type !== 'Z') {
            commands.push({ type: 'Z' });
          }
          numStack.length = 0;
          break;
        case 'B*':
        case 'b*':
          paintMode = 'fillStroke';
          evenOdd = true;
          if (commands.length > 0 && commands[commands.length - 1].type !== 'Z') {
            commands.push({ type: 'Z' });
          }
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
 * @param {string} objText - The Type3 font object text
 * @param {ObjectCache} objCache
 * @returns {Type0FontInfo|null}
 */
function buildType3OpentypeFont(objText, objCache) {
  // Extract FontMatrix
  const fmStr = resolveArrayValue(objText, 'FontMatrix', objCache);
  const fontMatrix = fmStr ? fmStr.split(/\s+/).map(Number) : [0.001, 0, 0, 0.001, 0, 0];

  // Extract FontBBox
  const fbStr = resolveArrayValue(objText, 'FontBBox', objCache);
  const fontBBox = fbStr ? fbStr.split(/\s+/).map(Number) : [0, 0, 0, 0];

  const nameMatch = /\/Name\s*\/([^\s/]+)/.exec(objText);
  const fontName = nameMatch ? nameMatch[1] : 'Type3Font';

  // Scaling: convert glyph space to OpenType units.
  // FontMatrix maps glyph space → text space. OpenType maps units → em (1 em = 1 text space unit).
  // So: opentype_coord = glyph_coord * fontMatrix_scale * unitsPerEm
  const unitsPerEm = 1000;
  const scaleX = fontMatrix[0] * unitsPerEm;
  const scaleY = fontMatrix[3] * unitsPerEm;

  // Derive ascender/descender from FontBBox if it's not the placeholder [-10,-10,10,10]
  const isPlaceholderBBox = fontBBox[0] === -10 && fontBBox[1] === -10 && fontBBox[2] === 10 && fontBBox[3] === 10;
  const ascender = isPlaceholderBBox ? Math.round(unitsPerEm * 0.8) : Math.round(fontBBox[3] * scaleY);
  const descender = isPlaceholderBBox ? Math.round(-unitsPerEm * 0.2) : Math.round(fontBBox[1] * scaleY);

  // Extract CharProcs
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
  let unicodeCounter = 0xE000; // Private Use Area for placeholder encoding

  const charProcMatches = [...charProcsDict.matchAll(/\/(\S+?)\s+(\d+)\s+\d+\s+R/g)];
  for (const match of charProcMatches) {
    const glyphName = match[1];
    const streamObjNum = Number(match[2]);

    const streamBytes = objCache.getStreamBytes(streamObjNum);
    if (!streamBytes) continue;

    const streamText = new TextDecoder('latin1').decode(streamBytes);
    const pathData = parseGlyphStreamPaths(streamText);

    // Convert path commands to an OpenType.js Path, scaling to OpenType units
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

    const glyph = new opentype.Glyph({
      name: glyphName,
      unicode: unicodeCounter,
      advanceWidth: Math.round(pathData.advanceWidth * scaleX),
      path: opPath,
    });
    glyphs.push(glyph);
    unicodeCounter++;
  }

  if (glyphs.length <= 1) return null; // Only .notdef

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
 * The stext parser produces incorrect bboxes because the placeholder FontBBox [-10,-10,10,10]
 * is used instead of actual glyph dimensions. This function replaces those bboxes using
 * the actual glyph outlines extracted from the raw PDF.
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
          // Map character code to glyph name via encoding
          let charCode = char.text.charCodeAt(0);
          // U+FFFD (replacement character) represents original byte 0
          if (charCode === 0xFFFD) charCode = 0;
          // Reverse PUA mapping: extractPDFTextDirect maps Type3 charCodes to U+E000+charCode
          if (charCode >= 0xE000 && charCode <= 0xE0FF) charCode -= 0xE000;

          const glyphName = fontInfo.encoding[charCode];
          if (!glyphName) continue;

          const glyph = fontInfo.glyphs[glyphName];
          if (!glyph || !glyph.bbox || glyph.advanceWidth === 0) continue;

          // Scale factor: stext width comes from advanceWidth * fontSize * dpi/72
          // so scale = stextWidth / advanceWidth
          const stextWidth = char.bbox.right - char.bbox.left;
          const scale = stextWidth / glyph.advanceWidth;

          // Baseline position: stext top + fontBBox ury * scale
          // FontBBox ury (e.g. 10) scaled gives distance from top to baseline
          const baselineY = char.bbox.top + fontInfo.fontBBox[3] * scale;

          // Corrected bbox from actual glyph outline
          const originX = char.bbox.left;
          char.bbox.left = Math.round(originX + glyph.bbox.x0 * scale);
          char.bbox.right = Math.round(originX + glyph.bbox.x1 * scale);
          char.bbox.top = Math.round(baselineY - glyph.bbox.y1 * scale);
          char.bbox.bottom = Math.round(baselineY - glyph.bbox.y0 * scale);

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
