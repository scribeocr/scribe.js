import ocr from '../objects/ocrObjects.js';

import {
  calcBboxUnion,
  mean50,
  descCharArr,
  ascCharArr,
  xCharArr,
  removeSuperscript,
} from '../utils/miscUtils.js';

import {
  LayoutDataTablePage,
} from '../objects/layoutObjects.js';
import { pass3 } from './convertPageShared.js';

const debugMode = false;

/**
 * @param {Object} params
 * @param {string} params.ocrStr - String or array of strings containing Google Vision JSON data.
 * @param {number} params.n
 */
export async function convertPageGoogleVision({ ocrStr, n }) {
  const ocrJson = JSON.parse(ocrStr);
  let visionResult;
  if (ocrJson.fullTextAnnotation) {
    visionResult = ocrJson;
  } else if (ocrJson?.responses?.[0]?.fullTextAnnotation) {
    visionResult = ocrJson?.responses?.[0];
  } else {
    visionResult = ocrJson?.[0];
  }

  if (!visionResult || !visionResult.fullTextAnnotation) {
    throw new Error('Failed to parse Google Vision OCR data.');
  }

  const pageVision = /** @type {GoogleVisionPage} */ (visionResult.fullTextAnnotation?.pages?.[0]);
  const pageWidth = pageVision.width;
  const pageHeight = pageVision.height;
  if (!pageWidth || !pageHeight) {
    throw new Error('Failed to parse page dimensions.');
  }

  /**
   * @param {GoogleVisionParagraph["boundingBox"]} boundingBox - The bounding box object.
   * @returns {Array<{x: number, y: number}>} - An array of vertex coordinates.
   */
  const getVertices = (boundingBox) => {
    if (boundingBox.vertices) {
      return boundingBox.vertices;
    }
    if (boundingBox.normalizedVertices) {
      return boundingBox.normalizedVertices.map((v) => ({
        x: (v.x || 0) * pageWidth,
        y: (v.y || 0) * pageHeight,
      }));
    }
    throw new Error('No vertices found in bounding box.');
  };

  const pageDims = { width: pageWidth, height: pageHeight };

  const pageObj = new ocr.OcrPage(n, pageDims);

  if (!pageVision.blocks || pageVision.blocks.length === 0) {
    const warn = { char: 'char_error' };
    return {
      pageObj,
      charMetricsObj: {},
      dataTables: new LayoutDataTablePage(n),
      warn,
    };
  }

  const tablesPage = new LayoutDataTablePage(n);

  /** @type {Array<number>} */
  const angleRisePage = [];

  pageVision.blocks.forEach((block, blockIndex) => {
    if (!block.paragraphs) return;

    block.paragraphs.forEach((paragraph, paragraphIndex) => {
      const wordsVision = paragraph.words;
      if (!wordsVision || wordsVision.length === 0) return;

      const parVertices = getVertices(paragraph.boundingBox);
      const xsPar = parVertices.map((v) => v.x || 0);
      const ysPar = parVertices.map((v) => v.y || 0);

      const bboxPar = {
        left: Math.min(...xsPar),
        top: Math.min(...ysPar),
        right: Math.max(...xsPar),
        bottom: Math.max(...ysPar),
      };

      const parObj = new ocr.OcrPar(pageObj, bboxPar);
      parObj.reason = String(block.blockType || 'TEXT');

      if (debugMode) {
        parObj.debug.sourceType = block.blockType || null;
      }

      let lineObj = new ocr.OcrLine(pageObj, null, [0, 0]);
      let lineIndex = 0;

      wordsVision.forEach((word, wordIndex) => {
        if (!word.symbols || word.symbols.length === 0) return;

        const wordVertices = getVertices(word.boundingBox);
        const xs = wordVertices.map((v) => v.x || 0);
        const ys = wordVertices.map((v) => v.y || 0);

        const bboxWord = {
          left: Math.min(...xs),
          top: Math.min(...ys),
          right: Math.max(...xs),
          bottom: Math.max(...ys),
        };

        const id = `word_${n + 1}_${blockIndex + 1}_${paragraphIndex + 1}_${lineIndex + 1}_${wordIndex + 1}`;

        const wordText = word.symbols.map((symbol) => symbol.text || '').join('');

        const incChars = false;
        let charObjs = /** @type {?OcrChar[]} */ (null);
        if (incChars) {
          charObjs = [];
          if (word.symbols) {
            word.symbols.forEach((symbol) => {
              const charVertices = getVertices(symbol.boundingBox);
              const charXs = charVertices.map((v) => v.x || 0);
              const charYs = charVertices.map((v) => v.y || 0);
              const charBbox = {
                left: Math.min(...charXs),
                top: Math.min(...charYs),
                right: Math.max(...charXs),
                bottom: Math.max(...charYs),
              };
              const charObj = new ocr.OcrChar(symbol.text || '', charBbox);
              charObjs.push(charObj);
            });
          }
        }

        const wordObj = new ocr.OcrWord(lineObj, id, wordText, bboxWord);
        wordObj.conf = (word.confidence || 0) * 100;
        wordObj.chars = charObjs;

        if (debugMode) {
          wordObj.debug.raw = JSON.stringify(word);
        }

        lineObj.words.push(wordObj);

        const hasLineBreak = word.symbols.some((symbol) => {
          const breakType = symbol.property?.detectedBreak?.type;
          return breakType === 'LINE_BREAK' || breakType === 'EOL_SURE_SPACE';
        });

        if (hasLineBreak || wordIndex === wordsVision.length - 1) {
          if (lineObj.words.length > 0) {
            const wordBboxes = lineObj.words.map((w) => w.bbox);
            lineObj.bbox = calcBboxUnion(wordBboxes);

            calculateTextMetrics(lineObj);

            pageObj.lines.push(lineObj);
            parObj.lines.push(lineObj);
            lineObj.par = parObj;
            lineIndex++;
          }

          if (wordIndex !== wordsVision.length - 1) {
            lineObj = new ocr.OcrLine(pageObj, null, [0, 0]);
          }
        }
      });

      if (parObj.lines.length > 0) {
        pageObj.pars.push(parObj);
      }
    });
  });

  pageObj.lines.forEach((line) => {
    const wordBoxArr = line.words.map((x) => x.bbox);
    line.bbox = calcBboxUnion(wordBoxArr);
  });

  const angleRiseMedian = mean50(angleRisePage) || 0;
  const angleOut = Math.asin(angleRiseMedian) * (180 / Math.PI);
  pageObj.angle = angleOut;
  pageObj.textSource = 'google_vision';

  const langSet = pass3(pageObj);

  return { pageObj, dataTables: tablesPage, langSet };
}

/**
 * Calculate text metrics for the line based on character types
 * @param {OcrLine} lineObj - The line object to update
 */
function calculateTextMetrics(lineObj) {
  const descCharRegex = new RegExp(`[${descCharArr.join('')}]`);
  const ascCharRegex = new RegExp(`[${ascCharArr.join('')}]`);
  const xCharRegex = new RegExp(`[${xCharArr.join('')}]`);

  const xOnlyWords = /** @type {OcrWord[]} */([]);
  const ascOnlyWords = /** @type {OcrWord[]} */([]);

  lineObj.words.forEach((word) => {
    if (word.text && xCharRegex.test(word.text) && !ascCharRegex.test(word.text)
      && !descCharRegex.test(word.text) && !/[fi]/.test(word.text)) {
      xOnlyWords.push(word);
    }
    if (word.text && ascCharRegex.test(word.text) && !descCharRegex.test(word.text)) {
      ascOnlyWords.push(word);
    }
  });

  let xHeight = null;
  if (xOnlyWords.length > 0) {
    xHeight = mean50(xOnlyWords.map((word) => word.bbox.bottom - word.bbox.top));
  }

  const ascHeight = ascOnlyWords.length > 0
    ? mean50(ascOnlyWords.map((word) => word.bbox.bottom - word.bbox.top))
    : null;

  if (xHeight && ascHeight && xHeight > ascHeight * 0.8) {
    if (ascOnlyWords.length > xOnlyWords.length) {
      xHeight = null;
    }
  }

  if (xHeight && xHeight > 0) lineObj.xHeight = xHeight;
  if (ascHeight && ascHeight > 0) lineObj.ascHeight = ascHeight;
}
