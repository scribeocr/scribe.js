import opentype from '../../font-parser/src/index.js';
import { parseCFFSummary } from '../../font-parser/src/cff.js';
import { standardNames, cffStandardEncoding } from '../../font-parser/src/encoding.js';
import { aglLookup, unicodeToAGL } from './standardEncodings.js';

/**
 * @typedef {{
 *   baseName?: string,
 *   toUnicode?: Map<number, string>,
 *   charCodeToCID?: Map<number, number>,
 *   differences?: Record<string, string>,
 *   encodingUnicode?: Map<number, string>,
 *   charCodeToGlyphName?: Map<number, string>|null,
 *   encodingToUnicodeConflicts?: Map<number, { encoding: string, toUnicode: string }>|null,
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
 * Map a CFF charset (GID->glyph-name, as returned by font-parser's parseCFFSummary) to GID->Unicode via the Adobe Glyph List.
 * Kept in the PDF layer so font-parser need not depend on the app's AGL tables.
 * @param {(string[]|null)} charsetNames
 * @returns {Map<number, string>}
 */
export function cffCharsetNamesToUnicode(charsetNames) {
  const glyphToUnicode = new Map();
  if (!charsetNames) return glyphToUnicode;
  for (let gid = 1; gid < charsetNames.length; gid++) {
    const uniStr = aglLookup(charsetNames[gid]);
    if (uniStr) glyphToUnicode.set(gid, uniStr);
  }
  return glyphToUnicode;
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

    // For CIDFontType0C the Top DICT FontMatrix is the CFF default [0.001 0 0 0.001 ...]
    // even when the per-FD FontMatrix carries the real scale (e.g. 1/2048). Using
    // the Top default for an FD-scaled font would render glyphs at 2x size.
    const topFm = fontShell.tables.cff.topDict.fontMatrix;
    const fdArr = fontShell.tables.cff.topDict._fdArray;
    const fdFm = (fontShell.isCIDFont && fdArr && fdArr.length > 0) ? fdArr[0].fontMatrix : null;
    const fm = (fdFm && fdFm[0] > 0 && fdFm[0] < 1) ? fdFm : topFm;
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
      const cidToGID = parseCFFSummary(cffData).cidToGID || new Map();
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
        const decision = cidCodepoint(cidToUnicode?.get(cid), cid, fontObj.widths?.get(cid));
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

        // PUA entries from the font's intrinsic encoding.
        // The renderer routes width-only charcodes (no encodingUnicode/toUnicode entry) through PUA.
        for (const [code, gid] of cffBaseEncoding) {
          const hasEnc = fontObj.encodingUnicode?.has(code);
          const overridden = diffCodeSet && diffCodeSet.has(code);
          const encU = fontObj.encodingUnicode?.get(code);
          const encIsWhitespace = typeof encU === 'string' && encU.trim() === '';
          // Whitespace codes still need a PUA fallback: fillText() skips whitespace,
          // but a malformed subset may store a visible outline under a whitespace name.
          if (hasEnc && !overridden && !encIsWhitespace) continue;
          const puaCode = 0xE000 + code;
          if (!unicodeToGID.has(puaCode)) {
            unicodeToGID.set(puaCode, gid);
            // For a whitespace code, only flag usesPUA when its glyph actually has an outline.
            if (!encIsWhitespace || (gid > 0 && fontShell.glyphs.get(gid)?.path.commands.some((c) => c.type === 'L' || c.type === 'C' || c.type === 'Q'))) {
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

        // Round-trip guard: also key each glyph under the codepoint the renderer draws for the char code that reaches it,
        // not just the glyph's own AGL name.
        // A caps-only CFF face reached by a lowercase code, or a base-encoding code whose Unicode differs from its glyph name,
        // otherwise leaves the drawn codepoint with no glyph.
        // /Differences codes render through their PUA entry above, so skip them.
        const codeToGid = new Map(cffBaseEncoding);
        if (encoding) {
          for (const [codeStr, glyphName] of Object.entries(encoding)) {
            const gid = nameToGID.get(glyphName);
            if (gid !== undefined) codeToGid.set(Number(codeStr), gid);
          }
        }
        addRoundTripCodepoints(fontObj, codeToGid, (cp, gid) => {
          if (!unicodeToGID.has(cp)) unicodeToGID.set(cp, gid);
        }, diffCodeSet);
      }
    }

    const notdefPath = new opentype.Path();
    const glyphs = [new opentype.Glyph({
      name: '.notdef', unicode: 0, advanceWidth: 0, path: notdefPath,
    })];
    const usedUnicodes = new Set([0]);

    // CFF outlines are in glyph space and must be transformed by the fontMatrix.
    // unitsPerEm is 1/fm[0], so it encodes only the X scale.
    // Bake the residual Y factor fm[3]/fm[0] into the coordinates
    // so a non-uniform matrix does not leave glyphs at the right width but wrong height.
    // That factor also flips Y when fm[3] is negative (Y-down outlines, OTF expects Y-up).
    // A non-zero shear fm[2] slants oblique faces via x' = x + (fm[2]/fm[0])*y on the original y.
    const haveScale = fm && fm[0] > 0 && fm[0] < 1;
    const shear = fm && Math.abs(fm[2]) > 1e-9 ? fm[2] / fm[0] : 0;
    const yScale = haveScale ? fm[3] / fm[0] : (fm && fm[3] < 0 ? -1 : 1);

    for (const [unicode, gid] of unicodeToGID) {
      if (gid <= 0 || gid >= fontShell.nGlyphs || usedUnicodes.has(unicode)) continue;
      usedUnicodes.add(unicode);
      const g = fontShell.glyphs.get(gid);
      let { path } = g;
      if (shear || yScale !== 1) {
        path = new opentype.Path();
        for (const cmd of g.path.commands) {
          const c = { ...cmd };
          if (shear) {
            if (c.x !== undefined) c.x = Math.round(c.x + shear * c.y);
            if (c.x1 !== undefined) c.x1 = Math.round(c.x1 + shear * c.y1);
            if (c.x2 !== undefined) c.x2 = Math.round(c.x2 + shear * c.y2);
          }
          if (yScale !== 1) {
            if (c.y !== undefined) c.y = Math.round(c.y * yScale);
            if (c.y1 !== undefined) c.y1 = Math.round(c.y1 * yScale);
            if (c.y2 !== undefined) c.y2 = Math.round(c.y2 * yScale);
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
 * Check whether a codepoint is a default-ignorable or format character that renders nothing in fillText.
 * Covers soft hyphen, the zero-width and bidi controls, BOM, Hangul filler, and variation selectors.
 * A glyph claimed under one silently vanishes, so route it to the PUA instead.
 * @param {number} cp
 */
export function isDefaultIgnorable(cp) {
  return cp === 0x00AD || cp === 0x061C || cp === 0x3164 || cp === 0xFEFF
    || (cp >= 0x200B && cp <= 0x200F) || (cp >= 0x202A && cp <= 0x202E)
    || (cp >= 0x2060 && cp <= 0x206F) || (cp >= 0xFE00 && cp <= 0xFE0F)
    || (cp >= 0xFFF9 && cp <= 0xFFFB);
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
 * Whether cp belongs to a script the canvas text engine complex-shapes, so a glyph drawn standalone
 * via fillText is mis-shaped and the caller must route it to the PUA instead.
 * @param {number} cp
 * @returns {boolean}
 */
export function isComplexShapingScript(cp) {
  // The canvas shaper reorders, joins, or stacks these blocks, so a glyph keyed here draws wrong standalone
  // even when its cmap is correct. Callers route it to the PUA to bypass shaping,
  // which also catches obfuscated ToUnicode that scatters Latin glyphs into these blocks.
  // Precomposed Hangul (U+AC00-D7A3) and CJK ideographs are not shaped and stay on real Unicode.
  return (cp >= 0x0590 && cp <= 0x08FF) // Hebrew, Arabic, Syriac, Thaana, NKo, Samaritan, Mandaic, Arabic Ext
    || (cp >= 0x0900 && cp <= 0x109F) // Brahmic (Devanagari..Sinhala), Thai, Lao, Tibetan, Myanmar
    || (cp >= 0x1100 && cp <= 0x11FF) // Hangul Jamo (conjoining)
    || (cp >= 0x1700 && cp <= 0x18FF) // Philippine, Khmer, Mongolian, UCAS Extended
    || (cp >= 0x1900 && cp <= 0x1C7F) // Limbu..Lepcha, Ol Chiki, Tai Tham, Balinese, Sundanese, Batak
    || (cp >= 0x1CD0 && cp <= 0x1DFF) // Vedic + combining-diacritical extensions/supplement (e.g. U+1DFA)
    || (cp >= 0xA800 && cp <= 0xAAFF) // Syloti Nagri, Phags-pa, Saurashtra, Javanese, Cham, Myanmar/Tai Viet Ext
    || (cp >= 0xABC0 && cp <= 0xABFF) // Meetei Mayek
    || (cp >= 0xD7B0 && cp <= 0xD7FF) // Hangul Jamo Extended-B
    || (cp >= 0xFB1D && cp <= 0xFDFF) // Hebrew + Arabic presentation forms A
    || (cp >= 0xFE70 && cp <= 0xFEFF); // Arabic presentation forms B
}

/**
 * Whether this glyph needs to be mapped through a PUA codepoint (0xE000+code).
 * The builder and the renderer both call this so their codepoint choices always agree.
 * Mapping to a PUA codepoint is necessary when the codepoint a glyph is mapped both
 * (1) is incorrect and (2) is considered a special case by the renderer (e.g. a combining mark, a default ignorable, etc.).
 * @param {number} cp - the codepoint the renderer would otherwise draw for the glyph
 * @param {number|undefined} width - the glyph's advance width from the PDF /Widths
 * @returns {boolean}
 */
export function drawnGlyphNeedsPUA(cp, width) {
  // A zero-width glyph is a genuine mark — leave it on its real codepoint. Only a positive-width
  // glyph is a real base glyph that an obfuscated /Encoding mislabeled with a codepoint that
  // misbehaves when drawn bare.
  if (typeof width !== 'number' || width <= 0) return false;
  // Codepoints canvas fillText will not render standalone at their own position:
  //  - combining/Indic marks and Latin combining diacritics (U+0300-U+036F): the shaper gives them
  //    zero advance and stacks them on the preceding glyph (U+0300-U+036F is excluded from
  //    isCombiningOrIndicMark, so it is listed explicitly here);
  //  - default-ignorables (soft hyphen, ZWJ, variation selectors, BOM): render as nothing;
  //  - complex-shaping scripts: reordered/joined, so a standalone glyph is mis-shaped.
  return isCombiningOrIndicMark(cp) || isDefaultIgnorable(cp) || isComplexShapingScript(cp)
    || (cp >= 0x300 && cp <= 0x36F);
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
 * @param {number} [width] - The CID's advance width from /W (undefined if unspecified).
 *   Distinguishes a base glyph mislabeled with a Latin combining-mark codepoint (positive width) from a real zero-width mark.
 */
export function cidCodepoint(toUniStr, cid, width) {
  if (toUniStr) {
    const chars = [...toUniStr];
    if (chars.length === 1) {
      const cp = toUniStr.codePointAt(0) || 0;
      // Use real Unicode unless it would cause rendering problems:
      // - combining marks → Chrome adds dotted-circle placeholders
      // - whitespace/control chars → trim() guard skips them, hiding visible glyphs
      // - default-ignorable/format chars (soft hyphen, zero-width and bidi controls,
      //   BOM, variation selectors) render nothing in fillText, so a glyph
      //   claimed under one silently vanishes (an obfuscated ToUnicode can map a real
      //   letter to U+00AD). Route them to PUA so the glyph still draws.
      // - U+FFFD replacement character → PDF producer's "couldn't decode" placeholder;
      //   claiming it in the cmap routes every CID with FFFD in ToUnicode (and every
      //   missing-CID fallback) to a single real glyph, so unrelated CIDs render as
      //   whichever glyph got there first.
      // A Latin combining diacritical mark (U+0300-U+036F) is normally kept as the real codepoint,
      // since some Latin academic fonts map precomposed glyphs through this block.
      // But a CID with a positive advance width is a base glyph mislabeled with a combining codepoint, not a real zero-width mark.
      // Drawn as the bare mark, the canvas shaper gives it zero advance and stacks it on the preceding glyph, shifting it one position.
      // Route those to PUA so the glyph draws standalone at its own spot.
      const latinCombiningBaseGlyph = cp >= 0x300 && cp <= 0x36F && typeof width === 'number' && width > 0;
      if (cp > 0x20 && cp !== 0xFFFD && !isCombiningOrIndicMark(cp)
        && !isDefaultIgnorable(cp) && !isComplexShapingScript(cp)
        && !latinCombiningBaseGlyph) {
        return { codepoint: cp, isPUA: false };
      }
    }
    // Multi-codepoint, combining mark, whitespace/control, or complex-shaping script -> PUA
  }
  // No Unicode info or needs PUA
  const pua = 0xE000 + cid <= 0xF8FF ? 0xE000 + cid : 0xF0000 + cid;
  return { codepoint: pua, isPUA: true };
}

/**
 * Decide the codepoint a simple-font (non-CID) rebuild keys a glyph under for a char code, and whether that codepoint is PUA.
 * Resolves the codepoint the renderer would draw in its normal branch (single-codepoint `encodingUnicode`, else single-codepoint ToUnicode),
 * then routes it to PUA via drawnGlyphNeedsPUA when that codepoint would not render correctly drawn bare.
 * Returns null when the code has no single-codepoint Unicode (the renderer then routes it through PUA, keyed separately).
 * Mirrors `cidCodepoint`.
 * @param {PdfFontObj} fontObj
 * @param {number} charCode
 * @returns {{ codepoint: number, isPUA: boolean }|null}
 */
export function simpleFontCodepoint(fontObj, charCode) {
  const enc = fontObj.encodingUnicode && fontObj.encodingUnicode.get(charCode);
  const tu = fontObj.toUnicode && fontObj.toUnicode.get(charCode);
  let cp = null;
  if (enc && [...enc].length === 1) cp = enc.codePointAt(0) ?? null;
  else if (tu && [...tu].length === 1) cp = tu.codePointAt(0) ?? null;
  if (cp === null) return null;
  if (drawnGlyphNeedsPUA(cp, fontObj.widths && fontObj.widths.get(charCode))) {
    return { codepoint: 0xE000 + charCode, isPUA: true };
  }
  return { codepoint: cp, isPUA: false };
}

/**
 * Additive round-trip guard. For each PDF char code that reaches a glyph, also key that glyph under `simpleFontCodepoint(code)`,
 * the codepoint the renderer draws for that code.
 * A simple-font rebuild that keys glyphs only by their own identity (a CFF charset name, or an embedded TrueType cmap codepoint)
 * otherwise leaves the renderer's drawn codepoint with no glyph when the PDF /Encoding draws a code at a different codepoint (divergence)
 * or aims several codes at one glyph (collapse).
 * Because `addEntry` fills a slot only when it is free, this never overrides an existing entry
 * and is a no-op for fonts whose rebuilt cmap already covers the drawn codepoints.
 * It does not handle collisions (two codes needing one codepoint). Those are rerouted to PUA per path.
 * @param {PdfFontObj} fontObj
 * @param {Iterable<[number, number]>} codeToGid - PDF char code -> GID for codes the renderer can draw
 * @param {(codepoint: number, gid: number) => void} addEntry - keys codepoint -> gid if the slot is free
 * @param {Set<number>|null} [skipCodes] - codes handled elsewhere (e.g. /Differences routed to PUA)
 */
export function addRoundTripCodepoints(fontObj, codeToGid, addEntry, skipCodes) {
  for (const [code, gid] of codeToGid) {
    if (gid <= 0 || (skipCodes && skipCodes.has(code))) continue;
    const decision = simpleFontCodepoint(fontObj, code);
    if (decision && decision.codepoint > 0x20 && decision.codepoint !== 0xFFFD) addEntry(decision.codepoint, gid);
  }
}

/**
 * Convert a Type1 PFA/PFB font to OTF by parsing charstrings into Path objects
 * via font-parser's Type1 parser, then constructing a new font.
 * @param {Uint8Array} pfaBytes - raw PFA font program bytes
 * @param {PdfFontObj} fontObj - parsed PDF font object
 * @returns {{ otfData: ArrayBuffer, fontMatrix: number[]|null, usesPUA: boolean }|null}
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
    // PDF /Encoding wins over Type1 built-in encoding wins over ToUnicode→AGL.
    // ToUnicode last because it loses glyph identity (e.g. 0x27 → U+0027 → 'quotesingle'
    // straight, but StandardEncoding says 'quoteright' curly).
    if (fontObj.charCodeToGlyphName) {
      for (const [code, glyphName] of fontObj.charCodeToGlyphName) {
        if (parsed.glyphs.has(glyphName)) glyphEncoding.set(code, glyphName);
      }
    }
    for (const [code, name] of parsed.encoding) {
      if (!glyphEncoding.has(code) && !(diffCharCodes && diffCharCodes.has(code)) && parsed.glyphs.has(name)) glyphEncoding.set(code, name);
    }
    if (fontObj.toUnicode && fontObj.toUnicode.size > 0) {
      for (const [charCode, unicode] of fontObj.toUnicode) {
        if (glyphEncoding.has(charCode)) continue;
        const cp = unicode.codePointAt(0);
        const name = unicodeToAGL(cp);
        if (name && parsed.glyphs.has(name)) glyphEncoding.set(charCode, name);
      }
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

    // Type1 path coords and advance widths are in font units that FontMatrix
    // scales to em. Output OTF is fixed at unitsPerEm=1000, so multiply by
    // fm[0]*1000 (no-op when fm[0]=0.001).
    const fm = parsed.fontMatrix;
    const isUniformDiag = fm && fm.length >= 4
      && fm[1] === 0 && fm[2] === 0
      && fm[0] > 0 && fm[3] > 0
      && Math.abs(fm[0] - fm[3]) < 1e-9;
    const pathScale = isUniformDiag ? fm[0] * 1000 : 1;
    const needsScale = pathScale !== 1 && Math.abs(pathScale - 1) > 1e-9;

    const notdefPath = new opentype.Path();
    const glyphs = [new opentype.Glyph({
      name: '.notdef', unicode: 0, advanceWidth: 0, path: notdefPath,
    })];
    const usedUnicodes = new Set([0]);

    // showType1Literal routes every /Differences-mapped char of a usesPUA font to 0xE000+charCode.
    // If any glyph lacks a single-codepoint Unicode (AGL/encoding/ToUnicode), every glyph goes to PUA.
    let usedPUA = false;
    for (const [charCode, glyphName] of glyphEncoding) {
      if (charCode < 0 || charCode > 0xFF || !parsed.glyphs.has(glyphName)) continue;
      const eu = fontObj.encodingUnicode && fontObj.encodingUnicode.get(charCode);
      if (eu && [...eu].length === 1) continue;
      const tu = fontObj.toUnicode && fontObj.toUnicode.get(charCode);
      if (tu && [...tu].length === 1) continue;
      const agl = aglLookup(glyphName);
      if (agl && [...agl].length === 1) continue;
      usedPUA = true;
      break;
    }

    for (const [charCode, glyphName] of glyphEncoding) {
      const glyphData = parsed.glyphs.get(glyphName);
      if (!glyphData) continue;
      const euUnicode = fontObj.encodingUnicode && fontObj.encodingUnicode.get(charCode);
      const tuUnicode = fontObj.toUnicode && fontObj.toUnicode.get(charCode);
      let unicode;
      if (euUnicode && [...euUnicode].length === 1) {
        unicode = euUnicode.codePointAt(0);
      } else if (tuUnicode && [...tuUnicode].length === 1) {
        unicode = tuUnicode.codePointAt(0);
      } else {
        const aglStr = aglLookup(glyphName);
        if (aglStr && [...aglStr].length === 1) {
          unicode = aglStr.codePointAt(0);
          if (fontObj.toUnicode && !fontObj.toUnicode.has(charCode)) fontObj.toUnicode.set(charCode, aglStr);
          if (fontObj.encodingUnicode && !fontObj.encodingUnicode.has(charCode)) fontObj.encodingUnicode.set(charCode, aglStr);
        }
      }
      // A positive-width glyph whose drawn codepoint would not render correctly drawn bare
      // (a combining mark, default-ignorable, or complex-shaping script) must be rerouted through a PUA codepoint.
      const rerouteToPUA = unicode !== undefined
        && drawnGlyphNeedsPUA(unicode, fontObj.widths && fontObj.widths.get(charCode));
      let unicodes;
      if (usedPUA) {
        if (charCode < 0 || charCode > 0xFF) continue;
        const puaCode = 0xE000 + charCode;
        unicodes = [puaCode];
        usedUnicodes.add(puaCode);
        if (!rerouteToPUA && unicode !== undefined && unicode !== puaCode && !usedUnicodes.has(unicode)) {
          unicodes.push(unicode);
          usedUnicodes.add(unicode);
        }
      } else if (rerouteToPUA) {
        if (charCode < 0 || charCode > 0xFF) continue;
        const puaCode = 0xE000 + charCode;
        if (usedUnicodes.has(puaCode)) continue;
        usedUnicodes.add(puaCode);
        unicodes = [puaCode];
      } else {
        if (!unicode || usedUnicodes.has(unicode)) continue;
        usedUnicodes.add(unicode);
        unicodes = [unicode];
      }

      let advanceWidth = glyphData.advanceWidth;
      let glyphPath = glyphData.path;
      if (needsScale && glyphPath && glyphPath.commands) {
        const scaled = new opentype.Path();
        for (const cmd of glyphPath.commands) {
          const sc = { ...cmd };
          if (sc.x !== undefined) sc.x *= pathScale;
          if (sc.y !== undefined) sc.y *= pathScale;
          if (sc.x1 !== undefined) sc.x1 *= pathScale;
          if (sc.y1 !== undefined) sc.y1 *= pathScale;
          if (sc.x2 !== undefined) sc.x2 *= pathScale;
          if (sc.y2 !== undefined) sc.y2 *= pathScale;
          scaled.commands.push(sc);
        }
        glyphPath = scaled;
        if (advanceWidth) advanceWidth *= pathScale;
      }
      if (fontObj.widths) {
        const pdfWidth = fontObj.widths.get(charCode);
        if (pdfWidth !== undefined) advanceWidth = pdfWidth;
      }

      glyphs.push(new opentype.Glyph({
        name: glyphName,
        unicode: unicodes[0],
        unicodes,
        advanceWidth: advanceWidth || 500,
        path: glyphPath,
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
    // Uniform diagonal FontMatrix is handled above by pre-scaling paths and widths;
    // only return fontMatrix when it contains off-diagonal or asymmetric terms.
    let fontMatrix = null;
    if (fm && fm.length >= 4
      && (fm[1] !== 0 || fm[2] !== 0 || Math.abs(fm[3]) !== Math.abs(fm[0]))) {
      // Normalize: multiply by unitsPerEm (1000) to get the transform relative to identity
      fontMatrix = [fm[0] * 1000, fm[1] * 1000, fm[2] * 1000, fm[3] * 1000, 0, 0];
    }

    return { otfData, fontMatrix, usesPUA: usedPUA };
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

    const tableDir = opentype.readSfntTableDirectory(data);
    if (!tableDir.head || !tableDir.maxp || !tableDir.loca || !tableDir.glyf || !tableDir.hhea || !tableDir.hmtx) return null;

    const head = opentype.parseHeadTable(data, tableDir.head.offset);
    const maxp = opentype.parseMaxpTable(data, tableDir.maxp.offset);
    const hhea = opentype.parseHheaTable(data, tableDir.hhea.offset);
    const loca = opentype.parseLocaTable(data, tableDir.loca.offset, maxp.numGlyphs, head.indexToLocFormat === 0);

    const fontShell = { unitsPerEm: head.unitsPerEm, numGlyphs: maxp.numGlyphs, tables: {} };
    fontShell.glyphs = opentype.parseGlyfTable(data, tableDir.glyf.offset, loca, fontShell);
    opentype.parseHmtxTable(data, tableDir.hmtx.offset, hhea.numberOfHMetrics, maxp.numGlyphs, fontShell.glyphs);

    const glyphToUnicode = new Map();
    /** @type {Map<number, Set<number>>} Every codepoint a Unicode cmap maps to a glyph, not just the primary one. */
    const gidExtraUnicodes = new Map();
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
        const hasOutline = gid + 1 < loca.length && loca[gid + 1] > loca[gid];
        // CID 0 is the .notdef glyph, whose ToUnicode (if any) is meaningless: a producer may map code 0 to a real letter purely as extraction filler,
        // so it must never claim a real Unicode and paint a fabricated character.
        // When it has an outline, key it at its PUA codepoint so the renderer draws the embedded notdef outline instead.
        if (cid === 0) {
          if (hasOutline) {
            glyphToUnicode.set(gid, cidCodepoint(undefined, cid, fontObj.widths?.get(cid)).codepoint);
            usesPUA = true;
          }
          continue;
        }
        // Skip GIDs with neither an outline nor a ToUnicode entry: an Identity CIDToGIDMap spans every GID including empty padding,
        // and assigning each the synthetic PUA codepoint below would let a padding glyph evict a real glyph whose ToUnicode legitimately maps it into the PUA.
        if (!hasOutline && !cidToUnicode?.has(cid)) continue;
        const decision = cidCodepoint(cidToUnicode?.get(cid), cid, fontObj.widths?.get(cid));
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
          // The renderer draws each code as the PUA codepoint 0xF000 + charCode (see parseDrawOps.js),
          // so the rebuilt cmap keys must land in the 0xF000+ range to match.
          // Map each key on its own: a key already >= 0xF000 is kept, a lower key is OR'd into 0xF000+.
          cmapType = 'symbol';
          for (const [unicodeStr, gi] of Object.entries(cmap.glyphIndexMap)) {
            const unicode = Number(unicodeStr);
            if (gi > 0 && !glyphToUnicode.has(gi)) {
              glyphToUnicode.set(gi, unicode >= 0xF000 ? unicode : (0xF000 | unicode));
            }
          }
        } else if (fontObj.toUnicode && cmap.platformID === 1) {
          // platformID=1 cmap keys are charCodes, not codepoints, so map each code to its drawn codepoint via toUnicode.
          // Use a per-code private-use codepoint (0xE000+charCode) instead wherever the toUnicode value would not render this glyph under fillText:
          // a multi-codepoint mapping (codes would collide on a shared first codepoint), or a first codepoint that is a combining/Indic mark, default-ignorable, or in a complex-shaping script.
          // A code with no toUnicode entry also takes a PUA codepoint when its charCode matches another code's toUnicode target.
          cmapType = 'rawCharCode';

          // Prefer the post table when available rather than the (1,0) Mac cmap, because post appears to be more reliable.
          if (tableDir.post) {
            const post = opentype.parsePostTable(data, tableDir.post.offset);
            const customNames = post.names || [];
            const limit = post.glyphNameIndex ? (post.numberOfGlyphs || 0) : customNames.length;
            const postUnicodeToGid = new Map();
            for (let gid = 1; gid < limit; gid++) {
              let name;
              if (post.glyphNameIndex) {
                const idx = post.glyphNameIndex[gid];
                name = idx < 258 ? standardNames[idx] : customNames[idx - 258];
              } else {
                name = customNames[gid];
              }
              if (!name || name === '.notdef') continue;
              const uniStr = aglLookup(name);
              if (!uniStr || [...uniStr].length !== 1) continue;
              const cp = uniStr.codePointAt(0);
              // First GID wins a given codepoint (post tables are ~1:1 name -> glyph).
              if (cp && !postUnicodeToGid.has(cp)) postUnicodeToGid.set(cp, gid);
            }
            for (const [, uStr] of fontObj.toUnicode) {
              if (!uStr || [...uStr].length !== 1) continue;
              const cp = uStr.codePointAt(0);
              const gid = postUnicodeToGid.get(cp);
              if (gid !== undefined && gid > 0 && gid < maxp.numGlyphs && !glyphToUnicode.has(gid)) {
                glyphToUnicode.set(gid, cp);
              }
            }
          }

          // parseCmapTableFormat0 re-keys glyphIndexMap's high half (0x80..0xFF) by Mac-Roman Unicode,
          // which can overwrite a raw code -> GID entry.
          // Read the unmodified byte array so a (1,0) cmap used as a direct glyph-index table survives.
          const codeGidPairs = cmap.byteToGlyphIndex
            ? cmap.byteToGlyphIndex.flatMap((gi, charCode) => (gi > 0 ? [[charCode, gi]] : []))
            : Object.entries(cmap.glyphIndexMap).map(([c, gi]) => [Number(c), gi]);

          const toUnicodeTargets = new Set();
          for (const [, uStr] of fontObj.toUnicode) {
            if (uStr && [...uStr].length === 1) toUnicodeTargets.add(uStr.codePointAt(0));
          }
          for (const [charCode, gi] of codeGidPairs) {
            if (gi <= 0) continue;
            const uniStr = fontObj.toUnicode.get(charCode);
            let unicode;
            if (uniStr) {
              const firstCp = uniStr.codePointAt(0) || 0;
              if ([...uniStr].length > 1 || isCombiningOrIndicMark(firstCp) || isDefaultIgnorable(firstCp) || isComplexShapingScript(firstCp)) {
                unicode = 0xE000 + charCode;
              } else {
                unicode = firstCp;
              }
            } else {
              unicode = toUnicodeTargets.has(charCode) ? 0xE000 + charCode : charCode;
            }
            if (unicode && !glyphToUnicode.has(gi)) {
              glyphToUnicode.set(gi, unicode);
            }
          }
        } else {
          // cmap keys are Unicode codepoints, and several can map to one glyph (e.g. a curly quote at both U+0093 and U+201C).
          // Keep the printable codepoint over a control-range one (below 0x20, or 0x7F-0x9F), which the renderer would skip or misrender.
          for (const [unicodeStr, gi] of Object.entries(cmap.glyphIndexMap)) {
            const unicode = Number(unicodeStr);
            if (gi <= 0) continue;
            const existing = glyphToUnicode.get(gi);
            const existingIsControl = existing !== undefined && (existing < 0x20 || (existing >= 0x7F && existing <= 0x9F));
            const newIsControl = unicode < 0x20 || (unicode >= 0x7F && unicode <= 0x9F);
            if (existing === undefined || (existingIsControl && !newIsControl)) {
              glyphToUnicode.set(gi, unicode);
            }
            // Record every codepoint, not just the primary,
            // so a caps-only font whose cmap aims both 'A' and 'a' at one glyph still resolves a lowercase code.
            let extras = gidExtraUnicodes.get(gi);
            if (!extras) { extras = new Set(); gidExtraUnicodes.set(gi, extras); }
            extras.add(unicode);
          }
        }
      }
    }

    // Round-trip guard for the general (Unicode-cmap) branch: that branch keys glyphs only by the embedded cmap,
    // so a code whose drawn codepoint (encodingUnicode/ToUnicode) is absent from the embedded cmap would miss its glyph (divergence).
    // Resolve code -> glyph name (charCodeToGlyphName) -> GID (post table) and additively key that GID under the drawn codepoint.
    // Skipped for symbol/rawCharCode cmaps (cmapType set), CID fonts, and fonts with no post names.
    // Additive, so a no-op when the embedded cmap already covers the drawn codepoints.
    if (!cidToGidMap && cmapType === null && fontObj.charCodeToGlyphName && tableDir.post) {
      const post = opentype.parsePostTable(data, tableDir.post.offset);
      const nameToGid = new Map();
      if (post.glyphNameIndex) {
        const customNames = post.names || [];
        for (let gid = 1; gid < (post.numberOfGlyphs || 0); gid++) {
          const nameIdx = post.glyphNameIndex[gid];
          const name = nameIdx < 258 ? standardNames[nameIdx] : customNames[nameIdx - 258];
          if (name && name !== '.notdef' && !nameToGid.has(name)) nameToGid.set(name, gid);
        }
      } else if (post.names) {
        for (let gid = 1; gid < post.names.length; gid++) {
          const name = post.names[gid];
          if (name && name !== '.notdef' && !nameToGid.has(name)) nameToGid.set(name, gid);
        }
      }
      if (nameToGid.size > 0) {
        const codeToGid = new Map();
        for (const [code, name] of fontObj.charCodeToGlyphName) {
          const gid = nameToGid.get(name);
          if (gid !== undefined && gid > 0) codeToGid.set(code, gid);
        }
        addRoundTripCodepoints(fontObj, codeToGid, (cp, gid) => {
          if (!glyphToUnicode.has(gid)) {
            glyphToUnicode.set(gid, cp);
          } else {
            let extras = gidExtraUnicodes.get(gid);
            if (!extras) { extras = new Set(); gidExtraUnicodes.set(gid, extras); }
            extras.add(cp);
          }
        });
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
      // Give the glyph every codepoint the cmap aimed at it (deduped against codepoints already taken),
      // so a caps-only font reached by a lowercase code still resolves.
      const unicodes = [unicode];
      const extras = gidExtraUnicodes.get(gi);
      if (extras) {
        for (const u of extras) {
          if (u !== unicode && !usedUnicodes.has(u)) { unicodes.push(u); usedUnicodes.add(u); }
        }
      }
      origGidToNewIdx.set(gi, glyphs.length);
      let advanceWidth = g.advanceWidth || head.unitsPerEm;
      const maxSafeAdvanceWidth = Math.min(32767, head.unitsPerEm * 4);
      if (advanceWidth > maxSafeAdvanceWidth) {
        // Corrupt hmtx entries can overflow signed bbox fields in the generated head table.
        advanceWidth = head.unitsPerEm;
      }
      const newGlyph = new opentype.Glyph({
        name: `glyph_${gi}`,
        unicode,
        unicodes,
        advanceWidth,
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

    // Pull in any component glyphs a composite references that are not otherwise in the subset
    // (e.g. an arrow whose gid references an unmapped base glyph plus a transform).
    // Otherwise the remap step below flattens the glyph to a simple outline and mishandles the component transform,
    // rendering it vertically flipped. Keeping it composite lets the canvas font rasterizer apply the transform itself.
    for (let i = glyphs.length - 1; i >= 1; i--) {
      const g = glyphs[i];
      if (!g.isComposite || !g.components) continue;
      for (const comp of g.components) {
        const cgid = comp.glyphIndex;
        if (origGidToNewIdx.has(cgid)) continue;
        const cg = fontShell.glyphs.get(cgid);
        if (!cg || !cg.path) continue;
        origGidToNewIdx.set(cgid, glyphs.length);
        const compGlyph = new opentype.Glyph({
          name: `glyph_${cgid}`,
          advanceWidth: cg.advanceWidth || head.unitsPerEm,
          path: cg.path,
        });
        if (cg.points) {
          compGlyph.points = cg.points;
          if (cg._xMin !== undefined) {
            compGlyph._xMin = cg._xMin;
            compGlyph._yMin = cg._yMin;
            compGlyph._xMax = cg._xMax;
            compGlyph._yMax = cg._yMax;
            compGlyph.leftSideBearing = cg._xMin;
          }
        }
        if (cg.isComposite && cg.components) {
          compGlyph.isComposite = true;
          compGlyph.components = cg.components;
        }
        glyphs.push(compGlyph);
      }
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
        // Drop the composite's stale bbox so the glyf writer recomputes it from the
        // flattened contour points (the inherited bbox may not enclose them).
        g._xMin = undefined;
        g._yMin = undefined;
        g._xMax = undefined;
        g._yMax = undefined;
      }
    }

    if (glyphs.length <= 1) return null;

    // Flag + skip fonts with no drawable outlines.
    let hasOutline = false;
    for (let i = 1; i < glyphs.length; i++) {
      if ((glyphs[i].path && glyphs[i].path.commands.length > 0) || glyphs[i].isComposite) {
        hasOutline = true;
        break;
      }
    }
    if (!hasOutline) {
      fontObj.allGlyphsEmpty = true;
      console.warn(`[rebuildFontFromGlyphs] Metrics-only subset for "${fontObj.baseName}" — all ${glyphs.length - 1} glyphs have empty outlines, skipping rebuild`);
      return null;
    }

    // opentype.Font requires a positive ascender and a non-positive descender;
    // subsetted embedded fonts sometimes ship an hhea that violates this.
    const newFont = new opentype.Font({
      familyName: fontObj.baseName || 'RebuiltFont',
      styleName: 'Regular',
      unitsPerEm: head.unitsPerEm,
      ascender: hhea.ascender > 0 ? hhea.ascender : Math.round(head.unitsPerEm * 0.8),
      descender: hhea.descender > 0 ? -hhea.descender : hhea.descender,
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
