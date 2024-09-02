// Disable linter rule.  Many async functions in this files draw on the canvas (a side effect) so need to be run one at a time.
/* eslint-disable no-await-in-loop */

import ocr from '../objects/ocrObjects.js';
import { calcLineFontSize, calcWordFontSize, calcWordMetrics } from '../utils/fontUtils.js';
import { getImageBitmap } from '../utils/imageUtils.js';
import { drawWordActual, drawWordRender } from './renderWordCanvas.js';

import { FontCont } from '../containers/fontContainer.js';
import { imageUtils } from '../objects/imageObjects.js';
import { getRandomAlphanum } from '../utils/miscUtils.js';
// import { CompDebug } from '../objects/imageObjects.js';

/** @type {OffscreenCanvasRenderingContext2D} */
let calcCtx;
/** @type {OffscreenCanvasRenderingContext2D} */
let viewCtx0;
/** @type {OffscreenCanvasRenderingContext2D} */
let viewCtx1;
/** @type {OffscreenCanvasRenderingContext2D} */
let viewCtx2;

// Browser case
if (typeof process === 'undefined') {
  // For whatever reason, this can fail silently in some browsers that do not support OffscreenCanvas, where the worker simply stops running.
  // Therefore, an explicit error message is added here to make the issue evident. Features will still fail, so this is not a fix.
  try {
    const canvasAlt = new OffscreenCanvas(200, 200);
    calcCtx = /** @type {OffscreenCanvasRenderingContext2D} */ (canvasAlt.getContext('2d'));

    const canvasComp0 = new OffscreenCanvas(200, 200);
    viewCtx0 = /** @type {OffscreenCanvasRenderingContext2D} */ (canvasComp0.getContext('2d'));

    const canvasComp1 = new OffscreenCanvas(200, 200);
    viewCtx1 = /** @type {OffscreenCanvasRenderingContext2D} */ (canvasComp1.getContext('2d'));

    const canvasComp2 = new OffscreenCanvas(200, 200);
    viewCtx2 = /** @type {OffscreenCanvasRenderingContext2D} */ (canvasComp2.getContext('2d'));
  } catch (error) {
    console.log('Failed to create OffscreenCanvas. This browser likely does not support OffscreenCanvas.');
    console.error(error);
  }
}

let tmpUniqueDir = null;
export const tmpUnique = {
  get: async () => {
    if (typeof process === 'undefined') {
      throw new Error('This function is not intended for browser use.');
    } else {
      const { tmpdir } = await import('os');
      const { mkdirSync } = await import('fs');

      if (!tmpUniqueDir) {
        tmpUniqueDir = `${tmpdir()}/${getRandomAlphanum(8)}`;
        mkdirSync(tmpUniqueDir);
      // console.log(`Created directory: ${tmpUniqueDir}`);
      }
      return tmpUniqueDir;
    }
  },
  delete: async () => {
    if (typeof process === 'undefined') {
      throw new Error('This function is not intended for browser use.');
    } else {
    // eslint-disable-next-line no-lonely-if
      if (tmpUniqueDir) {
        const { rmSync } = await import('fs');
        rmSync(tmpUniqueDir, { recursive: true, force: true });
        // console.log(`Deleted directory: ${tmpUniqueDir}`);
        tmpUniqueDir = null;
      }
    }
  },
};

export const initCanvasNode = async () => {
  if (typeof process === 'undefined') {
    throw new Error('This function is not intended for browser use.');
  } else {
    const { createCanvas, registerFont, deregisterAllFonts } = await import('canvas');
    // If canvases have already been defined, existing fonts need to be cleared.
    // This happens when recognizing multiple documents without starting a new process.
    const clearFonts = calcCtx && viewCtx0 && viewCtx1 && viewCtx2;

    if (clearFonts) {
    // Per a Git Issue, the `deregisterAllFonts` function may cause a memory leak.
    // However, this is not an issue that can be solved in this codebase, as it is necessary to deregister old fonts,
    // and leaving them would take up (at least) as much memory.
    // https://github.com/Automattic/node-canvas/issues/1974
      deregisterAllFonts();
    }

    const { isMainThread } = await import('worker_threads');

    // The Node.js canvas package does not currently support worke threads
    // https://github.com/Automattic/node-canvas/issues/1394
    if (!isMainThread) throw new Error('node-canvas is not currently supported on worker threads.');
    if (!FontCont.raw) throw new Error('Fonts must be defined before running this function.');

    const { writeFile } = await import('fs');
    const { promisify } = await import('util');
    const writeFile2 = promisify(writeFile);

    /**
   *
   * @param {FontContainerFont} fontObj
   */
    const registerFontObj = async (fontObj) => {
      if (typeof fontObj.src !== 'string') {
      // Create unique temp directory for this process only.
      // This prevents different processes from overwriting eachother when this is run in parallel.
        const tmpDir = await tmpUnique.get();

        // Optimized and non-optimized fonts should not overwrite each other
        const optStr = fontObj.opt ? '-opt' : '';

        const fontPathTmp = `${tmpDir}/${fontObj.family}-${fontObj.style}${optStr}.otf`;
        await writeFile2(fontPathTmp, Buffer.from(fontObj.src));
        // console.log(`Writing font to: ${fontPathTmp}`);

        registerFont(fontPathTmp, { family: fontObj.fontFaceName, style: fontObj.fontFaceStyle, weight: fontObj.fontFaceWeight });

      // unlinkSync(fontPathTmp);
      } else {
        registerFont(fontObj.src, { family: fontObj.fontFaceName, style: fontObj.fontFaceStyle, weight: fontObj.fontFaceWeight });
      }
    };

    // All fonts must be registered before the canvas is created, so all raw and optimized fonts are loaded.
    // Even when using optimized fonts, at least one raw font is needed to compare against optimized version.
    for (const [key1, value1] of Object.entries(FontCont.raw)) {
      if (['Default', 'SansDefault', 'SerifDefault'].includes(key1)) continue;
      for (const [key2, value2] of Object.entries(value1)) {
        await registerFontObj(value2);
      }
    }

    // This function is used before font optimization is complete, so `fontAll.opt` does not exist yet.
    if (FontCont.opt) {
      for (const [key1, value1] of Object.entries(FontCont.opt)) {
        if (['Default', 'SansDefault', 'SerifDefault'].includes(key1) || !value1) continue;
        for (const [key2, value2] of Object.entries(value1)) {
          if (!value2) continue;
          await registerFontObj(value2);
        }
      }
    }

    // This causes type errors in VSCode, as we are assigning an value of type `import('canvas').CanvasRenderingContext2D` to an object of type `OffscreenCanvasRenderingContext2D`.
    // Leaving for now, as switching the type of `calcCtx`, `viewCtx0`, etc. to allow for either causes more errors than it solves.
    // The core issue is that multiple object types (the canvas and image inputs) change *together* based on environment (Node.js vs. browser),
    // and it is unclear how to tell the type interpreter "when `calcCtx` is `import('canvas').CanvasRenderingContext2D` then the image input is always `import('canvas').Image".
    const canvasAlt = createCanvas(200, 200);
    calcCtx = /** @type {OffscreenCanvasRenderingContext2D} */ (/** @type {unknown} */ (canvasAlt.getContext('2d')));

    const canvasComp0 = createCanvas(200, 200);
    viewCtx0 = /** @type {OffscreenCanvasRenderingContext2D} */ (/** @type {unknown} */ (canvasComp0.getContext('2d')));

    const canvasComp1 = createCanvas(200, 200);
    viewCtx1 = /** @type {OffscreenCanvasRenderingContext2D} */ (/** @type {unknown} */ (canvasComp1.getContext('2d')));

    const canvasComp2 = createCanvas(200, 200);
    viewCtx2 = /** @type {OffscreenCanvasRenderingContext2D} */ (/** @type {unknown} */ (canvasComp2.getContext('2d')));
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
 * @param {dims} params.imgDims
 * @param {Object} [params.options]
 * @param {boolean} [params.options.view] - Draw results on debugging canvases
 * @param {boolean} [params.options.useAFontSize] - Use font size from `wordsA` when printing `wordsB`
 *   This is useful when the metrics from `wordsA` are considered systematically more reliable,
 *   such as when `wordsA` are from Tesseract Legacy and `wordsB` are from Tesseract LSTM.
 * @param {boolean} [params.options.useABaseline]
 */
export async function evalWords({
  wordsA, wordsB = [], binaryImage, angle, imgDims, options = {},
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

  const binaryImageBit = await getImageBitmap(binaryImage);

  if (!FontCont.raw) throw new Error('Fonts must be defined before running this function.');
  if (!calcCtx) throw new Error('Canvases must be defined before running this function.');

  const view = options?.view === undefined ? false : options?.view;
  const useABaseline = options?.useABaseline === undefined ? true : options?.useABaseline;

  const cosAngle = Math.cos(angle * -1 * (Math.PI / 180)) || 1;

  // All words are assumed to be on the same line
  const linebox = wordsA[0].line.bbox;
  const baselineA = wordsA[0].line.baseline;

  calcCtx.clearRect(0, 0, calcCtx.canvas.width, calcCtx.canvas.height);

  if (view) {
    viewCtx0.clearRect(0, 0, viewCtx0.canvas.width, viewCtx0.canvas.height);
    viewCtx1.clearRect(0, 0, viewCtx1.canvas.width, viewCtx1.canvas.height);
    viewCtx2.clearRect(0, 0, viewCtx2.canvas.width, viewCtx2.canvas.height);
  }

  // Draw the actual words (from the user-provided image)
  const ctxViewArr = view ? [viewCtx0, viewCtx1, viewCtx2] : undefined;
  const cropY = await drawWordActual(calcCtx, [...wordsA, ...wordsB], binaryImageBit, imgDims, angle, ctxViewArr);

  const imageDataActual = calcCtx.getImageData(0, 0, calcCtx.canvas.width, calcCtx.canvas.height).data;

  calcCtx.clearRect(0, 0, calcCtx.canvas.width, calcCtx.canvas.height);
  calcCtx.fillStyle = 'white';
  calcCtx.fillRect(0, 0, calcCtx.canvas.width, calcCtx.canvas.height);

  let ctxView = view ? viewCtx1 : null;

  // Draw the words in wordsA
  let x0 = wordsA[0].bbox.left;
  const y0 = linebox.bottom + baselineA[1] + baselineA[0] * (wordsA[0].bbox.left - linebox.left);
  for (let i = 0; i < wordsA.length; i++) {
    const word = wordsA[i];
    const wordIBox = word.bbox;

    const offsetX = (wordIBox.left - x0) / cosAngle;

    await drawWordRender(calcCtx, word, offsetX, cropY, ctxView, Boolean(angle));
  }

  const imageDataExpectedA = calcCtx.getImageData(0, 0, calcCtx.canvas.width, calcCtx.canvas.height).data;

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
    const baselineB = useABaseline ? baselineA : wordsB[0].line.baseline;

    calcCtx.clearRect(0, 0, calcCtx.canvas.width, calcCtx.canvas.height);
    calcCtx.fillStyle = 'white';
    calcCtx.fillRect(0, 0, calcCtx.canvas.width, calcCtx.canvas.height);

    ctxView = view ? viewCtx2 : null;

    // Draw the words in wordsB
    for (let i = 0; i < wordsB.length; i++) {
      // Clone object so editing does not impact the original
      const word = ocr.cloneWord(wordsB[i]);

      // Set style to whatever it is for wordsA.  This is based on the assumption that "A" is Tesseract Legacy and "B" is Tesseract LSTM (which does not have useful style info).
      word.style = wordsA[0].style;

      if (i === 0) {
        x0 = word.bbox.left;
      }
      const offsetX = (word.bbox.left - x0) / cosAngle;

      await drawWordRender(calcCtx, word, offsetX, cropY, ctxView, Boolean(angle));
    }

    const imageDataExpectedB = calcCtx.getImageData(0, 0, calcCtx.canvas.width, calcCtx.canvas.height).data;

    calcCtx.clearRect(0, 0, calcCtx.canvas.width, calcCtx.canvas.height);

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
      const imageRaw = await viewCtx0.canvas.convertToBlob();
      const imageA = await viewCtx1.canvas.convertToBlob();
      const imageB = await viewCtx2.canvas.convertToBlob();
      const dims = { width: viewCtx0.canvas.width, height: viewCtx0.canvas.height };

      debugImg = {
        context: 'browser', imageRaw, imageA, imageB, dims, errorRawA: metricA, errorRawB: metricB, errorAdjA: null, errorAdjB: null,
      };
    } else {
      const { loadImage } = await import('canvas');

      const imageRaw = await loadImage(viewCtx0.canvas.toBuffer('image/png'));
      const imageA = await loadImage(viewCtx1.canvas.toBuffer('image/png'));
      const imageB = await loadImage(viewCtx2.canvas.toBuffer('image/png'));

      const dims = { width: viewCtx0.canvas.width, height: viewCtx0.canvas.height };

      debugImg = {
        context: 'node', imageRaw, imageA, imageB, dims, errorRawA: metricA, errorRawB: metricB, errorAdjA: null, errorAdjB: null,
      };
    }
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
 * @param {string} [params.options.debugLabel]
 * @param {boolean} [params.options.evalConflicts] - Whether to evaluate word quality on conflicts. If `false` the text from `pageB` is always assumed correct.
 *    This option is useful for combining the style from Tesseract Legacy with the text from Tesseract LSTM.
 * @param {boolean} [params.options.supplementComp] - Whether to run additional recognition jobs for words in `pageA` not in `pageB`
 * @param {Tesseract.Scheduler} [params.options.tessScheduler] - Tesseract scheduler to use for recognizing text. `tessScheduler` or `tessWorker` must be provided if `supplementComp` is `true`.
 * @param {Tesseract.Worker} [params.options.tessWorker] - Tesseract scheduler to use for recognizing text. `tessScheduler` or `tessWorker` must be provided if `supplementComp` is `true`.
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
    binaryImageBit = binaryImage.imageBitmap || await getImageBitmap(binaryImage.src);
    imageUpscaled = binaryImage.upscaled;
    imageRotated = binaryImage.rotated;
  }

  const mode = options?.mode === undefined ? 'stats' : options?.mode;
  const editConf = options?.editConf === undefined ? false : options?.editConf;
  const legacyLSTMComb = options?.legacyLSTMComb === undefined ? false : options?.legacyLSTMComb;
  const debugLabel = options?.debugLabel === undefined ? '' : options?.debugLabel;
  const evalConflicts = options?.evalConflicts === undefined ? true : options?.evalConflicts;
  const supplementComp = options?.supplementComp === undefined ? false : options?.supplementComp;
  const tessScheduler = options?.tessScheduler === undefined ? null : options?.tessScheduler;
  const tessWorker = options?.tessWorker === undefined ? null : options?.tessWorker;
  const ignorePunct = options?.ignorePunct === undefined ? false : options?.ignorePunct;
  const ignoreCap = options?.ignoreCap === undefined ? false : options?.ignoreCap;
  const confThreshHigh = options?.confThreshHigh === undefined ? 85 : options?.confThreshHigh;
  const confThreshMed = options?.confThreshMed === undefined ? 75 : options?.confThreshMed;

  if (supplementComp && !(tessScheduler || tessWorker)) console.log('`supplementComp` enabled, but no scheduler was provided. This step will be skipped.');

  // If this is not being run in a worker, clone the data so the original is not edited.
  // This is not necessary when running in a worker, as the data is already cloned when sent to the worker.
  if (typeof WorkerGlobalScope === 'undefined') {
    pageA = structuredClone(pageA);
    pageB = structuredClone(pageB);
  }

  const imgAngle = imageRotated ? (pageMetricsObj.angle || 0) : 0;
  const imgDims = structuredClone(pageMetricsObj.dims);
  if (imageUpscaled) {
    ocr.scalePage(pageA, 2);
    ocr.scalePage(pageB, 2);
    imgDims.width *= 2;
    imgDims.height *= 2;
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

          wordBoxACore.top = wordBoxA.top + Math.round(wordBoxAHeight * 0.1);
          wordBoxACore.bottom = wordBoxA.bottom - Math.round(wordBoxAHeight * 0.1);

          for (let l = minWordB; l < lineB.words.length; l++) {
            const wordB = lineB.words[l];
            const wordBoxB = wordB.bbox;

            // Remove 10% from top/bottom of bounding box
            // This prevents small overlapping (around the edges) from triggering a comparison.
            // Nothing should be removed from left/right, as this would prevent legitimate one-to-many
            // relationships from being identified.
            const wordBoxBHeight = wordBoxB.bottom - wordBoxB.top;

            const wordBoxBCore = JSON.parse(JSON.stringify(wordBoxB));

            wordBoxBCore.top = wordBoxB.top + Math.round(wordBoxBHeight * 0.1);
            wordBoxBCore.bottom = wordBoxB.bottom - Math.round(wordBoxBHeight * 0.1);

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
              } else if (mode === 'comb') {
                wordA.conf = 0;
                wordA.matchTruth = false;

                // Check if there is a 1-to-1 comparison between words (this is usually true)
                const oneToOne = Math.abs(wordBoxB.left - wordBoxA.left) + Math.abs(wordBoxB.right - wordBoxA.right) < (wordBoxA.right - wordBoxA.left) * 0.1;

                let twoToOne = false;
                const wordsAArr = [];
                const wordsBArr = [];

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
                    const wordBNext = lineB.words[l + 1];
                    if (wordBNext) {
                      const wordBoxBNext = wordBNext.bbox;
                      if (Math.abs(wordBoxB.left - wordBoxA.left) + Math.abs(wordBoxA.right - wordBoxBNext.right) < (wordBoxBNext.right - wordBoxA.left) * 0.1) {
                        twoToOne = true;
                        wordsAArr.push(wordA);
                        wordsBArr.push(wordB);
                        wordsBArr.push(wordBNext);
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

                let hocrAError = 0;
                let hocrBError = 0;

                if (!evalConflicts) {
                  hocrAError = 1;
                } else if (oneToOne) {
                  // Some common patterns detected by Tesseract Legacy are so implausible that they are automatically rejected.
                  if (legacyLSTMComb && rejectWordLegacy(wordA.text, wordB.text)) {
                    hocrAError = 1;
                  // If the top choice out of the Tesseract Legacy classifier (but not entire model) is the same as the Tesseract LSTM choice, use the LSTM choice.
                  // This condition is common when the Legacy model improperly applies a dictionary "correction" to a word that was already correct.
                  } else if (legacyLSTMComb && wordA.textAlt && wordA.textAlt === wordB.text) {
                    hocrAError = 1;
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
                      wordsA: [wordA], wordsB: [wordAClone], binaryImage: binaryImageBit, angle: imgAngle, imgDims, options: { view: Boolean(debugLabel) },
                    });

                    hocrAError = evalRes.metricA + (await penalizeWord([wordA]));
                    hocrBError = evalRes.metricB + (await penalizeWord([wordB]));

                    // Reject Tesseract Legacy word if appropriate
                    if (legacyLSTMComb && rejectWordLegacy(wordA.text, wordB.text)) hocrAError = 1;

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
                    hocrAError = 1;
                  } else {
                    const evalRes = await evalWords({
                      wordsA: wordsAArr, wordsB: wordsBArr, binaryImage: binaryImageBit, angle: imgAngle, imgDims, options: { view: Boolean(debugLabel) },
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
                    if (legacyLSTMComb && rejectWordLegacy(wordsAText, wordsBText)) hocrAError = 1;

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
                if (hocrBError < hocrAError || (legacyLSTMComb && hocrAError > 0.7)) {
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
                        x.style = wordA.style;
                        x.smallCaps = wordA.smallCaps;

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
  if (supplementComp && (tessScheduler || tessWorker) && evalConflicts) {
    for (let i = 0; i < pageAInt.lines.length; i++) {
      const line = pageAInt.lines[i];
      for (let j = 0; j < line.words.length; j++) {
        const word = line.words[j];
        if (!word.compTruth) {
          const res = await checkWords([word], binaryImageBit, imageRotated, pageMetricsObj, {
            ignorePunct, tessScheduler, tessWorker, view: false,
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

  // Number of words in ground truth
  const totalCountB = ocr.getPageWords(pageB).length;

  // Number of words in candidate OCR
  const totalCountA = ocr.getPageWords(pageAInt).length;

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
 * @param {Tesseract.Scheduler} [options.tessScheduler]
 * @param {Tesseract.Worker} [options.tessWorker]
 */
export async function checkWords(wordsA, binaryImage, imageRotated, pageMetricsObj, options = {}) {
  const view = options?.view === undefined ? false : options?.view;
  const ignorePunct = options?.ignorePunct === undefined ? false : options?.ignorePunct;
  const ignoreCap = options?.ignoreCap === undefined ? false : options?.ignoreCap;

  // Draw the actual words (from the user-provided image)
  const angle = imageRotated ? (pageMetricsObj.angle || 0) : 0;
  const ctxViewArr = view ? [viewCtx0, viewCtx1, viewCtx2] : undefined;
  await drawWordActual(calcCtx, wordsA, binaryImage, pageMetricsObj.dims, angle, ctxViewArr);

  const extraConfig = {
    tessedit_pageseg_mode: '6', // "Single block"
  };

  const inputImage = typeof process === 'undefined' ? await calcCtx.canvas.convertToBlob() : await calcCtx.canvas.toBuffer('image/png');

  let res;
  if (options.tessScheduler) {
    res = (await options.tessScheduler.addJob('recognize', inputImage, extraConfig)).data;
  } else if (options.tessWorker) {
    res = await options.tessWorker.recognize(inputImage, extraConfig);
  } else {
    throw new Error('`tessScheduler` and `tessWorker` missing. One must be provided for words to be checked.');
  }

  let wordTextA = wordsA.map((x) => x.text).join(' ');
  let wordTextB = res.data.text.trim();

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

  const imgDims = structuredClone(pageMetricsObj.dims);
  const imgAngle = binaryImage.rotated ? (pageMetricsObj.angle || 0) : 0;
  if (binaryImage.upscaled) {
    for (let i = 0; i < lines.length; i++) {
      ocr.scaleLine(lines[i], 2);
    }
    imgDims.width *= 2;
    imgDims.height *= 2;
  }

  const binaryImageBit = binaryImage.imageBitmap || await getImageBitmap(binaryImage.src);

  if (!FontCont.raw) throw new Error('Fonts must be defined before running this function.');
  if (!calcCtx) throw new Error('Canvases must be defined before running this function.');

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
      wordsA: ocrLineJ.words, binaryImage: binaryImageBit, angle: imgAngle, imgDims, options: { view },
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
 * @param {ImageBitmap} params.binaryImage
 * @param {boolean} params.imageRotated - Whether provided `binaryImage` has been rotated.
 * @param {boolean} params.imageUpscaled - Whether provided `binaryImage` has been upscaled.
 * @param {PageMetrics} params.pageMetricsObj
 * @param {function} params.func
 * @param {boolean} params.view
 * @returns
 */
export async function nudgePageBase({
  page, binaryImage, imageRotated, imageUpscaled, pageMetricsObj, func, view = false,
}) {
  // If this is not being run in a worker, clone the data so the original is not edited.
  // This is not necessary when running in a worker, as the data is already cloned when sent to the worker.
  if (typeof WorkerGlobalScope === 'undefined') {
    page = structuredClone(page);
  }

  const imgDims = structuredClone(pageMetricsObj.dims);
  const imgAngle = imageRotated ? (pageMetricsObj.angle || 0) : 0;
  if (imageUpscaled) {
    ocr.scalePage(page, 2);
    imgDims.width *= 2;
    imgDims.height *= 2;
  }

  const binaryImageBit = await getImageBitmap(binaryImage);

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
        wordsA: ocrLineJ.words, wordsB: ocrLineJClone.words, binaryImage: binaryImageBit, angle: imgAngle, imgDims, options: { view, useAFontSize: false, useABaseline: false },
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
 * @param {ImageBitmap} params.binaryImage
 * @param {boolean} params.imageRotated - Whether provided `binaryImage` has been rotated.
 * @param {boolean} params.imageUpscaled - Whether provided `binaryImage` has been upscaled.
 * @param {PageMetrics} params.pageMetricsObj
 * @param {boolean} params.view
 * @returns
 */
export async function nudgePageFontSize({
  page, binaryImage, imageRotated, imageUpscaled, pageMetricsObj, view = false,
}) {
  const func = async (lineJ, x) => {
    const fontSizeBase = calcLineFontSize(lineJ);
    if (!fontSizeBase) return;
    lineJ._size = fontSizeBase + x;
  };

  return await nudgePageBase({
    page, binaryImage, imageRotated, imageUpscaled, pageMetricsObj, func, view,
  });
}

/**
 * @param {Object} params
 * @param {OcrPage} params.page
 * @param {ImageBitmap} params.binaryImage
 * @param {boolean} params.imageRotated - Whether provided `binaryImage` has been rotated.
 * @param {boolean} params.imageUpscaled - Whether provided `binaryImage` has been upscaled.
 * @param {PageMetrics} params.pageMetricsObj
 * @param {boolean} params.view
 * @returns
 */
export async function nudgePageBaseline({
  page, binaryImage, imageRotated, imageUpscaled, pageMetricsObj, view = false,
}) {
  const func = async (lineJ, x) => {
    lineJ.baseline[1] += x;
  };

  return await nudgePageBase({
    page, binaryImage, imageRotated, imageUpscaled, pageMetricsObj, func, view,
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
  viewCtx0.save();

  if (image) {
    const dims = imageUtils.getDims(image);
    viewCtx0.canvas.height = dims.height;
    viewCtx0.canvas.width = dims.width;

    const imageBit = await getImageBitmap(image.src);

    viewCtx0.drawImage(imageBit, 0, 0);
  } else {
    viewCtx0.canvas.height = page.dims.height;
    viewCtx0.canvas.width = page.dims.width;
  }

  angle = angle ?? 0;

  viewCtx0.textBaseline = 'alphabetic';

  const sinAngle = Math.sin(angle * (Math.PI / 180));
  const cosAngle = Math.cos(angle * (Math.PI / 180));

  for (const lineObj of page.lines) {
    const angleAdjLine = image.rotated ? ocr.calcLineStartAngleAdj(lineObj) : { x: 0, y: 0 };

    const baselineY = lineObj.bbox.bottom + lineObj.baseline[1] + angleAdjLine.y;
    const lineLeftAdj = lineObj.bbox.left + angleAdjLine.x;

    const rotateText = !image?.rotated;

    if (rotateText) {
      viewCtx0.setTransform(cosAngle, sinAngle, -sinAngle, cosAngle, lineLeftAdj, baselineY);
    } else {
      viewCtx0.setTransform(1, 0, 0, 1, lineLeftAdj, baselineY);
    }

    for (const wordObj of lineObj.words) {
      if (!wordObj.text) continue;

      const { fill, opacity } = ocr.getWordFillOpacity(wordObj, displayMode, confThreshMed, confThreshHigh);

      viewCtx0.fillStyle = fill;

      const angleAdjWord = wordObj.sup ? ocr.calcWordAngleAdj(wordObj) : { x: 0, y: 0 };

      // TODO: Test whether the math here is correct for drop caps.
      let ts = 0;
      if (wordObj.sup) {
        ts = (lineObj.bbox.bottom + lineObj.baseline[1] + angleAdjLine.y) - (wordObj.bbox.bottom + angleAdjLine.y + angleAdjWord.y);
      } else if (wordObj.dropcap) {
        ts = (lineObj.bbox.bottom + lineObj.baseline[1]) - wordObj.bbox.bottom + angleAdjLine.y + angleAdjWord.y;
      } else {
        ts = 0;
      }

      const width = (wordObj.bbox.left - wordObj.line.bbox.left) / cosAngle;

      const visualLeft = width + angleAdjWord.x;

      const wordMetrics = calcWordMetrics(wordObj);
      const advanceArr = wordMetrics.advanceArr;
      const kerningArr = wordMetrics.kerningArr;
      const charSpacing = wordMetrics.charSpacing;
      const wordFontSize = wordMetrics.fontSize;
      const leftSideBearing = wordMetrics.leftSideBearing;

      const advanceArrTotal = [];
      for (let i = 0; i < advanceArr.length; i++) {
        let leftI = 0;
        leftI += advanceArr[i] || 0;
        leftI += kerningArr[i] || 0;
        leftI += charSpacing || 0;
        advanceArrTotal.push(leftI);
      }

      const font = FontCont.getWordFont(wordObj);
      viewCtx0.font = `${font.fontFaceStyle} ${font.fontFaceWeight} ${wordFontSize}px ${font.fontFaceName}`;
      let leftI = wordObj.visualCoords ? visualLeft - leftSideBearing : visualLeft;
      for (let i = 0; i < wordMetrics.charArr.length; i++) {
        let charI = wordMetrics.charArr[i];

        if (wordObj.smallCaps) {
          if (charI === charI.toUpperCase()) {
            viewCtx0.font = `${font.fontFaceStyle} ${font.fontFaceWeight} ${wordFontSize}px ${font.fontFaceName}`;
          } else {
            charI = charI.toUpperCase();
            viewCtx0.font = `${font.fontFaceStyle} ${font.fontFaceWeight} ${wordFontSize * font.smallCapsMult}px ${font.fontFaceName}`;
          }
        }

        viewCtx0.fillText(charI, leftI, -ts);
        leftI += advanceArrTotal[i];
      }
    }
  }

  const img = typeof process === 'undefined' ? await viewCtx0.canvas.convertToBlob() : await viewCtx0.canvas.toBuffer('image/png');

  viewCtx0.restore();
  return img;
};
