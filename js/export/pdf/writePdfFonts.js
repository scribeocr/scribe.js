// Function for converting from bufferArray to hex (string)
// Taken from https://stackoverflow.com/questions/40031688/javascript-arraybuffer-to-hex

import { win1252Chars } from '../../../fonts/encoding.js';
import { determineSansSerif } from '../../utils/miscUtils.js';
import { FontCont } from '../../containers/fontContainer.js';
import { getDistinctCharsFont, subsetFont } from '../../utils/fontUtils.js';
import { encodeStreamObject, encodeBinaryStreamObject } from './writePdfStreams.js';

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
 * @returns {string} The ToUnicode CMap content string
 */
export function createToUnicode(font) {
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
    if (glyph.unicode !== undefined) {
      // Format the entry as: <srcCode> <unicode>
      const srcHex = i.toString(16).padStart(4, '0');
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
const generateFontFlags = (serif, italic, smallcap, symbolic) => { /* eslint-disable no-bitwise */
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
    objOut += '/FontBBox[0, 0, 0, 0]';
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

  const serif = determineSansSerif(namesTable.postScriptName.en) !== 'SansDefault';

  // Symbolic is always set to false, even if the font contains glyphs outside the Adobe standard Latin character set.
  // This is because symbolic fonts are only used when embedded, and this does not appear to matter for embedded fonts.
  objOut += `/Flags ${String(generateFontFlags(serif, italic, false, false))}`;

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
 * @returns {Promise<Array<string | import('./writePdfStreams.js').PdfBinaryObject>>}
 */
export async function createEmbeddedFontType0({
  font, firstObjIndex, italic = false, humanReadable = false,
}) {
  // Start 1st object: Font Dictionary
  let fontDictObjStr = `${String(firstObjIndex)} 0 obj\n<</Type/Font/Subtype/Type0`;

  // The relevant table is sometimes but not always in a property named `windows`.
  const namesTable = font.names.windows || font.names;

  // Add font name
  fontDictObjStr += `/BaseFont/${namesTable.postScriptName.en}`;

  fontDictObjStr += '/Encoding/Identity-H';

  fontDictObjStr += `/ToUnicode ${String(firstObjIndex + 5)} 0 R`;

  fontDictObjStr += `/DescendantFonts[${String(firstObjIndex + 4)} 0 R]`;

  fontDictObjStr += '>>\nendobj\n\n';

  // Start 2nd object: ToUnicode CMap
  const toUnicodeStr0 = createToUnicode(font);
  const toUnicodeObj = await encodeStreamObject(firstObjIndex + 5, toUnicodeStr0, { humanReadable });

  // Start 3rd object: FontDescriptor
  const fontDescObjStr = createFontDescriptor(font, firstObjIndex + 1, italic, firstObjIndex + 3);

  // Start 4th object: widths
  let widthsObjStr = `${String(firstObjIndex + 2)} 0 obj\n`;

  // There are 2 ways to represent the widths of the glyphs in a CIDFontType2.
  // (1) [first glyph index] [array of widths]
  // (2) [first glyph index] [last glyph index] [single width for all glyphs in range]
  // The smallest way to represent widths is to use both methods,
  // with the second method used for ranges of glyphs with the same width.
  // However, only the first method is used here, as mupdf rewrites the widths object.
  // The widths object needs to be present and accurate, as otherwise the glyphs will not be displayed correctly,
  // however it is not important that the widths be efficiently represented at this point.
  widthsObjStr += '[ 0 [';
  for (let i = 0; i < font.glyphs.length; i++) {
    const advanceNorm = Math.round(font.glyphs.glyphs[String(i)].advanceWidth * (1000 / font.unitsPerEm));
    widthsObjStr += `${String(advanceNorm)} `;
  }
  widthsObjStr += '] ]';

  widthsObjStr += '\nendobj\n\n';

  // Start 5th object: Font File
  const fontBuffer = new Uint8Array(font.toArrayBuffer());
  const fontFileObj = await encodeBinaryStreamObject(firstObjIndex + 3, fontBuffer, {
    humanReadable,
    dictExtras: `/Length1 ${String(fontBuffer.byteLength)}/Subtype/OpenType`,
  });

  // Start 6th object: Font
  let fontObjStr = `${String(firstObjIndex + 4)} 0 obj\n`;

  fontObjStr += '<</Type/Font/Subtype/CIDFontType2/CIDSystemInfo<</Registry(Adobe)/Ordering(Identity)/Supplement 0>>';

  fontObjStr += `/BaseFont/${namesTable.postScriptName.en}/FontDescriptor ${String(firstObjIndex + 1)} 0 R`;

  fontObjStr += `/W ${String(firstObjIndex + 2)} 0 R`;

  fontObjStr += '>>\nendobj\n\n';

  return [fontDictObjStr, fontDescObjStr, widthsObjStr, fontFileObj, fontObjStr, toUnicodeObj];
}

/**
 * Generate PDF font objects, not including the actual font data.
 * @param {number} objectIStart - Starting object index
 * @param {?Array<OcrPage>} [ocrArr] - Array of OcrPage objects
 *    Used to subset supplementary fonts to only the characters that are actually used.
 */
export const createPdfFontRefs = async (objectIStart, ocrArr) => {
  if (!FontCont.raw) throw new Error('No fonts loaded.');

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
      if (ocrArr) {
        const charArr = getDistinctCharsFont(ocrArr, familyKey, key);
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
        pdfFonts[familyKey][key] = {
          type: 0, index: fontI, name: `/FO${String(fontI)}`, objN: objectI, opentype,
        };
        pdfFontRefs.push({ familyKey, key });
        pdfFontObjStrArr.push(null);
        objectI += 6;
      }
      fontI++;
    }
  };

  // Create reference to all fonts.
  // Only the fonts that are actually used will be included in the final PDF.
  for (const familyKeyI of Object.keys(FontCont.raw)) {
    const useOpt = FontCont.useOptFamily(familyKeyI);
    const familyObjI = {
      normal: useOpt && FontCont.opt?.[familyKeyI]?.normal ? FontCont.opt[familyKeyI].normal : FontCont.raw[familyKeyI].normal,
      italic: useOpt && FontCont.opt?.[familyKeyI]?.italic ? FontCont.opt[familyKeyI].italic : FontCont.raw[familyKeyI].italic,
      bold: useOpt && FontCont.opt?.[familyKeyI]?.bold ? FontCont.opt[familyKeyI].bold : FontCont.raw[familyKeyI].bold,
      boldItalic: useOpt && FontCont.opt?.[familyKeyI]?.boldItalic ? FontCont.opt[familyKeyI].boldItalic : FontCont.raw[familyKeyI].boldItalic,
    };
    await addFontFamilyRef(familyKeyI, familyObjI);
  }

  if (FontCont.doc) {
    for (const familyKeyI of Object.keys(FontCont.doc)) {
      await addFontFamilyRef(familyKeyI, FontCont.doc[familyKeyI]);
    }
  }

  if (FontCont.supp.chi_sim && ocrArr) {
    const charArr = getDistinctCharsFont(ocrArr, FontCont.supp.chi_sim.family);

    if (charArr.length > 0) {
      const fontExport = await subsetFont(FontCont.supp.chi_sim.opentype, charArr);

      pdfFonts.NotoSansSC = {};
      pdfFonts.NotoSansSC.normal = {
        type: 0, index: fontI, name: `/FO${String(fontI)}`, objN: objectI, opentype: fontExport,
      };
      pdfFontRefs.push({ familyKey: 'NotoSansSC', key: 'normal' });
      pdfFontObjStrArr.push(null);
      objectI += 6;
      fontI++;
    }
  } else if (FontCont.supp.chi_sim) {
    console.warn('Chinese font loaded but no OCR data available to determine if it is needed. Font will not be included in PDF.');
  }

  return {
    pdfFonts, pdfFontRefs, pdfFontObjStrArr, objectI,
  };
};
