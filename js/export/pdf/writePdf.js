import { FontCont } from '../../containers/fontContainer.js';

import { createEmbeddedFontType0, createEmbeddedFontType1 } from './writePdfFonts.js';
import { createEmbeddedImages, createImageResourceDict, drawImageCommands } from './writePdfImages.js';

import { opt } from '../../containers/app.js';
import { ocrPageToPDFStream } from './writePdfText.js';
import { getDistinctCharsFont, subsetFont } from '../../utils/fontUtils.js';

// Creates 3 PDF objects necessary to embed font.
// These are (1) the font dictionary, (2) the font descriptor, and (3) the font file,
// which will be located at objects firstObjIndex, firstObjIndex + 1, and firstObjIndex + 2 (respectively).

/**
 * Create a PDF from an array of ocrPage objects.
 *
 * @param {Object} params
 * @param {Array<OcrPage>} params.ocrArr -
 * @param {PageMetrics[]} params.pageMetricsArr -
 * @param {number} [params.minpage=0] -
 * @param {number} [params.maxpage=-1] -
 * @param {("ebook"|"eval"|"proof"|"invis")} [params.textMode="ebook"] -
 * @param {boolean} [params.rotateText=false] -
 * @param {boolean} [params.rotateBackground=false] -
 * @param {dims} [params.dimsLimit] -
 * @param {number} [params.confThreshHigh=85] -
 * @param {number} [params.confThreshMed=75] -
 * @param {number} [params.proofOpacity=0.8] -
 * @param {Array<ImageWrapper>} [params.images=[]] - Array of images to include in PDF
 * @param {boolean} [params.includeImages=false] - Whether to include images in the PDF
 *
 * A valid PDF will be created if an empty array is provided for `ocrArr`, as long as `maxpage` is set manually.
 */
export async function writePdf({
  ocrArr,
  pageMetricsArr,
  minpage = 0,
  maxpage = -1,
  textMode = 'ebook',
  rotateText = false,
  rotateBackground = false,
  dimsLimit = { width: -1, height: -1 },
  confThreshHigh = 85,
  confThreshMed = 75,
  proofOpacity = 0.8,
  images = [],
  includeImages = false,
}) {
  if (!FontCont.raw) throw new Error('No fonts loaded.');

  if (maxpage === -1) {
    maxpage = ocrArr.length - 1;
  }

  // This can happen if (1) `ocrArr` is length 0 and (2) `maxpage` is left as the default (-1).
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

  if (FontCont.supp.chi_sim) {
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
  }

  // Add images [WIP]
  /** @type {Array<string>} */
  const pdfImageObjStrArr = [];
  const imageObjIndices = [];

  if (includeImages && images && images.length > 0) {
    const imageObjects = createEmbeddedImages(images, objectI);
    for (let i = 0; i < imageObjects.length; i++) {
      pdfImageObjStrArr.push(imageObjects[i]);
      imageObjIndices.push(objectI + i);
    }
    objectI += imageObjects.length;
  }

  /** @type {Array<string>} */
  const pdfPageObjStrArr = [];

  // Add pages
  const pageIndexArr = [];
  for (let i = minpage; i <= maxpage; i++) {
    const angle = pageMetricsArr[i].angle || 0;
    const { dims } = pageMetricsArr[i];

    // eslint-disable-next-line no-await-in-loop
    const { pdfObj, pdfFontsUsed: pdfFontsUsedI } = (await ocrPageToPDF({
      pageObj: ocrArr[i],
      inputDims: dims,
      outputDims: dimsLimit,
      firstObjIndex: objectI,
      parentIndex: 2,
      proofOpacity,
      pdfFonts,
      textMode,
      angle,
      rotateText,
      rotateBackground,
      confThreshHigh,
      confThreshMed,
      imageObjIndices,
      includeImages,
    }));

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
    if (pdfFont.opentype?.names?.postScriptName?.en === 'NotoSansSC-Regular') continue;
    const isStandardFont = false;
    if (isStandardFont) {
      pdfFontObjStrArr[pdfFont.index] = createEmbeddedFontType1(pdfFont.opentype, pdfFont.objN);
    } else {
      pdfFontObjStrArr[pdfFont.index] = createEmbeddedFontType0({ font: pdfFont.opentype, firstObjIndex: pdfFont.objN });
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

  for (let i = 0; i < pdfImageObjStrArr.length; i++) {
    xrefArr.push({ type: 'obj', offset: pdfOut.length + 2 });
    pdfOut += pdfImageObjStrArr[i];
  }

  for (let i = 0; i < pdfPageObjStrArr.length; i++) {
    xrefArr.push({ type: 'obj', offset: pdfOut.length + 2 });
    pdfOut += pdfPageObjStrArr[i];
  }

  // The 0th object always exists, and contains no meaningful data.
  const objCount = pdfObjStrArr.length + pdfFontRefs.length * 6 + pdfImageObjStrArr.length + pdfPageObjStrArr.length + 1;

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
 * @param {Object} params - Parameters object
 * @param {OcrPage} params.pageObj
 * @param {dims} params.inputDims
 * @param {dims} params.outputDims
 * @param {number} params.firstObjIndex
 * @param {number} params.parentIndex
 * @param {number} params.proofOpacity
 * @param {Object<string, PdfFontFamily>} params.pdfFonts
 * @param {("ebook"|"eval"|"proof"|"invis")} params.textMode -
 * @param {number} params.angle
 * @param {boolean} [params.rotateText=false]
 * @param {boolean} [params.rotateBackground=false]
 * @param {number} [params.confThreshHigh=85]
 * @param {number} [params.confThreshMed=75]
 * @param {?import('opentype.js').Font} [params.fontChiSim=null]
 * @param {Array<number>} [params.imageObjIndices=[]] - Array of image object indices
 * @param {boolean} [params.includeImages=false] - Whether to include images
 */
async function ocrPageToPDF({
  pageObj,
  inputDims,
  outputDims,
  firstObjIndex,
  parentIndex,
  proofOpacity,
  pdfFonts,
  textMode,
  angle,
  rotateText = false,
  rotateBackground = false,
  confThreshHigh = 85,
  confThreshMed = 75,
  imageObjIndices = [],
  includeImages = false,
}) {
  if (outputDims.width < 1) {
    outputDims = inputDims;
  }

  const noTextContent = !pageObj || pageObj.lines.length === 0;
  const noImageContent = !includeImages || imageObjIndices.length === 0;

  const pageIndex = firstObjIndex;
  let pageObjStr = `${String(pageIndex)} 0 obj\n<</Type/Page/MediaBox[0 0 ${String(outputDims.width)} ${String(outputDims.height)}]`;

  if (noTextContent && noImageContent) {
    pageObjStr += '/Resources<<>>';
    pageObjStr += `/Parent ${parentIndex} 0 R>>\nendobj\n\n`;
    return { pdfObj: [pageObjStr], pdfFontsUsed: /** @type {Set<PdfFontInfo>} */ (new Set()) };
  }

  pageObjStr += `/Contents ${String(firstObjIndex + 2)} 0 R`;

  let imageContentObjStr = '';

  if (includeImages && imageObjIndices.length > 0) {
    if (imageObjIndices.length > 0) {
      let rotation = 0;
      if (rotateBackground && Math.abs(angle ?? 0) > 0.05) {
        rotation = angle;
      }
      imageContentObjStr += drawImageCommands(0, 0, 0, outputDims.width, outputDims.height, rotation);
    }
  }

  const { textContentObjStr, pdfFontsUsed } = await ocrPageToPDFStream(pageObj, outputDims, pdfFonts, textMode, angle,
    rotateText, rotateBackground, confThreshHigh, confThreshMed);

  let pdfFontsStr = '';
  for (const font of pdfFontsUsed) {
    pdfFontsStr += `${String(font.name)} ${String(font.objN)} 0 R\n`;
  }

  let resourceDictObjStr = `${String(firstObjIndex + 1)} 0 obj\n<<`;

  resourceDictObjStr += `/Font<<${pdfFontsStr}>>`;

  if (includeImages && imageObjIndices.length > 0) {
    const imageResourceStr = createImageResourceDict(imageObjIndices);
    resourceDictObjStr += imageResourceStr;
  }

  // Use `GSO` prefix to avoid conflicts with other graphics states, which are normally named `/GS[n]` by convention.
  resourceDictObjStr += '/ExtGState<<';
  resourceDictObjStr += '/GSO0 <</ca 0.0>>';
  resourceDictObjStr += `/GSO1 <</ca ${proofOpacity}>>`;
  resourceDictObjStr += '>>';

  resourceDictObjStr += '>>\nendobj\n\n';

  const pageResourceStr = `/Resources ${String(firstObjIndex + 1)} 0 R`;

  pageObjStr += `${pageResourceStr}/Parent ${parentIndex} 0 R>>\nendobj\n\n`;

  const pageContentObjStr = `${String(firstObjIndex + 2)} 0 obj\n<</Length ${String(imageContentObjStr.length + textContentObjStr.length)} >>\nstream\n${imageContentObjStr}${textContentObjStr}\nendstream\nendobj\n\n`;

  return {
    pdfObj: [pageObjStr, resourceDictObjStr, pageContentObjStr], pdfFontsUsed,
  };
}
