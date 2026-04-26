import opentype from '../../font-parser/src/index.js';
import { standardNames, cffStandardEncoding } from '../../font-parser/src/encoding.js';
import { aglMap, aglLookup } from './standardEncodings.js';

/**
 * @typedef {{
 *   baseName?: string,
 *   toUnicode?: Map<number, string>,
 *   charCodeToCID?: Map<number, number>,
 *   differences?: Record<string, string>,
 *   encodingUnicode?: Map<number, string>,
 *   isCIDFont?: boolean,
 *   ascent?: number,
 *   descent?: number,
 *   widths?: Map<number, number>,
 *   type1?: { fontMatrix?: number[] },
 *   bold?: boolean,
 *   italic?: boolean,
 * }} PdfFontObj
 */

/**
 * Read a CFF offset of 1-4 bytes.
 * @param {Uint8Array} data
 * @param {number} pos
 * @param {number} offSize
 * @returns {number}
 */
export function readCFFOffset(data, pos, offSize) {
  let val = 0;
  for (let i = 0; i < offSize; i++) val = (val << 8) | data[pos + i];
  return val;
}

/**
 * Parse a CFF DICT data block into key-value pairs.
 * Returns a map from operator -> last operand value (simplified for our needs).
 */
export function parseCFFDict(data) {
  const entries = {};
  const operands = [];
  let i = 0;
  while (i < data.length) {
    const b0 = data[i];
    if (b0 >= 32 && b0 <= 246) {
      operands.push(b0 - 139);
      i++;
    } else if (b0 >= 247 && b0 <= 250) {
      operands.push((b0 - 247) * 256 + data[i + 1] + 108);
      i += 2;
    } else if (b0 >= 251 && b0 <= 254) {
      operands.push(-(b0 - 251) * 256 - data[i + 1] - 108);
      i += 2;
    } else if (b0 === 28) {
      operands.push((data[i + 1] << 8) | data[i + 2]);
      i += 3;
    } else if (b0 === 29) {
      operands.push((data[i + 1] << 24) | (data[i + 2] << 16) | (data[i + 3] << 8) | data[i + 4]);
      i += 5;
    } else if (b0 === 30) {
      // Real number — skip for our purposes
      i++;
      while (i < data.length) {
        const nib = data[i++];
        if ((nib & 0x0F) === 0x0F || (nib >> 4) === 0x0F) break;
      }
      operands.push(0);
    } else if (b0 <= 21) {
      // Operator
      let op = b0;
      if (b0 === 12 && i + 1 < data.length) {
        op = 1200 + data[i + 1];
        i += 2;
      } else {
        i++;
      }
      if (operands.length > 0) entries[op] = operands[operands.length - 1];
      operands.length = 0;
    } else {
      i++;
    }
  }
  return entries;
}

const CFF_STANDARD_STRINGS = [
  // SID 0-7
  '.notdef', 'space', 'exclam', 'quotedbl', 'numbersign', 'dollar', 'percent', 'ampersand',
  // SID 8-15
  'quoteright', 'parenleft', 'parenright', 'asterisk', 'plus', 'comma', 'hyphen', 'period',
  // SID 16-26
  'slash', 'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
  // SID 27-33
  'colon', 'semicolon', 'less', 'equal', 'greater', 'question', 'at',
  // SID 34-59 (A-Z)
  'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q',
  'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z',
  // SID 60-65
  'bracketleft', 'backslash', 'bracketright', 'asciicircum', 'underscore', 'quoteleft',
  // SID 66-91 (a-z)
  'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm', 'n', 'o', 'p', 'q',
  'r', 's', 't', 'u', 'v', 'w', 'x', 'y', 'z',
  // SID 92-95
  'braceleft', 'bar', 'braceright', 'asciitilde',
  // SID 96-137
  'exclamdown', 'cent', 'sterling', 'fraction', 'yen', 'florin', 'section', 'currency',
  'quotesingle', 'quotedblleft', 'guillemotleft', 'guilsinglleft', 'guilsinglright', 'fi', 'fl',
  'endash', 'dagger', 'daggerdbl', 'periodcentered', 'paragraph', 'bullet',
  'quotesinglbase', 'quotedblbase', 'quotedblright', 'guillemotright', 'ellipsis', 'perthousand',
  'questiondown', 'grave', 'acute', 'circumflex', 'tilde', 'macron', 'breve',
  'dotaccent', 'dieresis', 'ring', 'cedilla', 'hungarumlaut', 'ogonek', 'caron',
  'emdash',
  // SID 138-149
  'AE', 'ordfeminine', 'Lslash', 'Oslash', 'OE', 'ordmasculine',
  'ae', 'dotlessi', 'lslash', 'oslash', 'oe', 'germandbls',
  // SID 150-170
  'onesuperior', 'logicalnot', 'mu', 'trademark', 'Eth', 'onehalf', 'plusminus', 'Thorn',
  'onequarter', 'divide', 'brokenbar', 'degree', 'thorn', 'threequarters', 'twosuperior',
  'registered', 'minus', 'eth', 'multiply', 'threesuperior', 'copyright',
  // SID 171-228
  'Aacute', 'Acircumflex', 'Adieresis', 'Agrave', 'Aring', 'Atilde', 'Ccedilla', 'Eacute',
  'Ecircumflex', 'Edieresis', 'Egrave', 'Iacute', 'Icircumflex', 'Idieresis', 'Igrave',
  'Ntilde', 'Oacute', 'Ocircumflex', 'Odieresis', 'Ograve', 'Otilde', 'Scaron', 'Uacute',
  'Ucircumflex', 'Udieresis', 'Ugrave', 'Yacute', 'Ydieresis', 'Zcaron',
  'aacute', 'acircumflex', 'adieresis', 'agrave', 'aring', 'atilde', 'ccedilla', 'eacute',
  'ecircumflex', 'edieresis', 'egrave', 'iacute', 'icircumflex', 'idieresis', 'igrave',
  'ntilde', 'oacute', 'ocircumflex', 'odieresis', 'ograve', 'otilde', 'scaron', 'uacute',
  'ucircumflex', 'udieresis', 'ugrave', 'yacute', 'ydieresis', 'zcaron',
  // SID 229-268
  'exclamsmall', 'Hungarumlautsmall', 'dollaroldstyle', 'dollarsuperior', 'ampersandsmall',
  'Acutesmall', 'parenleftsuperior', 'parenrightsuperior', 'twodotenleader', 'onedotenleader',
  'zerooldstyle', 'oneoldstyle', 'twooldstyle', 'threeoldstyle', 'fouroldstyle', 'fiveoldstyle',
  'sixoldstyle', 'sevenoldstyle', 'eightoldstyle', 'nineoldstyle',
  'commasuperior', 'threequartersemdash', 'periodsuperior', 'questionsmall', 'asuperior',
  'bsuperior', 'centsuperior', 'dsuperior', 'esuperior', 'isuperior', 'lsuperior', 'msuperior',
  'nsuperior', 'osuperior', 'rsuperior', 'ssuperior', 'tsuperior', 'ff', 'ffi', 'ffl',
  // SID 269-318
  'parenleftinferior', 'parenrightinferior', 'Circumflexsmall', 'hyphensuperior', 'Gravesmall',
  'Asmall', 'Bsmall', 'Csmall', 'Dsmall', 'Esmall', 'Fsmall', 'Gsmall', 'Hsmall', 'Ismall',
  'Jsmall', 'Ksmall', 'Lsmall', 'Msmall', 'Nsmall', 'Osmall', 'Psmall', 'Qsmall', 'Rsmall',
  'Ssmall', 'Tsmall', 'Usmall', 'Vsmall', 'Wsmall', 'Xsmall', 'Ysmall', 'Zsmall',
  'colonmonetary', 'onefitted', 'rupiah', 'Tildesmall', 'exclamdownsmall', 'centoldstyle',
  'Lslashsmall', 'Scaronsmall', 'Zcaronsmall', 'Dieresissmall', 'Brevesmall', 'Caronsmall',
  'Dotaccentsmall', 'Macronsmall', 'figuredash', 'hypheninferior', 'Ogoneksmall', 'Ringsmall',
  'Cedillasmall',
  // SID 319-390
  'questiondownsmall', 'oneeighth', 'threeeighths', 'fiveeighths', 'seveneighths', 'onethird',
  'twothirds', 'zerosuperior', 'foursuperior', 'fivesuperior', 'sixsuperior', 'sevensuperior',
  'eightsuperior', 'ninesuperior', 'zeroinferior', 'oneinferior', 'twoinferior', 'threeinferior',
  'fourinferior', 'fiveinferior', 'sixinferior', 'seveninferior', 'eightinferior', 'nineinferior',
  'centinferior', 'dollarinferior', 'periodinferior', 'commainferior',
  'Agravesmall', 'Aacutesmall', 'Acircumflexsmall', 'Atildesmall', 'Adieresissmall', 'Aringsmall',
  'AEsmall', 'Ccedillasmall', 'Egravesmall', 'Eacutesmall', 'Ecircumflexsmall', 'Edieresissmall',
  'Igravesmall', 'Iacutesmall', 'Icircumflexsmall', 'Idieresissmall', 'Ethsmall', 'Ntildesmall',
  'Ogravesmall', 'Oacutesmall', 'Ocircumflexsmall', 'Otildesmall', 'Odieresissmall', 'OEsmall',
  'Oslashsmall', 'Ugravesmall', 'Uacutesmall', 'Ucircumflexsmall', 'Udieresissmall', 'Yacutesmall',
  'Thornsmall', 'Ydieresissmall',
  '001.000', '001.001', '001.002', '001.003',
  'Black', 'Bold', 'Book', 'Light', 'Medium', 'Regular', 'Roman', 'Semibold',
];

/**
 * Get a CFF string by SID. SIDs 0-390 are standard strings; higher SIDs
 * are looked up in the font's local String INDEX.
 */
export function getCFFString(sid, cffData, hdrSize) {
  if (sid < CFF_STANDARD_STRINGS.length) return CFF_STANDARD_STRINGS[sid] || `sid${sid}`;

  const localIdx = sid - CFF_STANDARD_STRINGS.length;
  let pos = hdrSize;
  const dv = new DataView(cffData.buffer, cffData.byteOffset, cffData.byteLength);

  // Skip Name INDEX
  const nameCount = dv.getUint16(pos);
  if (nameCount === 0) { pos += 2; } else {
    const os = cffData[pos + 2];
    const lastOff = readCFFOffset(cffData, pos + 3 + nameCount * os, os);
    pos = pos + 3 + (nameCount + 1) * os + lastOff - 1;
  }
  // Skip Top DICT INDEX
  const tdCount = dv.getUint16(pos);
  if (tdCount === 0) { pos += 2; } else {
    const os = cffData[pos + 2];
    const lastOff = readCFFOffset(cffData, pos + 3 + tdCount * os, os);
    pos = pos + 3 + (tdCount + 1) * os + lastOff - 1;
  }
  // Now at String INDEX
  const strCount = dv.getUint16(pos);
  if (localIdx >= strCount) return `sid${sid}`;
  const os = cffData[pos + 2];
  const off1 = readCFFOffset(cffData, pos + 3 + localIdx * os, os);
  const off2 = readCFFOffset(cffData, pos + 3 + (localIdx + 1) * os, os);
  const dataStart = pos + 3 + (strCount + 1) * os;
  let s = '';
  for (let i = dataStart + off1 - 1; i < dataStart + off2 - 1 && i < cffData.length; i++) {
    s += String.fromCharCode(cffData[i]);
  }
  return s;
}

/**
 * Parse CFF font data to extract charset info for text extraction.
 * For non-CID CFF: returns glyph names mapped to Unicode via AGL.
 * For CID CFF: returns the set of valid CIDs that have glyphs.
 * @param {Uint8Array} cffData
 */
export function parseCFFCharset(cffData) {
  try {
    if (cffData.length < 4 || cffData[0] !== 1) return null;

    const cffDV = new DataView(cffData.buffer, cffData.byteOffset, cffData.byteLength);
    const hdrSize = cffData[2];

    let pos = hdrSize;
    const nameCount = cffDV.getUint16(pos);
    if (nameCount === 0) { pos += 2; } else {
      const os = cffData[pos + 2];
      const lastOff = readCFFOffset(cffData, pos + 3 + nameCount * os, os);
      pos = pos + 3 + (nameCount + 1) * os + lastOff - 1;
    }

    const tdCount = cffDV.getUint16(pos);
    let charsetOffset = 0;
    let charStringsOffset = 0;
    let isCID = false;
    if (tdCount > 0) {
      const tdOffSize = cffData[pos + 2];
      const tdDataStart = pos + 3 + (tdCount + 1) * tdOffSize;
      const tdOff1 = readCFFOffset(cffData, pos + 3, tdOffSize);
      const tdOff2 = readCFFOffset(cffData, pos + 3 + tdOffSize, tdOffSize);
      const tdBytes = cffData.subarray(tdDataStart + tdOff1 - 1, tdDataStart + tdOff2 - 1);
      const tdEntries = parseCFFDict(tdBytes);
      charsetOffset = tdEntries[15] || 0;
      charStringsOffset = tdEntries[17] || 0;
      isCID = tdEntries[1230] !== undefined;
    }

    let numGlyphs = 1;
    if (charStringsOffset > 0) {
      numGlyphs = cffDV.getUint16(charStringsOffset);
    }

    if (charsetOffset < 2 || charsetOffset >= cffData.length) return null;

    const fmt = cffData[charsetOffset];
    let cp = charsetOffset + 1;

    if (isCID) {
      const validCIDs = new Set([0]);
      if (fmt === 0) {
        for (let gi = 1; gi < numGlyphs && cp + 1 < cffData.length; gi++) {
          validCIDs.add(cffDV.getUint16(cp));
          cp += 2;
        }
      } else if (fmt === 1 || fmt === 2) {
        let gi = 1;
        while (gi < numGlyphs && cp + (fmt === 1 ? 2 : 3) < cffData.length) {
          const firstCID = cffDV.getUint16(cp);
          const nLeft = fmt === 1 ? cffData[cp + 2] : cffDV.getUint16(cp + 2);
          cp += fmt === 1 ? 3 : 4;
          for (let j = 0; j <= nLeft && gi < numGlyphs; j++, gi++) {
            validCIDs.add(firstCID + j);
          }
        }
      }
      return { isCID: true, validCIDs };
    }

    const glyphToUnicode = new Map();
    if (fmt === 0) {
      for (let gi = 1; gi < numGlyphs && cp + 1 < cffData.length; gi++) {
        const name = getCFFString(cffDV.getUint16(cp), cffData, hdrSize);
        const uniStr = aglLookup(name);
        if (uniStr) glyphToUnicode.set(gi, uniStr);
        cp += 2;
      }
    } else if (fmt === 1 || fmt === 2) {
      let gi = 1;
      while (gi < numGlyphs && cp + (fmt === 1 ? 2 : 3) < cffData.length) {
        const sid = cffDV.getUint16(cp);
        const nLeft = fmt === 1 ? cffData[cp + 2] : cffDV.getUint16(cp + 2);
        cp += fmt === 1 ? 3 : 4;
        for (let j = 0; j <= nLeft && gi < numGlyphs; j++, gi++) {
          const name = getCFFString(sid + j, cffData, hdrSize);
          const uniStr = aglLookup(name);
          if (uniStr) glyphToUnicode.set(gi, uniStr);
        }
      }
    }
    return { isCID: false, glyphToUnicode };
  } catch {
    return null;
  }
}

/**
 * Extract CID→GID mapping from raw CFF charset bytes.
 * In CID CFF fonts, charset entries are CID values (stored as 2-byte SIDs).
 * @param {Uint8Array} cffData
 */
function extractCIDToGIDFromCFF(cffData) {
  const cidToGID = new Map();
  if (cffData.length < 4 || cffData[0] !== 1) return cidToGID;

  const dv = new DataView(cffData.buffer, cffData.byteOffset, cffData.byteLength);
  const hdrSize = cffData[2];

  let pos = hdrSize;
  const nameCount = dv.getUint16(pos);
  if (nameCount === 0) { pos += 2; } else {
    const os = cffData[pos + 2];
    const lastOff = readCFFOffset(cffData, pos + 3 + nameCount * os, os);
    pos = pos + 3 + (nameCount + 1) * os + lastOff - 1;
  }
  const tdCount = dv.getUint16(pos);
  if (tdCount === 0) return cidToGID;
  const tdOffSize = cffData[pos + 2];
  const tdDataStart = pos + 3 + (tdCount + 1) * tdOffSize;
  const tdOff1 = readCFFOffset(cffData, pos + 3, tdOffSize);
  const tdOff2 = readCFFOffset(cffData, pos + 3 + tdOffSize, tdOffSize);
  const tdBytes = cffData.subarray(tdDataStart + tdOff1 - 1, tdDataStart + tdOff2 - 1);
  const tdEntries = parseCFFDict(tdBytes);

  const charsetOffset = tdEntries[15] || 0;
  const charStringsOffset = tdEntries[17] || 0;
  if (charsetOffset < 2 || charStringsOffset === 0) return cidToGID;

  const numGlyphs = dv.getUint16(charStringsOffset);
  const fmt = cffData[charsetOffset];
  let cp = charsetOffset + 1;
  if (fmt === 0) {
    for (let gi = 1; gi < numGlyphs && cp + 1 < cffData.length; gi++) {
      cidToGID.set(dv.getUint16(cp), gi);
      cp += 2;
    }
  } else if (fmt === 1 || fmt === 2) {
    let gi = 1;
    while (gi < numGlyphs && cp + (fmt === 1 ? 2 : 3) < cffData.length) {
      const firstCID = dv.getUint16(cp);
      const nLeft = fmt === 1 ? cffData[cp + 2] : dv.getUint16(cp + 2);
      cp += fmt === 1 ? 3 : 4;
      for (let j = 0; j <= nLeft && gi < numGlyphs; j++, gi++) {
        cidToGID.set(firstCID + j, gi);
      }
    }
  }
  return cidToGID;
}

/**
 * Build a new font from CFF data by parsing charstrings into Path objects
 * via opentype.js's CFF parser, then constructing a new font.
 * @param {Uint8Array} cffData - raw CFF font program bytes
 * @param {PdfFontObj} fontObj - parsed PDF font object
 * @param {Record<string, string>} [encoding] - PDF Differences encoding (charCode → glyphName)
 * @returns {{ otfData: ArrayBuffer, usesPUA: boolean, cidCollisions: Set<number>|null }|null}
 */
export function buildFontFromCFF(cffData, fontObj, encoding) {
  try {
    const dv = new DataView(cffData.buffer, cffData.byteOffset, cffData.byteLength);
    const fontShell = {
      tables: {}, encoding: null, isCIDFont: false, unitsPerEm: 1000,
    };
    opentype.parseCFFTable(dv, 0, fontShell);

    const fm = fontShell.tables.cff.topDict.fontMatrix;
    const unitsPerEm = fm && fm[0] > 0 && fm[0] < 1 ? Math.round(1 / fm[0]) : 1000;
    fontShell.unitsPerEm = unitsPerEm;
    const ascent = fontObj.ascent || Math.round(unitsPerEm * 0.8);
    const rawDescent = fontObj.descent || Math.round(unitsPerEm * -0.2);
    // PDF Descent values are sometimes positive (spec says negative); opentype.js requires negative.
    const descent = rawDescent > 0 ? -rawDescent : rawDescent;

    /** @type {Map<number, number>} unicode codepoint → GID */
    const unicodeToGID = new Map();
    let usesPUA = false;
    /** @type {Set<number>|null} CIDs forced to PUA due to Unicode collision */
    let cidCollisions = null;

    if (fontShell.isCIDFont) {
      const cidToGID = extractCIDToGIDFromCFF(cffData);
      // Build CID→Unicode lookup (same logic as rebuildFontFromGlyphs)
      const cidToUnicode = (!fontObj.charCodeToCID || fontObj.charCodeToCID.size === 0)
        ? fontObj.toUnicode
        : (() => {
          const m = new Map();
          for (const [charCode, cid2] of fontObj.charCodeToCID) {
            if (!m.has(cid2) && fontObj.toUnicode?.has(charCode)) m.set(cid2, fontObj.toUnicode.get(charCode));
          }
          return m;
        })();
      const claimedUnicodes = new Set();
      for (const [cid, gid] of cidToGID) {
        const decision = cidCodepoint(cidToUnicode?.get(cid), cid);
        let { codepoint } = decision;
        let { isPUA } = decision;
        if (!isPUA && claimedUnicodes.has(codepoint)) {
          codepoint = 0xE000 + cid <= 0xF8FF ? 0xE000 + cid : 0xF0000 + cid;
          isPUA = true;
          if (!cidCollisions) cidCollisions = new Set();
          cidCollisions.add(cid);
        }
        if (!isPUA) claimedUnicodes.add(codepoint);
        if (isPUA) usesPUA = true;
        unicodeToGID.set(codepoint, gid);
      }
    } else {
      const charset = fontShell.tables.cff.charset;
      if (charset) {
        for (let gi = 1; gi < charset.length; gi++) {
          const name = charset[gi];
          if (!name) continue;
          const uniStr = aglLookup(name);
          if (uniStr) {
            const cp = uniStr.codePointAt(0);
            if (cp && !unicodeToGID.has(cp)) unicodeToGID.set(cp, gi);
          }
        }
      }
      if (unicodeToGID.size === 0 && fontObj.toUnicode && fontObj.toUnicode.size > 0) {
        for (const [cid, unicode] of fontObj.toUnicode) {
          if (cid === 0 || cid >= fontShell.nGlyphs) continue;
          const cp = unicode.codePointAt(0);
          if (cp && cp > 0 && !unicodeToGID.has(cp)) unicodeToGID.set(cp, cid);
        }
      }
      // Add PUA entries so the renderer can draw glyphs via U+E000+charCode.
      // When /Differences is present, only add PUA entries for explicit
      // /Differences charCodes. For non-/Differences codes, keep normal Unicode
      // rendering unless the glyph name is non-AGL and no Unicode mapping exists
      // (e.g. custom logo glyph names in built-in CFF encodings).
      if (charset) {
        const nameToGID = new Map();
        for (let gi = 1; gi < charset.length; gi++) {
          if (charset[gi]) nameToGID.set(charset[gi], gi);
        }
        const hasDifferencesEncoding = !!(encoding && Object.keys(encoding).length > 0);
        const diffCodeSet = hasDifferencesEncoding ? new Set(Object.keys(encoding).map(Number)) : null;
        /** @type {Map<number, number>} */
        const cffBaseEncoding = new Map();
        const addBaseEncodingEntry = (code, gid) => {
          if (!Number.isFinite(code) || code < 0 || code > 255) return;
          if (!Number.isFinite(gid) || gid <= 0) return;
          if (!cffBaseEncoding.has(code)) cffBaseEncoding.set(code, gid);
        };
        // PUA entries from /Differences encoding
        if (encoding) {
          for (const [charCodeStr, glyphName] of Object.entries(encoding)) {
            const charCode = Number(charCodeStr);
            const gid = nameToGID.get(glyphName);
            if (gid === undefined) continue;
            const puaCode = 0xE000 + charCode;
            if (!unicodeToGID.has(puaCode)) {
              unicodeToGID.set(puaCode, gid);
              usesPUA = true;
            }
          }
        }
        // Collect built-in CFF encoding charCode→GID mappings.
        const cffEncArray = fontShell.tables.cff.encoding;
        if (cffEncArray) {
          for (let code = 0; code < cffEncArray.length; code++) {
            addBaseEncodingEntry(code, cffEncArray[code]);
          }
        }
        // CFF encoding may be stored in fontShell.cffEncoding or fontShell.encoding
        // (depends on the font-parser path taken).
        const cffEncObj = fontShell.cffEncoding || fontShell.encoding;
        if (cffEncObj && cffEncObj.encoding) {
          const cffEnc = cffEncObj.encoding;
          for (const [codeStr, idx] of Object.entries(cffEnc)) {
            // Skip empty/non-numeric values — some CFF parsers return empty strings
            // for pre-defined encodings (StandardEncoding) they didn't expand.
            if (idx === '' || (typeof idx === 'string' && idx.length === 0)) continue;
            const numIdx = typeof idx === 'number' ? idx : Number(idx);
            const code = Number(codeStr);
            if (!Number.isFinite(numIdx)) continue;
            // Resolve through charset: encoding index → glyph name → GID
            const glyphName = charset[numIdx + 1];
            const gid = glyphName ? nameToGID.get(glyphName) : undefined;
            addBaseEncodingEntry(code, gid);
          }
        }
        // Fallback: when the CFF encoding was empty or had only invalid entries
        // (e.g., pre-defined StandardEncoding not expanded by the parser), derive
        // charCode→GID from StandardEncoding glyph names.
        if (cffBaseEncoding.size === 0) {
          for (let code = 32; code < cffStandardEncoding.length; code++) {
            const glyphName = cffStandardEncoding[code];
            if (!glyphName) continue;
            addBaseEncodingEntry(code, nameToGID.get(glyphName));
          }
        }

        // PUA entries from the CFF's built-in encoding are only needed when no
        // /Differences encoding is present. With /Differences, broad built-in PUA
        // entries can incorrectly claim standard ASCII charCodes.
        if (!hasDifferencesEncoding) {
          for (const [code, gid] of cffBaseEncoding) {
            if (fontObj.encodingUnicode?.has(code) && !(diffCodeSet && diffCodeSet.has(code))) continue;
            const puaCode = 0xE000 + code;
            if (!unicodeToGID.has(puaCode)) {
              unicodeToGID.set(puaCode, gid);
              usesPUA = true;
            }
          }
        }

        // Preserve base-encoding glyph mapping for non-AGL glyph names when no
        // Unicode mapping exists. This keeps custom logo glyphs renderable in fonts
        // that use /Differences only for high charCodes (e.g., IBMLogo in 2620504.pdf).
        for (const [code, gid] of cffBaseEncoding) {
          if (diffCodeSet && diffCodeSet.has(code)) continue;
          if (fontObj.encodingUnicode?.has(code) || fontObj.toUnicode?.has(code)) continue;
          if (unicodeToGID.has(code)) continue;
          const glyphName = charset[gid];
          if (!glyphName || aglLookup(glyphName)) continue;
          unicodeToGID.set(code, gid);
        }
      }
    }

    const notdefPath = new opentype.Path();
    const glyphs = [new opentype.Glyph({
      name: '.notdef', unicode: 0, advanceWidth: 0, path: notdefPath,
    })];
    const usedUnicodes = new Set([0]);

    // If the CFF fontMatrix has a non-zero shear component (fm[2]), the font is oblique/italic.
    // CFF glyph outlines are stored in glyph space and must be transformed by the fontMatrix
    // to produce the actual shape. The scaling (fm[0]/fm[3]) is handled by unitsPerEm, but the
    // shear must be applied explicitly to the path coordinates: x' = x + shear * y.
    const shear = fm && Math.abs(fm[2]) > 1e-9 ? fm[2] / fm[0] : 0;
    // If the CFF fontMatrix has a negative Y scale (fm[3] < 0), the glyph outlines are designed
    // in a Y-down coordinate system. OTF expects Y-up, so negate all Y coordinates.
    const yFlip = fm && fm[3] < 0;

    for (const [unicode, gid] of unicodeToGID) {
      if (gid <= 0 || gid >= fontShell.nGlyphs || usedUnicodes.has(unicode)) continue;
      usedUnicodes.add(unicode);
      const g = fontShell.glyphs.get(gid);
      let { path } = g;
      if (shear || yFlip) {
        path = new opentype.Path();
        for (const cmd of g.path.commands) {
          const c = { ...cmd };
          if (shear) {
            if (c.x !== undefined) c.x = Math.round(c.x + shear * c.y);
            if (c.x1 !== undefined) c.x1 = Math.round(c.x1 + shear * c.y1);
            if (c.x2 !== undefined) c.x2 = Math.round(c.x2 + shear * c.y2);
          }
          if (yFlip) {
            if (c.y !== undefined) c.y = -c.y;
            if (c.y1 !== undefined) c.y1 = -c.y1;
            if (c.y2 !== undefined) c.y2 = -c.y2;
          }
          path.commands.push(c);
        }
      }
      glyphs.push(new opentype.Glyph({
        name: (fontShell.tables.cff.charset && fontShell.tables.cff.charset[gid]) || `glyph_${gid}`,
        unicode,
        advanceWidth: g.advanceWidth || 500,
        path,
      }));
    }

    if (glyphs.length <= 1) return null;

    const familyName = (fontObj.baseName || 'CFFFont').replace(/[^A-Za-z0-9\-]/g, '') || 'CFFFont';
    const font = new opentype.Font({
      familyName,
      styleName: 'Regular',
      unitsPerEm,
      ascender: ascent,
      descender: descent,
      glyphs,
    });

    return { otfData: font.toArrayBuffer(), usesPUA, cidCollisions };
  } catch (_e) {
    // Font building failed — caller logs a warning
    return null;
  }
}

/**
 * Check whether a codepoint is a combining mark or Indic-script dependent vowel/sign
 * that would render as a "dotted circle + mark" placeholder when passed to fillText()
 * without a preceding base character. Covers the Unicode General_Category Mn/Mc ranges
 * most commonly seen in PDF text: general combining diacriticals and all Indic blocks
 * (Devanagari, Bengali, Gurmukhi, Gujarati, Oriya, Tamil, Telugu, Kannada, Malayalam,
 * Sinhala, Thai, Lao, Tibetan, Myanmar, Khmer).
 * @param {number} cp
 */
export function isCombiningOrIndicMark(cp) {
  // Only flag as combining if the specific code point is in Indic combining-marks subranges.
  // Signs (anusvara/visarga) and viramas are combining; base consonants/vowels are not.
  // (Latin Combining Diacritical Marks U+0300-U+036F are NOT included to avoid affecting
  // Latin math/academic fonts that may map precomposed glyphs via these codepoints.)
  const combiningSubranges = [
    [0x0981, 0x0983], // Bengali signs (candrabindu, anusvara, visarga)
    [0x09BC, 0x09BC], // Bengali nuqta
    [0x09BE, 0x09C4], // Bengali dependent vowel signs (aa, i, ii, u, uu, r̥, r̥̄)
    [0x09C7, 0x09C8], // Bengali vowel signs e, ai
    [0x09CB, 0x09CD], // Bengali vowel signs o, au, virama
    [0x09D7, 0x09D7], // Bengali au length mark
    [0x09E2, 0x09E3], // Bengali vowel signs vocalic l, ll
    [0x0900, 0x0903], // Devanagari signs
    [0x093A, 0x093C], // Devanagari signs
    [0x093E, 0x094F], // Devanagari vowel signs + virama
    [0x0951, 0x0957], // Devanagari stress/vedic signs
    [0x0962, 0x0963], // Devanagari vocalic l/ll signs
    [0x0A01, 0x0A03], // Gurmukhi signs
    [0x0A3C, 0x0A3C], // Gurmukhi nuqta
    [0x0A3E, 0x0A4D], // Gurmukhi vowel signs + virama
    [0x0A70, 0x0A71], // Gurmukhi tippi/addak
    [0x0A75, 0x0A75],
    [0x0A81, 0x0A83], // Gujarati signs
    [0x0ABC, 0x0ABC], // Gujarati nuqta
    [0x0ABE, 0x0ACD], // Gujarati vowel signs + virama
    [0x0AE2, 0x0AE3],
    [0x0B01, 0x0B03], // Oriya signs
    [0x0B3C, 0x0B3C],
    [0x0B3E, 0x0B4D],
    [0x0B55, 0x0B57],
    [0x0B62, 0x0B63],
    [0x0BBE, 0x0BCD], // Tamil signs
    [0x0BD7, 0x0BD7],
    [0x0C00, 0x0C04], // Telugu signs
    [0x0C3C, 0x0C3C],
    [0x0C3E, 0x0C4D],
    [0x0C55, 0x0C56],
    [0x0C62, 0x0C63],
    [0x0C81, 0x0C83], // Kannada signs
    [0x0CBC, 0x0CBC],
    [0x0CBE, 0x0CCD],
    [0x0CD5, 0x0CD6],
    [0x0CE2, 0x0CE3],
    [0x0D00, 0x0D03], // Malayalam signs
    [0x0D3B, 0x0D3C],
    [0x0D3E, 0x0D4D],
    [0x0D57, 0x0D57],
    [0x0D62, 0x0D63],
    [0x0D81, 0x0D83], // Sinhala signs
    [0x0DCA, 0x0DCA],
    [0x0DCF, 0x0DDF],
    [0x0DF2, 0x0DF3],
  ];
  for (const [lo, hi] of combiningSubranges) {
    if (cp >= lo && cp <= hi) return true;
  }
  return false;
}

/**
 * Decide the codepoint to use in the font's cmap AND the renderer's fillText()
 * for a CID glyph. Uses real Unicode from ToUnicode when available and safe;
 * falls back to PUA for combining marks, whitespace, multi-codepoint sequences,
 * and missing Unicode.
 *
 * Called by both the font builder (cmap construction) and the renderer (text string
 * construction) to guarantee they always agree.
 *
 * @param {string|undefined} toUniStr - ToUnicode string for this CID (undefined if not mapped)
 * @param {number} cid - The CID value
 */
export function cidCodepoint(toUniStr, cid) {
  if (toUniStr) {
    const chars = [...toUniStr];
    if (chars.length === 1) {
      const cp = toUniStr.codePointAt(0);
      // Use real Unicode unless it would cause rendering problems:
      // - combining marks → Chrome adds dotted-circle placeholders
      // - whitespace/control chars → trim() guard skips them, hiding visible glyphs
      // - U+FFFD replacement character → PDF producer's "couldn't decode" placeholder;
      //   claiming it in the cmap routes every CID with FFFD in ToUnicode (and every
      //   missing-CID fallback) to a single real glyph, so unrelated CIDs render as
      //   whichever glyph got there first.
      if (cp > 0x20 && cp !== 0xFFFD && !isCombiningOrIndicMark(cp)) {
        return { codepoint: cp, isPUA: false };
      }
    }
    // Multi-codepoint, combining mark, or whitespace/control → PUA
  }
  // No Unicode info or needs PUA
  const pua = 0xE000 + cid <= 0xF8FF ? 0xE000 + cid : 0xF0000 + cid;
  return { codepoint: pua, isPUA: true };
}

/**
 * Reverse AGL: unicode codepoint → glyph name (only matches single-codepoint
 * entries). Built lazily on first call because the full forward map has ~4300
 * entries and a per-call linear scan was the #1 hot spot in PDF rendering —
 * a text-heavy 14-page academic paper spent ~58% of wall time inside this
 * single function before the reverse map was cached.
 *
 * @type {Map<number, string>|null}
 */
let aglReverseMap = null;
function unicodeToAGL(cp) {
  if (aglReverseMap === null) {
    aglReverseMap = new Map();
    for (const [name, uni] of Object.entries(aglMap)) {
      if (!aglReverseMap.has(uni)) aglReverseMap.set(uni, name);
    }
  }
  return aglReverseMap.get(cp) || null;
}

/**
 * Convert a Type1 PFA/PFB font to OTF by parsing charstrings into Path objects
 * via font-parser's Type1 parser, then constructing a new font.
 * @param {Uint8Array} pfaBytes - raw PFA font program bytes
 * @param {PdfFontObj} fontObj - parsed PDF font object
 * @returns {{ otfData: ArrayBuffer, fontMatrix: number[]|null }|null}
 */
export function convertType1ToOTFNew(pfaBytes, fontObj) {
  try {
    const parsed = opentype.parseType1Font(pfaBytes);
    if (!parsed) return null;

    const glyphEncoding = new Map();
    // Track charCodes claimed by /Differences — even when the referenced glyph is
    // missing from the Type1 program (corrupted/subsetted font), the built-in
    // encoding at that charCode position maps to a completely unrelated glyph.
    // Falling through to it would render the wrong character (e.g. 'e' → 't').
    const diffCharCodes = fontObj.differences ? new Set(Object.keys(fontObj.differences).map(Number)) : null;
    if (fontObj.differences) {
      for (const [charCodeStr, glyphName] of Object.entries(fontObj.differences)) {
        const code = Number(charCodeStr);
        if (parsed.glyphs.has(glyphName)) glyphEncoding.set(code, glyphName);
      }
    }
    if (fontObj.toUnicode && fontObj.toUnicode.size > 0) {
      for (const [charCode, unicode] of fontObj.toUnicode) {
        if (glyphEncoding.has(charCode)) continue;
        const cp = unicode.codePointAt(0);
        const name = unicodeToAGL(cp);
        if (name && parsed.glyphs.has(name)) glyphEncoding.set(charCode, name);
      }
    }
    for (const [code, name] of parsed.encoding) {
      if (!glyphEncoding.has(code) && !(diffCharCodes && diffCharCodes.has(code)) && parsed.glyphs.has(name)) glyphEncoding.set(code, name);
    }

    // If the Type1 parser extracted very few glyphs compared to the Differences entries,
    // the eexec decryption likely failed. Return null to fall through to CSS font fallback
    // so all characters render consistently from the same system font.
    // Compare against Differences entries whose glyph exists in the font (not total Differences
    // count), because subsetted fonts legitimately have many Differences entries for glyphs
    // not in this subset (shared encoding object across pages).
    let diffMatchCount = 0;
    if (fontObj.differences) {
      for (const glyphName of Object.values(fontObj.differences)) {
        if (parsed.glyphs.has(glyphName)) diffMatchCount++;
      }
    }
    if (diffMatchCount > 5 && glyphEncoding.size < diffMatchCount * 0.5) return null;

    const notdefPath = new opentype.Path();
    const glyphs = [new opentype.Glyph({
      name: '.notdef', unicode: 0, advanceWidth: 0, path: notdefPath,
    })];
    const usedUnicodes = new Set([0]);

    for (const [charCode, glyphName] of glyphEncoding) {
      const glyphData = parsed.glyphs.get(glyphName);
      if (!glyphData) continue;
      let unicode;
      const tuUnicode = fontObj.toUnicode && fontObj.toUnicode.get(charCode);
      if (tuUnicode) {
        unicode = tuUnicode.codePointAt(0);
      } else {
        const uniStr = aglLookup(glyphName);
        if (uniStr) {
          unicode = uniStr.codePointAt(0);
          // Populate toUnicode for charCodes from the Type1 font's built-in encoding
          // that have no /Differences or /ToUnicode entry. Without this, the renderer's
          // showType1Literal falls back to str[i] which is a control char for codes < 0x20
          // (e.g. charCode 12 = "fi" ligature in TeX fonts), causing trim() to skip it.
          if (fontObj.toUnicode) fontObj.toUnicode.set(charCode, uniStr);
          if (fontObj.encodingUnicode) fontObj.encodingUnicode.set(charCode, uniStr);
        }
      }
      if (!unicode || usedUnicodes.has(unicode)) continue;
      usedUnicodes.add(unicode);

      let advanceWidth = glyphData.advanceWidth;
      if (fontObj.widths) {
        const pdfWidth = fontObj.widths.get(charCode);
        if (pdfWidth !== undefined) advanceWidth = pdfWidth;
      }

      glyphs.push(new opentype.Glyph({
        name: glyphName,
        unicode,
        advanceWidth: advanceWidth || 500,
        path: glyphData.path,
      }));
    }

    if (glyphs.length <= 1) return null;

    const familyName = (fontObj.baseName || 'Type1Font').replace(/[^A-Za-z0-9-]/g, '') || 'Type1Font';
    const font = new opentype.Font({
      familyName,
      styleName: 'Regular',
      unitsPerEm: 1000,
      ascender: fontObj.ascent || 800,
      descender: fontObj.descent > 0 ? -fontObj.descent : (fontObj.descent || -200),
      glyphs,
    });

    const otfData = font.toArrayBuffer();

    // Return non-standard FontMatrix so the renderer can apply shear/flip transforms.
    // Standard FontMatrix [0.001, 0, 0, 0.001, 0, 0] is handled by unitsPerEm=1000;
    // only return fontMatrix when it contains off-diagonal or asymmetric terms.
    const fm = parsed.fontMatrix;
    let fontMatrix = null;
    if (fm && fm.length >= 4
      && (fm[1] !== 0 || fm[2] !== 0 || Math.abs(fm[3]) !== Math.abs(fm[0]))) {
      // Normalize: multiply by unitsPerEm (1000) to get the transform relative to identity
      fontMatrix = [fm[0] * 1000, fm[1] * 1000, fm[2] * 1000, fm[3] * 1000, 0, 0];
    }

    return { otfData, fontMatrix };
  } catch (_e) {
    return null;
  }
}

/**
 * Rebuild a clean OTS-compliant font from scratch by parsing raw TrueType binary tables
 * using font-parser's exported parsers, then constructing a new font via opentype.js.
 *
 * @param {ArrayBuffer} arrayBuffer - The original embedded TrueType font data
 * @param {PdfFontObj} fontObj - PDF font object
 * @param {Uint8Array} [cidToGidMap] - Optional CIDToGIDMap stream (2 bytes per CID, big-endian GID)
 * @returns {{ otfData: ArrayBuffer, usesPUA: boolean, cmapType: string|null, cidCollisions: Set<number>|null }|null}
 */
export function rebuildFontFromGlyphs(arrayBuffer, fontObj, cidToGidMap) {
  try {
    const data = new DataView(arrayBuffer);
    const bytes = new Uint8Array(arrayBuffer);

    const sfVersion = data.getUint32(0);
    if (sfVersion !== 0x00010000 && sfVersion !== 0x74727565) return null;

    const numTables = data.getUint16(4);
    const tableDir = {};
    for (let i = 0; i < numTables; i++) {
      const off = 12 + i * 16;
      const tag = String.fromCharCode(bytes[off], bytes[off + 1], bytes[off + 2], bytes[off + 3]);
      tableDir[tag.trim()] = { offset: data.getUint32(off + 8), length: data.getUint32(off + 12) };
    }

    if (!tableDir.head || !tableDir.maxp || !tableDir.loca || !tableDir.glyf || !tableDir.hhea || !tableDir.hmtx) return null;

    const head = opentype.parseHeadTable(data, tableDir.head.offset);
    const maxp = opentype.parseMaxpTable(data, tableDir.maxp.offset);
    const hhea = opentype.parseHheaTable(data, tableDir.hhea.offset);
    const loca = opentype.parseLocaTable(data, tableDir.loca.offset, maxp.numGlyphs, head.indexToLocFormat === 0);

    const fontShell = { unitsPerEm: head.unitsPerEm, numGlyphs: maxp.numGlyphs, tables: {} };
    fontShell.glyphs = opentype.parseGlyfTable(data, tableDir.glyf.offset, loca, fontShell);
    opentype.parseHmtxTable(data, tableDir.hmtx.offset, hhea.numberOfHMetrics, maxp.numGlyphs, fontShell.glyphs);

    const glyphToUnicode = new Map();
    let usesPUA = false;
    /** @type {Set<number>|null} CIDs forced to PUA due to Unicode collision */
    let cidCollisions = null;
    /** @type {string|null} */
    let cmapType = null;

    if (cidToGidMap) {
      // For Identity-H (no charCodeToCID), toUnicode is keyed by charCode which equals CID.
      // For custom CMap, reverse the mapping to get CID→Unicode.
      const cidToUnicode = (!fontObj.charCodeToCID || fontObj.charCodeToCID.size === 0)
        ? fontObj.toUnicode
        : (() => {
          const m = new Map();
          for (const [charCode, cid2] of fontObj.charCodeToCID) {
            if (!m.has(cid2) && fontObj.toUnicode?.has(charCode)) m.set(cid2, fontObj.toUnicode.get(charCode));
          }
          return m;
        })();
      const claimedUnicodes = new Set();
      for (let i = 0; i < cidToGidMap.length - 1; i += 2) {
        const gid = (cidToGidMap[i] << 8) | cidToGidMap[i + 1];
        const cid = i / 2;
        if (cid === 0 && gid === 0) continue;
        const decision = cidCodepoint(cidToUnicode?.get(cid), cid);
        let { codepoint } = decision;
        let { isPUA } = decision;
        // Collision: real Unicode already claimed by a different GID → force PUA
        if (!isPUA && claimedUnicodes.has(codepoint)) {
          codepoint = 0xE000 + cid <= 0xF8FF ? 0xE000 + cid : 0xF0000 + cid;
          isPUA = true;
          if (!cidCollisions) cidCollisions = new Set();
          cidCollisions.add(cid);
        }
        if (!isPUA) claimedUnicodes.add(codepoint);
        if (isPUA) usesPUA = true;
        glyphToUnicode.set(gid, codepoint);
      }
      // Fallback: if CIDToGIDMap produced only PUA mappings (no real Unicode), the
      // cidToUnicode was likely keyed wrong (e.g., GBK charCodes used as keys when
      // the font uses a predefined CMap, not Identity-H). In this case, use the
      // embedded TrueType font's own Unicode cmap instead — it directly maps Unicode
      // to GIDs and is the most reliable source for embedded subsetted fonts.
      // Only include GIDs that appear in the CIDToGIDMap (the subset actually used).
      if (usesPUA && claimedUnicodes.size === 0 && fontObj.toUnicode && fontObj.toUnicode.size > 0 && tableDir.cmap) {
        const fallbackCmap = opentype.parseCmapTable(data, tableDir.cmap.offset);
        if (fallbackCmap.glyphIndexMap && fallbackCmap.platformID === 3 && fallbackCmap.encodingID !== 0) {
          // Collect valid GIDs from CIDToGIDMap
          const validGids = new Set();
          for (let i = 0; i < cidToGidMap.length - 1; i += 2) {
            const gid = (cidToGidMap[i] << 8) | cidToGidMap[i + 1];
            if (gid > 0) validGids.add(gid);
          }
          glyphToUnicode.clear();
          usesPUA = false;
          cidCollisions = null;
          for (const [unicodeStr, gi] of Object.entries(fallbackCmap.glyphIndexMap)) {
            if (gi > 0 && validGids.has(gi) && !glyphToUnicode.has(gi)) {
              glyphToUnicode.set(gi, Number(unicodeStr));
            }
          }
        }
      }
    } else if (tableDir.cmap) {
      const cmap = opentype.parseCmapTable(data, tableDir.cmap.offset);
      if (cmap.glyphIndexMap) {
        if (cmap.platformID === 3 && cmap.encodingID === 0) {
          // Symbol-encoded cmap (platform 3, encoding 0).
          // All platform-3/encoding-0 fonts are symbol fonts — the renderer must use
          // PUA codepoints (0xF000 + charCode) so that characters like space (charCode 32)
          // are not skipped by the whitespace trim() check.
          // Traditional symbol fonts (Wingdings, Symbol) already have keys in 0xF000+ PUA range.
          // Bare-ASCII symbol fonts (e.g. barcode fonts) need remapping to PUA.
          cmapType = 'symbol';
          const keys = Object.keys(cmap.glyphIndexMap).map(Number);
          const hasPUAKeys = keys.some((k) => k >= 0xF000);
          for (const [unicodeStr, gi] of Object.entries(cmap.glyphIndexMap)) {
            const unicode = Number(unicodeStr);
            if (gi > 0 && !glyphToUnicode.has(gi)) {
              // Bare-ASCII keys need PUA remapping; PUA keys are already in the right range.
              glyphToUnicode.set(gi, hasPUAKeys ? unicode : (0xF000 | unicode));
            }
          }
        } else if (fontObj.toUnicode && cmap.platformID === 1) {
          // Mac-platform cmap: keys are charCodes, not unicode codepoints.
          // Bridge charCode→GID (cmap) with charCode→unicode (toUnicode).
          // Multi-codepoint ToUnicode entries (conjunct glyphs in Indic fonts, ligatures, etc.)
          // map to PUA (0xE000 + charCode) to avoid collisions where multiple GIDs share the
          // same first-codepoint. Combining marks (Indic vowel signs U+09BE-U+09D7, nuqta
          // U+09BC, etc.) also get PUA so that fillText() doesn't render them with a dotted
          // circle placeholder (which occurs because a combining mark has no standalone base).
          // Without PUA, a conjunct like "দব্" (U+9A6 U+9AC U+9CD) would collide with
          // single-char "দ" (U+9A6) in the rebuilt font's cmap.
          cmapType = 'rawCharCode';
          for (const [charCodeStr, gi] of Object.entries(cmap.glyphIndexMap)) {
            if (gi <= 0) continue;
            const charCode = Number(charCodeStr);
            const uniStr = fontObj.toUnicode.get(charCode);
            let unicode;
            if (uniStr) {
              const firstCp = uniStr.codePointAt(0) || 0;
              if ([...uniStr].length > 1 || isCombiningOrIndicMark(firstCp)) {
                unicode = 0xE000 + charCode;
              } else {
                unicode = firstCp;
              }
            } else {
              unicode = charCode;
            }
            if (unicode && !glyphToUnicode.has(gi)) {
              glyphToUnicode.set(gi, unicode);
            }
          }
        } else {
          // Unicode-platform cmap (or no toUnicode): keys are unicode codepoints
          for (const [unicodeStr, gi] of Object.entries(cmap.glyphIndexMap)) {
            const unicode = Number(unicodeStr);
            if (gi > 0 && !glyphToUnicode.has(gi)) {
              glyphToUnicode.set(gi, unicode);
            }
          }
        }
      }
    }

    // Fonts without cmap but WITH a post table: use post glyph names + AGL to build GID→Unicode.
    // This is common in subsetted TrueType fonts embedded in PDFs where the cmap was stripped.
    if (glyphToUnicode.size === 0 && tableDir.post) {
      const post = opentype.parsePostTable(data, tableDir.post.offset);
      if (post.glyphNameIndex) {
        // Format 2.0: each GID maps to a name index.
        // nameIndex < 258 → standardNames[nameIndex]; nameIndex >= 258 → post.names[nameIndex - 258]
        const customNames = post.names || [];
        for (let gid = 1; gid < (post.numberOfGlyphs || 0); gid++) {
          const nameIdx = post.glyphNameIndex[gid];
          const glyphName = nameIdx < 258 ? standardNames[nameIdx] : customNames[nameIdx - 258];
          if (!glyphName) continue;
          const uniStr = aglLookup(glyphName);
          if (uniStr) {
            const cp = uniStr.codePointAt(0);
            if (cp && !glyphToUnicode.has(gid)) {
              glyphToUnicode.set(gid, cp);
            }
          }
        }
      } else if (post.names) {
        // Format 1.0: GID i → standardNames[i]
        for (let gid = 1; gid < post.names.length; gid++) {
          const glyphName = post.names[gid];
          if (!glyphName) continue;
          const uniStr = aglLookup(glyphName);
          if (uniStr) {
            const cp = uniStr.codePointAt(0);
            if (cp && !glyphToUnicode.has(gid)) {
              glyphToUnicode.set(gid, cp);
            }
          }
        }
      }
    }

    // Last-resort fallback: treat charCode as GID (for fonts with no cmap and no post table).
    // This is a guess and will produce wrong glyphs if charCode ≠ GID.
    if (glyphToUnicode.size === 0 && fontObj.toUnicode) {
      console.warn(`[rebuildFontFromGlyphs] No cmap or post table for "${fontObj.baseName}" — using charCode-as-GID fallback (glyphs may be wrong)`);
      for (const [charCode, uniStr] of fontObj.toUnicode) {
        const uniVal = uniStr.codePointAt(0);
        if (charCode > 0 && uniVal && !glyphToUnicode.has(charCode)) {
          glyphToUnicode.set(charCode, uniVal);
        }
      }
    }

    const notdefPath = new opentype.Path();
    const glyphs = [new opentype.Glyph({
      name: '.notdef', unicode: 0, advanceWidth: Math.round(head.unitsPerEm / 2), path: notdefPath,
    })];
    const usedUnicodes = new Set([0]);
    const origGidToNewIdx = new Map();

    for (const [gi, unicode] of glyphToUnicode) {
      if (gi < 0 || gi >= maxp.numGlyphs || usedUnicodes.has(unicode)) continue;
      const g = fontShell.glyphs.get(gi);
      if (!g) continue;
      const path = g.path; // triggers lazy parse → g.points is now set
      if (!path) continue;
      usedUnicodes.add(unicode);
      origGidToNewIdx.set(gi, glyphs.length);
      const newGlyph = new opentype.Glyph({
        name: `glyph_${gi}`,
        unicode,
        advanceWidth: g.advanceWidth || head.unitsPerEm,
        path,
      });
      if (g.points) {
        newGlyph.points = g.points;
        if (g._xMin !== undefined) {
          newGlyph._xMin = g._xMin;
          newGlyph._yMin = g._yMin;
          newGlyph._xMax = g._xMax;
          newGlyph._yMax = g._yMax;
          newGlyph.leftSideBearing = g._xMin;
        } else {
          let xMin = Infinity;
          for (let pi = 0; pi < g.points.length; pi++) {
            if (g.points[pi].x < xMin) xMin = g.points[pi].x;
          }
          newGlyph.leftSideBearing = xMin !== Infinity ? xMin : (g.leftSideBearing || 0);
        }
      }
      if (g.instructions && g.instructions.length > 0) {
        newGlyph.instructions = g.instructions;
      }
      if (g.isComposite && g.components) {
        newGlyph.isComposite = true;
        newGlyph.components = g.components;
      }
      glyphs.push(newGlyph);
    }

    // Remap composite component GIDs from original to new font indices.
    // If any component is missing from the new font, fall back to simple glyph.
    for (let i = 1; i < glyphs.length; i++) {
      const g = glyphs[i];
      if (!g.isComposite || !g.components) continue;
      let allPresent = true;
      for (let ci = 0; ci < g.components.length; ci++) {
        if (!origGidToNewIdx.has(g.components[ci].glyphIndex)) {
          allPresent = false;
          break;
        }
      }
      if (allPresent) {
        g.components = g.components.map((comp) => ({
          ...comp,
          glyphIndex: origGidToNewIdx.get(comp.glyphIndex),
        }));
      } else {
        delete g.isComposite;
        delete g.components;
      }
    }

    if (glyphs.length <= 1) return null;

    // Metrics-only subset: if no glyph has outline data, the glyf table would
    // be zero bytes and Chrome OTS rejects it ("glyf: zero-length table").
    // Return null so the caller falls back to a system/bundled substitute.
    let hasOutline = false;
    for (let i = 1; i < glyphs.length; i++) {
      if ((glyphs[i].path && glyphs[i].path.commands.length > 0) || glyphs[i].isComposite) {
        hasOutline = true;
        break;
      }
    }
    if (!hasOutline) {
      console.warn(`[rebuildFontFromGlyphs] Metrics-only subset for "${fontObj.baseName}" — all ${glyphs.length - 1} glyphs have empty outlines, skipping rebuild`);
      return null;
    }

    const newFont = new opentype.Font({
      familyName: fontObj.baseName || 'RebuiltFont',
      styleName: 'Regular',
      unitsPerEm: head.unitsPerEm,
      ascender: hhea.ascender,
      descender: hhea.descender,
      glyphs,
    });
    newFont.outlinesFormat = 'truetype';

    // Copy TrueType hinting infrastructure from the original font.
    // Composite glyphs have instructions that reference functions in fpgm
    // and control values in cvt — without these tables the instructions fail.
    const cvtTag = tableDir['cvt '] || tableDir.cvt;
    if (cvtTag) {
      const cvt = [];
      for (let ci = 0; ci < cvtTag.length; ci += 2) {
        cvt.push(data.getInt16(cvtTag.offset + ci));
      }
      newFont.tables.cvt = cvt;
    }
    if (tableDir.fpgm) {
      const fpgm = [];
      for (let fi = 0; fi < tableDir.fpgm.length; fi++) {
        fpgm.push(data.getUint8(tableDir.fpgm.offset + fi));
      }
      newFont.tables.fpgm = fpgm;
    }
    if (tableDir.prep) {
      const prep = [];
      for (let pi = 0; pi < tableDir.prep.length; pi++) {
        prep.push(data.getUint8(tableDir.prep.offset + pi));
      }
      newFont.tables.prep = prep;
    }
    if (maxp.version === 1) {
      newFont.tables.maxp = {
        maxZones: maxp.maxZones,
        maxTwilightPoints: maxp.maxTwilightPoints,
        maxStorage: maxp.maxStorage,
        maxFunctionDefs: maxp.maxFunctionDefs,
        maxInstructionDefs: maxp.maxInstructionDefs,
        maxStackElements: maxp.maxStackElements,
      };
    }

    return {
      otfData: newFont.toArrayBuffer(), usesPUA, cmapType, cidCollisions,
    };
  } catch (_e) {
    return null;
  }
}
