// Function for converting from bufferArray to hex (string)
// Taken from https://stackoverflow.com/questions/40031688/javascript-arraybuffer-to-hex

import { win1252Chars } from '../../../fonts/encoding.js';
import { determineSansSerif } from '../../utils/miscUtils.js';
import { GlobalFonts } from '../../containers/fontContainer.js';
import { getDistinctCharsFont, subsetFont } from '../../utils/fontUtils.js';
import { encodeStreamObject, encodeBinaryStreamObject } from './writePdfStreams.js';

/**
 * Advance-width scale factors for the width-scaled font variants.
 * For example, the 1.1 variant is identical to the standard font,
 * except has a *declared width* (`/Width` array) 1.1x the standard variant.
 * The *visual width* is identical.
 * @type {Number[]}
 */
export const FONT_WIDTH_VARIANT_SCALES = [1.1, 1.2, 1.3, 1.4, 1.5];

/** @typedef {import('../../containers/fontContainer.js').DocFonts} DocFonts */

/** @type {Array<string>} */
const byteToHex = [];

for (let n = 0; n <= 0xff; ++n) {
  const hexOctet = n.toString(16).padStart(2, '0');
  byteToHex.push(hexOctet);
}

/**
 * Converts an ArrayBuffer to a hexadecimal string.
 *
 * @param {ArrayBufferLike} arrayBuffer - The ArrayBuffer to be converted.
 * @returns {string} The hexadecimal representation of the ArrayBuffer.
 */
export function hex(arrayBuffer) {
  const buff = new Uint8Array(arrayBuffer);
  let hexOctets = '';
  for (let i = 0; i < buff.length; ++i) {
    if (i % 32 === 0 && i !== 0) hexOctets += '\n';
    hexOctets += byteToHex[buff[i]];
  }

  return hexOctets;
}

/**
 * Creates a ToUnicode CMap string for a font.
 * The CMap maps character codes to Unicode values to enable text extraction.
 *
 * @param {import('../../font-parser/src/font.js').Font} font - Opentype.js font object
 * @param {Map<number, string>} [toUnicodeOverride] - Optional per-GID unicode override.
 *   When present, the GID's entry in the CMap is emitted as the supplied string
 *   (which may be multi-codepoint, e.g. "fi" for a ligature glyph). Falls back to
 *   `glyph.unicode` for GIDs not in the map.
 * @returns {string} The ToUnicode CMap content string
 */
export function createToUnicode(font, toUnicodeOverride) {
  let cmapStr = `/CIDInit /ProcSet findresource begin
12 dict begin
begincmap
/CIDSystemInfo
<< /Registry (Adobe)
   /Ordering (UCS)
   /Supplement 0
>> def
/CMapName /Adobe-Identity-UCS def
/CMapType 2 def
1 begincodespacerange
<0000> <FFFF>
endcodespacerange\n`;

  // Get all glyphs and their unicode values
  const entries = [];
  for (let i = 0; i < font.glyphs.length; i++) {
    const glyph = font.glyphs.glyphs[String(i)];
    const override = toUnicodeOverride ? toUnicodeOverride.get(i) : undefined;
    const srcHex = i.toString(16).padStart(4, '0');
    if (override !== undefined) {
      let unicodeHex = '';
      for (const cp of override) {
        unicodeHex += cp.codePointAt(0).toString(16).padStart(4, '0');
      }
      if (unicodeHex) entries.push(`<${srcHex}> <${unicodeHex}>`);
    } else if (glyph.unicode !== undefined) {
      const unicodeHex = glyph.unicode.toString(16).padStart(4, '0');
      entries.push(`<${srcHex}> <${unicodeHex}>`);
    }
  }

  // Write entries in chunks of 100
  const chunkSize = 100;
  for (let i = 0; i < entries.length; i += chunkSize) {
    const chunk = entries.slice(i, i + chunkSize);
    cmapStr += `${chunk.length} beginbfchar\n`;
    cmapStr += chunk.join('\n');
    cmapStr += '\nendbfchar\n';
  }

  cmapStr += `endcmap
CMapName currentdict /CMap defineresource pop
end
end`;

  return cmapStr;
}

/**
 * Generates the flags value for a PDF font descriptor.
 *
 * @param {boolean} serif - Whether the font has serifs.
 * @param {boolean} italic - Whether the font is italicized.
 * @param {boolean} smallcap - Whether the font uses small caps.
 * @param {boolean} symbolic - Whether the font contains glyphs outside the Adobe standard Latin character set.
 * @returns {number} The flags value as an unsigned 32-bit integer.
 */
const generateFontFlags = (serif, italic, smallcap, symbolic) => {
  let flags = 0;

  // Set bits based on the input flags:
  if (serif) flags |= (1 << 1); // Set bit 2 for serif
  if (italic) flags |= (1 << 6); // Set bit 7 for italic
  if (smallcap) flags |= (1 << 17); // Set bit 18 for smallcap
  if (symbolic) {
    flags |= (1 << 2); // Set bit 3 for symbolic
  } else {
    flags |= (1 << 5); // Set bit 6 for nonsymbolic
  }

  return flags;
};

/**
 *
 * @param {opentypeFont} font - Opentype.js font object
 * @param {number} objIndex - Index for font descriptor PDF object
 * @param {boolean} italic
 * @param {?number} embeddedObjIndex - Index for embedded font file PDF object.
 *  If not provided, the font will not be embedded in the PDF.
 * @returns {string} The font descriptor object string.
 */
function createFontDescriptor(font, objIndex, italic, embeddedObjIndex = null) {
  let objOut = `${String(objIndex)} 0 obj\n<</Type/FontDescriptor`;

  const namesTable = font.names.windows || font.names;

  objOut += `/FontName/${namesTable.postScriptName.en}`;

  const headTable = font.tables.head;
  if (headTable) {
    objOut += `/FontBBox[${[font.tables.head.xMin, font.tables.head.yMin, font.tables.head.xMax, font.tables.head.yMax].join(' ')}]`;
  } else {
    // Not all fonts have a head table, so we set the FontBBox to 0, which per the PDF specification appears to be acceptable.
    // "If all four elements of the rectangle are zero, no assumptions are made based
    // on the font bounding box. If any element is nonzero, it is essential that the
    // font bounding box be accurate. If any glyph’s marks fall outside this bounding
    // box, incorrect behavior may result."
    objOut += '/FontBBox[0 0 0 0]';
  }

  const postTable = font.tables.post;

  if (postTable) {
    objOut += `/ItalicAngle ${String(postTable.italicAngle)}`;
  } else {
    // This is only correct for non-italic fonts. Unclear if this matters or not.
    objOut += '/ItalicAngle 0';
  }

  objOut += `/Ascent ${String(font.ascender)}`;

  objOut += `/Descent ${String(font.descender)}`;

  // StemV is a required field, however it is not already in the opentype font, and does not appear to matter.
  // Therefore, we set to 0.08 * em to mimic the behavior of other programs.
  // https://www.verypdf.com/document/pdf-format-reference/pg_0457.htm
  // https://stackoverflow.com/questions/35485179/stemv-value-of-the-truetype-font
  objOut += `/StemV ${String(Math.round(0.08 * font.unitsPerEm))}`;

  const category = determineSansSerif(namesTable.postScriptName.en);
  const symbolic = category === 'SymbolDefault';
  const serif = !symbolic && category !== 'SansDefault';

  objOut += `/Flags ${String(generateFontFlags(serif, italic, false, symbolic))}`;

  if (embeddedObjIndex === null || embeddedObjIndex === undefined) {
    objOut += '>>\nendobj\n\n';
    return objOut;
  }

  objOut += `/FontFile3 ${String(embeddedObjIndex)} 0 R`;

  objOut += '>>\nendobj\n\n';

  return objOut;
}

/**
 * Converts a Opentype.js font object into an array of PDF objects.
 * The font is represented as a simple "Type 1" font.
 * This code is currently unused, as Type 0 is used for all fonts.
 *
 * @param {opentypeFont} font - Opentype.js font object
 * @param {number} firstObjIndex - Index for the first PDF object
 * @param {boolean} [italic=false] - Whether the font is italic.
 * @param {boolean} [isStandardFont=false] - Whether the font is a standard font.
 *  Standard fonts are not embedded in the PDF.
 * @param {boolean} [humanReadable=false] - If true, embed the font file as
 *   ASCII-hex instead of Flate-compressed binary.
 * @returns {Promise<Array<string | import('./writePdfStreams.js').PdfBinaryObject>>}
 */
export async function createEmbeddedFontType1(font, firstObjIndex, italic = false, isStandardFont = false, humanReadable = false) {
  // Start 1st object: Font Dictionary
  let fontDictObjStr = `${String(firstObjIndex)} 0 obj\n<</Type/Font/Subtype/Type1`;

  // Add font name
  fontDictObjStr += `\n/BaseFont/${font.tables.name.postScriptName.en}`;

  fontDictObjStr += '/Encoding/WinAnsiEncoding';

  // const cmapIndices = Object.keys(font.tables.cmap.glyphIndexMap).map((x) => parseInt(x));

  fontDictObjStr += '/Widths[';
  for (let i = 0; i < win1252Chars.length; i++) {
    const advance = font.charToGlyph(win1252Chars[i]).advanceWidth || font.unitsPerEm;
    const advanceNorm = Math.round(advance * (1000 / font.unitsPerEm));
    fontDictObjStr += `${String(advanceNorm)} `;
  }
  fontDictObjStr += ']/FirstChar 32/LastChar 255';

  fontDictObjStr += `/FontDescriptor ${String(firstObjIndex + 1)} 0 R>>\nendobj\n\n`;

  // Start 2nd object: Font Descriptor
  const fontDescObjStr = createFontDescriptor(font, firstObjIndex + 1, italic, isStandardFont ? null : firstObjIndex + 2);

  // objOut += `${String(firstObjIndex + 1)} 0 obj\n<</Type/FontDescriptor`;

  // objOut += `/FontName/${font.tables.name.postScriptName.en}`;

  // objOut += `/FontBBox[${[font.tables.head.xMin, font.tables.head.yMin, font.tables.head.xMax, font.tables.head.yMax].join(' ')}]`;

  // objOut += `/ItalicAngle ${String(font.tables.post.italicAngle)}`;

  // objOut += `/Ascent ${String(font.ascender)}`;

  // objOut += `/Descent ${String(font.descender)}`;

  // // StemV is a required field, however it is not already in the opentype font, and does not appear to matter.
  // // Therefore, we set to 0.08 * em to mimic the behavior of other programs.
  // // https://www.verypdf.com/document/pdf-format-reference/pg_0457.htm
  // // https://stackoverflow.com/questions/35485179/stemv-value-of-the-truetype-font
  // objOut += `/StemV ${String(Math.round(0.08 * font.unitsPerEm))}`;

  // objOut += `/Flags ${String(font.tables.head.flags)}`;

  // if (isStandardFont) {
  //   objOut += '>>\nendobj\n\n';
  //   return objOut;
  // }

  // objOut += `/FontFile3 ${String(firstObjIndex + 2)} 0 R`;

  // objOut += '>>\nendobj\n\n';

  // Start 3rd object: Font File
  const fontBuffer = new Uint8Array(font.toArrayBuffer());
  const fontFileObj = await encodeBinaryStreamObject(firstObjIndex + 2, fontBuffer, {
    humanReadable,
    dictExtras: `/Length1 ${String(fontBuffer.byteLength)}/Subtype/OpenType`,
  });

  return [fontDictObjStr, fontDescObjStr, fontFileObj];
}

/**
 * Converts a Opentype.js font object into an array of PDF objects.
 * The font is represented as a composite "Type 0" font.
 *
 * @param {Object} options - Configuration object
 * @param {opentypeFont} options.font - Opentype.js font object
 * @param {number} options.firstObjIndex - Index for the first PDF object
 * @param {boolean} [options.italic=false] - Whether the font is italic.
 * @param {boolean} [options.humanReadable=false] - If true, emit the font
 *   file as ASCII-hex and the ToUnicode CMap uncompressed, for debugging.
 *   When false (default), both are Flate-compressed.
 * @param {Map<number, string>} [options.toUnicodeOverride] - Optional per-GID
 *   ToUnicode override. Values may be multi-codepoint strings (e.g. "fi" for a
 *   ligature). GIDs absent from the map fall back to `glyph.unicode`.
 * @param {number} [options.widthScale=1] - Advance-width multiplier for a width-scaled variant.
 *   Scales the emitted `/W` array; 1 (default) for a base font.
 * @param {number} [options.baseDescriptorObjN] - For a width-scaled variant, the object number of the base font's shared FontDescriptor.
 *   This argument should be left empty by default.
 * @param {number} [options.baseToUnicodeObjN] - For a width-scaled variant, the object number of the base font's shared ToUnicode CMap.
 * @returns {Promise<Array<string | import('./writePdfStreams.js').PdfBinaryObject | null>>}
 */
export async function createEmbeddedFontType0({
  font, firstObjIndex, italic = false, humanReadable = false, toUnicodeOverride,
  widthScale = 1, baseDescriptorObjN, baseToUnicodeObjN,
}) {
  // A width-scaled variant shares the base font's FontDescriptor (+1), FontFile (+3), and ToUnicode (+5) instead of re-embedding them.
  // It emits only the Type0 dict (+0), the scaled `/W` (+2), and the CIDFont dict (+4),
  // returning null for the three shared slots (callers write a free xref entry for each).
  const variantMode = !!baseDescriptorObjN;
  const descriptorObjN = variantMode ? baseDescriptorObjN : firstObjIndex + 1;
  const toUnicodeObjN = variantMode ? baseToUnicodeObjN : firstObjIndex + 5;

  // Start 1st object: Font Dictionary
  let fontDictObjStr = `${String(firstObjIndex)} 0 obj\n<</Type/Font/Subtype/Type0`;

  // The relevant table is sometimes but not always in a property named `windows`.
  const namesTable = font.names.windows || font.names;

  // Add font name
  fontDictObjStr += `/BaseFont/${namesTable.postScriptName.en}`;

  fontDictObjStr += '/Encoding/Identity-H';

  fontDictObjStr += `/ToUnicode ${String(toUnicodeObjN)} 0 R`;

  fontDictObjStr += `/DescendantFonts[${String(firstObjIndex + 4)} 0 R]`;

  fontDictObjStr += '>>\nendobj\n\n';

  // 2nd object: ToUnicode CMap. 3rd: FontDescriptor.
  // In variant mode both are shared from the base font (referenced by object number) and not re-emitted, so their slots come back null.
  const toUnicodeObj = variantMode
    ? null
    : await encodeStreamObject(firstObjIndex + 5, createToUnicode(font, toUnicodeOverride), { humanReadable });
  const fontDescObjStr = variantMode
    ? null
    : createFontDescriptor(font, firstObjIndex + 1, italic, firstObjIndex + 3);

  // Start 4th object: widths
  let widthsObjStr = `${String(firstObjIndex + 2)} 0 obj\n`;

  // Emit CIDFontType2 glyph widths as [firstGlyphIndex [w0 w1 ...]].
  // The widths must be present and accurate or glyphs render wrong, but need not be packed efficiently (no run grouping).
  // A width-scaled variant folds its inter-character stretch into these declared advances via `widthScale`.
  widthsObjStr += '[ 0 [';
  for (let i = 0; i < font.glyphs.length; i++) {
    const advanceNorm = Math.round(font.glyphs.glyphs[String(i)].advanceWidth * widthScale * (1000 / font.unitsPerEm));
    widthsObjStr += `${String(advanceNorm)} `;
  }
  widthsObjStr += '] ]';

  widthsObjStr += '\nendobj\n\n';

  // Start 5th object: Font File. In variant mode the base font's copy is shared, so none is embedded.
  /** @type {string | import('./writePdfStreams.js').PdfBinaryObject | null} */
  let fontFileObj = null;
  if (!variantMode) {
    const fontBuffer = new Uint8Array(font.toArrayBuffer());
    fontFileObj = await encodeBinaryStreamObject(firstObjIndex + 3, fontBuffer, {
      humanReadable,
      dictExtras: `/Length1 ${String(fontBuffer.byteLength)}/Subtype/OpenType`,
    });
  }

  // Start 6th object: Font
  let fontObjStr = `${String(firstObjIndex + 4)} 0 obj\n`;

  fontObjStr += '<</Type/Font/Subtype/CIDFontType0/CIDSystemInfo<</Registry(Adobe)/Ordering(Identity)/Supplement 0>>';

  fontObjStr += `/BaseFont/${namesTable.postScriptName.en}/FontDescriptor ${String(descriptorObjN)} 0 R`;

  fontObjStr += `/W ${String(firstObjIndex + 2)} 0 R`;

  fontObjStr += '>>\nendobj\n\n';

  // Object-number order: [+0 Type0 dict, +1 FontDescriptor, +2 /W, +3 FontFile, +4 CIDFont, +5 ToUnicode].
  // Variant mode returns null at +1/+3/+5. Callers write a free xref entry for each.
  return [fontDictObjStr, fontDescObjStr, widthsObjStr, fontFileObj, fontObjStr, toUnicodeObj];
}

/**
 * Generate PDF font objects, not including the actual font data.
 * @param {number} objectIStart - Starting object index
 * @param {?Array<OcrPage>} [ocrArr] - Array of OcrPage objects
 *    Used to subset supplementary fonts to only the characters that are actually used.
 * @param {DocFonts} [docFonts] - Per-document fonts.
 */
export const createPdfFontRefs = async (objectIStart, ocrArr, docFonts) => {
  if (!GlobalFonts.raw) throw new Error('No fonts loaded.');

  const fonts = docFonts;

  let objectI = objectIStart;

  let fontI = 0;
  /** @type {Object<string, PdfFontFamily>} */
  const pdfFonts = {};
  /** @type {{familyKey: string, key: string}[]} */
  const pdfFontRefs = [];
  /** @type {string[][]} */
  const pdfFontObjStrArr = [];

  /**
   *
   * @param {string} familyKey
   * @param {FontContainerFamily} familyObj
   */
  const addFontFamilyRef = async (familyKey, familyObj) => {
    pdfFonts[familyKey] = {};
    for (const [key, value] of Object.entries(familyObj)) {
      if (!value) continue;
      // This should include both (1) if this is a standard 14 font and (2) if characters outside of the Windows-1252 range are used.
      // If the latter is true, then a composite font is needed, even if the font is a standard 14 font.
      // TODO: We currently have no mechanism for resolving name conflicts between fonts in the base and overlay document.
      // As a workaround, we use the names `/FO[n]` rather than the more common `/F[n]`.
      // However, this likely will cause issues if this application is used to create visible text, and then the resulting PDF is uploaded.
      // This would move the fonts from the overlay document to the base document, and the names would conflict.
      const isStandardFont = false;

      let opentype = value.opentype;
      // Whether the document sets any characters in this font.
      let fontUsed = true;
      if (ocrArr) {
        const charArr = getDistinctCharsFont(ocrArr, docFonts, familyKey, key);
        fontUsed = charArr.length > 0;
        opentype = await subsetFont(value.opentype, charArr);
      }

      if (isStandardFont) {
        pdfFonts[familyKey][key] = {
          type: 1, index: fontI, name: `/FO${String(fontI)}`, objN: objectI, opentype,
        };
        pdfFontRefs.push({ familyKey, key });
        pdfFontObjStrArr.push(null);
        objectI += 3;
      } else {
        /** @type {PdfFontInfo} */
        const baseInfo = {
          type: 0, index: fontI, name: `/FO${String(fontI)}`, objN: objectI, opentype,
        };
        pdfFonts[familyKey][key] = baseInfo;
        pdfFontRefs.push({ familyKey, key });
        pdfFontObjStrArr.push(null);
        objectI += 6;

        // Width-scaled variants share the base `opentype` by reference and carry only a `widthScale` (the `/W` array is scaled at embed time)
        // plus the object numbers of the base's shared FontDescriptor (+1) and ToUnicode (+5).
        // Each is registered as an ordinary 6-object font ref (3 real objects + 3 free slots for the shared base objects) so the existing embedding/xref machinery handles it unchanged,
        // and is embedded only when a word selects it in `writePdfText`.
        baseInfo.widthVariants = [];
        if (fontUsed) {
          for (const scale of FONT_WIDTH_VARIANT_SCALES) {
            fontI++;
            baseInfo.widthVariants.push({
              scale,
              info: {
                type: 0,
                index: fontI,
                name: `/FO${String(fontI)}`,
                objN: objectI,
                opentype,
                widthScale: scale,
                baseDescriptorObjN: baseInfo.objN + 1,
                baseToUnicodeObjN: baseInfo.objN + 5,
              },
            });
            pdfFontRefs.push({ familyKey, key });
            pdfFontObjStrArr.push(null);
            objectI += 6;
          }
        }
      }
      fontI++;
    }
  };

  // Create reference to all fonts.
  // Only the fonts that are actually used will be included in the final PDF.
  for (const familyKeyI of Object.keys(GlobalFonts.raw)) {
    const useOpt = fonts.useOptFamily(familyKeyI);
    const familyObjI = {
      normal: useOpt && fonts.opt?.[familyKeyI]?.normal ? fonts.opt[familyKeyI].normal : GlobalFonts.raw[familyKeyI].normal,
      italic: useOpt && fonts.opt?.[familyKeyI]?.italic ? fonts.opt[familyKeyI].italic : GlobalFonts.raw[familyKeyI].italic,
      bold: useOpt && fonts.opt?.[familyKeyI]?.bold ? fonts.opt[familyKeyI].bold : GlobalFonts.raw[familyKeyI].bold,
      boldItalic: useOpt && fonts.opt?.[familyKeyI]?.boldItalic ? fonts.opt[familyKeyI].boldItalic : GlobalFonts.raw[familyKeyI].boldItalic,
    };
    await addFontFamilyRef(familyKeyI, familyObjI);
  }

  if (fonts.doc) {
    for (const familyKeyI of Object.keys(fonts.doc)) {
      await addFontFamilyRef(familyKeyI, fonts.doc[familyKeyI]);
    }
  }

  if (GlobalFonts.supp.chi_sim && ocrArr) {
    const charArr = getDistinctCharsFont(ocrArr, docFonts, GlobalFonts.supp.chi_sim.family);

    if (charArr.length > 0) {
      const fontExport = await subsetFont(GlobalFonts.supp.chi_sim.opentype, charArr);

      pdfFonts.NotoSansSC = {};
      pdfFonts.NotoSansSC.normal = {
        type: 0, index: fontI, name: `/FO${String(fontI)}`, objN: objectI, opentype: fontExport,
      };
      pdfFontRefs.push({ familyKey: 'NotoSansSC', key: 'normal' });
      pdfFontObjStrArr.push(null);
      objectI += 6;
      fontI++;
    }
  } else if (GlobalFonts.supp.chi_sim) {
    console.warn('Chinese font loaded but no OCR data available to determine if it is needed. Font will not be included in PDF.');
  }

  return {
    pdfFonts, pdfFontRefs, pdfFontObjStrArr, objectI,
  };
};
