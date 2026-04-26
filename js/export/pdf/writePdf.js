import { FontCont } from '../../containers/fontContainer.js';

import { createEmbeddedFontType0, createEmbeddedFontType1, createPdfFontRefs } from './writePdfFonts.js';
import {
  createDeviceNRGBA, createEmbeddedImages, createImageResourceDict, drawImageCommands,
} from './writePdfImages.js';

import { opt } from '../../containers/app.js';
import { ocrPageToPDFStream } from './writePdfText.js';
import { buildHighlightAnnotObjects, consolidateAnnotations } from './writePdfAnnots.js';
import { encodeStreamObject } from './writePdfStreams.js';

/**
 * Create a PDF from an array of ocrPage objects.
 *
 * @param {Object} params
 * @param {PageMetrics[]} params.pageMetricsArr -
 * @param {?Array<OcrPage>} [params.ocrArr] -
 * @param {?Array<number>} [params.pageArr=null] - Array of 0-based page indices to include. Overrides minpage/maxpage when provided.
 * @param {number} [params.minpage=0] -
 * @param {number} [params.maxpage=-1] -
 * @param {('ebook'|'eval'|'proof'|'invis'|'annot')} [params.textMode='ebook'] -
 * @param {boolean} [params.rotateText=false] -
 * @param {boolean} [params.rotateBackground=false] -
 * @param {boolean} [params.rotateOrientation=false] - If true, canvas is adjusted to flip width/height to account for image rotation
 *    of 90 or 270 degrees. This argument is currently only used in a dev script and may not be the best approach.
 * @param {dims} [params.dimsLimit] -
 * @param {number} [params.confThreshHigh=85] -
 * @param {number} [params.confThreshMed=75] -
 * @param {number} [params.proofOpacity=0.8] -
 * @param {?Array<ImageWrapper>} [params.images=null] - Array of images to include in PDF
 * @param {boolean} [params.includeImages=false] - Whether to include images in the PDF
 * @param {?Array<Array<AnnotationHighlight>>} [params.annotationsPages=null] - Per-page annotation arrays
 * @param {boolean} [params.humanReadable=false] - If true, emit uncompressed
 *   streams + hex-wrapped fonts for diffing. Default emits FlateDecode.
 *
 * A valid PDF will be created if an empty array is provided for `ocrArr`, as long as `pageArr` is non-empty.
 */
export async function writePdf({
  pageMetricsArr,
  ocrArr = null,
  pageArr = null,
  minpage = 0,
  maxpage = -1,
  textMode = 'ebook',
  rotateText = false,
  rotateBackground = false,
  rotateOrientation = false,
  dimsLimit = { width: -1, height: -1 },
  confThreshHigh = 85,
  confThreshMed = 75,
  proofOpacity = 0.8,
  images = null,
  includeImages = false,
  annotationsPages = null,
  humanReadable = false,
}) {
  if (!FontCont.raw) throw new Error('No fonts loaded.');

  if (!pageArr) {
    const start = Math.max(0, minpage);
    const end = maxpage >= 0 ? Math.min(maxpage, pageMetricsArr.length - 1) : pageMetricsArr.length - 1;
    pageArr = [];
    for (let i = start; i <= end; i++) pageArr.push(i);
  }
  if (pageArr.length === 0) throw new Error('PDF with zero pages requested.');

  let objectI = 3;
  /** @type {Object<string, PdfFontFamily>} */
  let pdfFonts = {};
  /** @type {{familyKey: string, key: string}[]} */
  let pdfFontRefs = [];
  /** @type {Array<Array<string | import('./writePdfStreams.js').PdfBinaryObject> | null>} */
  let pdfFontObjStrArr = [];

  if (ocrArr && ocrArr.length > 0 && textMode !== 'annot') {
    const fontRefs = await createPdfFontRefs(objectI, ocrArr);
    pdfFonts = fontRefs.pdfFonts;
    pdfFontRefs = fontRefs.pdfFontRefs;
    pdfFontObjStrArr = fontRefs.pdfFontObjStrArr;
    objectI = fontRefs.objectI;
  }

  /** @type {Set<PdfFontInfo>} */
  const pdfFontsUsed = new Set();

  /** @type {Array<string>} */
  const pdfImageObjStrArr = [];
  const imageObjIndices = [];

  if (includeImages && images && images.length > 0) {
    const objectIDeviceN = objectI;
    const colorDevObjects = await createDeviceNRGBA(objectI);
    for (let i = 0; i < colorDevObjects.length; i++) {
      pdfImageObjStrArr.push(colorDevObjects[i]);
      objectI++;
    }

    const imageObjects = createEmbeddedImages(images, objectI, objectIDeviceN);
    for (let i = 0; i < imageObjects.length; i++) {
      pdfImageObjStrArr.push(imageObjects[i]);
      imageObjIndices.push(objectI + i);
    }
    objectI += imageObjects.length;
  }

  /** @type {Array<string | import('./writePdfStreams.js').PdfBinaryObject>} */
  const pdfPageObjArr = [];

  const pageIndexArr = [];
  for (const i of pageArr) {
    const angle = pageMetricsArr[i].angle || 0;
    const { dims } = pageMetricsArr[i];

    const imageName = includeImages && images && images.length > 0 ? `Im${String(i % images.length)}` : null;

    // eslint-disable-next-line no-await-in-loop
    const { pdfObj, pdfFontsUsed: pdfFontsUsedI } = (await ocrPageToPDF({
      pageObj: ocrArr?.[i],
      inputDims: dims,
      outputDims: dimsLimit,
      firstObjIndex: objectI,
      parentIndex: 2,
      proofOpacity,
      pdfFonts,
      textMode,
      angle,
      rotateOrientation,
      rotateText,
      rotateBackground,
      confThreshHigh,
      confThreshMed,
      imageObjIndices,
      imageName,
      pageAnnotations: consolidateAnnotations(annotationsPages?.[i] || [], ocrArr?.[i]),
      humanReadable,
    }));

    for (const font of pdfFontsUsedI) {
      pdfFontsUsed.add(font);
    }

    for (let j = 0; j < pdfObj.length; j++) {
      pdfPageObjArr.push(pdfObj[j]);
    }

    // This assumes the "page" is always the first object returned by `ocrPageToPDF`.
    pageIndexArr.push(objectI);

    objectI += pdfObj.length;

    opt.progressHandler({ n: i, type: 'export', info: { } });
  }

  // Create font objects for fonts that are used
  for (const pdfFont of pdfFontsUsed) {
    if (pdfFont.opentype?.names?.postScriptName?.en === 'NotoSansSC-Regular') continue;
    // Type 1 fonts are currently never used.
    const isStandardFont = false;
    if (isStandardFont) {
      pdfFontObjStrArr[pdfFont.index] = await createEmbeddedFontType1(pdfFont.opentype, pdfFont.objN, false, false, humanReadable);
    } else {
      pdfFontObjStrArr[pdfFont.index] = await createEmbeddedFontType0({
        font: pdfFont.opentype, firstObjIndex: pdfFont.objN, humanReadable,
      });
    }
  }

  let pagesObjStr = '2 0 obj\n<</Type /Pages\n/Kids [';
  for (let i = 0; i < pageArr.length; i++) {
    pagesObjStr += `${String(pageIndexArr[i])} 0 R\n`;
  }
  pagesObjStr += `]\n/Count ${String(pageArr.length)}>>\nendobj\n\n`;

  /** @type {(string | Uint8Array)[]} */
  const parts = [];
  /** @type {{type: string, offset: number}[]} */
  const xrefArr = [];
  let byteLen = 0;

  // The first %PDF line is ASCII; the binary-marker line has four bytes ≥ 0x80
  // (`µ¶` UTF-8) that tells viewers the file is binary.
  const header = new TextEncoder().encode('%PDF-1.7\n%µ¶n\n');
  parts.push(header);
  byteLen += header.length;

  /** @param {string | import('./writePdfStreams.js').PdfBinaryObject} obj */
  const pushObj = (obj) => {
    xrefArr.push({ type: 'obj', offset: byteLen });
    if (typeof obj === 'string') {
      parts.push(obj);
      byteLen += obj.length;
    } else {
      parts.push(obj.header);
      byteLen += obj.header.length;
      parts.push(obj.streamData);
      byteLen += obj.streamData.length;
      parts.push(obj.trailer);
      byteLen += obj.trailer.length;
    }
  };

  // Objects 1 and 2: catalog + pages tree.
  pushObj('1 0 obj\n<</Type /Catalog\n/Pages 2 0 R>>\nendobj\n\n');
  pushObj(pagesObjStr);

  // Font objects (6 per used font; free xref entries for unused font slots).
  for (let i = 0; i < pdfFontRefs.length; i++) {
    const fontObjs = pdfFontObjStrArr[i];
    if (fontObjs) {
      for (const obj of fontObjs) pushObj(obj);
    } else {
      for (let j = 0; j < 6; j++) xrefArr.push({ type: 'free', offset: 0 });
    }
  }

  for (const imgObj of pdfImageObjStrArr) pushObj(imgObj);
  for (const pageObj of pdfPageObjArr) pushObj(pageObj);

  const objCount = 2 + pdfFontRefs.length * 6 + pdfImageObjStrArr.length + pdfPageObjArr.length + 1;

  const xrefOffset = byteLen;

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

  parts.push(xrefStr);
  byteLen += xrefStr.length;

  const result = new Uint8Array(byteLen);
  let writeOffset = 0;
  for (const part of parts) {
    if (typeof part === 'string') {
      for (let ci = 0; ci < part.length; ci++) {
        result[writeOffset++] = part.charCodeAt(ci);
      }
    } else {
      result.set(part, writeOffset);
      writeOffset += part.length;
    }
  }

  return result.buffer;
}

/**
 * Generates PDF objects for a single page of OCR data.
 * Generally returns an array of 2 strings, the first being the text content object, and the second being the page object.
 * If there is no text content, only the page object is returned.
 * @param {Object} params - Parameters object
 * @param {OcrPage} [params.pageObj]
 * @param {dims} params.inputDims
 * @param {dims} params.outputDims
 * @param {number} params.firstObjIndex
 * @param {number} params.parentIndex
 * @param {number} params.proofOpacity
 * @param {Object<string, PdfFontFamily>} params.pdfFonts
 * @param {('ebook'|'eval'|'proof'|'invis'|'annot')} params.textMode -
 * @param {number} params.angle
 * @param {boolean} [params.rotateOrientation=false] - If true, canvas is adjusted to flip width/height to account for image rotation
 *    of 90 or 270 degrees. This argument is currently only used in a dev script and may not be the best approach.
 * @param {boolean} [params.rotateText=false]
 * @param {boolean} [params.rotateBackground=false]
 * @param {number} [params.confThreshHigh=85]
 * @param {number} [params.confThreshMed=75]
 * @param {?import('../../font-parser/src/font.js').Font} [params.fontChiSim=null]
 * @param {Array<number>} [params.imageObjIndices=[]] - Array of image object indices
 * @param {?string} [params.imageName=null]
 * @param {Array<AnnotationHighlight>} [params.pageAnnotations=[]] - Highlight annotations for this page
 * @param {boolean} [params.humanReadable=false]
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
  rotateOrientation = false,
  rotateText = false,
  rotateBackground = false,
  confThreshHigh = 85,
  confThreshMed = 75,
  imageObjIndices = [],
  imageName = null,
  pageAnnotations = [],
  humanReadable = false,
}) {
  if (outputDims.width < 1) {
    outputDims = inputDims;
  }

  const noTextContent = !pageObj || pageObj.lines.length === 0 || textMode === 'annot';
  const noImageContent = !imageName || !imageObjIndices || imageObjIndices.length === 0;

  const pageIndex = firstObjIndex;
  let pageObjStr = `${String(pageIndex)} 0 obj\n<</Type/Page/MediaBox[0 0 ${String(outputDims.width)} ${String(outputDims.height)}]`;

  if (rotateOrientation && (angle > 45 && angle < 135 || angle > 225 && angle < 315)) {
    pageObjStr = `${String(pageIndex)} 0 obj\n<</Type/Page/MediaBox[0 0 ${String(outputDims.height)} ${String(outputDims.width)}]`;
  }

  pageObjStr += `/Parent ${parentIndex} 0 R`;

  /** @type {Array<string | import('./writePdfStreams.js').PdfBinaryObject>} */
  const pdfObj = [];
  let pdfFontsUsed = /** @type {Set<PdfFontInfo>} */ (new Set());

  if (noTextContent && noImageContent) {
    pageObjStr += '/Resources<<>>';
    pageObjStr += `/Contents ${String(firstObjIndex + 1)} 0 R`;
    // Empty content stream: keep uncompressed — a FlateDecode header would
    // grow it from 0 bytes to ~10 bytes of overhead for no win.
    pdfObj.push(`${String(firstObjIndex + 1)} 0 obj\n<</Length 0 >>\nstream\n\nendstream\nendobj\n\n`);
  } else {
    let resourceDictObjStr = `${String(firstObjIndex + 1)} 0 obj\n<<`;

    pageObjStr += `/Contents ${String(firstObjIndex + 2)} 0 R`;
    pageObjStr += `/Resources ${String(firstObjIndex + 1)} 0 R`;

    let imageResourceStr = '';
    let imageContentObjStr = '';

    if (imageName && imageObjIndices.length > 0) {
      imageResourceStr = createImageResourceDict(imageObjIndices);
      let rotation = 0;
      if (rotateBackground && Math.abs(angle ?? 0) > 0.05) {
        rotation = angle;
      }

      let x = 0;
      let y = 0;
      if (rotateOrientation && (rotation > 45 && rotation < 135 || rotation > 225 && rotation < 315)) {
        x = (outputDims.height - outputDims.width) / 2;
        y = (outputDims.width - outputDims.height) / 2;
      }

      imageContentObjStr += drawImageCommands(imageName, x, y, outputDims.width, outputDims.height, rotation);
    }

    if (noTextContent) {
      resourceDictObjStr += imageResourceStr;
      resourceDictObjStr += '>>\nendobj\n\n';
      pdfObj.push(resourceDictObjStr);
      pdfObj.push(await encodeStreamObject(firstObjIndex + 2, imageContentObjStr, { humanReadable }));
    } else {
      const textResult = await ocrPageToPDFStream(pageObj, outputDims, pdfFonts, textMode, angle,
        rotateText, rotateBackground, confThreshHigh, confThreshMed);
      pdfFontsUsed = textResult.pdfFontsUsed;

      let pdfFontsStr = '';
      for (const font of pdfFontsUsed) {
        pdfFontsStr += `${String(font.name)} ${String(font.objN)} 0 R\n`;
      }

      resourceDictObjStr += `/Font<<${pdfFontsStr}>>`;
      resourceDictObjStr += imageResourceStr;

      // Use `GSO` prefix to avoid conflicts with other graphics states, which are normally named `/GS[n]` by convention.
      resourceDictObjStr += '/ExtGState<<';
      resourceDictObjStr += '/GSO0 <</ca 0.0>>';
      resourceDictObjStr += `/GSO1 <</ca ${proofOpacity}>>`;
      resourceDictObjStr += '>>';

      resourceDictObjStr += '>>\nendobj\n\n';

      pdfObj.push(resourceDictObjStr);
      pdfObj.push(await encodeStreamObject(firstObjIndex + 2, `${imageContentObjStr}${textResult.textContentObjStr}`, { humanReadable }));
    }
  }

  // Build annotation objects.
  // pdfObj contains 0 items (empty page) or 2 items (resourceDict + contentStream).
  // The page dict (prepended below) is always at firstObjIndex, so annotation objects
  // start at firstObjIndex + pdfObj.length + 1.
  if (pageAnnotations.length > 0) {
    const annotObjStart = firstObjIndex + pdfObj.length + 1;
    const { objectTexts, annotRefs } = buildHighlightAnnotObjects(pageAnnotations, annotObjStart, outputDims);
    for (const text of objectTexts) pdfObj.push(text);
    pageObjStr += `/Annots [${annotRefs.join(' ')}]`;
  }

  pageObjStr += '>>\nendobj\n\n';
  pdfObj.unshift(pageObjStr);

  return { pdfObj, pdfFontsUsed };
}
