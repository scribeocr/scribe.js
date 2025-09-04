import { winEncodingLookup } from '../../fonts/encoding.js';

import { FontCont } from '../containers/fontContainer.js';
import {
  calcWordMetrics, subsetFont,
} from '../utils/fontUtils.js';

import { createEmbeddedFontType0, createEmbeddedFontType1 } from './writePdfFonts.js';

import { opt } from '../containers/app.js';
import { pageMetricsArr } from '../containers/dataContainer.js';
import ocr from '../objects/ocrObjects.js';
import { getStyleLookup } from '../utils/miscUtils.js';

/**
 * @param {number} x
 */
const formatNum = (x) => String(Math.round(x * 1e6) / 1e6);

// Creates 3 PDF objects necessary to embed font.
// These are (1) the font dictionary, (2) the font descriptor, and (3) the font file,
// which will be located at objects firstObjIndex, firstObjIndex + 1, and firstObjIndex + 2 (respectively).

/**
 * Create a PDF from an array of ocrPage objects.
 *
 * @param {Array<OcrPage>} hocrArr -
 * @param {number} minpage -
 * @param {number} maxpage -
 * @param {("ebook"|"eval"|"proof"|"invis")} textMode -
 * @param {boolean} rotateText -
 * @param {boolean} rotateBackground -
 * @param {dims} dimsLimit -
 * @param {number} confThreshHigh -
 * @param {number} confThreshMed -
 * @param {number} [proofOpacity=0.8] -
 *
 * A valid PDF will be created if an empty array is provided for `hocrArr`, as long as `maxpage` is set manually.
 */
export async function writePdf(hocrArr, minpage = 0, maxpage = -1, textMode = 'ebook', rotateText = false, rotateBackground = false,
  dimsLimit = { width: -1, height: -1 }, confThreshHigh = 85, confThreshMed = 75, proofOpacity = 0.8) {
  if (!FontCont.raw) throw new Error('No fonts loaded.');

  if (maxpage === -1) {
    maxpage = hocrArr.length - 1;
  }

  // This can happen if (1) `hocrArr` is length 0 and (2) `maxpage` is left as the default (-1).
  if (maxpage < 0) throw new Error('PDF with negative page count requested.');

  let fontI = 0;
  let objectI = 3;
  /** @type {Object<string, PdfFontFamily>} */
  const pdfFonts = {};
  /** @type {{familyKey: string, key: string}[]} */
  const pdfFontRefs = [];
  /** @type {string[][]} */
  const pdfFontObjStrArr = [];
  /** @type {Set<PdfFontInfo>} */
  const pdfFontsUsed = new Set();

  /**
   *
   * @param {string} familyKey
   * @param {FontContainerFamily} familyObj
   */
  const addFontFamilyRef = async (familyKey, familyObj) => {
    pdfFonts[familyKey] = {};
    for (const [key, value] of Object.entries(familyObj)) {
      // This should include both (1) if this is a standard 14 font and (2) if characters outside of the Windows-1252 range are used.
      // If the latter is true, then a composite font is needed, even if the font is a standard 14 font.
      // TODO: We currently have no mechanism for resolving name conflicts between fonts in the base and overlay document.
      // As a workaround, we use the names `/FO[n]` rather than the more common `/F[n]`.
      // However, this likely will cause issues if this application is used to create visible text, and then the resulting PDF is uploaded.
      // This would move the fonts from the overlay document to the base document, and the names would conflict.
      const isStandardFont = false;
      if (isStandardFont) {
        pdfFonts[familyKey][key] = {
          type: 1, index: fontI, name: `/FO${String(fontI)}`, objN: objectI, opentype: value.opentype,
        };
        pdfFontRefs.push({ familyKey, key });
        pdfFontObjStrArr.push(null);
        objectI += 3;
      } else {
        pdfFonts[familyKey][key] = {
          type: 0, index: fontI, name: `/FO${String(fontI)}`, objN: objectI, opentype: value.opentype,
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

  // TODO: Fix support for Chinese
  /** @type {?opentypeFont} */
  const fontChiSimExport = null;
  if (FontCont.supp.chi_sim) {
    pdfFonts.NotoSansSC.normal = {
      type: 0, name: `/FO${String(fontI)}`, objN: objectI, opentype: FontCont.supp.chi_sim.opentype,
    };
    fontI++;
  }

  // /** @type {?opentype.Font} */
  // let fontChiSimExport = null;
  // if (FontCont.supp.chi_sim) {
  //   pdfFonts.NotoSansSC = {};
  //   const font = FontCont.supp.chi_sim.opentype;

  //   const objectThis = objectI;

  //   const charArr = ocr.getDistinctChars(hocrArr);
  //   fontChiSimExport = await subsetFont(font, charArr);

  //   const fontObjArr = createEmbeddedFontType0(fontChiSimExport, objectThis);
  //   for (let j = 0; j < fontObjArr.length; j++) {
  //     pdfFontObjStrArr.push(fontObjArr[j]);
  //   }
  //   objectI += fontObjArr.length;

  //   pdfFonts.NotoSansSC.normal = { type: 0, name: `/FO${String(fontI)}`, objN: objectThis };

  //   fontI++;
  // }

  /** @type {Array<string>} */
  const pdfPageObjStrArr = [];

  // Add pages
  const pageIndexArr = [];
  for (let i = minpage; i <= maxpage; i++) {
    const angle = pageMetricsArr[i].angle || 0;
    const { dims } = pageMetricsArr[i];

    // eslint-disable-next-line no-await-in-loop
    const { pdfObj, pdfFontsUsed: pdfFontsUsedI } = (await ocrPageToPDF(hocrArr[i], dims, dimsLimit, objectI, 2, proofOpacity, pdfFonts,
      textMode, angle, rotateText, rotateBackground, confThreshHigh, confThreshMed, fontChiSimExport));

    for (const font of pdfFontsUsedI) {
      pdfFontsUsed.add(font);
    }

    for (let j = 0; j < pdfObj.length; j++) {
      pdfPageObjStrArr.push(pdfObj[j]);
    }

    // This assumes the "page" is always the first object returned by `ocrPageToPDF`.
    pageIndexArr.push(objectI);

    objectI += pdfObj.length;

    opt.progressHandler({ n: i, type: 'export', info: { } });
  }

  // Create font objects for fonts that are used
  for (const pdfFont of pdfFontsUsed) {
    const isStandardFont = false;
    if (isStandardFont) {
      pdfFontObjStrArr[pdfFont.index] = createEmbeddedFontType1(pdfFont.opentype, pdfFont.objN);
    } else {
      pdfFontObjStrArr[pdfFont.index] = createEmbeddedFontType0(pdfFont.opentype, pdfFont.objN);
    }
  }

  /** @type {Array<string>} */
  const pdfObjStrArr = [];

  let pdfOut = '%PDF-1.7\n%µ¶n\n';

  pdfObjStrArr.push('1 0 obj\n<</Type /Catalog\n/Pages 2 0 R>>\nendobj\n\n');

  let pagesObjStr = '2 0 obj\n<</Type /Pages\n/Kids [';
  for (let i = 0; i < (maxpage - minpage + 1); i++) {
    pagesObjStr += `${String(pageIndexArr[i])} 0 R\n`;
  }
  pagesObjStr += `]\n/Count ${String(maxpage - minpage + 1)}>>\nendobj\n\n`;

  pdfObjStrArr.push(pagesObjStr);

  /** @type {{type: string, offset: number}[]} */
  const xrefArr = [];

  for (let i = 0; i < pdfObjStrArr.length; i++) {
    xrefArr.push({ type: 'obj', offset: pdfOut.length + 2 });
    pdfOut += pdfObjStrArr[i];
  }

  for (let i = 0; i < pdfFontRefs.length; i++) {
    if (pdfFontObjStrArr[i]) {
      for (let j = 0; j < pdfFontObjStrArr[i].length; j++) {
        xrefArr.push({ type: 'obj', offset: pdfOut.length + 2 });
        pdfOut += pdfFontObjStrArr[i][j];
      }
    } else {
      xrefArr.push({ type: 'free', offset: 0 });
      xrefArr.push({ type: 'free', offset: 0 });
      xrefArr.push({ type: 'free', offset: 0 });
      xrefArr.push({ type: 'free', offset: 0 });
      xrefArr.push({ type: 'free', offset: 0 });
      xrefArr.push({ type: 'free', offset: 0 });
    }
  }

  for (let i = 0; i < pdfPageObjStrArr.length; i++) {
    xrefArr.push({ type: 'obj', offset: pdfOut.length + 2 });
    pdfOut += pdfPageObjStrArr[i];
  }

  // The 0th object always exists, and contains no meaningful data.
  const objCount = pdfObjStrArr.length + pdfFontRefs.length * 6 + pdfPageObjStrArr.length + 1;

  const xrefOffset = pdfOut.length + 2;

  let xrefStr = `xref\n0 ${objCount}\n`;

  xrefStr += '0000000000 65535 f\n';

  for (let i = 0; i < xrefArr.length; i++) {
    if (xrefArr[i].type === 'obj') {
      xrefStr += `${String(xrefArr[i].offset).padStart(10, '0')} 00000 n\n`;
    } else {
      xrefStr += '0000000000 65535 f\n';
    }
  }

  xrefStr += `trailer
  <<  /Root 1 0 R
      /Size ${objCount}
  >>
startxref
${xrefOffset}
%%EOF`;

  pdfOut += xrefStr;

  return pdfOut;
}

/**
 * Generates PDF objects for a single page of OCR data.
 * Generally returns an array of 2 strings, the first being the text content object, and the second being the page object.
 * If there is no text content, only the page object is returned.
 * @param {OcrPage} pageObj
 * @param {dims} inputDims
 * @param {dims} outputDims
 * @param {number} firstObjIndex
 * @param {number} parentIndex
 * @param {number} proofOpacity
 * @param {Object<string, PdfFontFamily>} pdfFonts
 * @param {("ebook"|"eval"|"proof"|"invis")} textMode -
 * @param {number} angle
 * @param {boolean} rotateText
 * @param {boolean} rotateBackground
 * @param {number} confThreshHigh
 * @param {number} confThreshMed
 * @param {?import('opentype.js').Font} fontChiSim
 */
async function ocrPageToPDF(pageObj, inputDims, outputDims, firstObjIndex, parentIndex, proofOpacity, pdfFonts, textMode, angle,
  rotateText = false, rotateBackground = false, confThreshHigh = 85, confThreshMed = 75, fontChiSim = null) {
  if (outputDims.width < 1) {
    outputDims = inputDims;
  }

  const noContent = !pageObj || pageObj.lines.length === 0;

  const pageIndex = firstObjIndex;
  let pageObjStr = `${String(pageIndex)} 0 obj\n<</Type/Page/MediaBox[0 0 ${String(outputDims.width)} ${String(outputDims.height)}]`;

  if (noContent) {
    pageObjStr += '/Resources<<>>';
    pageObjStr += `/Parent ${parentIndex} 0 R>>\nendobj\n\n`;
    return { pdfObj: [pageObjStr], pdfFontsUsed: /** @type {Set<PdfFontInfo>} */ (new Set()) };
  }

  pageObjStr += `/Contents ${String(firstObjIndex + 2)} 0 R`;

  let { textContentObjStr, pdfFontsUsed } = await ocrPageToPDFStream(pageObj, outputDims, pdfFonts, textMode, angle,
    rotateText, rotateBackground, confThreshHigh, confThreshMed, fontChiSim);

  let pdfFontsStr = '';
  for (const font of pdfFontsUsed) {
    pdfFontsStr += `${String(font.name)} ${String(font.objN)} 0 R\n`;
  }

  let resourceDictObjStr = `${String(firstObjIndex + 1)} 0 obj\n<<`;

  resourceDictObjStr += `/Font<<${pdfFontsStr}>>`;

  // Use `GSO` prefix to avoid conflicts with other graphics states, which are normally named `/GS[n]` by convention.
  resourceDictObjStr += '/ExtGState<<';
  resourceDictObjStr += '/GSO0 <</ca 0.0>>';
  resourceDictObjStr += `/GSO1 <</ca ${proofOpacity}>>`;
  resourceDictObjStr += '>>';

  resourceDictObjStr += '>>\nendobj\n\n';

  const pageResourceStr = `/Resources ${String(firstObjIndex + 1)} 0 R`;

  pageObjStr += `${pageResourceStr}/Parent ${parentIndex} 0 R>>\nendobj\n\n`;

  textContentObjStr = `${String(firstObjIndex + 2)} 0 obj\n<</Length ${String(textContentObjStr.length)} >>\nstream\n${textContentObjStr}\nendstream\nendobj\n\n`;

  return {
    pdfObj: [pageObjStr, resourceDictObjStr, textContentObjStr], pdfFontsUsed,
  };
}

/**
 *
 * @param {OcrPage} pageObj
 * @param {dims} outputDims
 * @param {Object<string, PdfFontFamily>} pdfFonts
 * @param {("ebook"|"eval"|"proof"|"invis")} textMode -
 * @param {number} angle
 * @param {boolean} rotateText
 * @param {boolean} rotateBackground
 * @param {number} confThreshHigh
 * @param {number} confThreshMed
 * @param {?import('opentype.js').Font} fontChiSim
 * @returns
 */
async function ocrPageToPDFStream(pageObj, outputDims, pdfFonts, textMode, angle,
  rotateText = false, rotateBackground = false, confThreshHigh = 85, confThreshMed = 75, fontChiSim = null) {
  const { lines } = pageObj;

  const cosAnglePage = Math.cos(angle * (Math.PI / 180));

  /** @type {Set<PdfFontInfo>} */
  const pdfFontsUsed = new Set();

  const underlines = /** @type {Array<{left: number, right: number, top: number, height: number, fontSize: number, bold: boolean}>} */ ([]);

  // Start 1st object: Text Content
  let textContentObjStr = '';

  if (textMode === 'invis') {
    textContentObjStr += '/GSO0 gs\n';
  } else if (['proof', 'eval'].includes(textMode)) {
    textContentObjStr += '/GSO1 gs\n';
  }

  textContentObjStr += 'BT\n';

  // Move cursor to top of the page
  textContentObjStr += `1 0 0 1 0 ${String(outputDims.height)} Tm\n`;

  let pdfFontNameCurrent = '';
  let pdfFontTypeCurrent = 0;

  for (let i = 0; i < lines.length; i++) {
    const lineObj = lines[i];
    const { words } = lineObj;

    if (words.length === 0) continue;

    let wordJ = words[0];

    let fillColor = '0 0 0 rg';
    if (textMode === 'proof') {
      if (wordJ.conf > confThreshHigh) {
        fillColor = '0 1 0.5 rg';
      } else if (wordJ.conf > confThreshMed) {
        fillColor = '1 0.8 0 rg';
      } else {
        fillColor = '1 0 0 rg';
      }
    }

    const angleAdjLine = (rotateBackground && Math.abs(angle ?? 0) > 0.05) ? ocr.calcLineStartAngleAdj(lineObj) : { x: 0, y: 0 };

    let fillColorCurrent = fillColor;

    textContentObjStr += `${fillColor}\n`;

    let wordFont = FontCont.getWordFont(wordJ);

    // The Chinese font is subset to only relevant characters, the others currently are not.
    let wordFontOpentype = (wordJ.lang === 'chi_sim' ? fontChiSim : wordFont.opentype);

    if (!wordFontOpentype) {
      const fontNameMessage = wordJ.lang === 'chi_sim' ? 'chi_sim' : `${wordFont.family} (${getStyleLookup(wordJ.style)})`;
      console.log(`Skipping word due to missing font (${fontNameMessage})`);
      continue;
    }

    const word0Metrics = calcWordMetrics(wordJ, angle);

    let wordFontSize = word0Metrics.fontSize;

    // Set font and font size
    const pdfFontCurrent = wordJ.lang === 'chi_sim' ? pdfFonts.NotoSansSC.normal : pdfFonts[wordFont.family][getStyleLookup(wordJ.style)];
    pdfFontNameCurrent = pdfFontCurrent.name;
    pdfFontTypeCurrent = pdfFontCurrent.type;
    pdfFontsUsed.add(pdfFontCurrent);

    textContentObjStr += `${pdfFontNameCurrent} ${String(wordFontSize)} Tf\n`;

    // Reset baseline to line baseline
    textContentObjStr += '0 Ts\n';

    const word0LeftBearing = wordJ.visualCoords ? word0Metrics.leftSideBearing : 0;

    let tz = 100;
    if (wordJ.style.dropcap) {
      const wordWidthActual = wordJ.bbox.right - wordJ.bbox.left;
      tz = (wordWidthActual / word0Metrics.visualWidth) * 100;
    }

    // Move to next line
    const lineLeftAdj = wordJ.bbox.left - word0LeftBearing * (tz / 100) + angleAdjLine.x;
    const lineTopAdj = lineObj.bbox.bottom + lineObj.baseline[1] + angleAdjLine.y;

    const lineAngleDeg = Number(rotateText) * angle + 90 * lineObj.orientation;

    const sinAngleTm = Math.sin(lineAngleDeg * (Math.PI / 180));
    const cosAngleTm = Math.cos(lineAngleDeg * (Math.PI / 180));

    if (lineObj.orientation === 1) {
      textContentObjStr += `${formatNum(cosAngleTm)} ${formatNum(-sinAngleTm)} ${formatNum(sinAngleTm)} ${formatNum(cosAngleTm)} ${formatNum(outputDims.width - lineTopAdj + 1)} ${formatNum(outputDims.height - lineLeftAdj)} Tm\n`;
    } else if (lineObj.orientation === 2) {
      textContentObjStr += `${formatNum(cosAngleTm)} ${formatNum(-sinAngleTm)} ${formatNum(sinAngleTm)} ${formatNum(cosAngleTm)} ${formatNum(outputDims.width - lineLeftAdj + 1)} ${formatNum(lineTopAdj)} Tm\n`;
    } else if (lineObj.orientation === 3) {
      textContentObjStr += `${formatNum(cosAngleTm)} ${formatNum(-sinAngleTm)} ${formatNum(sinAngleTm)} ${formatNum(cosAngleTm)} ${formatNum(lineTopAdj)} ${formatNum(lineLeftAdj)} Tm\n`;
    } else {
      textContentObjStr += `${formatNum(cosAngleTm)} ${formatNum(-sinAngleTm)} ${formatNum(sinAngleTm)} ${formatNum(cosAngleTm)} ${formatNum(lineLeftAdj)} ${formatNum(outputDims.height - lineTopAdj + 1)} Tm\n`;
    }

    textContentObjStr += '[ ';

    let wordBoxLast = {
      left: 0, top: 0, right: 0, bottom: 0,
    };
    let wordRightBearingLast = 0;
    let charSpacingLast = 0;
    let spacingAdj = 0;
    let kernSpacing = false;
    let wordLast = wordJ;
    let underlineLeft = /** @type {?number} */ null;
    let underlineRight = /** @type {?number} */ null;
    let wordFontOpentypeLast = wordFontOpentype;
    let fontSizeLast = wordFontSize;
    let tsCurrent = 0;
    let tzCurrent = 100;
    let charLig = false;

    for (let j = 0; j < words.length; j++) {
      wordJ = words[j];

      const wordMetrics = calcWordMetrics(wordJ, angle);
      wordFontSize = wordMetrics.fontSize;
      const charSpacing = wordMetrics.charSpacing;
      const charArr = wordMetrics.charArr;
      const wordLeftBearing = wordJ.visualCoords ? wordMetrics.leftSideBearing : 0;
      const kerningArr = wordMetrics.kerningArr;

      wordFont = FontCont.getWordFont(wordJ);
      wordFontOpentype = wordJ.lang === 'chi_sim' ? fontChiSim : wordFont.opentype;

      if (!wordFontOpentype) {
        const fontNameMessage = wordJ.lang === 'chi_sim' ? 'chi_sim' : `${wordFont.family} (${getStyleLookup(wordJ.style)})`;
        console.log(`Skipping word due to missing font (${fontNameMessage})`);
        continue;
      }

      fillColor = '0 0 0 rg';
      if (textMode === 'proof') {
        const wordConf = wordJ.conf;

        if (wordConf > confThreshHigh) {
          fillColor = '0 1 0.5 rg';
        } else if (wordConf > confThreshMed) {
          fillColor = '1 0.8 0 rg';
        } else {
          fillColor = '1 0 0 rg';
        }
      } else if (textMode === 'eval') {
        fillColor = wordJ.matchTruth ? '0 1 0.5 rg' : '1 0 0 rg';
      }

      const angleAdjWord = wordJ.style.sup ? ocr.calcWordAngleAdj(wordJ) : { x: 0, y: 0 };
      const angleAdjWordX = (rotateBackground && Math.abs(angle ?? 0) > 0.05) ? angleAdjWord.x : 0;

      let ts = 0;
      if (wordJ.style.sup || wordJ.style.dropcap) {
        ts = (lineObj.bbox.bottom + lineObj.baseline[1] + angleAdjLine.y) - (wordJ.bbox.bottom + angleAdjLine.y + angleAdjWord.y);
        if (!wordJ.visualCoords) {
          const fontDesc = wordFont.opentype.descender / wordFont.opentype.unitsPerEm * wordMetrics.fontSize;
          ts -= fontDesc;
        }
      } else {
        ts = 0;
      }

      // TODO: This probably fails for Chinese, rethink.
      tz = 100;
      if (wordJ.style.dropcap) {
        const wordWidthActual = wordJ.bbox.right - wordJ.bbox.left;
        tz = (wordWidthActual / wordMetrics.visualWidth) * 100;
      }

      const pdfFont = wordJ.lang === 'chi_sim' ? pdfFonts.NotoSansSC.normal : pdfFonts[wordFont.family][getStyleLookup(wordJ.style)];
      const pdfFontName = pdfFont.name;
      const pdfFontType = pdfFont.type;
      pdfFontsUsed.add(pdfFont);

      const wordWidthAdj = (wordJ.bbox.right - wordJ.bbox.left) / cosAnglePage;
      const wordSpaceAdj = (wordJ.bbox.left - wordBoxLast.right) / cosAnglePage;

      // Add space character between words
      if (j > 0 && !kernSpacing) {
        // The space between words determined by:
        // (1) The right bearing of the last word, (2) the left bearing of the current word, (3) the width of the space character between words,
        // (4) the current character spacing value (applied twice--both before and after the space character).
        const spaceAdvance = wordFontOpentypeLast.charToGlyph(' ').advanceWidth || wordFontOpentypeLast.unitsPerEm / 2;
        const spaceWidthGlyph = spaceAdvance * (fontSizeLast / wordFontOpentypeLast.unitsPerEm);

        const wordSpaceExpectedPx = (spaceWidthGlyph + charSpacingLast * 2 + wordRightBearingLast) + wordLeftBearing;

        // Ad-hoc adjustment needed to replicate wordSpace
        // const wordSpaceExtra = (wordSpace + angleSpaceAdjXWord - spaceWidth - charSpacing * 2 - wordLeftBearing - wordRightBearingLast + spacingAdj);
        const wordSpaceExtraPx = (wordSpaceAdj - wordSpaceExpectedPx + spacingAdj + angleAdjWordX) * (100 / tzCurrent);

        if (pdfFontTypeCurrent === 0) {
          const spaceChar = wordFontOpentype.charToGlyphIndex(' ').toString(16).padStart(4, '0');
          textContentObjStr += `<${spaceChar}> ${String(Math.round(wordSpaceExtraPx * (-1000 / fontSizeLast) * 1e6) / 1e6)}`;
        } else {
          textContentObjStr += `( ) ${String(Math.round(wordSpaceExtraPx * (-1000 / fontSizeLast) * 1e6) / 1e6)}`;
        }
      }
      kernSpacing = false;

      wordBoxLast = wordJ.bbox;

      // In general, we assume that (given our adjustments to character spacing) the rendered word has the same width as the image of that word.
      // However, this assumption does not hold for single-character words, as there is no space between character to adjust.
      // Therefore, we calculate the difference between the rendered and actual word and apply an adjustment to the width of the next space.
      // (This does not apply to drop caps as those have horizontal scaling applied to exactly match the image.)
      if (charArr.length === 1 && !wordJ.style.dropcap) {
        const wordLastGlyph = wordFontOpentype.charToGlyph(charArr.at(-1));
        const wordLastGlyphMetrics = wordLastGlyph.getMetrics();
        const lastCharAdvance = wordLast.visualCoords ? (wordLastGlyphMetrics.xMax - wordLastGlyphMetrics.xMin) : wordLastGlyph.advanceWidth || wordFontOpentype.unitsPerEm / 2;
        const lastCharWidth = lastCharAdvance * (wordFontSize / wordFontOpentype.unitsPerEm);
        spacingAdj = wordWidthAdj - lastCharWidth - angleAdjWordX;
      } else {
        spacingAdj = 0 - angleAdjWordX;
      }

      textContentObjStr += ' ] TJ\n';

      const fontSize = wordJ.style.smallCaps && wordJ.text[0] && wordJ.text[0] !== wordJ.text[0].toUpperCase() ? wordFontSize * wordFont.smallCapsMult : wordFontSize;
      if (pdfFontName !== pdfFontNameCurrent || fontSize !== fontSizeLast) {
        textContentObjStr += `${pdfFontName} ${String(fontSize)} Tf\n`;
        pdfFontNameCurrent = pdfFontName;
        pdfFontTypeCurrent = pdfFontType;
        fontSizeLast = fontSize;
      }
      if (fillColor !== fillColorCurrent) {
        textContentObjStr += `${fillColor}\n`;
        fillColorCurrent = fillColor;
      }
      if (ts !== tsCurrent) {
        textContentObjStr += `${String(ts)} Ts\n`;
        tsCurrent = ts;
      }
      if (tz !== tzCurrent) {
        textContentObjStr += `${String(tz)} Tz\n`;
        tzCurrent = tz;
      }

      textContentObjStr += `${String(Math.round(charSpacing * 1e6) / 1e6)} Tc\n`;

      textContentObjStr += '[ ';

      // Non-ASCII and special characters are encoded/escaped using winEncodingLookup
      for (let k = 0; k < charArr.length; k++) {
        const letterSrc = charArr[k];
        const letter = wordJ.style.smallCaps ? charArr[k].toUpperCase() : charArr[k];
        const fontSizeLetter = wordJ.style.smallCaps && letterSrc !== letter ? wordFontSize * wordFont.smallCapsMult : wordFontSize;

        const letterEnc = pdfFontTypeCurrent === 0 ? wordFontOpentype.charToGlyphIndex(letter)?.toString(16).padStart(4, '0') : winEncodingLookup[letter];
        if (letterEnc) {
          let kern = (kerningArr[k] || 0) * (-1000 / fontSizeLetter);

          if (wordJ.lang === 'chi_sim' && j + 1 < words.length && words[j + 1].lang === 'chi_sim') {
            kernSpacing = true;
            const wordNext = words[j + 1];
            const wordSpaceNextAdj = (wordNext.bbox.left - wordJ.bbox.right) / cosAngleTm;
            // const wordSpaceNextAdj = wordNext.bbox.left - wordBox.right;

            const wordGlyph = wordFontOpentype.charToGlyph(charArr.at(-1));
            const wordGlyphMetrics = wordGlyph.getMetrics();
            const wordNextGlyphMetrics = wordFontOpentype.charToGlyph(wordNext.text.substr(0, 1)).getMetrics();

            const wordRightBearing = wordJ.visualCoords ? (wordGlyph.advanceWidth - wordGlyphMetrics.xMax) * (wordFontSize / wordFontOpentype.unitsPerEm) : 0;

            const wordNextLeftBearing = wordNext.visualCoords ? wordNextGlyphMetrics.xMin * (wordFontSize / wordFontOpentype.unitsPerEm) : 0;

            const wordSpaceExpected = charSpacing + wordRightBearing + wordNextLeftBearing;

            kern = Math.round((wordSpaceNextAdj - wordSpaceExpected + spacingAdj + angleAdjWordX) * (-1000 / wordFontSize));
          }

          // PDFs render text based on a "widths" PDF object, rather than the advance width in the embedded font file.
          // The widths are in 1/1000 of a unit, and this PDF object is created by mupdf.
          // The widths output in this object are converted to integers, which creates a rounding error when the font em size is not 1000.
          // All built-in fonts are already 1000 to avoid this, however custom fonts may not be.
          // This results in a small rounding error for the advance of each character, which adds up, as PDF positioning is cumulative.
          // To correct for this, the error is calculated and added to the kerning value.
          const charAdvance = wordFontOpentype.charToGlyph(letter).advanceWidth;
          const charWidthPdfPrecise = charAdvance * (1000 / wordFontOpentype.unitsPerEm);
          const charWidthPdfRound = Math.floor(charWidthPdfPrecise);
          const charWidthError = charWidthPdfRound - charWidthPdfPrecise;

          const charAdj = kern + charWidthError;

          if (pdfFontName !== pdfFontNameCurrent || fontSizeLetter !== fontSizeLast) {
            textContentObjStr += ' ] TJ\n';
            textContentObjStr += `${pdfFontName} ${String(fontSizeLetter)} Tf\n`;
            fontSizeLast = fontSizeLetter;
            textContentObjStr += `${String(Math.round(charSpacing * 1e6) / 1e6)} Tc\n`;
            textContentObjStr += '[ ';
          }

          if (pdfFontTypeCurrent === 0) {
            textContentObjStr += `<${letterEnc}> ${String(Math.round(charAdj * 1e6) / 1e6)} `;
          } else {
            textContentObjStr += `(${letterEnc}) ${String(Math.round(kern * 1e6) / 1e6)} `;
          }

          if (charLig) {
            k++;
            charLig = false;
          }
        } else {
          // When the requested character could not be found, a space is inserted, with extra space to match the width of the missing character
          const kern = (wordFontOpentype.charToGlyph(letter).advanceWidth - wordFontOpentype.charToGlyph(' ').advanceWidth) * (-1000 / wordFontOpentype.unitsPerEm) || 0;

          if (pdfFontTypeCurrent === 0) {
            const spaceChar = wordFontOpentype.charToGlyphIndex(' ').toString(16).padStart(4, '0');
            textContentObjStr += `<${spaceChar}> ${String(Math.round(kern * 1e6) / 1e6)} `;
          } else {
            textContentObjStr += `( ) ${String(Math.round(kern * 1e6) / 1e6)} `;
          }
        }
      }

      if (wordJ.style.underline && underlineLeft === null) {
        underlineLeft = wordJ.bbox.left;
      }

      if (wordJ.style.underline) {
        underlineRight = wordJ.bbox.right;
      }

      if (underlineLeft !== null && (!wordJ.style.underline || j === words.length - 1)) {
        underlines.push({
          left: underlineLeft,
          right: underlineRight,
          top: lineTopAdj,
          height: lineObj.bbox.bottom - lineObj.bbox.top,
          fontSize: wordFontSize,
          bold: wordJ.style.bold,
        });

        underlineLeft = null;
        underlineRight = null;
      }

      wordLast = wordJ;
      wordRightBearingLast = wordLast.visualCoords ? wordMetrics.rightSideBearing : 0;
      wordFontOpentypeLast = wordFontOpentype;
      charSpacingLast = charSpacing;
    }

    textContentObjStr += ' ] TJ\n';
  }

  textContentObjStr += 'ET';

  // Add underlines
  underlines.forEach((underline) => {
    const underlineThickness = underline.bold ? Math.ceil(underline.fontSize / 12) : Math.ceil(underline.fontSize / 24);
    const underlineOffset = Math.ceil(underline.fontSize / 12) + underlineThickness;

    textContentObjStr += `\n${String(underline.left)} ${String(outputDims.height - underline.top - underlineOffset)} ${String(underline.right - underline.left)} ${underlineThickness} re\nf\n`;
  });

  return { textContentObjStr, pdfFontsUsed };
}
