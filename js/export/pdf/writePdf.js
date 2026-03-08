import { FontCont } from '../../containers/fontContainer.js';

import { createEmbeddedFontType0, createEmbeddedFontType1 } from './writePdfFonts.js';
import {
  createDeviceNRGBA, createEmbeddedImages, createImageResourceDict, drawImageCommands,
} from './writePdfImages.js';

import { opt } from '../../containers/app.js';
import { ocrPageToPDFStream } from './writePdfText.js';
import { getDistinctCharsFont, subsetFont } from '../../utils/fontUtils.js';

/**
 * Generate PDF font objects, not including the actual font data.
 * @param {number} objectIStart - Starting object index
 * @param {?Array<OcrPage>} [ocrArr] - Array of OcrPage objects
 *    Used to subset supplementary fonts to only the characters that are actually used.
 */
const createPdfFontRefs = async (objectIStart, ocrArr) => {
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

/**
 * Create a PDF from an array of ocrPage objects.
 *
 * @param {Object} params
 * @param {PageMetrics[]} params.pageMetricsArr -
 * @param {?Array<OcrPage>} [params.ocrArr] -
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
 *
 * A valid PDF will be created if an empty array is provided for `ocrArr`, as long as `maxpage` is set manually.
 */
export async function writePdf({
  pageMetricsArr,
  ocrArr = null,
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
}) {
  if (!FontCont.raw) throw new Error('No fonts loaded.');

  if (maxpage === -1) {
    maxpage = pageMetricsArr.length - 1;
  }

  // This can happen if (1) `ocrArr` is length 0 and (2) `maxpage` is left as the default (-1).
  if (maxpage < 0) throw new Error('PDF with negative page count requested.');

  let objectI = 3;
  /** @type {Object<string, PdfFontFamily>} */
  let pdfFonts = {};
  /** @type {{familyKey: string, key: string}[]} */
  let pdfFontRefs = [];
  /** @type {string[][]} */
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

  // Add images [WIP]
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

  /** @type {Array<string>} */
  const pdfPageObjStrArr = [];

  // Add pages
  const pageIndexArr = [];
  for (let i = minpage; i <= maxpage; i++) {
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
 * Consolidates highlight annotations by using the OCR line/word structure.
 * For each annotation, overlapping words are found in the page object.
 * Words are grouped by their parent line, and consecutive highlighted words
 * within a line are merged into a single quad. Adjacent lines with highlights
 * are combined into multi-quad annotations.
 *
 * @param {Array<AnnotationHighlight>} pageAnnotations
 * @param {OcrPage} [pageObj]
 * @returns {Array<AnnotationHighlight>}
 */
function consolidateAnnotations(pageAnnotations, pageObj) {
  if (pageAnnotations.length === 0 || !pageObj || pageObj.lines.length === 0) return [];

  // Group annotations by style key (color + opacity) and groupId.
  const groups = {};
  for (let i = 0; i < pageAnnotations.length; i++) {
    const annot = pageAnnotations[i];
    const key = annot.groupId || `style_${annot.color}_${annot.opacity}`;
    if (!groups[key]) {
      groups[key] = {
        color: annot.color, opacity: annot.opacity, comment: annot.comment || '', annotations: [],
      };
    }
    groups[key].annotations.push(annot);
  }

  const result = [];

  for (const groupKey of Object.keys(groups)) {
    const group = groups[groupKey];

    // For each line in the page, find which word indices are highlighted by any annotation in this group.
    // Use a map of lineIndex -> Set<wordIndex> to track highlighted words.
    /** @type {Map<number, Set<number>>} */
    const highlightedWords = new Map();
    for (let li = 0; li < pageObj.lines.length; li++) {
      const line = pageObj.lines[li];
      for (let wi = 0; wi < line.words.length; wi++) {
        const word = line.words[wi];
        for (let ai = 0; ai < group.annotations.length; ai++) {
          const annot = group.annotations[ai];
          // Check if the annotation bbox overlaps with the word bbox.
          if (!(annot.bbox.left < word.bbox.right && annot.bbox.right > word.bbox.left
            && annot.bbox.top < word.bbox.bottom && annot.bbox.bottom > word.bbox.top)) continue;
          // If annotation has quads, require overlap with at least one quad.
          if (annot.quads) {
            const matchesQuad = annot.quads.some((quad) => quad.left < word.bbox.right && quad.right > word.bbox.left
              && quad.top < word.bbox.bottom && quad.bottom > word.bbox.top);
            if (!matchesQuad) continue;
          }
          if (!highlightedWords.has(li)) highlightedWords.set(li, new Set());
          /** @type {Set<number>} */ (highlightedWords.get(li)).add(wi);
          break;
        }
      }
    }

    if (highlightedWords.size === 0) continue;

    // For each line with highlighted words, split into runs of consecutive word indices.
    // Each run produces one quad bbox.
    /** @type {Array<{lineIndex: number, bbox: bbox}>} */
    const lineQuads = [];
    const sortedLineIndices = [...highlightedWords.keys()].sort((a, b) => a - b);

    for (const li of sortedLineIndices) {
      const wordSet = /** @type {Set<number>} */ (highlightedWords.get(li));
      const wordIndices = [...wordSet].sort((a, b) => a - b);
      const line = pageObj.lines[li];

      let runStart = 0;
      for (let i = 1; i <= wordIndices.length; i++) {
        if (i === wordIndices.length || wordIndices[i] !== wordIndices[i - 1] + 1) {
          // End of a consecutive run: merge bboxes of words in this run.
          let left = line.words[wordIndices[runStart]].bbox.left;
          let top = line.words[wordIndices[runStart]].bbox.top;
          let right = line.words[wordIndices[runStart]].bbox.right;
          let bottom = line.words[wordIndices[runStart]].bbox.bottom;
          for (let j = runStart + 1; j < i; j++) {
            const wb = line.words[wordIndices[j]].bbox;
            left = Math.min(left, wb.left);
            top = Math.min(top, wb.top);
            right = Math.max(right, wb.right);
            bottom = Math.max(bottom, wb.bottom);
          }
          lineQuads.push({
            lineIndex: li,
            bbox: {
              left, top, right, bottom,
            },
          });
          runStart = i;
        }
      }
    }

    // Merge quads from consecutive lines into multi-quad annotations.
    // Separate runs on the same line remain separate annotations.
    let currentQuads = [{ ...lineQuads[0].bbox }];
    let currentBbox = { ...lineQuads[0].bbox };
    let prevLineIndex = lineQuads[0].lineIndex;

    for (let i = 1; i < lineQuads.length; i++) {
      const isNextLine = lineQuads[i].lineIndex === prevLineIndex + 1;
      if (isNextLine) {
        currentQuads.push({ ...lineQuads[i].bbox });
        currentBbox.left = Math.min(currentBbox.left, lineQuads[i].bbox.left);
        currentBbox.top = Math.min(currentBbox.top, lineQuads[i].bbox.top);
        currentBbox.right = Math.max(currentBbox.right, lineQuads[i].bbox.right);
        currentBbox.bottom = Math.max(currentBbox.bottom, lineQuads[i].bbox.bottom);
      } else {
        result.push({
          bbox: currentBbox, quads: currentQuads, color: group.color, opacity: group.opacity, comment: group.comment,
        });
        currentQuads = [{ ...lineQuads[i].bbox }];
        currentBbox = { ...lineQuads[i].bbox };
      }
      prevLineIndex = lineQuads[i].lineIndex;
    }
    result.push({
      bbox: currentBbox, quads: currentQuads, color: group.color, opacity: group.opacity, comment: group.comment,
    });
  }

  return result;
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
 * @param {?import('opentype.js').Font} [params.fontChiSim=null]
 * @param {Array<number>} [params.imageObjIndices=[]] - Array of image object indices
 * @param {?string} [params.imageName=null]
 * @param {Array<AnnotationHighlight>} [params.pageAnnotations=[]] - Highlight annotations for this page
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

  /** @type {string[]} */
  const pdfObj = [];
  let pdfFontsUsed = /** @type {Set<PdfFontInfo>} */ (new Set());

  if (noTextContent && noImageContent) {
    pageObjStr += '/Resources<<>>';
    pageObjStr += `/Contents ${String(firstObjIndex + 1)} 0 R`;
    const emptyContentStr = `${String(firstObjIndex + 1)} 0 obj\n<</Length 0 >>\nstream\n\nendstream\nendobj\n\n`;
    pdfObj.push(emptyContentStr);
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
      const pageContentObjStr = `${String(firstObjIndex + 2)} 0 obj\n<</Length ${String(imageContentObjStr.length)} >>\nstream\n${imageContentObjStr}\nendstream\nendobj\n\n`;
      pdfObj.push(resourceDictObjStr, pageContentObjStr);
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

      const pageContentObjStr = `${String(firstObjIndex + 2)} 0 obj\n<</Length ${String(imageContentObjStr.length + textResult.textContentObjStr.length)} >>\nstream\n${imageContentObjStr}${textResult.textContentObjStr}\nendstream\nendobj\n\n`;
      pdfObj.push(resourceDictObjStr, pageContentObjStr);
    }
  }

  // Build annotation objects.
  // pdfObj contains 0 items (empty page) or 2 items (resourceDict + contentStream).
  // The page dict (prepended below) is always at firstObjIndex, so annotation objects
  // start at firstObjIndex + pdfObj.length + 1.
  if (pageAnnotations.length > 0) {
    const annotObjStart = firstObjIndex + pdfObj.length + 1;
    let annotsRef = '/Annots [';
    for (let a = 0; a < pageAnnotations.length; a++) {
      const annotObjIndex = annotObjStart + a;
      annotsRef += `${String(annotObjIndex)} 0 R `;

      const annot = pageAnnotations[a];
      const hex = annot.color.replace('#', '');
      const r = parseInt(hex.substring(0, 2), 16) / 255;
      const g = parseInt(hex.substring(2, 4), 16) / 255;
      const b = parseInt(hex.substring(4, 6), 16) / 255;

      // Convert to PDF coordinates (origin bottom-left, y increases upward)
      const pdfRectTop = outputDims.height - annot.bbox.top;
      const pdfRectBottom = outputDims.height - annot.bbox.bottom;

      let annotStr = `${String(annotObjIndex)} 0 obj\n`;
      annotStr += '<</Type /Annot /Subtype /Highlight';
      annotStr += ` /Rect [${annot.bbox.left} ${pdfRectBottom} ${annot.bbox.right} ${pdfRectTop}]`;

      // Build QuadPoints from per-line quads.
      let quadPoints = '';
      const quads = annot.quads || [annot.bbox];
      for (const q of quads) {
        const qTop = outputDims.height - q.top;
        const qBottom = outputDims.height - q.bottom;
        quadPoints += `${q.left} ${qTop} ${q.right} ${qTop} ${q.left} ${qBottom} ${q.right} ${qBottom} `;
      }
      annotStr += ` /QuadPoints [${quadPoints.trim()}]`;

      annotStr += ` /C [${r} ${g} ${b}]`;
      annotStr += ` /CA ${annot.opacity}`;
      annotStr += ' /F 4';
      if (annot.comment) {
        // Use UTF-16BE hex string with BOM for Unicode compatibility.
        let hexStr = 'FEFF';
        for (let ci = 0; ci < annot.comment.length; ci++) {
          hexStr += annot.comment.charCodeAt(ci).toString(16).toUpperCase().padStart(4, '0');
        }
        annotStr += ` /Contents <${hexStr}>`;
      }
      annotStr += '>>\nendobj\n\n';

      pdfObj.push(annotStr);
    }
    annotsRef += ']';
    pageObjStr += annotsRef;
  }

  pageObjStr += '>>\nendobj\n\n';
  pdfObj.unshift(pageObjStr);

  return { pdfObj, pdfFontsUsed };
}
