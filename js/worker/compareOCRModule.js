// Disable linter rule.  Many async functions in this files draw on the canvas (a side effect) so need to be run one at a time.
/* eslint-disable no-await-in-loop */

import ocr from '../objects/ocrObjects.js';
import { calcLineFontSize, calcWordFontSize, calcWordMetrics } from '../utils/fontUtils.js';

import { FontCont } from '../containers/fontContainer.js';
import { imageUtils } from '../objects/imageObjects.js';
import { ca } from '../canvasAdapter.js';

/**
 * Crop the image data the area containing `words` and render to the `calcCanvas` canvas.
 * @param {Array<OcrWord>} words
 * @param {ImageBitmap} imageBinaryBit
 * @param {number} angle
 */
export async function drawWordActual(words, imageBinaryBit, angle) {
  if (!FontCont.raw) throw new Error('Fonts must be defined before running this function.');

  // The font/style from the first word is used for the purposes of font metrics
  const lineFontSize = calcLineFontSize(words[0].line);

  const fontI = FontCont.getWordFont(words[0]);

  const fontOpentypeI = fontI.opentype;

  const fontAscApprox = fontOpentypeI.charToGlyph('A').getMetrics().yMax * 1.1;
  const fontDescApprox = fontOpentypeI.charToGlyph('j').getMetrics().yMin * 1.1;

  const fontDesc = Math.round(fontDescApprox * (lineFontSize / 1000));
  const fontAsc = Math.round(fontAscApprox * (lineFontSize / 1000));

  const sinAngle = Math.sin(angle * (Math.PI / 180));
  const cosAngle = Math.cos(angle * (Math.PI / 180));

  const wordsBox = words.map((x) => x.bbox);

  // Union of all bounding boxes
  const wordBoxUnion = {
    left: Math.min(...wordsBox.map((x) => x.left)),
    top: Math.min(...wordsBox.map((x) => x.top)),
    right: Math.max(...wordsBox.map((x) => x.right)),
    bottom: Math.max(...wordsBox.map((x) => x.bottom)),
  };

  // All words are assumed to be on the same line
  const lineObj = words[0].line;
  const linebox = words[0].line.bbox;
  const { baseline } = words[0].line;

  const imageRotated = angle !== 0;
  const angleAdjLine = imageRotated ? ocr.calcLineStartAngleAdj(lineObj) : { x: 0, y: 0 };

  const start = linebox.left + angleAdjLine.x + (wordBoxUnion.left - linebox.left) / cosAngle;

  // We crop to the dimensions of the font (fontAsc and fontDesc) rather than the image bounding box.
  const height = Math.round(fontAsc - fontDesc);
  const width = Math.round(wordBoxUnion.right - wordBoxUnion.left + 1);

  const cropY = linebox.bottom + baseline[1] - fontAsc - 1;
  const cropYAdj = cropY + angleAdjLine.y;

  const canvas = await ca.createCanvas(width, height);
  const ctx = /** @type {OffscreenCanvasRenderingContext2D} */ (canvas.getContext('2d'));

  ctx.drawImage(imageBinaryBit, start - 1, cropYAdj, width, height, 0, 0, width, height);

  return {
    canvas,
    cropY,
    width,
    height,
  };
}

/**
 * Function that draws a word on a canvas.
 * This code was factored out to allow for drawing multiple times while only calculating metrics once.
 * Therefore, only the drawing code should be in this function; the metrics should be calculated elsewhere
 * and passed to this function, rather than calcualting from an `OcrWord` object.
 *
 * @param {Object} params
 * @param {CanvasRenderingContext2D|OffscreenCanvasRenderingContext2D} params.ctx
 * @param {Array<string>} params.charArr
 * @param {number} params.left
 * @param {number} params.bottom
 * @param {Array<number>} params.advanceArr - Array of pixels to advance for each character.
 *    Unlike the "advance" property of a glyph, this is the actual distance to advance on the canvas,
 *    and should include kerning and character spacing.
 * @param {FontContainerFont} params.font
 * @param {number} params.size
 * @param {boolean} params.smallCaps
 * @param {string} [params.fillStyle='black']
 */
const printWordOnCanvas = async ({
  ctx, charArr, left, bottom, advanceArr, font, size, smallCaps, fillStyle = 'black',
}) => {
  ctx.font = `${font.fontFaceStyle} ${font.fontFaceWeight} ${size}px ${font.fontFaceName}`;
  ctx.fillStyle = fillStyle;
  ctx.textBaseline = 'alphabetic';

  let leftI = left;
  for (let i = 0; i < charArr.length; i++) {
    let charI = charArr[i];

    if (smallCaps) {
      if (charI === charI.toUpperCase()) {
        ctx.font = `${font.fontFaceStyle} ${font.fontFaceWeight} ${size}px ${font.fontFaceName}`;
      } else {
        charI = charI.toUpperCase();
        ctx.font = `${font.fontFaceStyle} ${font.fontFaceWeight} ${size * font.smallCapsMult}px ${font.fontFaceName}`;
      }
    }

    ctx.fillText(charI, leftI, bottom);
    leftI += advanceArr[i];
  }
};

/**
 * Print word on canvas.
 *
 * @param {CanvasRenderingContext2D|OffscreenCanvasRenderingContext2D} ctx
 * @param {OcrWord} word
 * @param {number} offsetX
 * @param {number} cropY
 * @param {?CanvasRenderingContext2D|OffscreenCanvasRenderingContext2D} ctxView
 * @param {boolean} [imageRotated=false] -
 */
export const drawWordRender = async (ctx, word, offsetX = 0, cropY = 0, ctxView = null, imageRotated = false) => {
  if (!FontCont.raw) throw new Error('Fonts must be defined before running this function.');
  if (!ctx) throw new Error('Canvases must be defined before running this function.');

  const fontI = FontCont.getWordFont(word);

  let baselineY = word.line.bbox.bottom + word.line.baseline[1];

  const wordMetrics = calcWordMetrics(word);
  const advanceArr = wordMetrics.advanceArr;
  const kerningArr = wordMetrics.kerningArr;
  const charSpacing = wordMetrics.charSpacing;
  const wordFontSize = wordMetrics.fontSize;

  if (word.sup) {
    const wordboxXMid = word.bbox.left + (word.bbox.right - word.bbox.left) / 2;

    const baselineYWord = word.line.bbox.bottom + word.line.baseline[1] + word.line.baseline[0] * (wordboxXMid - word.line.bbox.left);

    baselineY -= (baselineYWord - word.bbox.bottom);

    if (!word.visualCoords) {
      const fontDesc = fontI.opentype.descender / fontI.opentype.unitsPerEm * wordMetrics.fontSize;
      baselineY += fontDesc;
    }
  } else if (!imageRotated) {
    const wordboxXMid = word.bbox.left + (word.bbox.right - word.bbox.left) / 2;

    baselineY = word.line.bbox.bottom + word.line.baseline[1] + word.line.baseline[0] * (wordboxXMid - word.line.bbox.left);
  }

  const y = baselineY - cropY;

  const advanceArrTotal = [];
  for (let i = 0; i < advanceArr.length; i++) {
    let leftI = 0;
    leftI += advanceArr[i] || 0;
    leftI += kerningArr[i] || 0;
    leftI += charSpacing || 0;
    advanceArrTotal.push(leftI);
  }

  let left = 1 + offsetX;
  if (word.visualCoords) left -= wordMetrics.leftSideBearing;

  await printWordOnCanvas({
    ctx, charArr: wordMetrics.charArr, left, bottom: y, advanceArr: advanceArrTotal, font: fontI, size: wordFontSize, smallCaps: word.smallCaps,
  });

  if (ctxView) {
    await printWordOnCanvas({
      ctx: ctxView, charArr: wordMetrics.charArr, left, bottom: y, advanceArr: advanceArrTotal, font: fontI, size: wordFontSize, smallCaps: word.smallCaps, fillStyle: 'red',
    });
  }
};

/**
 * Evaluate the accuracy of OCR results by comparing visually with input image.
 * Optionally, an alternative array of OCR results (for the same underlying text)
 * can be provided for comparison purposes.
 * @param {Object} params
 * @param {Array<OcrWord>} params.wordsA - Array of words
 * @param {Array<OcrWord>} [params.wordsB] - Array of words for comparison.  Optional.
 * @param {ImageBitmap} params.binaryImage - Image to compare to.  Using an ImageBitmap is more efficient
 *    when multiple compparisons are being made to the same binaryImage.
 * @param {number} params.angle - Angle image has been rotated. This should be 0 if the image has not been rotated.
 * @param {Object} [params.options]
 * @param {boolean} [params.options.view] - Draw results on debugging canvases
 * @param {boolean} [params.options.useAFontSize] - Use font size from `wordsA` when printing `wordsB`
 *   This is useful when the metrics from `wordsA` are considered systematically more reliable,
 *   such as when `wordsA` are from Tesseract Legacy and `wordsB` are from Tesseract LSTM.
 * @param {boolean} [params.options.useABaseline]
 */
export async function evalWords({
  wordsA, wordsB = [], binaryImage, angle, options = {},
}) {
  // This code cannot currently handle non-Latin characters.
  // Therefore, if any Chinese words are in either set of words,
  // `wordsB` are determined correct by default.
  let anyChinese = false;
  wordsA.forEach((x) => {
    if (x.lang === 'chi_sim') anyChinese = true;
  });
  wordsB.forEach((x) => {
    if (x.lang === 'chi_sim') anyChinese = true;
  });
  // Also skip if the first word in the line, which are used for various calculations, are Chinese.
  if (wordsA[0].line.words[0].lang === 'chi_sim') anyChinese = true;
  if (wordsB[0] && wordsB[0].line.words[0].lang === 'chi_sim') anyChinese = true;

  if (anyChinese) return { metricA: 1, metricB: 0, debug: null };

  const binaryImageBit = await ca.getImageBitmap(binaryImage);

  if (!FontCont.raw) throw new Error('Fonts must be defined before running this function.');

  const view = options?.view === undefined ? false : options?.view;
  const useABaseline = options?.useABaseline === undefined ? true : options?.useABaseline;

  const cosAngle = Math.cos(angle * -1 * (Math.PI / 180)) || 1;

  // All words are assumed to be on the same line
  const linebox = wordsA[0].line.bbox;
  const baselineA = wordsA[0].line.baseline;

  // Draw the actual words (from the user-provided image)
  const {
    canvas, cropY, width, height,
  } = await drawWordActual([...wordsA, ...wordsB], binaryImageBit, angle);

  const ctx = /** @type {OffscreenCanvasRenderingContext2D} */ (canvas.getContext('2d'));

  const imageDataActual = ctx.getImageData(0, 0, width, height).data;

  let canvasView0;
  let ctxView0;
  let canvasView1;
  let ctxView1;
  let canvasView2;
  let ctxView2;
  if (view) {
    let img;
    if (typeof process === 'undefined') {
      img = canvas;
    } else {
      img = ca.CanvasKit.MakeImage({
        width,
        height,
        alphaType: ca.CanvasKit.AlphaType.Unpremul,
        colorType: ca.CanvasKit.ColorType.RGBA_8888,
        colorSpace: ca.CanvasKit.ColorSpace.SRGB,
      }, imageDataActual, 4 * width);
    }

    canvasView0 = await ca.createCanvas(width, height);
    ctxView0 = /** @type {OffscreenCanvasRenderingContext2D} */ (canvasView0.getContext('2d'));
    ctxView0.drawImage(img, 0, 0);
    canvasView1 = await ca.createCanvas(width, height);
    ctxView1 = /** @type {OffscreenCanvasRenderingContext2D} */ (canvasView1.getContext('2d'));
    ctxView1.drawImage(img, 0, 0);
    if (wordsB.length > 0) {
      canvasView2 = await ca.createCanvas(width, height);
      ctxView2 = /** @type {OffscreenCanvasRenderingContext2D} */ (canvasView2.getContext('2d'));
      ctxView2.drawImage(img, 0, 0);
    }
  }

  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, width, height);

  // Draw the words in wordsA
  let x0 = wordsA[0].bbox.left;
  const y0 = linebox.bottom + baselineA[1] + baselineA[0] * (wordsA[0].bbox.left - linebox.left);
  for (let i = 0; i < wordsA.length; i++) {
    const word = wordsA[i];
    const wordIBox = word.bbox;

    const offsetX = (wordIBox.left - x0) / cosAngle;

    await drawWordRender(ctx, word, offsetX, cropY, ctxView1, Boolean(angle));
  }

  const imageDataExpectedA = ctx.getImageData(0, 0, width, height).data;

  if (imageDataActual.length !== imageDataExpectedA.length) {
    console.log('Actual and expected images are different sizes');
    debugger;
  }

  let diffA = 0;
  let totalA = 0;
  let lastMatch = false;
  for (let i = 0; i < imageDataActual.length; i++) {
    if (imageDataActual[i] !== 255 || imageDataExpectedA[i] !== 255) {
      totalA += 1;
      if (imageDataActual[i] === 255 || imageDataExpectedA[i] === 255) {
        if (lastMatch) {
          diffA += 0.5;
        } else {
          diffA += 1;
        }
        lastMatch = false;
      } else {
        lastMatch = true;
      }
    }
  }

  const metricA = diffA / totalA;

  let metricB = 1;
  if (wordsB.length > 0) {
    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, width, height);

    // Draw the words in wordsB
    for (let i = 0; i < wordsB.length; i++) {
      // Clone object so editing does not impact the original
      const word = ocr.cloneWord(wordsB[i]);

      // Set style to whatever it is for wordsA.  This is based on the assumption that "A" is Tesseract Legacy and "B" is Tesseract LSTM (which does not have useful style info).
      word.font = wordsA[0].font;
      word.style = wordsA[0].style;

      if (i === 0) {
        x0 = word.bbox.left;
      }
      const offsetX = (word.bbox.left - x0) / cosAngle;

      await drawWordRender(ctx, word, offsetX, cropY, ctxView2, Boolean(angle));
    }

    const imageDataExpectedB = ctx.getImageData(0, 0, width, height).data;

    ctx.clearRect(0, 0, width, height);

    let diffB = 0;
    let totalB = 0;
    let lastMatch = false;
    for (let i = 0; i < imageDataActual.length; i++) {
      if (imageDataActual[i] !== 255 || imageDataExpectedB[i] !== 255) {
        totalB += 1;
        if (imageDataActual[i] === 255 || imageDataExpectedB[i] === 255) {
          if (lastMatch) {
            diffB += 0.5;
          } else {
            diffB += 1;
          }
          lastMatch = false;
        } else {
          lastMatch = true;
        }
      }
    }

    metricB = diffB / totalB;
  }

  /** @type {?CompDebugBrowser|CompDebugNode} */
  let debugImg = null;
  if (view) {
    if (typeof process === 'undefined') {
      let imageRaw;
      let imageA;
      let imageB;

      if (canvasView0) imageRaw = await canvasView0.convertToBlob();
      if (canvasView1) imageA = await canvasView1.convertToBlob();
      if (canvasView2) imageB = await canvasView2.convertToBlob();
      const dims = { width, height };

      debugImg = {
        context: 'browser', imageRaw, imageA, imageB, dims, errorRawA: metricA, errorRawB: metricB, errorAdjA: null, errorAdjB: null,
      };
    } else {
      let imageRaw;
      let imageA;
      let imageB;

      if (canvasView0) imageRaw = canvasView0.toDataURL('image/png');
      if (canvasView1) imageA = canvasView1.toDataURL('image/png');
      if (canvasView2) imageB = canvasView2.toDataURL('image/png');

      const dims = { width, height };

      debugImg = {
        context: 'node', imageRaw, imageA, imageB, dims, errorRawA: metricA, errorRawB: metricB, errorAdjA: null, errorAdjB: null,
      };
    }
  }

  if (typeof process !== 'undefined') {
    canvas.dispose();
    if (canvasView0) canvasView0.dispose();
    if (canvasView1) canvasView1.dispose();
    if (canvasView2) canvasView2.dispose();
  }

  return { metricA, metricB, debug: debugImg };
}

/**
 * Determines whether Tesseract Legacy word should be rejected in favor of LSTM word.
 * This should only be run when combining Tesseract Legacy and Tesseract LSTM,
 * as these heuristics are based specifically on Tesseract Legacy issues,
 * and it should only include patterns that are highly likely to be incorrect when only found in Legacy.
 * Patterns that should merely be penalized (in all engines) should be in `penalizeWord`,
 *
 * @param {string} legacyText
 * @param {string} lstmText
 */
function rejectWordLegacy(legacyText, lstmText) {
  // Automatically reject words that contain a number between two letters.
  // Tesseract Legacy commonly identifies letters as numbers (usually 1).
  // This does not just happen with "l"--in test documents "r" and "i" were also misidentified as "1" multiple times.
  const replaceNum = /[a-z]\d[a-z]/i.test(legacyText) && !/[a-z]\d[a-z]/i.test(lstmText);

  // Automatically reject words where "ii" is between two non-"i" letters
  // Tesseract Legacy commonly recognizes "ii" when the (actual) letter contains an accent,
  // while Tesseract LSTM usually recognizes the correct letter, sans the accent.
  // This "ii" pattern is automatically discarded, regardless of the overlap metrics,
  // because the overlap metrics often fail in this case.
  // E.g. the letter "ö" (o with umlaut) may overlap better with "ii" than "o".
  const replaceII = /[a-hj-z]ii[a-hj-z]/i.test(legacyText) && !/[a-hj-z]ii[a-hj-z]/i.test(lstmText);

  return replaceNum || replaceII;
}

/**
 * Calculate penalty for word using ad-hoc heuristics.
 * Supplements word overlap strategy by penalizing patterns that may have plausible overlap
 * but are implausible from a language perspective (e.g. "1%" being misidentified as "l%")
 * @param {Array<OcrWord>} wordObjs - Array of OcrWord objects. All objects should (potentially) belong to a single word,
 *    rather than this function being used on an entire line.
 */
async function penalizeWord(wordObjs) {
  const wordStr = wordObjs.map((x) => x.text).join('');

  let penalty = 0;
  // Penalize non-numbers followed by "%"
  // This potentially penalizes valid URLs
  if (/[^0-9]%/.test(wordStr)) penalty += 0.05;

  // Penalize "ii" (virtually always a false positive)
  // If this penalty becomes an issue, a whitelist of dictionary words containing "ii" can be added
  if (/ii/.test(wordStr)) penalty += 0.05;

  // Penalize single-letter word "m"
  // When Tesseract Legacy incorrectly combines letters, resulting wide "character" is usually identified as "m".
  // Therefore, "m" as a single word is likely a short word like "to" that was not segmented correctly.
  if (/^m$/.test(wordStr)) penalty += 0.05;

  // Penalize digit between two letters
  // This usually indicates a letter is being misidentified as "0" or "1"
  if (/[a-z]\d[a-z]/i.test(wordStr)) penalty += 0.05;

  // Penalize "]" at the start of word (followed by at least one other character)
  // Motivated by "J" being misidentified as "]"
  // (Overlap can be fairly strong of no actual "]" characters are present due to font optimization)
  if (/^\]./.test(wordStr)) penalty += 0.05;

  // Penalize likely noise characters.
  // These are identified as characters that cause the characters to overlap, however if reduced, the spacing would be plausible.
  // This is currently limited to two letter words where a letter is following by a period, comma, or dash,
  // however should likely be expanded in the future to cover more cases.
  // See notes for more explanation of this issue.
  if (wordObjs.length === 1 && /^[a-z][.,-]$/i.test(wordStr)) {
    const word = wordObjs[0];
    const wordTextArr = wordStr.split('');
    const wordFontSize = calcLineFontSize(word.line);

    const fontI = FontCont.getWordFont(word);
    const fontOpentypeI = fontI.opentype;

    // These calculations differ from the standard word width calculations,
    // because they do not include left/right bearings.
    const glyphFirstMetrics = fontOpentypeI.charToGlyph(wordTextArr[0]).getMetrics();
    const widthFirst = (glyphFirstMetrics.xMax - glyphFirstMetrics.xMin) / fontOpentypeI.unitsPerEm * wordFontSize;

    const glyphSecondMetrics = fontOpentypeI.charToGlyph(wordTextArr[1]).getMetrics();
    const widthSecond = (glyphSecondMetrics.xMax - glyphSecondMetrics.xMin) / fontOpentypeI.unitsPerEm * wordFontSize;

    const widthTotal = widthFirst + widthSecond;

    const wordWidth = word.bbox.right - word.bbox.left;

    if (widthFirst >= wordWidth * 0.9 && widthTotal > wordWidth * 1.15) penalty += 0.05;
  }

  return penalty;
}

/**
 * Checks words in pageA against words in pageB.
 * @param {object} params
 * @param {OcrPage} params.pageA
 * @param {OcrPage} params.pageB
 * @param {import('../containers/imageContainer.js').ImageWrapper} params.binaryImage
 * @param {PageMetrics} params.pageMetricsObj
 * @param {object} params.options
 * @param {("stats"|"comb")} [params.options.mode='stats'] - If `mode = 'stats'` stats quantifying the number of matches/mismatches are returned.
 *    If `mode = 'comb'` a new version of `pageA`, with text and confidence metrics informed by comparisons with pageB, is created.
 * @param {boolean} [params.options.editConf] - Whether confidence metrics should be updated when `mode = 'stats'`,
 *    rather than simply setting `compTruth`/`matchTruth`. Enabled when using recognition to update confidence metrics, but not when comparing to ground truth.
 * @param {boolean} [params.options.legacyLSTMComb] - Whether Tesseract Legacy and Tesseract LSTM are being combined, when `mode = 'comb'`.
 *    When `legacyLSTMComb` is enabled, additional heuristics are applied that are based on specific behaviors of the Tesseract Legacy engine.
 * @param {boolean} [params.options.useBboxB] - Use bounding boxes from `pageB` in combined output.
 * @param {string} [params.options.debugLabel]
 * @param {boolean} [params.options.evalConflicts] - Whether to evaluate word quality on conflicts. If `false` the text from `pageB` is always assumed correct.
 *    This option is useful for combining the style from Tesseract Legacy with the text from Tesseract LSTM.
 * @param {boolean} [params.options.supplementComp] - Whether to run additional recognition jobs for words in `pageA` not in `pageB`
 * @param {Tesseract.Worker} [params.options.tessWorker] - Tesseract worker to use for recognizing text. Must be provided if `supplementComp` is `true`.
 * @param {boolean} [params.options.ignorePunct]
 * @param {boolean} [params.options.ignoreCap]
 * @param {number} [params.options.confThreshHigh]
 * @param {number} [params.options.confThreshMed]
 */
export async function compareOCRPageImp({
  pageA, pageB, binaryImage, pageMetricsObj, options = {},
}) {
  // The `binaryImage` argument is not sent for certain operations, which do not require it.
  // For example, running a basic comparison between a page and the ground truth does not require having the image.
  // The types do not currently reflect this, so this should be reworked at some point.
  /** @type {?ImageBitmap} */
  let binaryImageBit = null;
  let imageUpscaled = false;
  let imageRotated = false;

  if (binaryImage) {
    binaryImageBit = binaryImage.imageBitmap || await ca.getImageBitmap(binaryImage.src);
    imageUpscaled = binaryImage.upscaled;
    imageRotated = binaryImage.rotated;
  }

  const mode = options?.mode === undefined ? 'stats' : options?.mode;
  const editConf = options?.editConf === undefined ? false : options?.editConf;
  const legacyLSTMComb = options?.legacyLSTMComb === undefined ? false : options?.legacyLSTMComb;
  const useBboxB = options?.useBboxB === undefined ? false : options?.useBboxB;
  const debugLabel = options?.debugLabel === undefined ? '' : options?.debugLabel;
  const evalConflicts = options?.evalConflicts === undefined ? true : options?.evalConflicts;
  const supplementComp = options?.supplementComp === undefined ? false : options?.supplementComp;
  const tessWorker = options?.tessWorker === undefined ? null : options?.tessWorker;
  const ignorePunct = options?.ignorePunct === undefined ? false : options?.ignorePunct;
  const ignoreCap = options?.ignoreCap === undefined ? false : options?.ignoreCap;
  const confThreshHigh = options?.confThreshHigh === undefined ? 85 : options?.confThreshHigh;
  const confThreshMed = options?.confThreshMed === undefined ? 75 : options?.confThreshMed;

  if (supplementComp && !tessWorker) console.log('`supplementComp` enabled, but no scheduler was provided. This step will be skipped.');

  // If this is not being run in a worker, clone the data so the original is not edited.
  // This is not necessary when running in a worker, as the data is already cloned when sent to the worker.
  if (typeof WorkerGlobalScope === 'undefined') {
    pageA = structuredClone(pageA);
    pageB = structuredClone(pageB);
  }

  const imgAngle = imageRotated ? (pageMetricsObj.angle || 0) : 0;
  if (imageUpscaled) {
    ocr.scalePage(pageA, 2);
    ocr.scalePage(pageB, 2);
  }

  const debugImg = [];

  const hocrAOverlap = {};
  const hocrBOverlap = {};
  const hocrBOverlapAWords = {};
  const hocrACorrect = {};
  const hocrBCorrect = {};

  // Reset all comparison-related fields in input page
  ocr.getPageWords(pageA).forEach((x) => {
    x.compTruth = false;
    x.matchTruth = false;
  });

  // Create copy of `pageA` so original is not edited.
  // This is used to get the original confidence metrics later in the code.
  const pageAInt = structuredClone(pageA);

  if (mode === 'comb') {
    ocr.getPageWords(pageAInt).forEach((x) => {
      x.conf = 0;
    });
  }

  // TODO: This assumes that the lines are in a specific order, which may not always be the case.
  //    Add a sorting step or otherwise make more robust.
  // TODO: Does this need to consider rotation?  It does not do so at present.
  for (let i = 0; i < pageAInt.lines.length; i++) {
    const lineA = pageAInt.lines[i];
    const lineBoxA = lineA.bbox;

    let lineWordsEditedNew = 0;
    let lineBReplace = null;

    for (let j = 0; j < pageB.lines.length; j++) {
      const lineB = pageB.lines[j];
      const lineBoxB = lineB.bbox;

      // If top of line A is below bottom of line B, move to next line B
      if (lineBoxA.top > lineBoxB.bottom) {
        // minLineB = minLineB + 1;
        continue;

        // If top of line B is below bottom of line A, move to next line A
        // (We assume no match is possible for any B)
      } else if (lineBoxB.top > lineBoxA.bottom) {
        continue;

        // Otherwise, there is possible overlap
      } else {
        let minWordB = 0;

        for (let k = 0; k < lineA.words.length; k++) {
          const wordA = lineA.words[k];

          // TODO: Despite the comment, this code does not actually return early.
          //    Consider how to best handle this situation--if we just add a "continue" statement
          //    some of the stats may not add up.
          // If option is set to ignore punctuation and the current "word" conly contains punctuation,
          // exit early with options that will result in the word being printed in green.
          if (ignorePunct && !wordA.text.replace(/[\W_]/g, '')) {
            wordA.compTruth = true;
            wordA.matchTruth = true;
            if (mode === 'comb') wordA.conf = 100;
            hocrACorrect[wordA.id] = 1;
          }

          const wordBoxA = wordA.bbox;

          // Remove 10% from top/bottom of bounding box
          // This prevents small overlapping (around the edges) from triggering a comparison.
          // Nothing should be removed from left/right, as this would prevent legitimate one-to-many
          // relationships from being identified.

          const wordBoxAHeight = wordBoxA.bottom - wordBoxA.top;

          const wordBoxACore = JSON.parse(JSON.stringify(wordBoxA));

          if (wordA.visualCoords) {
            wordBoxACore.top = wordBoxA.top + Math.round(wordBoxAHeight * 0.1);
            wordBoxACore.bottom = wordBoxA.bottom - Math.round(wordBoxAHeight * 0.1);
          } else {
            wordBoxACore.top = wordBoxA.top + Math.round(wordBoxAHeight * 0.25);
            wordBoxACore.bottom = wordBoxA.bottom - Math.round(wordBoxAHeight * 0.25);
          }

          for (let l = minWordB; l < lineB.words.length; l++) {
            const wordB = lineB.words[l];
            const wordBoxB = wordB.bbox;

            // Remove 10% from top/bottom of bounding box
            // This prevents small overlapping (around the edges) from triggering a comparison.
            // Nothing should be removed from left/right, as this would prevent legitimate one-to-many
            // relationships from being identified.
            const wordBoxBHeight = wordBoxB.bottom - wordBoxB.top;

            const wordBoxBCore = JSON.parse(JSON.stringify(wordBoxB));

            if (wordB.visualCoords) {
              wordBoxBCore.top = wordBoxB.top + Math.round(wordBoxBHeight * 0.1);
              wordBoxBCore.bottom = wordBoxB.bottom - Math.round(wordBoxBHeight * 0.1);
            } else {
              wordBoxBCore.top = wordBoxB.top + Math.round(wordBoxBHeight * 0.25);
              wordBoxBCore.bottom = wordBoxB.bottom - Math.round(wordBoxBHeight * 0.25);
            }

            // If left of word A is past right of word B, move to next word B
            if (wordBoxACore.left > wordBoxBCore.right) {
              minWordB += 1;
              continue;

              // If left of word B is past right of word A, move to next word B
            } else if (wordBoxBCore.left > wordBoxACore.right) {
              continue;

              // Otherwise, overlap is likely
            } else {
              // Check for overlap using word height
              if (wordBoxACore.top > wordBoxBCore.bottom || wordBoxBCore.top > wordBoxACore.bottom) {
                continue;
              }

              // Mark `wordA` as having been compared
              wordA.compTruth = true;

              let wordTextA = ocr.replaceLigatures(wordA.text);
              let wordTextB = ocr.replaceLigatures(wordB.text);
              if (ignorePunct) {
                // Punctuation next to numbers is not ignored, even if this setting is enabled, as punctuation differences are
                // often/usually substantive in this context (e.g. "-$1,000" vs $1,000" or "$100" vs. "$1.00")
                wordTextA = wordTextA.replace(/(^|\D)[\W_]($|\D)/g, '$1$2');
                wordTextB = wordTextB.replace(/(^|\D)[\W_]($|\D)/g, '$1$2');
              }
              if (ignoreCap) {
                wordTextA = wordTextA.toLowerCase();
                wordTextB = wordTextB.toLowerCase();
              }

              hocrAOverlap[wordA.id] = 1;
              hocrBOverlap[wordB.id] = 1;

              if (!hocrBOverlapAWords[wordB.id]) hocrBOverlapAWords[wordB.id] = {};
              hocrBOverlapAWords[wordB.id][wordA.id] = 1;

              // TODO: Account for cases without 1-to-1 mapping between bounding boxes
              if (wordTextA === wordTextB) {
                wordA.compTruth = true;
                wordA.matchTruth = true;
                if (mode === 'comb') wordA.conf = 100;
                hocrACorrect[wordA.id] = 1;
                hocrBCorrect[wordB.id] = 1;
                if (mode === 'comb' && useBboxB) {
                  wordA.bbox = structuredClone(wordB.bbox);
                  wordA.visualCoords = true;
                  wordA.chars = structuredClone(wordB.chars);
                }
              } else if (mode === 'comb') {
                wordA.conf = 0;
                wordA.matchTruth = false;

                // Check if there is a 1-to-1 comparison between words (this is usually true)
                let oneToOne = Math.abs(wordBoxB.left - wordBoxA.left) + Math.abs(wordBoxB.right - wordBoxA.right) < (wordBoxA.right - wordBoxA.left) * 0.1;

                // Note: The following block solves an issue that I believe has been patched in our version of Tesseract.
                // Due to a bug with the LSTM engine, when a word is split into 3 words (for example), the first and last word can have the right bound.
                // This condition should catch cases where `oneToOne` is `true`, however the appropriate comparison is actually 2-to-1 or 3-to-1.
                const wordBNext = lineB.words[l + 1];
                const wordBNext2 = lineB.words[l + 2];
                const wordBNext3 = lineB.words[l + 3];
                if (oneToOne && legacyLSTMComb) {
                  if (wordBNext3 && wordBNext3.text.length > 2) {
                    const wordBoxBNext3 = wordBNext3.bbox;
                    if (Math.abs(wordBoxB.left - wordBoxA.left) + Math.abs(wordBoxA.right - wordBoxBNext3.right) < (wordBoxBNext3.right - wordBoxA.left) * 0.1) oneToOne = false;
                  }

                  if (wordBNext2 && wordBNext2.text.length > 2) {
                    const wordBoxBNext2 = wordBNext2.bbox;
                    if (Math.abs(wordBoxB.left - wordBoxA.left) + Math.abs(wordBoxA.right - wordBoxBNext2.right) < (wordBoxBNext2.right - wordBoxA.left) * 0.1) oneToOne = false;
                  }

                  if (wordBNext && wordBNext.text.length > 2) {
                    const wordBoxBNext = wordBNext.bbox;
                    if (Math.abs(wordBoxB.left - wordBoxA.left) + Math.abs(wordBoxA.right - wordBoxBNext.right) < (wordBoxBNext.right - wordBoxA.left) * 0.1) oneToOne = false;
                  }
                }

                let twoToOne = false;
                const wordsAArr = [];
                let wordsBArr = [];

                // If there is no 1-to-1 comparison, check if a 2-to-1 comparison is possible using the next word in either dataset
                if (!oneToOne) {
                  if (wordBoxA.right < wordBoxB.right) {
                    const wordANext = lineA.words[k + 1];
                    if (wordANext) {
                      const wordBoxANext = wordANext.bbox;
                      if (Math.abs(wordBoxB.left - wordBoxA.left) + Math.abs(wordBoxB.right - wordBoxANext.right) < (wordBoxANext.right - wordBoxA.left) * 0.1) {
                        twoToOne = true;
                        wordsAArr.push(wordA);
                        wordsAArr.push(wordANext);
                        wordsBArr.push(wordB);

                        wordANext.conf = 0;
                        wordANext.compTruth = true;
                        wordANext.matchTruth = false;
                      }
                    }
                  } else {
                    if (wordBNext3) {
                      const wordBoxBNext3 = wordBNext3.bbox;
                      if (Math.abs(wordBoxB.left - wordBoxA.left) + Math.abs(wordBoxA.right - wordBoxBNext3.right) < (wordBoxBNext3.right - wordBoxA.left) * 0.1) {
                        twoToOne = true;
                        wordsAArr.push(wordA);
                        wordsBArr.push(wordB);
                        wordsBArr.push(wordBNext);
                        wordsBArr.push(wordBNext2);
                        wordsBArr.push(wordBNext3);
                      }
                    }

                    if (wordBNext2 && !twoToOne) {
                      const wordBoxBNext2 = wordBNext2.bbox;
                      if (Math.abs(wordBoxB.left - wordBoxA.left) + Math.abs(wordBoxA.right - wordBoxBNext2.right) < (wordBoxBNext2.right - wordBoxA.left) * 0.1) {
                        twoToOne = true;
                        wordsAArr.push(wordA);
                        wordsBArr.push(wordB);
                        wordsBArr.push(wordBNext);
                        wordsBArr.push(wordBNext2);
                      }
                    }

                    if (wordBNext && !twoToOne) {
                      const wordBoxBNext = wordBNext.bbox;
                      if (Math.abs(wordBoxB.left - wordBoxA.left) + Math.abs(wordBoxA.right - wordBoxBNext.right) < (wordBoxBNext.right - wordBoxA.left) * 0.1) {
                        twoToOne = true;
                        wordsAArr.push(wordA);
                        wordsBArr.push(wordB);
                        wordsBArr.push(wordBNext);
                      }
                    }

                    // If comparing one word from Tesseract Legacy with multiple words from Tesseract LSTM, and the letters are mostly the same,
                    // use the bounding boxes from Tesseract Legacy.  These should be more accurate.
                    if (twoToOne && legacyLSTMComb) {
                      const wordsAText = wordsAArr.map((x) => x.text).join('');
                      const wordsBText = wordsBArr.map((x) => x.text).join('');
                      if (wordsAArr.length === 1 && wordsAArr[0]?.chars?.length === wordsAText.length && wordsAText.length === wordsBText.length) {
                        // To make sure the legacy boxes are comparable, either:
                        // (1) the text must be the same between Legacy and LSTM (aside from one word being split/combined), or
                        // (2) the LSTM version must have 2 words, one word matches, and the total number of letters is the same.
                        const match = wordsAText === wordsBText;
                        const match1 = wordsAArr[0].text.substring(0, wordsBArr[0].text.length) === wordsBArr[0].text;
                        const match2 = wordsAArr[0].text.substring(wordsBArr[0].text.length, wordsBArr[0].text.length + wordsBArr[1].text.length) === wordsBArr[1].text;

                        if (match || (wordsBArr.length === 2 && (match1 || match2))) {
                          wordsBArr = wordsBArr.map((x) => ocr.cloneWord(x));
                          wordsBArr[0].chars = wordsAArr[0].chars.slice(0, wordsBArr[0].text.length).map((x) => ocr.cloneChar(x));
                          wordsBArr[1].chars = wordsAArr[0].chars.slice(wordsBArr[0].text.length, wordsBArr[0].text.length + wordsBArr[1].text.length).map((x) => ocr.cloneChar(x));
                          if (wordsBArr[2]) {
                            wordsBArr[2].chars = wordsAArr[0].chars.slice(wordsBArr[0].text.length + wordsBArr[1].text.length,
                              wordsBArr[0].text.length + wordsBArr[1].text.length + wordsBArr[2].text.length).map((x) => ocr.cloneChar(x));
                          }
                          if (wordsBArr[3]) {
                            wordsBArr[3].chars = wordsAArr[0].chars.slice(wordsBArr[0].text.length + wordsBArr[1].text.length + wordsBArr[2].text.length,
                              wordsBArr[0].text.length + wordsBArr[1].text.length + wordsBArr[2].text.length + wordsBArr[3].text.length).map((x) => ocr.cloneChar(x));
                          }
                          if (!match) {
                            wordsBArr[0].chars.forEach((x, i) => x.text = wordsBArr[0].text[i]);
                            wordsBArr[1].chars.forEach((x, i) => x.text = wordsBArr[1].text[i]);
                            if (wordsBArr[2]) wordsBArr[2].chars.forEach((x, i) => x.text = wordsBArr[2].text[i]);
                          }
                          for (const word of wordsBArr) {
                            // @ts-ignore
                            word.bbox = ocr.calcBboxUnion(word.chars.map((x) => x.bbox));
                          }
                        }
                      }
                    }
                  }
                }

                // Only consider switching word contents if their bounding boxes are close together
                // This should filter off cases where 2+ words in one dataset match to 1 word in another
                // TODO: Account for cases without 1-to-1 mapping between bounding boxes
                if (!oneToOne && !twoToOne) {
                  continue;
                }

                let hocrAError = 1;
                let hocrBError = 1;
                let hocrAAltError = 1;

                if (!evalConflicts) {
                  hocrBError = 0;
                } else if (oneToOne) {
                  // Some common patterns detected by Tesseract Legacy are so implausible that they are automatically rejected.
                  if (legacyLSTMComb && rejectWordLegacy(wordA.text, wordB.text)) {
                    hocrBError = 0;
                  // If the top choice out of the Tesseract Legacy classifier (but not entire model) is the same as the Tesseract LSTM choice, use the LSTM choice.
                  // This condition is common when the Legacy model improperly applies a dictionary "correction" to a word that was already correct.
                  } else if (legacyLSTMComb && wordA.textAlt && wordA.textAlt === wordB.text) {
                    hocrBError = 0;
                  // Otherwise, the words are compared visually.
                  } else {
                    // TODO: Figure out how to compare between small caps/non small-caps words (this is the only relevant style as it is the only style LSTM detects)
                    // Clone hocrAWord and set text content equal to hocrBWord
                    const wordAClone = ocr.cloneWord(wordA);
                    wordAClone.text = wordB.text;

                    if (wordB.smallCaps && !wordA.smallCaps) {
                      wordAClone.smallCaps = true;
                      wordAClone.size = calcWordFontSize(wordB);
                    }

                    const evalRes = await evalWords({
                      wordsA: [wordA], wordsB: [wordAClone], binaryImage: binaryImageBit, angle: imgAngle, options: { view: Boolean(debugLabel) },
                    });

                    hocrAError = evalRes.metricA + (await penalizeWord([wordA]));
                    hocrBError = evalRes.metricB + (await penalizeWord([wordB]));

                    // Reject Tesseract Legacy word if appropriate
                    if (legacyLSTMComb && rejectWordLegacy(wordA.text, wordB.text)) hocrBError = 0;

                    // The alternative word from Tesseract legacy is tested if both other options are rejected.
                    // This can be useful for relatively high-quality scans of non-dictionary words, which both the LSTM model and the Legacy model (after dictionary correction) may fail on,
                    // with the raw results from the Legacy classifier being the most accurate.
                    if (legacyLSTMComb && hocrAError > 0.5 && hocrBError > 0.5 && wordA.textAlt && wordA.textAlt !== wordB.text) {
                      wordAClone.text = wordA.textAlt;

                      // This would run faster if it was built into the original evalWords function, but this case should be rare enough that it doesn't matter.
                      const evalResAlt = await evalWords({
                        wordsA: [wordAClone], binaryImage: binaryImageBit, angle: imgAngle, options: { view: Boolean(debugLabel) },
                      });

                      hocrAAltError = evalResAlt.metricA + (await penalizeWord([wordAClone]));

                      // To use the alt word, the error must be less than 0.5, and the alt word but be at least 0.1 better than both other options.
                      if (hocrAAltError >= 0.5 || (hocrAError - hocrAAltError) < 0.1 || (hocrBError - hocrAAltError) < 0.1) hocrAAltError = 1;
                    }

                    if (evalRes.debug) {
                      const debugObj = evalRes.debug;
                      debugObj.errorAdjA = hocrAError;
                      debugObj.errorAdjB = hocrBError;

                      debugImg.push(debugObj);
                    }
                  }
                } else if (twoToOne) {
                  const wordsAText = wordsAArr.map((x) => x.text).join('');
                  const wordsBText = wordsBArr.map((x) => x.text).join('');

                  if (legacyLSTMComb && rejectWordLegacy(wordsAText, wordsBText)) {
                    hocrBError = 0;
                  } else {
                    const evalRes = await evalWords({
                      wordsA: wordsAArr, wordsB: wordsBArr, binaryImage: binaryImageBit, angle: imgAngle, options: { view: Boolean(debugLabel) },
                    });

                    // The option with more words has a small penalty added, as otherwise words incorrectly split will often score slightly better (due to more precise positioning)
                    hocrAError = evalRes.metricA + (wordsAArr.length - 1) * 0.025 + (await penalizeWord(wordsAArr));
                    hocrBError = evalRes.metricB + (wordsBArr.length - 1) * 0.025 + (await penalizeWord(wordsBArr));

                    // An additional penalty is added to the option with more words when (1) the text is the same in both options and (2) at least one word has no letters.
                    // This has 2 primary motivations:
                    //  1. Tesseract Legacy often splits numbers into separate words.
                    //    For example, the "-" in a negative number may be a different word, or the digits before and after the decimal point may be split into separate words.
                    //    TODO: It may be worth investigating if this issue can be improved in the engine.
                    //  1. Punctuation characters should not be their own word (e.g. quotes should come before/after alphanumeric characters)
                    if (wordsAText === wordsBText) {
                      if (wordsAArr.map((x) => /[a-z]/i.test(x.text)).filter((x) => !x).length > 0 || wordsBArr.map((x) => /[a-z]/i.test(x.text)).filter((x) => !x).length > 0) {
                        hocrAError += (wordsAArr.length - 1) * 0.05;
                        hocrBError += (wordsBArr.length - 1) * 0.05;
                      }
                    }

                    // Reject Tesseract Legacy word if appropriate
                    if (legacyLSTMComb && rejectWordLegacy(wordsAText, wordsBText)) hocrBError = 0;

                    if (evalRes.debug) {
                      const debugObj = evalRes.debug;
                      debugObj.errorAdjA = hocrAError;
                      debugObj.errorAdjB = hocrBError;

                      debugImg.push(debugObj);
                    }
                  }
                }

                // The LSTM model is known to be more accurate on average.
                // Therefore, if both metrics are terrible (indicating the word isn't lined up at all), the LSTM word is used.
                if ((hocrBError < hocrAError && hocrBError < hocrAAltError) || (legacyLSTMComb && hocrAError > 0.5 && hocrAAltError > 0.5)) {
                  const skip = ['eg', 'ie'].includes(wordA.text.replace(/\W/g, ''));

                  if (!skip) {
                    if (oneToOne) {
                      lineWordsEditedNew += 1;
                      lineBReplace = lineB;

                      wordA.text = wordB.text;

                      // Erase character-level data rather than replacing it, as the LSTM data is not expected to be accurate.
                      // There should eventually be an option to disable this when Tesseract Combined is the "B" data and user-provided data is the "A".
                      wordA.chars = null;

                      // Switch to small caps/non-small caps based on style of replacement word.
                      // This is not relevant for italics as the LSTM engine does not detect italics.
                      if (wordB.smallCaps) wordA.smallCaps = true;
                    } else {
                      const wordsBArrRep = wordsBArr.map((x) => ocr.cloneWord(x));

                      lineWordsEditedNew += wordsBArrRep.length;
                      lineBReplace = lineB;

                      wordsBArrRep.forEach((x) => {
                        // Use style from word A (assumed to be Tesseract Legacy)
                        if (legacyLSTMComb) {
                          x.font = wordA.font;
                          x.style = wordA.style;
                          x.smallCaps = wordA.smallCaps;
                        }

                        // Set confidence to 0
                        x.conf = 0;

                        // Erase character-level data rather than replacing it, as the LSTM data is not expected to be accurate.
                        // There should eventually be an option to disable this when Tesseract Combined is the "B" data and user-provided data is the "A".
                        x.chars = null;

                        x.compTruth = true;
                        x.matchTruth = false;

                        x.line = lineA;

                        // Change ID to prevent duplicates
                        x.id += 'b';
                      });

                      // Replace "A" words with "B" words
                      lineA.words.splice(k, wordsAArr.length, ...wordsBArrRep);

                      k = k + wordsBArrRep.length - 1;

                      // Move to next hocrAWord
                      break;
                    }
                  }
                } else if (wordA.textAlt && hocrAAltError < 0.5 && hocrAAltError < hocrAError) {
                  lineWordsEditedNew += 1;
                  if (wordA.text.length !== wordA.textAlt.length) wordA.chars = null;
                  wordA.text = wordA.textAlt;
                }
              }
            }
          }
        }
      }
    }

    // If a majority of words in line A are replaced, replace the ascender height and x-height with those from line B.
    if (lineBReplace && lineWordsEditedNew > lineA.words.length * 0.5) {
      lineA.ascHeight = lineBReplace.ascHeight;
      lineA.xHeight = lineBReplace.xHeight;
    }
  }

  // If `supplementComp` is enabled, we run OCR for any words in pageA without an existing comparison in pageB.
  // This ensures that every word has been checked.
  // Unlike the comparisons above, this is strictly for confidence purposes--if conflicts are identified the text is not edited.
  if (supplementComp && tessWorker && evalConflicts) {
    for (let i = 0; i < pageAInt.lines.length; i++) {
      const line = pageAInt.lines[i];
      for (let j = 0; j < line.words.length; j++) {
        const word = line.words[j];
        if (!word.compTruth) {
          const res = await checkWords([word], binaryImageBit, imageRotated, pageMetricsObj, tessWorker, {
            ignorePunct, tessWorker, view: false,
          });
          word.matchTruth = res.match;
          word.conf = word.matchTruth ? 100 : 0;
        }
      }
    }
  }

  // In addition to not making sense, the statistics below will not be properly calculated when `mode == "comb"` and errors will be thrown if attempted.
  // The core issue is that pageAInt is being actively edited `mode == "comb"`.
  // Therefore, `hocrAOverlap` ends up including words not in `pageA`, so `ocr.getPageWord(pageA, overlappingWordsA[i]);` returns `null`.
  if (mode === 'comb') {
    if (imageUpscaled) ocr.scalePage(pageAInt, 0.5);

    return {
      page: pageAInt, metrics: null, debugImg,
    };
  }

  // Note: These metrics leave open the door for some fringe edge cases.
  // For example,

  const hocrBAll = {};
  ocr.getPageWords(pageB).forEach((x) => {
    hocrBAll[x.id] = 1;
  });

  const hocrAAll = {};
  ocr.getPageWords(pageAInt).forEach((x) => {
    hocrAAll[x.id] = 1;
  });

  // Delete any punctuation-only words from the stats if they are being ignored.
  if (ignorePunct) {
    const punctOnlyIDsA = ocr.getPageWords(pageA).filter((x) => !x.text.replace(/[\W_]/g, '')).map((x) => x.id);
    punctOnlyIDsA.forEach((x) => {
      delete hocrAAll[x];
      delete hocrAOverlap[x];
      delete hocrACorrect[x];
    });
    const punctOnlyIDsB = ocr.getPageWords(pageB).filter((x) => !x.text.replace(/[\W_]/g, '')).map((x) => x.id);
    punctOnlyIDsB.forEach((x) => {
      delete hocrBAll[x];
      delete hocrBOverlap[x];
      delete hocrBCorrect[x];
    });
  }

  // Number of words in ground truth
  const totalCountB = Object.keys(hocrBAll).length;

  // Number of words in candidate OCR
  const totalCountA = Object.keys(hocrAAll).length;

  // Number of words in ground truth with any overlap with candidate OCR
  const overlapCountB = Object.keys(hocrBOverlap).length;

  // Number of words in candidate OCR with any overlap with ground truth
  const overlapCountA = Object.keys(hocrAOverlap).length;

  // Number of words in ground truth correctly identified by 1+ overlapping word in candidate OCR
  const correctCount = Object.keys(hocrBCorrect).length;

  // Number of words in ground truth not identified by 1+ overlapping word in candidate OCR
  const incorrectCount = overlapCountB - correctCount;

  let correctCountLowConf = 0;
  let incorrectCountHighConf = 0;
  const overlappingWordsB = Object.keys(hocrBOverlap);
  for (let i = 0; i < overlappingWordsB.length; i++) {
    const wordBID = overlappingWordsB[i];

    const wordAIDs = Object.keys(hocrBOverlapAWords[wordBID]);

    let lowConfCount = 0;
    let highConfCount = 0;
    for (let j = 0; j < wordAIDs.length; j++) {
      // The word comes from the original input (pageA) since we need unedited confidence metrics.
      const word = ocr.getPageWord(pageA, wordAIDs[j]);
      if (word.conf <= confThreshMed) {
        lowConfCount++;
      } else if (word.conf > confThreshHigh) {
        highConfCount++;
      }
    }

    const match = hocrBCorrect[wordBID];

    if (match && lowConfCount > 0) {
      correctCountLowConf++;
    } else if (!match && highConfCount > 0) {
      incorrectCountHighConf++;
    }
  }

  /** @type {EvalMetrics} */
  const metricsRet = {
    total: totalCountB,
    correct: correctCount,
    incorrect: incorrectCount,
    missed: totalCountB - overlapCountB,
    extra: totalCountA - overlapCountA,
    correctLowConf: correctCountLowConf,
    incorrectHighConf: incorrectCountHighConf,
  };

  // Confidence scores are only edited if an option is set.
  // This is because confidence scores should not be edited when comparing to ground truth.
  if (editConf) {
    ocr.getPageWords(pageAInt).forEach((x) => {
      x.conf = x.matchTruth ? 100 : 0;
    });
  }

  if (imageUpscaled) ocr.scalePage(pageAInt, 0.5);

  return {
    page: pageAInt, metrics: metricsRet, debugImg,
  };
}

/**
 * @param {Array<OcrWord>} wordsA
 * @param {ImageBitmap} binaryImage
 * @param {boolean} imageRotated - Whether provided `binaryImage` has been rotated.
 * @param {PageMetrics} pageMetricsObj
 * @param {object} [options]
 * @param {boolean} [options.view] - TODO: make this functional or remove
 * @param {boolean} [options.ignorePunct]
 * @param {boolean} [options.ignoreCap]
 */
export async function checkWords(wordsA, binaryImage, imageRotated, pageMetricsObj, tessWorker, options = {}) {
  const view = options?.view === undefined ? false : options?.view;
  const ignorePunct = options?.ignorePunct === undefined ? false : options?.ignorePunct;
  const ignoreCap = options?.ignoreCap === undefined ? false : options?.ignoreCap;

  // Draw the actual words (from the user-provided image)
  const angle = imageRotated ? (pageMetricsObj.angle || 0) : 0;
  // const ctxViewArr = view ? [{ canvas: viewCanvas0, ctx: viewCtx0 }, { canvas: viewCanvas1, ctx: viewCtx1 }, { canvas: viewCanvas2, ctx: viewCtx2 }] : undefined;
  const { canvas } = await drawWordActual(wordsA, binaryImage, angle);

  const extraConfig = {
    tessedit_pageseg_mode: '6', // "Single block"
  };

  const inputImage = typeof process === 'undefined' ? await canvas.convertToBlob() : await canvas.toDataURL();

  const res = (await tessWorker.recognize(inputImage, extraConfig)).data;

  let wordTextA = wordsA.map((x) => x.text).join(' ');
  let wordTextB = res.text.trim();

  wordTextA = ocr.replaceLigatures(wordTextA);
  wordTextB = ocr.replaceLigatures(wordTextB);

  if (ignorePunct) {
    // Punctuation next to numbers is not ignored, even if this setting is enabled, as punctuation differences are
    // often/usually substantive in this context (e.g. "-$1,000" vs $1,000" or "$100" vs. "$1.00")
    wordTextA = wordTextA.replace(/(^|\D)[\W_]($|\D)/g, '$1$2');
    wordTextB = wordTextB.replace(/(^|\D)[\W_]($|\D)/g, '$1$2');
  }
  if (ignoreCap) {
    wordTextA = wordTextA.toLowerCase();
    wordTextB = wordTextB.toLowerCase();
  }

  return { match: wordTextA === wordTextB };
}

/**
 * @param {Object} params
 * @param {OcrPage|OcrLine} params.page
 * @param {import('../containers/imageContainer.js').ImageWrapper} params.binaryImage
 * @param {PageMetrics} params.pageMetricsObj
 * @param {?function} [params.func=null]
 * @param {boolean} [params.view=false] - Draw results on debugging canvases
 * @returns
 */
export async function evalPageBase({
  page, binaryImage, pageMetricsObj, func = null, view = false,
}) {
  // If this is not being run in a worker, clone the data so the original is not edited.
  // This is not necessary when running in a worker, as the data is already cloned when sent to the worker.
  if (typeof WorkerGlobalScope === 'undefined') {
    page = structuredClone(page);
  }

  const lines = 'lines' in page ? page.lines : [page];

  const imgAngle = binaryImage.rotated ? (pageMetricsObj.angle || 0) : 0;
  if (binaryImage.upscaled) {
    for (let i = 0; i < lines.length; i++) {
      ocr.scaleLine(lines[i], 2);
    }
  }

  const binaryImageBit = binaryImage.imageBitmap || await ca.getImageBitmap(binaryImage.src);

  if (!FontCont.raw) throw new Error('Fonts must be defined before running this function.');

  let metricTotal = 0;
  let wordsTotal = 0;
  const debugArr = [];

  for (let j = 0; j < lines.length; j++) {
    let ocrLineJ = lines[j];

    // The Chinese font is currently not loaded in the workers, so trying to evaluate it will cause an error.
    if (ocrLineJ.words[0].lang === 'chi_sim') continue;

    if (func) {
      ocrLineJ = await func(lines[j]);
    }

    if (!ocrLineJ) continue;

    const evalRes = await evalWords({
      wordsA: ocrLineJ.words, binaryImage: binaryImageBit, angle: imgAngle, options: { view },
    });

    metricTotal += (evalRes.metricA * ocrLineJ.words.length);

    wordsTotal += ocrLineJ.words.length;

    if (evalRes.debug) debugArr.push(evalRes.debug);
  }

  return { wordsTotal, metricTotal, debug: debugArr };
}

/**
 * @param {Object} params
 * @param {OcrPage} params.page
 * @param {import('../containers/imageContainer.js').ImageWrapper} params.binaryImage
 * @param {PageMetrics} params.pageMetricsObj
 * @param {string} params.font
 * @param {boolean} [params.opt=false] - Whether to use the optimized font set
 * @returns
 */
export async function evalPageFont({
  page, binaryImage, pageMetricsObj, font, opt = false,
}) {
  const enableOptSave = FontCont.enableOpt;
  const forceOptSave = FontCont.forceOpt;

  // Allowing the font to be set here allows for better performance during font optimization compared to using the `enableFontOpt` function.
  // This is because the `enableFontOpt` function requires a response from the main thread and *every* worker before completing, which leads to non-trivial waiting time.
  if (opt === true) {
    if (!FontCont.opt) throw new Error('Optimized fonts requested but not defined.');
    FontCont.forceOpt = true;
  } else if (opt === false) {
    if (!FontCont.raw) throw new Error('Raw fonts requested but not defined.');
    FontCont.enableOpt = false;
    FontCont.forceOpt = false;
  }

  /**
   * @param {OcrLine} ocrLineJ
   */
  const transformLineFont = (ocrLineJ) => {
    if (!FontCont.raw) throw new Error('Fonts must be defined before running this function.');

    if (!ocrLineJ.words[0]) {
      console.log('Line has 0 words, this should not happen.');
      return ocr.cloneLine(ocrLineJ);
    }

    // If the font is not set for a specific word, whether it is assumed sans/serif will be determined by the default font.
    const lineFontType = ocrLineJ.words[0].font ? FontCont.getWordFont(ocrLineJ.words[0]).type : FontCont.getFont('Default').type;

    if (FontCont.raw[font].normal.type !== lineFontType) return null;

    const ocrLineJClone = ocr.cloneLine(ocrLineJ);

    ocrLineJClone.words.forEach((x) => {
      x.font = font;
    });

    return ocrLineJClone;
  };

  const res = await evalPageBase({
    page, binaryImage, pageMetricsObj, func: transformLineFont,
  });

  FontCont.enableOpt = enableOptSave;
  FontCont.forceOpt = forceOptSave;

  return res;
}

/**
 * @param {Object} params
 * @param {OcrPage} params.page
 * @param {import('../containers/imageContainer.js').ImageWrapper} params.binaryImage
 * @param {PageMetrics} params.pageMetricsObj
 * @param {function} params.func
 * @param {boolean} params.view
 * @returns
 */
export async function nudgePageBase({
  page, binaryImage, pageMetricsObj, func, view = false,
}) {
  // If this is not being run in a worker, clone the data so the original is not edited.
  // This is not necessary when running in a worker, as the data is already cloned when sent to the worker.
  if (typeof WorkerGlobalScope === 'undefined') {
    page = structuredClone(page);
  }

  const imgAngle = binaryImage.rotated ? (pageMetricsObj.angle || 0) : 0;
  if (binaryImage.upscaled) {
    ocr.scalePage(page, 2);
  }

  const binaryImageBit = binaryImage.imageBitmap || await ca.getImageBitmap(binaryImage.src);

  if (!FontCont.raw) throw new Error('Fonts must be defined before running this function.');
  if (!calcCtx) throw new Error('Canvases must be defined before running this function.');

  let improveCt = 0;
  let totalCt = 0;

  const debugImg = [];

  for (const ocrLineJ of page.lines) {
    const tryNudge = async (x) => {
      const ocrLineJClone = ocr.cloneLine(ocrLineJ);
      await func(ocrLineJClone, x);

      if (!ocrLineJClone) return false;

      const evalRes = await evalWords({
        wordsA: ocrLineJ.words, wordsB: ocrLineJClone.words, binaryImage: binaryImageBit, angle: imgAngle, options: { view, useAFontSize: false, useABaseline: false },
      });

      if (evalRes.debug) debugImg.push(evalRes.debug);

      if (evalRes.metricB < evalRes.metricA) {
        return true;
      }
      return false;
    };

    const res1 = await tryNudge(1);
    if (res1) {
      await func(ocrLineJ, 1);
      improveCt += 1;
    } else {
      const res2 = await tryNudge(-1);
      if (res2) {
        await func(ocrLineJ, -1);
        improveCt += 1;
      }
    }

    totalCt += 1;
  }

  return {
    page, improveCt, totalCt, debug: view ? debugImg : null,
  };
}

/**
 * @param {Object} params
 * @param {OcrPage} params.page
 * @param {import('../containers/imageContainer.js').ImageWrapper} params.binaryImage
 * @param {PageMetrics} params.pageMetricsObj
 * @param {boolean} params.view
 * @returns
 */
export async function nudgePageFontSize({
  page, binaryImage, pageMetricsObj, view = false,
}) {
  const func = async (lineJ, x) => {
    const fontSizeBase = calcLineFontSize(lineJ);
    if (!fontSizeBase) return;
    lineJ._size = fontSizeBase + x;
  };

  return await nudgePageBase({
    page, binaryImage, pageMetricsObj, func, view,
  });
}

/**
 * @param {Object} params
 * @param {OcrPage} params.page
 * @param {import('../containers/imageContainer.js').ImageWrapper} params.binaryImage
 * @param {PageMetrics} params.pageMetricsObj
 * @param {boolean} params.view
 * @returns
 */
export async function nudgePageBaseline({
  page, binaryImage, pageMetricsObj, view = false,
}) {
  const func = async (lineJ, x) => {
    lineJ.baseline[1] += x;
  };

  return await nudgePageBase({
    page, binaryImage, pageMetricsObj, func, view,
  });
}

/**
 * Render a page to a canvas.
 * This function is a WIP and not all options are implemented.
 * @param {Object} args
 * @param {OcrPage} args.page - Page to render.
 * @param {import('../containers/imageContainer.js').ImageWrapper} args.image
 * @param {dims} [args.pageDims] - Dimensions of page.
 * @param {?number} [args.angle=0] - Angle of page.
 * @param {("proof" | "invis" | "ebook" | "eval")} [args.displayMode='proof'] - Display mode.
 * @param {number} [args.confThreshMed=75] - Threshold above which words are medium-confidence (0-100).
 * @param {number} [args.confThreshHigh=85] - Threshold above which words are high-confidence (0-100).
 * @returns {Promise<Blob>}
 *
 * TODO: This function does not belong here, however it is in this file because this is where the canvases live.
 * Think about how to refactor--the canvases within workers probably belong in their own container.
 *
 */
export const renderPageStaticImp = async ({
  page, image, angle = 0, displayMode = 'proof', confThreshMed = 75, confThreshHigh = 85,
}) => {
  const dims = image ? imageUtils.getDims(image) : page.dims;

  const canvas = await ca.createCanvas(dims.width, dims.height);
  const ctx = /** @type {OffscreenCanvasRenderingContext2D} */ (/** @type {unknown} */ (canvas.getContext('2d')));

  const imageBit = await ca.getImageBitmap(image.src);
  if (image) ctx.drawImage(imageBit, 0, 0);

  angle = angle ?? 0;

  ctx.textBaseline = 'alphabetic';

  const sinAngle = Math.sin(angle * (Math.PI / 180));
  const cosAngle = Math.cos(angle * (Math.PI / 180));

  for (const lineObj of page.lines) {
    const angleAdjLine = image.rotated ? ocr.calcLineStartAngleAdj(lineObj) : { x: 0, y: 0 };

    const baselineY = lineObj.bbox.bottom + lineObj.baseline[1] + angleAdjLine.y;
    const lineLeftAdj = lineObj.bbox.left + angleAdjLine.x;

    const rotateText = !image?.rotated;

    if (rotateText) {
      ctx.setTransform(cosAngle, sinAngle, -sinAngle, cosAngle, lineLeftAdj, baselineY);
    } else {
      ctx.setTransform(1, 0, 0, 1, lineLeftAdj, baselineY);
    }

    for (const wordObj of lineObj.words) {
      if (!wordObj.text) continue;

      const { fill, opacity } = ocr.getWordFillOpacity(wordObj, displayMode, confThreshMed, confThreshHigh);

      ctx.fillStyle = fill;

      const angleAdjWord = wordObj.sup ? ocr.calcWordAngleAdj(wordObj) : { x: 0, y: 0 };

      const wordMetrics = calcWordMetrics(wordObj);
      const advanceArr = wordMetrics.advanceArr;
      const kerningArr = wordMetrics.kerningArr;
      const charSpacing = wordMetrics.charSpacing;
      const wordFontSize = wordMetrics.fontSize;
      const leftSideBearing = wordMetrics.leftSideBearing;

      // TODO: Test whether the math here is correct for drop caps.
      let ts = 0;
      if (wordObj.sup || wordObj.dropcap) {
        ts = (lineObj.bbox.bottom + lineObj.baseline[1] + angleAdjLine.y) - (wordObj.bbox.bottom + angleAdjLine.y + angleAdjWord.y);
        if (!wordObj.visualCoords) {
          const font = FontCont.getWordFont(wordObj);
          const fontDesc = font.opentype.descender / font.opentype.unitsPerEm * wordMetrics.fontSize;
          ts -= fontDesc;
        }
      } else {
        ts = 0;
      }

      const width = (wordObj.bbox.left - wordObj.line.bbox.left) / cosAngle;

      const visualLeft = width + angleAdjWord.x;

      const advanceArrTotal = [];
      for (let i = 0; i < advanceArr.length; i++) {
        let leftI = 0;
        leftI += advanceArr[i] || 0;
        leftI += kerningArr[i] || 0;
        leftI += charSpacing || 0;
        advanceArrTotal.push(leftI);
      }

      const font = FontCont.getWordFont(wordObj);
      ctx.font = `${font.fontFaceStyle} ${font.fontFaceWeight} ${wordFontSize}px ${font.fontFaceName}`;
      let leftI = wordObj.visualCoords ? visualLeft - leftSideBearing : visualLeft;
      for (let i = 0; i < wordMetrics.charArr.length; i++) {
        let charI = wordMetrics.charArr[i];

        if (wordObj.smallCaps) {
          if (charI === charI.toUpperCase()) {
            ctx.font = `${font.fontFaceStyle} ${font.fontFaceWeight} ${wordFontSize}px ${font.fontFaceName}`;
          } else {
            charI = charI.toUpperCase();
            ctx.font = `${font.fontFaceStyle} ${font.fontFaceWeight} ${wordFontSize * font.smallCapsMult}px ${font.fontFaceName}`;
          }
        }

        ctx.fillText(charI, leftI, -ts);
        leftI += advanceArrTotal[i];
      }
    }
  }

  const img = typeof process === 'undefined' ? await canvas.convertToBlob() : await canvas.toDataURL();

  return img;
};
