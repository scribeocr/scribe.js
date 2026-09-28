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
 * @param {?{ascent: number, descent: number}} [metrics] - Ascent and descent to declare instead of the program's own, per 1000 em.
 * @returns {string} The font descriptor object string.
 */
function createFontDescriptor(font, objIndex, italic, embeddedObjIndex = null, metrics = null) {
  return `${String(objIndex)} 0 obj\n${fontDescriptorDict(font, italic, embeddedObjIndex, metrics)}\nendobj\n\n`;
}

/**
 * The font descriptor dictionary of a font, without the object wrapper.
 * @param {opentypeFont} font
 * @param {boolean} italic
 * @param {?number} embeddedObjIndex - Object number of the embedded font file, or null for a font that is not embedded.
 * @param {?{ascent: number, descent: number}} [metrics] - Ascent and descent to declare instead of the program's own, per 1000 em.
 */
function fontDescriptorDict(font, italic, embeddedObjIndex, metrics = null) {
  let objOut = '<</Type/FontDescriptor';

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

  objOut += `/Ascent ${String(metrics ? metrics.ascent : font.ascender)}`;

  objOut += `/Descent ${String(metrics ? metrics.descent : font.descender)}`;

  // StemV is a required field, however it is not already in the opentype font, and does not appear to matter.
  // Therefore, we set to 0.08 * em to mimic the behavior of other programs.
  // https://www.verypdf.com/document/pdf-format-reference/pg_0457.htm
  // https://stackoverflow.com/questions/35485179/stemv-value-of-the-truetype-font
  objOut += `/StemV ${String(Math.round(0.08 * font.unitsPerEm))}`;

  const category = determineSansSerif(namesTable.postScriptName.en);
  const symbolic = category === 'SymbolDefault';
  const serif = !symbolic && category !== 'SansDefault';

  objOut += `/Flags ${String(generateFontFlags(serif, italic, false, symbolic))}`;

  if (embeddedObjIndex === null || embeddedObjIndex === undefined) return `${objOut}>>`;

  objOut += `/FontFile3 ${String(embeddedObjIndex)} 0 R`;

  return `${objOut}>>`;
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
 * The six objects of an embedded composite Type 0 font, before encoding.
 * They are, in object-number order from `firstObjIndex`: the Type0 dict, the FontDescriptor, the `/W` widths, the FontFile, the CIDFont dict and the ToUnicode CMap.
 * A slot is null when the font shares that object with a base font.
 * @param {Object} options
 * @param {opentypeFont} options.font
 * @param {number} options.firstObjIndex
 * @param {boolean} [options.italic=false]
 * @param {Map<number, string>} [options.toUnicodeOverride] - Per-GID ToUnicode override.
 *   Values may be multi-codepoint strings (e.g. "fi" for a ligature).
 *   GIDs absent from the map fall back to `glyph.unicode`.
 * @param {number} [options.widthScale=1] - Advance-width multiplier for a width-scaled variant.
 * @param {number} [options.baseDescriptorObjN] - For a width-scaled variant, the object number of the base font's shared FontDescriptor.
 * @param {number} [options.baseToUnicodeObjN] - The object number of a base font's shared ToUnicode CMap.
 * @param {number} [options.baseWidthsObjN] - The object number of a base font's shared `/W` array.
 * @param {number} [options.baseFontFileObjN] - The object number of a base font's shared FontFile.
 * @param {ArrayBuffer|Uint8Array} [options.rawFontBytes] - Embed these bytes verbatim as the font file instead of re-serializing `font`.
 *   Used for edited native text, where the embedded program must be byte-identical to the one the renderer rasterizes with.
 * @param {?{ascent: number, descent: number}} [options.metrics] - Ascent and descent to declare in the descriptor instead of the program's own, per 1000 em.
 * @returns {Array<?({ text: string } | { stream: string | Uint8Array, dictExtras: string })>}
 *   `text` is a non-stream object's body.
 *   A stream object carries its data and the dictionary entries that go beside the `/Length` and `/Filter` the encoder writes.
 */
export function type0FontObjectParts({
  font, firstObjIndex, italic = false, toUnicodeOverride,
  widthScale = 1, baseDescriptorObjN, baseToUnicodeObjN, baseWidthsObjN, baseFontFileObjN, rawFontBytes, metrics = null,
}) {
  const descriptorObjN = baseDescriptorObjN || firstObjIndex + 1;
  const widthsObjN = baseWidthsObjN || firstObjIndex + 2;
  const fontFileObjN = baseFontFileObjN || firstObjIndex + 3;
  const toUnicodeObjN = baseToUnicodeObjN || firstObjIndex + 5;

  // The relevant table is sometimes but not always in a property named `windows`.
  const namesTable = font.names.windows || font.names;
  const postScriptName = namesTable.postScriptName.en;

  const type0 = { text: `<</Type/Font/Subtype/Type0/BaseFont/${postScriptName}/Encoding/Identity-H/ToUnicode ${String(toUnicodeObjN)} 0 R/DescendantFonts[${String(firstObjIndex + 4)} 0 R]>>` };

  const descriptor = baseDescriptorObjN ? null : { text: fontDescriptorDict(font, italic, fontFileObjN, metrics) };

  // Emit CIDFontType2 glyph widths as [firstGlyphIndex [w0 w1 ...]].
  // The widths must be present and accurate or glyphs render wrong, but need not be packed efficiently (no run grouping).
  // A width-scaled variant folds its inter-character stretch into these declared advances via `widthScale`.
  /** @type {?{ text: string }} */
  let widths = null;
  if (!baseWidthsObjN) {
    const advances = [];
    for (let i = 0; i < font.glyphs.length; i++) {
      advances.push(String(Math.round(font.glyphs.glyphs[String(i)].advanceWidth * widthScale * (1000 / font.unitsPerEm))));
    }
    widths = { text: `[ 0 [${advances.join(' ')} ] ]` };
  }

  /** @type {?{ stream: Uint8Array, dictExtras: string }} */
  let fontFile = null;
  if (!baseFontFileObjN && !baseDescriptorObjN) {
    const fontBuffer = rawFontBytes
      ? (rawFontBytes instanceof Uint8Array ? rawFontBytes : new Uint8Array(rawFontBytes))
      : new Uint8Array(font.toArrayBuffer());
    fontFile = { stream: fontBuffer, dictExtras: `/Length1 ${String(fontBuffer.byteLength)}/Subtype/OpenType` };
  }

  const truetypeOutlines = font.outlinesFormat === 'truetype';
  const cidFont = {
    text: `<</Type/Font/Subtype/${truetypeOutlines ? 'CIDFontType2' : 'CIDFontType0'}/CIDSystemInfo<</Registry(Adobe)/Ordering(Identity)/Supplement 0>>`
      + `/BaseFont/${postScriptName}/FontDescriptor ${String(descriptorObjN)} 0 R/W ${String(widthsObjN)} 0 R${truetypeOutlines ? '/CIDToGIDMap/Identity' : ''}>>`,
  };

  const toUnicode = baseToUnicodeObjN ? null : { stream: createToUnicode(font, toUnicodeOverride), dictExtras: '' };

  return [type0, descriptor, widths, fontFile, cidFont, toUnicode];
}

/**
 * Converts an Opentype.js font object into an array of PDF objects representing a composite Type 0 font.
 * @param {Parameters<typeof type0FontObjectParts>[0] & { humanReadable?: boolean }} options
 * @returns {Promise<Array<string | import('./writePdfStreams.js').PdfBinaryObject | null>>}
 *   Object-number order: [+0 Type0 dict, +1 FontDescriptor, +2 /W, +3 FontFile, +4 CIDFont, +5 ToUnicode].
 *   A shared slot is null, and callers write a free xref entry for it.
 */
export async function createEmbeddedFontType0(options) {
  const { firstObjIndex, humanReadable = false } = options;
  const parts = type0FontObjectParts(options);
  /** @type {Array<string | import('./writePdfStreams.js').PdfBinaryObject | null>} */
  const out = [];
  for (let k = 0; k < parts.length; k++) {
    const part = parts[k];
    const objN = firstObjIndex + k;
    if (!part) out.push(null);
    else if (!('stream' in part)) out.push(`${String(objN)} 0 obj\n${part.text}\nendobj\n\n`);
    else if (typeof part.stream === 'string') out.push(await encodeStreamObject(objN, part.stream, { humanReadable, dictExtras: part.dictExtras }));
    else out.push(await encodeBinaryStreamObject(objN, part.stream, { humanReadable, dictExtras: part.dictExtras }));
  }
  return out;
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
