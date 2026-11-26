import { opt } from './containers/app.js';
import { PageStore, holdJson } from './containers/pageStore.js';
import { scribeDocDefaults } from './containers/scribeDocDefaults.js';
import { loadBuiltInFontsRaw, loadChiSimFont } from './fontContainerMain.js';
import { calcCharMetricsLayer } from './fontStatistics.js';
import { gs } from './generalWorkerMain.js';
import { ImageWrapper } from './objects/imageObjects.js';
import { LayoutDataTablePage, LayoutPage, addCircularRefsDataTables } from './objects/layoutObjects.js';
import ocr, { addCircularRefsOcr, OcrPage } from './objects/ocrObjects.js';
import { PageMetrics } from './objects/pageMetricsObjects.js';
import { selectOcrPages } from './pdf/ocrPageSelection.js';
import { base64ToBytes } from './utils/imageUtils.js';
import { clearObjectProperties } from './utils/miscUtils.js';

/** @typedef {import('./containers/scribeDoc.js').ScribeDoc} ScribeDoc */

// Data-derived thresholds for the post-OCR keep/discard gate (ocrAddsNewText, below).
const OCR_NEW_CONF_MIN = 85; // min word confidence (0-100) to count an OCR word as legitimate
const OCR_NEW_LINE_WORDS = 3; // new word-like words in one OCR line => a coherent new-text line
const OCR_NEW_LINES_MIN = 2; // coherent new-text lines that keep the OCR
const OCR_NEW_NUMS_MIN = 10; // new multi-digit numbers that keep the OCR (a baked data table)
const OCR_NEW_CHARS_MIN = 100; // new word-like characters that keep the OCR

/**
 * Decide whether a page's pure OCR adds legitimate text its native layer lacks (the keep/discard gate).
 * An OCR word counts as "new" when its normalized token is not a substring of the native token stream.
 * The check is substring membership, not equality, because native and OCR segment words differently.
 * @param {OcrPage|null|undefined} nativePage - The native (PDF) text layer.
 *   A null layer (a scan or broken-encoding page) makes all OCR new, so the OCR is kept.
 * @param {OcrPage} ocrPage - The page's pure OCR result.
 * @returns {boolean} True to keep the OCR, false to discard it in favor of the native text.
 */
export function ocrAddsNewText(nativePage, ocrPage) {
  if (!nativePage) return true;
  const normTok = (/** @type {string} */ text) => ocr.replaceLigatures(text)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]/g, '');
  const nativeStream = nativePage.lines.flatMap((l) => l.words).map((w) => normTok(w.text)).filter(Boolean).join(' ');
  let newChars = 0;
  let newNums = 0;
  let newTextLines = 0;
  for (const line of ocrPage.lines) {
    let lineNewWords = 0;
    for (const word of line.words) {
      const tok = normTok(word.text);
      if (tok.length < 2 || word.conf < OCR_NEW_CONF_MIN || nativeStream.includes(tok)) continue;
      if (/^[a-z]{3,}$/.test(tok) && /[aeiouy]/.test(tok)) {
        newChars += tok.length;
        lineNewWords += 1;
      } else if (/^[0-9]{2,}$/.test(tok)) {
        newNums += 1;
      }
    }
    if (lineNewWords >= OCR_NEW_LINE_WORDS) newTextLines += 1;
  }
  return newTextLines >= OCR_NEW_LINES_MIN || newNums >= OCR_NEW_NUMS_MIN || newChars >= OCR_NEW_CHARS_MIN;
}

/**
 * Build the 'Combined' text layer for a partial OCR selection and make it active.
 * Clears `doc.inputData.ocrApplied` in place for pages that use native text.
 * @param {ScribeDoc} doc
 * @param {string} source - Layer name of the OCR output (`'Combined'` or a custom model layer).
 * @param {boolean[]} ocrPageMask
 * @param {boolean} gateApplies
 * @param {boolean} fullOcr
 * @param {?string} native - Layer name for native PDF text, if any.
 * @param {?string} userOcr - Layer name for user-uploaded OCR, if any.
 */
function buildCombinedLayer(doc, source, ocrPageMask, gateApplies, fullOcr, native, userOcr) {
  if (fullOcr || userOcr || !ocrPageMask.some(Boolean)) return;
  const store = doc.pageStore;
  for (let i = 0; i < doc.inputData.pageCount; i++) {
    const hasNative = !!native && store.hasPage(i, native);
    const hasOcr = store.hasPage(i, source);
    let fromOcr = !hasNative && hasOcr;
    if (ocrPageMask[i] && hasOcr) {
      fromOcr = !(gateApplies && hasNative) || store.held(() => ocrAddsNewText(
        store.readOnlyPage(i, /** @type {string} */ (native)), /** @type {OcrPage} */ (store.readOnlyPage(i, source)),
      ));
    }
    if (!fromOcr && hasNative) doc.inputData.ocrApplied[i] = false;
    if (!hasNative && !hasOcr) {
      store.setPage(i, new OcrPage(i, doc.pageMetrics[i].dims), 'Combined');
    } else if (!(fromOcr && source === 'Combined')) {
      store.sharePage(i, fromOcr ? source : /** @type {string} */ (native), 'Combined');
    }
  }
  store.active = 'Combined';
}

/**
 * Display warning/error message to user if missing character-level data.
 *
 * @param {ScribeDoc} doc
 * @param {Array<Object.<string, string>>} warnArr - Array of objects containing warning/error messages from convertPage
 */
export function checkCharWarn(doc, warnArr) {
  // TODO: Figure out what happens if there is one blank page with no identified characters (as that would presumably trigger an error and/or warning on the page level).
  // Make sure the program still works in that case for both Tesseract and Abbyy.

  const charErrorCt = warnArr.filter((x) => x?.char === 'char_error').length;
  const charWarnCt = warnArr.filter((x) => x?.char === 'char_warning').length;
  const charGoodCt = warnArr.length - charErrorCt - charWarnCt;

  // The UI warning/error messages cannot be thrown within this function,
  // as that would make this file break when imported into contexts that do not have the main UI.
  if (charGoodCt === 0 && charErrorCt > 0) {
    if (typeof process === 'undefined') {
      const errorHTML = `No character-level OCR data detected. Abbyy XML is only supported with character-level data.
        <a href="https://docs.scribeocr.com/faq.html#is-character-level-ocr-data-required--why" target="_blank" class="alert-link">Learn more.</a>`;
      doc.errorHandler({ message: errorHTML });
    } else {
      const errorText = `No character-level OCR data detected. Abbyy XML is only supported with character-level data.
        See: https://docs.scribeocr.com/faq.html#is-character-level-ocr-data-required--why`;
      doc.errorHandler({ message: errorText });
    }
  } if (charGoodCt === 0 && charWarnCt > 0 && typeof process === 'undefined') {
    const warningHTML = `No character-level OCR data detected. Font optimization features will be disabled.
      <a href="https://docs.scribeocr.com/faq.html#is-character-level-ocr-data-required--why" target="_blank" class="alert-link">Learn more.</a>`;
    doc.warningHandler({ message: warningHTML });
  }
}

/**
 * Sum up evaluation statistics for all pages.
 * @param {Array<EvalMetrics>} evalStatsArr
 */
export const calcEvalStatsDoc = (evalStatsArr) => {
  const evalStatsDoc = {
    total: 0,
    correct: 0,
    incorrect: 0,
    missed: 0,
    extra: 0,
    correctLowConf: 0,
    incorrectHighConf: 0,
  };

  for (let i = 0; i < evalStatsArr.length; i++) {
    evalStatsDoc.total += evalStatsArr[i].total;
    evalStatsDoc.correct += evalStatsArr[i].correct;
    evalStatsDoc.incorrect += evalStatsArr[i].incorrect;
    evalStatsDoc.missed += evalStatsArr[i].missed;
    evalStatsDoc.extra += evalStatsArr[i].extra;
    evalStatsDoc.correctLowConf += evalStatsArr[i].correctLowConf;
    evalStatsDoc.incorrectHighConf += evalStatsArr[i].incorrectHighConf;
  }
  return evalStatsDoc;
};

/**
 * Throw an AbortError if the given signal has fired.
 * Matches the shape of fetch()/streams APIs so callers can `if (e.name === 'AbortError')`.
 * @param {AbortSignal} [signal]
 */
const throwIfAborted = (signal) => {
  if (!signal || !signal.aborted) return;
  const reason = signal.reason instanceof Error ? signal.reason : undefined;
  if (typeof DOMException !== 'undefined') {
    throw new DOMException(reason ? reason.message : 'Recognition aborted', 'AbortError');
  }
  const err = new Error(reason ? reason.message : 'Recognition aborted');
  err.name = 'AbortError';
  throw err;
};

/**
 * setTimeout that resolves early when `signal` fires. Never rejects.
 * @param {number} ms
 * @param {AbortSignal} [signal]
 */
const abortableDelay = (ms, signal) => new Promise((resolve) => {
  if (signal && signal.aborted) { resolve(); return; }
  const onAbort = () => {
    clearTimeout(t);
    if (signal) signal.removeEventListener('abort', onAbort);
    resolve();
  };
  const t = setTimeout(() => {
    if (signal) signal.removeEventListener('abort', onAbort);
    resolve();
  }, ms);
  if (signal) signal.addEventListener('abort', onAbort, { once: true });
});

/**
 * @param {ScribeDoc} doc
 * @param {Object} params
 * @param {OcrPage | OcrLine} params.page
 * @param {?function} [params.func=null]
 * @param {boolean} [params.view=false] - Draw results on debugging canvases
 */
export async function evalOCRPage(doc, params) {
  const n = 'page' in params.page ? params.page.page.n : params.page.n;
  const binaryImage = await doc.images.getBinary(n);
  const pageMetricsObj = doc.pageMetrics[n];
  return gs.evalPageBase({
    page: params.page, binaryImage, pageMetricsObj, func: params.func, view: params.view, docId: doc.id,
  });
}

/**
 * Compare two text layers of a document, page by page.
 * @param {ScribeDoc} doc
 * @param {string} layerA - Name of a text layer, or `'active'`.
 * @param {string} layerB - Name of a text layer, or `'active'`.
 * @param {Parameters<import('./worker/compareOCRModule.js').compareOCRPageImp>[0]['options']} [options]
 * @param {?function} [progressCallback=null]
 * @param {?(i: number, page: OcrPage) => void} [onPage=null] - Receives each compared page as it finishes, leaving the returned `ocr` array empty.
 */
export async function compareOCR(doc, layerA, layerB, options, progressCallback = null, onPage = null) {
  /** @type {Parameters<import('./worker/compareOCRModule.js').compareOCRPageImp>[0]['options']} */
  const compOptions = {
    ignorePunct: scribeDocDefaults.ignorePunct,
    ignoreCap: scribeDocDefaults.ignoreCap,
    confThreshHigh: scribeDocDefaults.confThreshHigh,
    confThreshMed: scribeDocDefaults.confThreshMed,
  };

  Object.assign(compOptions, options || {});

  /** @type {Array<OcrPage>} */
  const ocrArr = [];
  /** @type {Array<Error>} */
  const errors = [];
  /** @type {Array<?EvalMetrics>} */
  const metricsArr = [];
  /** @type {Array<Array<CompDebugBrowser | CompDebugNode>>} */
  const debugImageArr = [];

  const comparePageI = async (i) => {
    const pageA = doc.pageStore.readOnlyPage(i, layerA, true);
    const pageB = doc.pageStore.readOnlyPage(i, layerB, true);
    // A per-page OCR subset leaves skipped pages empty, so skip any page missing from either input.
    if (!pageA || !pageB) {
      if (progressCallback) progressCallback();
      return;
    }
    // Some option combinations need the page image and some do not.
    // Skip it when unneeded for performance, and so accuracy benchmarks can run without an image.
    const mode = compOptions.mode || 'stats';
    const evalConflicts = compOptions.evalConflicts ?? true;
    const supplementComp = compOptions.supplementComp ?? false;
    const skipImage = (mode === 'stats' && !supplementComp) || (mode === 'comb' && !evalConflicts && !supplementComp);
    const binaryImage = skipImage ? null : await doc.images.getBinary(pageA.n);
    const res = await gs.compareOCRPageImp({
      pageA,
      pageB,
      binaryImage,
      pageMetricsObj: doc.pageMetrics[pageA.n],
      options: compOptions,
      docId: doc.id,
    });

    if (onPage) onPage(i, res.page);
    else ocrArr[i] = res.page;

    metricsArr[i] = res.metrics;

    if (res.debugImg) debugImageArr[i] = res.debugImg;
    if (progressCallback) progressCallback();
  };

  await gs.getGeneralScheduler();
  const maxInFlight = gs.schedulerInner.getNumWorkers() + 2;
  /** @type {Set<Promise<void>>} */
  const inFlight = new Set();
  const pageCount = doc.pageStore.slotCount(layerA);
  for (let i = 0; i < pageCount; i++) {
    while (inFlight.size >= maxInFlight) await Promise.race(inFlight);
    const job = comparePageI(i).catch((err) => { errors[i] = err; });
    inFlight.add(job);
    job.then(() => inFlight.delete(job));
  }
  await Promise.all(inFlight);

  return {
    ocr: ocrArr, metrics: metricsArr, debug: debugImageArr, errors,
  };
}

/**
 *  Calculate what arguments to use with Tesseract `recognize` function relating to rotation.
 * @param {ScribeDoc} doc
 * @param {number} n - Page number to recognize.
 * @param {boolean} areaMode
 */
async function calcRecognizeRotateArgs(doc, n, areaMode) {
  // Whether the binary image should be rotated internally by Tesseract
  // This should always be true (Tesseract results are horrible without auto-rotate) but kept as a variable for debugging purposes.
  const rotate = true;

  // Whether the rotated images should be saved, overwriting any non-rotated images.
  const autoRotate = true;

  // Threshold (in radians) under which page angle is considered to be effectively 0.
  const angleThresh = 0.0008726646;

  const angle = doc.pageMetrics[n]?.angle;

  // Whether the page angle is already known (or needs to be detected)
  const angleKnown = typeof (angle) === 'number';

  const nativeN = await doc.images.getNative(n);

  // Calculate additional rotation to apply to page.  Rotation should not be applied if page has already been rotated.
  const rotateDegrees = rotate && angle && Math.abs(angle || 0) > 0.05 && !nativeN.rotated ? angle * -1 : 0;
  const rotateRadians = rotateDegrees * (Math.PI / 180);

  let saveBinaryImageArg = false;

  // The binary image is not saved when using "recognize area" as these intermediate images are cropped.
  if (!areaMode) {
    const binaryN = await doc.images.binary[n];
    if (!binaryN || autoRotate && !binaryN.rotated && (!angleKnown || Math.abs(rotateRadians) > angleThresh)) saveBinaryImageArg = true;
  }

  return {
    angleThresh,
    angleKnown,
    rotateRadians,
    saveBinaryImageArg,
  };
}

/**
 * Lower-level function to run OCR for a single page.
 * Requires additional code to handle the results; for advanced users only.
 * Most users should use `recognize` instead to recognize all pages in a document.
 *
 * @param {ScribeDoc} doc
 * @param {number} n - Page number to recognize.
 * @param {boolean} legacy - Run the Legacy engine. At least one engine must be named.
 * @param {boolean} lstm - Run the LSTM engine.
 * @param {boolean} areaMode -
 * @param {Object<string, string>} tessOptions - Options to pass to Tesseract.js.
 * @param {boolean} [debugVis=false] - Generate instructions for debugging visualizations.
 * @param {?Array<string>} [langs=null] - Languages for this job. When set, the worker ensures its
 *    engine matches before recognizing, so concurrent documents in different languages stay isolated.
 * @param {boolean} [vanillaMode=false] - Use the vanilla Tesseract.js model.
 * @param {?AbortSignal} [signal=null] - The run's cancel signal. A page whose run was canceled while it waited for the pool is not sent to a worker.
 * @returns {Promise<Awaited<ReturnType<typeof import('./worker/generalWorker.js').recognizeAndConvert>>>} The page's result: `recognize` and `convert`.
 *    `convert.page` holds the page.
 */
export async function recognizePageImp(
  doc, n, legacy, lstm, areaMode, tessOptions = {}, debugVis = false, langs = null, vanillaMode = false, signal = null,
) {
  if (!legacy && !lstm) throw new Error('recognizePageImp needs an engine: set legacy or lstm.');
  const {
    angleThresh, angleKnown, rotateRadians, saveBinaryImageArg,
  } = await calcRecognizeRotateArgs(doc, n, areaMode);

  const nativeN = await doc.images.getNative(n);

  if (!nativeN) throw new Error(`No image source found for page ${n}`);

  const config = {
    ...{
      rotateRadians, rotateAuto: !angleKnown, legacy, lstm,
    },
    ...tessOptions,
  };

  const pageDims = doc.pageMetrics[n].dims;

  throwIfAborted(signal);

  const res = await gs.recognizeAndConvert({
    // Materialize `src` in case this is a viewer-rendered bitmap-backed wrapper (no-op otherwise).
    image: nativeN.ensureSrc(),
    options: config,
    // Nothing reads the plain-text output, which the worker produces by default.
    output: {
      blocks: true, text: false, imageBinary: saveBinaryImageArg, debugVis,
    },
    n,
    knownAngle: doc.pageMetrics[n].angle,
    pageDims,
    langs,
    vanillaMode,
    docId: doc.id,
  }, signal);

  const elapsedSec = res.recognitionTime / 1000;
  if (scribeDocDefaults.printRecognitionTime === true || (typeof scribeDocDefaults.printRecognitionTime === 'number' && elapsedSec > scribeDocDefaults.printRecognitionTime)) {
    console.log(`Page ${n} recognition time: ${elapsedSec.toFixed(2)}s`);
  }

  if (!angleKnown) doc.pageMetrics[n].angle = (res.recognize.rotateRadians || 0) * (180 / Math.PI) * -1;

  // An image is rotated if either the source was rotated or rotation was applied by Tesseract.
  const isRotated = Boolean(res.recognize.rotateRadians || 0) || nativeN.rotated;

  // Images from Tesseract should not overwrite the existing images in the case where rotateAuto is true,
  // but no significant rotation was actually detected.
  const significantRotation = Math.abs(res.recognize.rotateRadians || 0) > angleThresh;

  const upscale = res.recognize.upscale || false;
  if (saveBinaryImageArg && res.recognize.imageBinary && (significantRotation || !doc.images.binary[n])) {
    doc.images.binaryProps[n] = { rotated: isRotated, upscaled: upscale, colorMode: 'binary' };
    doc.images.binary[n] = new ImageWrapper(n, res.recognize.imageBinary, 'binary', isRotated, upscale);
  }

  return res;
}

/**
 * Convert from raw OCR data to the internal hocr format used here
 * Currently supports .hocr (used by Tesseract), Abbyy .xml, and stext (an intermediate data format used by mupdf).
 *
 * @param {string} ocrRaw - String containing raw OCR data for single page.
 * @param {number} n - Page number
 * @param {TextSource} format - Format of raw data.
 * @returns {Promise<Awaited<ReturnType<typeof import('./import/convertPageBlocks.js').convertPageBlocks>>>}
 */
async function convertOCRPage(ocrRaw, n, format) {
  await gs.getGeneralScheduler();
  let res;
  if (format === 'hocr') {
    res = await gs.convertPageHocr({ ocrStr: ocrRaw, n });
  } else if (format === 'abbyy') {
    res = await gs.convertPageAbbyy({ ocrStr: ocrRaw, n });
  } else if (format === 'alto') {
    res = await gs.convertPageAlto({ ocrStr: ocrRaw, n });
  } else if (format === 'textract') {
    // res = await gs.convertPageTextract({ ocrStr: ocrRaw, n });
  } else if (format === 'azure_doc_intel') {
    // res = await gs.convertDocAzureDocIntel({ ocrStr: ocrRaw, });
  } else if (format === 'google_doc_ai') {
    // Document-level format, handled in convertOCR
  } else if (format === 'google_vision') {
    res = await gs.convertPageGoogleVision({ ocrStr: ocrRaw, n });
  } else if (format === 'stext') {
    res = await gs.convertPageStext({ ocrStr: ocrRaw, n });
  } else if (format === 'text') {
    res = await gs.convertPageText({ textStr: ocrRaw });
  } else if (format === 'docx' || format === 'md') {
    console.error('format does not support page-level import.');
    // res = await gs.convertDocDocx({ docxData: ocrRaw });
  } else {
    throw new Error(`Invalid format: ${format}`);
  }

  return res;
}

/**
 * Install a parsed `OcrPage` into `doc` at 0-based page index `n`.
 * @param {ScribeDoc} doc
 * @param {number} n
 * @param {OcrPage} page
 * @param {object} options
 * @param {string} [options.layer] - Target text layer name, created if absent.
 * @param {string} [options.engineName] - Alias of `layer`.
 * @param {LayoutDataTablePage} [options.dataTables]
 * @param {Object<string,string>} [options.warn] - Conversion warnings for the page.
 * @param {boolean} [options.mainData=true] - Whether to update `pageMetrics` and `convertPageWarn` and replace existing default `dataTables` at index `n`.
 * @param {boolean} [options.setActive=true] - Whether to make this layer active.
 * @param {?HocrSourcePage} [options.hocrSource] - Source hOCR markup for re-exporting this layer, or `null` to clear it.
 */
export function insertParsedPage(doc, n, page, {
  layer, engineName, dataTables, warn = {}, mainData = true, setActive = true, hocrSource = undefined,
}) {
  const name = /** @type {string} */ (layer ?? engineName);
  addCircularRefsOcr([page]);

  doc.pageStore.add(name, doc.inputData.pageCount);
  doc.pageStore.setSnapshot(n, name, PageStore.snapshotOfPage(page));
  if (setActive) doc.pageStore.active = name;

  if (mainData) {
    doc.convertPageWarn[n] = warn;
    if (page.dims && page.dims.height && page.dims.width) doc.pageMetrics[n] = new PageMetrics(page.dims);
    doc.pageMetrics[n].angle = page.angle;
  }

  if (hocrSource !== undefined) {
    if (!doc.hocrSource.pages[n]) doc.hocrSource.pages[n] = {};
    if (hocrSource) doc.hocrSource.pages[n][name] = holdJson(hocrSource);
    else delete doc.hocrSource.pages[n][name];
  }

  doc.inputData.xmlMode[n] = true;

  if (dataTables && dataTables.tables.length > 0) {
    const existing = doc.layoutDataTables.pages[n];
    if (!existing || existing.tables.length === 0 || (mainData && existing.default !== false)) {
      addCircularRefsDataTables([dataTables]);
      doc.layoutDataTables.pages[n] = dataTables;
    }
  }

  doc.progressHandler({ n, type: 'convert', info: { engineName: name } });
}

/**
 * This function is called after running a `convertPage` (or `recognizeAndConvert`) function, updating this document with the results.
 * This needs to be a separate function from `convertOCRPage`, given that sometimes recognition and conversion are combined by using `recognizeAndConvert`.
 *
 * @param {ScribeDoc} doc
 * @param {Awaited<ReturnType<typeof import('./import/convertPageBlocks.js').convertPageBlocks>> & {hocrSource?: ?HocrSourcePage}} params
 * @param {number} n
 * @param {boolean} mainData
 * @param {string} engineName - Name of OCR engine.
 */
async function convertPageCallback(doc, {
  pageObj, dataTables, warn, langSet, hocrSource,
}, n, mainData, engineName) {
  const fontPromiseArr = [];
  if (langSet && langSet.has('chi_sim')) fontPromiseArr.push(loadChiSimFont());
  if (langSet && (langSet.has('rus') || langSet.has('ukr') || langSet.has('ell'))) {
    fontPromiseArr.push(loadBuiltInFontsRaw('all'));
  } else {
    fontPromiseArr.push(loadBuiltInFontsRaw());
  }
  await Promise.all(fontPromiseArr);

  insertParsedPage(doc, n, pageObj, {
    engineName, dataTables, warn, mainData, setActive: false, hocrSource,
  });
}

/**
 * Convert from raw OCR data to the internal hocr format used here
 * Currently supports .hocr (used by Tesseract), Abbyy .xml, and stext (an intermediate data format used by mupdf).
 *
 * @param {ScribeDoc} doc
 * @param {Array<?string>} ocrRawArr - Array with raw OCR data, with an element for each page (null for a page that has none)
 * @param {boolean} mainData - Whether this is the "main" data that document metrics are calculated from.
 *  For imports of user-provided data, the first data provided should be flagged as the "main" data.
 *  For Tesseract.js recognition, the engine's results are flagged as the "main" data.
 * @param {TextSource} format - Format of raw data.
 * @param {string} engineName - Name of OCR engine.
 * @param {?PageMetrics[]} [pageMetrics=null] - Page metrics to use for the pages (Textract only).
 * @param {Object} [options]
 * @param {'width' | 'sentence'} [options.docxLineSplitMode] - DOCX line-split mode.
 *    Defaults to `scribeDocDefaults.docxLineSplitMode`. Ignored for non-docx formats.
 */
export async function convertOCR(doc, ocrRawArr, mainData, format, engineName, pageMetrics = null, options = {}) {
  const docxLineSplitMode = options.docxLineSplitMode ?? scribeDocDefaults.docxLineSplitMode;
  if (format === 'textract') {
    if (!pageMetrics || !pageMetrics[0]?.dims) throw new Error('Page metrics must be provided for Textract data.');
    const pageDims = pageMetrics.map((metrics) => (metrics.dims));

    // When multiple Textract entries exist (per-page files), each file contains
    // blocks with Page=1. Process each individually with the correct pageNum
    // to avoid merging all pages into page 0.
    if (ocrRawArr.length > 1) {
      for (let i = 0; i < ocrRawArr.length; i++) {
        const res = await gs.convertDocTextract({ ocrStr: [ocrRawArr[i]], pageDims: [pageDims[i]], pageNum: i });
        if (res.length > 0) {
          await convertPageCallback(doc, res[0], i, mainData, engineName);
        }
      }
    } else {
      const res = await gs.convertDocTextract({ ocrStr: ocrRawArr, pageDims });
      for (let n = 0; n < res.length; n++) {
        await convertPageCallback(doc, res[n], n, mainData, engineName);
      }
    }
    return;
  }

  if (format === 'azure_doc_intel') {
    if (!pageMetrics || !pageMetrics[0]?.dims) throw new Error('Page metrics must be provided for Azure Document Intelligence data.');
    const pageDims = pageMetrics.map((metrics) => (metrics.dims));
    const res = await gs.convertDocAzureDocIntel({ ocrStr: ocrRawArr, pageDims });
    for (let n = 0; n < res.length; n++) {
      await convertPageCallback(doc, res[n], n, mainData, engineName);
    }
    return;
  }

  if (format === 'google_doc_ai') {
    if (!pageMetrics || !pageMetrics[0]?.dims) throw new Error('Page metrics must be provided for Google Document AI data.');
    const pageDims = pageMetrics.map((metrics) => (metrics.dims));
    const res = await gs.convertDocGoogleDocAI({ ocrStr: ocrRawArr, pageDims });
    for (let n = 0; n < res.length; n++) {
      await convertPageCallback(doc, res[n], n, mainData, engineName);
    }
    return;
  }

  if (format === 'google_vision' && pageMetrics && pageMetrics[0]?.dims) {
    for (let n = 0; n < ocrRawArr.length; n++) {
      const res = await gs.convertPageGoogleVision({ ocrStr: ocrRawArr[n], n, pageDims: pageMetrics[n].dims });
      await convertPageCallback(doc, res, n, mainData, engineName);
    }
    return;
  }

  if (format === 'text' || format === 'docx' || format === 'md') {
    let res;
    if (format === 'text') {
      res = await gs.convertPageText({ textStr: ocrRawArr[0] });
    } else if (format === 'docx') {
      res = await gs.convertDocDocx({ docxData: ocrRawArr[0], lineSplitMode: docxLineSplitMode, docId: doc.id });
    } else {
      res = await gs.convertDocMd({ mdStr: ocrRawArr[0] });
    }

    if (res.length > doc.inputData.pageCount) doc.inputData.pageCount = res.length;

    for (let i = 0; i < res.length; i++) {
      if (!doc.layoutRegions.pages[i]) doc.layoutRegions.pages[i] = new LayoutPage(i);
    }

    for (let i = 0; i < res.length; i++) {
      if (!doc.layoutDataTables.pages[i]) doc.layoutDataTables.pages[i] = new LayoutDataTablePage(i);
    }

    for (let n = 0; n < res.length; n++) {
      await convertPageCallback(doc, res[n], n, mainData, engineName);
    }
    return;
  }

  await gs.getGeneralScheduler();
  const maxInFlight = gs.schedulerInner.getNumWorkers() + 2;
  /** @type {Set<Promise<void>>} */
  const inFlight = new Set();
  /** @type {{ failure: ?Error }} */
  const run = { failure: null };
  for (let n = 0; n < ocrRawArr.length; n++) {
    if (run.failure) break;
    const ocrRaw = ocrRawArr[n];
    if (ocrRaw == null) continue;
    while (inFlight.size >= maxInFlight) await Promise.race(inFlight);
    const job = convertOCRPage(ocrRaw, n, format)
      .then((res) => convertPageCallback(doc, res, n, mainData, engineName))
      .catch((err) => { if (!run.failure) run.failure = err; });
    inFlight.add(job);
    job.then(() => inFlight.delete(job));
  }
  await Promise.all(inFlight);
  if (run.failure) throw run.failure;
}

/**
 * @param {ScribeDoc} doc
 * @param {boolean} legacy
 * @param {boolean} lstm
 * @param {boolean} mainData
 * @param {Array<string>} [langs=['eng']]
 * @param {boolean} [vanillaMode=false]
 * @param {Object<string, string>} [config={}]
 * @param {?boolean[]} [ocrPageMask=null] - Per-page mask. When set, only `true` pages are recognized.
 * @param {?AbortSignal} [signal=null] - The run's cancel signal. Once it fires no further page is scheduled and the pages already on a worker land, then the run throws an AbortError.
 */
async function recognizeAllPages(
  doc, legacy = true, lstm = true, mainData = false, langs = ['eng'], vanillaMode = false, config = {}, ocrPageMask = null, signal = null,
) {
  const inputPages = ocrPageMask ? [...Array(doc.images.pageCount).keys()].filter((i) => ocrPageMask[i]) : [...Array(doc.images.pageCount).keys()];

  // Whichever engines ran, the result lands under 'Combined': the merged page of a dual-engine run, or the engine's own page.
  doc.pageStore.add('Combined', doc.inputData.pageCount);
  doc.pageStore.active = 'Combined';

  await gs.initTesseract({
    anyOk: false, vanillaMode, langs, config,
  });
  throwIfAborted(signal);

  // The first page to fail ends the run, once the pages in flight have landed.
  /** @type {{ failure: ?Error }} */
  const run = { failure: null };

  // Upscaling is enabled only for image data, and only if the user has explicitly enabled it.
  // For PDF data, if upscaling is desired, that should be handled by rendering the PDF at a higher resolution.
  const upscale = doc.inputData.imageMode && scribeDocDefaults.enableUpscale;

  const configPage = { upscale, gpu: opt.dev.disableGPU ? 'off' : opt.dev.forceGPU ? 'force' : 'auto' };

  // The bound caps how many page rasters are resident at once, since each chain renders its own page and releases it below.
  // Recognition is 10-20x slower than rendering, so a lookahead this small still keeps every engine busy.
  const maxInFlight = gs.schedulerInner.getNumWorkers() + 2;
  /** @type {Set<Promise<void>>} */
  const inFlight = new Set();

  for (const x of inputPages) {
    if ((signal && signal.aborted) || run.failure) break;
    while (inFlight.size >= maxInFlight) await Promise.race(inFlight);
    if ((signal && signal.aborted) || run.failure) break;
    const chain = recognizePageImp(doc, x, legacy, lstm, false, configPage, scribeDocDefaults.debugVis, langs, vanillaMode, signal).then(async (res) => {
      // A page that lands after the run stopped must not write into a document that is being put back.
      if ((signal && signal.aborted) || run.failure) return;
      if (res.recognize.debugVis) {
        const gzStream = new Blob([res.recognize.debugVis]).stream().pipeThrough(new CompressionStream('gzip'));
        doc.vis[x] = new Uint8Array(await new Response(gzStream).arrayBuffer());
      }

      await convertPageCallback(doc, res.convert.page, x, mainData, 'Combined');
      doc.ocrTiming[x] = {
        ...doc.ocrTiming[x],
        Combined: {
          0: res.recognitionTime, ...res.recognize.timing, dev: res.recognize.dev,
        },
      };

      // Releasing here is safe because the compare and font-eval tail read only `binary`.
      if (doc.inputData.pdfMode) {
        doc.images.native[x] = undefined;
        doc.images.nativeProps[x] = undefined;
      }
    }).catch((err) => {
      // A chain never rejects, so the pump's race above cannot throw. A page that stopped on the cancel is not a failure.
      if (!run.failure && !(signal && signal.aborted)) run.failure = err;
    });
    inFlight.add(chain);
    chain.then(() => inFlight.delete(chain));
  }

  await Promise.all(inFlight);
  if (run.failure) throw run.failure;
  throwIfAborted(signal);

  if (mainData) {
    await checkCharWarn(doc, doc.convertPageWarn);
  }

  doc.pageStore.active = 'Combined';
}

/**
 * Render a page's stored debug visualizations (`doc.vis[n]`) to canvases.
 * Returns one entry per debug window, or `null` when the page has none stored.
 * A single page's canvases total roughly a gigabyte at 300 DPI, so callers should not retain output across pages.
 * @param {ScribeDoc} doc
 * @param {number} n - Page number.
 */
export async function renderVis(doc, n) {
  const visData = doc.vis[n];
  if (!visData) return null;
  const gunzipStream = new Blob([visData]).stream().pipeThrough(new DecompressionStream('gzip'));
  const visStr = await new Response(gunzipStream).text();
  const { ScrollView } = await import('../scrollview-web/scrollview/ScrollView.js');
  const sv = new ScrollView({
    lightTheme: true,
  });
  await sv.processVisStr(visStr);
  return sv.getAll(true);
}

/**
 * Convert a page of raw model output (HOCR string, Textract JSON string, etc.) into
 * the internal OcrPage model and store it under the given engine name. Shared between
 * the per-image and document-mode custom recognition paths.
 * @param {ScribeDoc} doc
 * @param {string} rawData
 * @param {number} n - Page index.
 * @param {RecognitionModel} model
 */
async function convertModelRawPage(doc, rawData, n, model) {
  const engineName = model.config.name;
  const outputFormat = model.config.outputFormat;
  if (model.convertPage) {
    const convertResult = await model.convertPage(rawData, n);
    await convertPageCallback(doc, convertResult, n, true, engineName);
  } else if (outputFormat === 'textract') {
    const pageDims = [doc.pageMetrics[n].dims];
    const res = await gs.convertDocTextract({ ocrStr: rawData, pageDims, pageNum: n });
    for (let i = 0; i < res.length; i++) {
      await convertPageCallback(doc, res[i], n + i, true, engineName);
    }
  } else if (outputFormat === 'azure_doc_intel') {
    const pageDims = [doc.pageMetrics[n].dims];
    const res = await gs.convertDocAzureDocIntel({ ocrStr: rawData, pageDims });
    for (let i = 0; i < res.length; i++) {
      await convertPageCallback(doc, res[i], n + i, true, engineName);
    }
  } else if (outputFormat === 'google_doc_ai') {
    const pageDims = [doc.pageMetrics[n].dims];
    const res = await gs.convertDocGoogleDocAI({ ocrStr: rawData, pageDims, pageNum: n });
    for (let i = 0; i < res.length; i++) {
      await convertPageCallback(doc, res[i], n + i, true, engineName);
    }
  } else if (outputFormat === 'google_vision') {
    const res = await gs.convertPageGoogleVision({ ocrStr: rawData, n, pageDims: doc.pageMetrics[n].dims });
    await convertPageCallback(doc, res, n, true, engineName);
  } else {
    const res = await convertOCRPage(rawData, n, /** @type {TextSource} */ (outputFormat));
    await convertPageCallback(doc, res, n, true, engineName);
  }
}

/**
 * Recognize a document with a document-mode model that streams per-page results.
 * @param {ScribeDoc} doc
 * @param {Object} options
 * @param {RecognitionModel} options.model
 * @param {Object} [options.modelOptions]
 * @param {AbortSignal} [options.signal]
 * @param {?boolean[]} ocrPageMask - Pages to recognize, or `null` for all pages.
 * @param {?string} nativeLayer - Name of the layer holding the document's native (PDF) text, if any.
 */
async function recognizeCustomModelDocumentMode(doc, options, ocrPageMask, nativeLayer) {
  const model = options.model;
  const modelOptions = options.modelOptions || {};
  const signal = options.signal;
  const engineName = model.config.name;
  // modelOptions passed to the model has `signal` merged in so network-backed models
  // can cancel their in-flight HTTP requests. We keep the caller's modelOptions object
  // untouched to avoid mutating a user-supplied reference.
  const modelOptionsWithSignal = { ...modelOptions, signal };

  doc.pageStore.add(engineName, doc.inputData.pageCount);
  if (scribeDocDefaults.keepRawData && !doc.ocrRaw[engineName]) doc.ocrRaw[engineName] = Array(doc.inputData.pageCount);

  if (ocrPageMask && !ocrPageMask.some(Boolean)) {
    for (let n = 0; n < doc.inputData.pageCount; n++) {
      if (nativeLayer && doc.pageStore.hasPage(n, nativeLayer)) doc.pageStore.sharePage(n, nativeLayer, engineName);
      else doc.pageStore.setPage(n, new OcrPage(n, doc.pageMetrics[n].dims), engineName);
    }
    doc.pageStore.active = engineName;
    return;
  }
  const pageSelection = model.config.documentModePageSelection && ocrPageMask && !ocrPageMask.every(Boolean) ? ocrPageMask : null;

  // Filling `ocrApplied` here would mark unselected pages OCR-applied, which the searchable-PDF export reads to pick pages to flatten.
  if (pageSelection) {
    for (let n = 0; n < doc.inputData.pageCount; n++) {
      if (pageSelection[n]) continue;
      if (nativeLayer && doc.pageStore.hasPage(n, nativeLayer)) doc.pageStore.sharePage(n, nativeLayer, engineName);
      else doc.pageStore.setPage(n, new OcrPage(n, doc.pageMetrics[n].dims), engineName);
    }
  } else {
    if (ocrPageMask && !ocrPageMask.every(Boolean)) {
      const ocrCount = ocrPageMask.filter(Boolean).length;
      doc.warningHandler({ message: `This document-mode model does not support per-page selection, so all ${doc.inputData.pageCount} pages will be sent to the model; the OCR selection (${ocrCount}/${doc.inputData.pageCount}) still determines which results are kept.` });
    }
    // The whole PDF is OCR'd in document mode, so every page's active layer becomes OCR.
    doc.inputData.ocrApplied = Array(doc.inputData.pageCount).fill(true);
  }

  throwIfAborted(signal);

  const pageDims = doc.pageMetrics.map((m) => m.dims);
  const pdfBytes = doc.inputData.pdfMode && doc.images.pdfData ? new Uint8Array(doc.images.pdfData) : null;

  const docInput = { pdfBytes, pageCount: doc.inputData.pageCount, pageDims };
  if (pageSelection) docInput.pages = [...Array(doc.inputData.pageCount).keys()].filter((n) => pageSelection[n]);

  const stream = await model.recognizeDocument(docInput, modelOptionsWithSignal);

  const failedPagesDoc = [];
  let lastErrMsg = '';
  let docAborted = false;
  const terminalPages = new Set();
  const droppedPages = new Set();
  try {
    for await (const entry of stream) {
      if (signal && signal.aborted) { docAborted = true; break; }
      if (!entry) continue;
      if (entry.progress) {
        if (pageSelection && entry.pageNum != null && !pageSelection[entry.pageNum]) continue;
        doc.progressHandler({
          n: entry.pageNum,
          type: 'recognize',
          info: {
            status: 'progress', stage: entry.progress.stage, pct: entry.progress.pct, engineName, timestamp: Date.now(),
          },
        });
        continue;
      }
      if (entry.pageNum == null || (!entry.error && entry.rawData === undefined)) {
        doc.warningHandler({ message: 'Document-mode model yielded an entry with no rawData, error, or progress; it was ignored.' });
        continue;
      }
      if (pageSelection && !pageSelection[entry.pageNum]) {
        droppedPages.add(entry.pageNum);
        continue;
      }
      if (entry.error) {
        const errMsg = entry.error.message || String(entry.error);
        failedPagesDoc.push(entry.pageNum);
        lastErrMsg = errMsg;
        terminalPages.add(entry.pageNum);
        doc.warningHandler({ message: `Recognition failed for page ${entry.pageNum}: ${errMsg}`, page: entry.pageNum });
        doc.pageStore.setPage(entry.pageNum, new OcrPage(entry.pageNum, doc.pageMetrics[entry.pageNum].dims), engineName);
        continue;
      }
      const { pageNum, rawData } = entry;
      terminalPages.add(pageNum);
      if (scribeDocDefaults.keepRawData) doc.ocrRaw[engineName][pageNum] = rawData;
      doc.progressHandler({
        n: pageNum, type: 'recognize', info: { status: 'received', engineName, timestamp: Date.now() },
      });
      await convertModelRawPage(doc, rawData, pageNum, model);
    }
  } finally {
    // Best-effort: if the model's generator supports early termination via return(),
    // give it a chance to clean up (e.g. cancel an in-flight fetch). Works for both
    // native async generators (have .return) and hand-rolled async iterators.
    if (docAborted && stream && typeof stream.return === 'function') {
      try { await stream.return(); } catch (_) { /* ignore */ }
    }
  }

  // Preserve partial results on abort — caller (and any resume layer) may want them.
  doc.pageStore.active = engineName;
  if (scribeDocDefaults.keepRawData) doc.ocrRaw.active = doc.ocrRaw[engineName];

  // Always throw if the signal is aborted, regardless of whether the library or the
  // model's own early-return terminated the for-await loop first.
  throwIfAborted(signal);

  if (droppedPages.size > 0) {
    doc.warningHandler({ message: `Document-mode model returned results for unselected page(s) (${[...droppedPages].sort((a, b) => a - b).join(', ')}); they were ignored.` });
  }

  // Without this, a model that ends the stream without answering every page leaves `undefined` holes in the active layer.
  for (let n = 0; n < doc.inputData.pageCount; n++) {
    if (pageSelection && !pageSelection[n]) continue;
    if (terminalPages.has(n)) continue;
    failedPagesDoc.push(n);
    lastErrMsg = 'no result was returned for this page.';
    doc.warningHandler({ message: `Recognition failed for page ${n}: no result was returned for this page.`, page: n });
    doc.pageStore.setPage(n, new OcrPage(n, doc.pageMetrics[n].dims), engineName);
  }

  const expectedPageCount = pageSelection ? pageSelection.filter(Boolean).length : doc.inputData.pageCount;
  if (failedPagesDoc.length === expectedPageCount) {
    throw new Error(`Recognition failed for all pages. Last error message: ${lastErrMsg}`);
  }
  if (failedPagesDoc.length > 0) {
    failedPagesDoc.sort((a, b) => a - b);
    doc.warningHandler({ message: `Recognition failed for ${failedPagesDoc.length} page(s) (${failedPagesDoc.join(', ')}). These pages will have no OCR data.` });
  }
}

/**
 * Recognize a document using a custom recognition model.
 * @param {ScribeDoc} doc
 * @param {Object} options
 * @param {RecognitionModel} options.model
 * @param {Object} [options.modelOptions]
 * @param {Array<string>} [options.langs]
 * @param {AbortSignal} [options.signal] - Preserves completed pages and throws an `AbortError` when aborted.
 * @param {?boolean[]} ocrPageMask - Pages to recognize, or `null` for all pages.
 * @param {?string} nativeLayer - Name of the layer holding the document's native (PDF) text, if any.
 */
async function recognizeCustomModel(doc, options, ocrPageMask, nativeLayer) {
  const model = options.model;
  const modelOptions = options.modelOptions || {};
  const signal = options.signal;
  const engineName = model.config.name;
  const outputFormat = model.config.outputFormat;
  // modelOptions passed to the model has `signal` merged in so network-backed models
  // can cancel their in-flight HTTP requests. We keep the caller's modelOptions object
  // untouched to avoid mutating a user-supplied reference.
  const modelOptionsWithSignal = { ...modelOptions, signal };

  const knownFormats = ['hocr', 'abbyy', 'alto', 'textract', 'azure_doc_intel', 'google_doc_ai', 'google_vision', 'stext', 'text'];
  if (!knownFormats.includes(outputFormat) && !model.convertPage) {
    throw new Error(`Model output format '${outputFormat}' is not supported. Provide a convertPage method on the model.`);
  }

  await gs.getGeneralScheduler();

  // Document-mode models OCR the whole PDF in a single call, so route them to their own path.
  if (model.config.documentMode) {
    await recognizeCustomModelDocumentMode(doc, options, ocrPageMask, nativeLayer);
    return;
  }

  // Initialize array for custom model results
  doc.pageStore.add(engineName, doc.inputData.pageCount);
  if (scribeDocDefaults.keepRawData && !doc.ocrRaw[engineName]) doc.ocrRaw[engineName] = Array(doc.inputData.pageCount);

  // No page selected: skip the model entirely, filling each page from its native (PDF) text.
  if (ocrPageMask && !ocrPageMask.some(Boolean)) {
    for (let n = 0; n < doc.inputData.pageCount; n++) {
      if (nativeLayer && doc.pageStore.hasPage(n, nativeLayer)) doc.pageStore.sharePage(n, nativeLayer, engineName);
      else doc.pageStore.setPage(n, new OcrPage(n, doc.pageMetrics[n].dims), engineName);
    }
    doc.pageStore.active = engineName;
    return;
  }

  // Different cloud providers implement usage quotas in different ways.
  // AWS Textract (Sync) uses transactions per second (TPS).
  // AWS Textract (Async) uses both transactions per second (TPS) and concurrent request limits.
  // Google Vision (Sync) uses requests per minute (RPM).
  // The core distinction is that TPS limits the number of requests SENT per second,
  // rather than the number of live requests at any given time.
  const configRateLimit = modelOptions.rateLimit ?? model.config.rateLimit ?? null;
  const regionCount = Array.isArray(modelOptions?.region) ? modelOptions.region.length : 1;
  const baseTps = configRateLimit?.tps ?? (configRateLimit?.rpm ? configRateLimit.rpm / 60 : null);
  const tps = baseTps != null ? baseTps * regionCount : null;
  let adaptiveTps = tps;
  let lastRequestTime = 0;

  let concurrency;
  if (modelOptions.maxConcurrency != null) {
    concurrency = modelOptions.maxConcurrency;
  } else if (tps != null) {
    // When tps is set, that is the primary means of limiting concurrency.
    // This is set to a large number as a safeguard.
    concurrency = 30;
  } else if (opt.workerN) {
    concurrency = opt.workerN;
  } else if (typeof process === 'undefined') {
    concurrency = Math.min(Math.round((globalThis.navigator.hardwareConcurrency || 8) / 2), 6);
  } else {
    const cpuN = Math.floor((await import('node:os')).cpus().length / 2);
    concurrency = Math.max(Math.min(cpuN - 1, 8), 1);
  }

  const pages = [...Array(doc.images.pageCount).keys()].filter((n) => !ocrPageMask || ocrPageMask[n]);
  if (ocrPageMask) {
    for (let n = 0; n < doc.images.pageCount; n++) {
      if (ocrPageMask[n]) continue;
      if (nativeLayer && doc.pageStore.hasPage(n, nativeLayer)) doc.pageStore.sharePage(n, nativeLayer, engineName);
      else doc.pageStore.setPage(n, new OcrPage(n, doc.pageMetrics[n].dims), engineName);
    }
  }
  const executing = new Set();

  const maxConsecutiveFailures = 3;
  let consecutiveFailures = 0;
  let lastErrorMessage = '';
  let quitEarly = false;
  /** @type {number[]} */
  const failedPages = [];

  for (const n of pages) {
    if (quitEarly) break;
    if (signal && signal.aborted) break;
    // eslint-disable-next-line no-loop-func
    const p = (async () => {
      if (quitEarly) return;
      if (signal && signal.aborted) return;

      const nativeN = await doc.images.getNative(n);
      if (!nativeN) {
        doc.warningHandler({ message: `No image found for page ${n}, skipping.`, page: n });
        doc.pageStore.setPage(n, new OcrPage(n, doc.pageMetrics[n].dims), engineName);
        return;
      }

      // Convert base64 data URL to Uint8Array for the model.
      // Materialize `src` in case this is a viewer-rendered bitmap-backed wrapper (no-op otherwise).
      const imageData = base64ToBytes(nativeN.ensureSrc());

      // Drop the cached render once its bytes are copied.
      // Without this every page's rendered image stays cached for the whole run,
      // and a large document exhausts the heap before recognition finishes.
      // TODO: This will delete images at the user's current position in the viewer.
      // Additionally, rendering 1k pages in the viewer will still cause a crash.
      // We should switch to a more robust system for clearing cache.
      // Gated to large documents for now since small docs are not a memory risk.
      if (doc.inputData.pdfMode && doc.inputData.pageCount > 100) delete doc.images.native[n];

      const maxThrottleRetries = 3;
      /** @type {RecognitionResult} */
      let result = { success: false, format: '' };

      // Attempt recognition with up to maxThrottleRetries retries for throttling errors.
      // Attempt 0 is the initial request; attempts 1–maxThrottleRetries are retries.
      for (let attempt = 0; attempt <= maxThrottleRetries; attempt++) {
        if (signal && signal.aborted) return;
        // TPS pacing: claim the next available dispatch slot before yielding.
        if (adaptiveTps != null && adaptiveTps > 0) {
          const now = Date.now();
          // Using a number slightly above 1 second to account for variation.
          const minInterval = 1050 / adaptiveTps;
          const targetTime = Math.max(now, lastRequestTime + minInterval);
          lastRequestTime = targetTime;
          const waitMs = targetTime - now;
          if (waitMs > 0) {
            await abortableDelay(waitMs, signal);
            if (signal && signal.aborted) return;
          }
        }

        doc.progressHandler({ n, type: 'recognize', info: { status: 'sending', engineName, timestamp: Date.now() } });
        const recognizeStart = Date.now();
        result = await model.recognizeImage(imageData, modelOptionsWithSignal);

        if (result.success) {
          doc.ocrTiming[n] = { ...doc.ocrTiming[n], [engineName]: { 0: Date.now() - recognizeStart } };
          const elapsedSec = (Date.now() - recognizeStart) / 1000;
          if (scribeDocDefaults.printRecognitionTime === true || (typeof scribeDocDefaults.printRecognitionTime === 'number' && elapsedSec > scribeDocDefaults.printRecognitionTime)) {
            console.log(`Page ${n} recognition time: ${elapsedSec.toFixed(2)}s`);
          }
          break;
        }

        // Only throttling errors are retried.
        const isThrottle = model.isThrottlingError && result.error && model.isThrottlingError(result.error);
        if (!isThrottle) break;

        if (attempt === maxThrottleRetries) {
          doc.warningHandler({ message: `Page ${n}: throttled ${maxThrottleRetries + 1} times, giving up.`, page: n });
          break;
        }
        const backoffMs = Math.min(1000 * (2 ** attempt), 16000);
        doc.warningHandler({ message: `Page ${n}: throttled by API, retrying in ${backoffMs}ms (attempt ${attempt + 1}/${maxThrottleRetries})`, page: n });
        if (adaptiveTps != null && adaptiveTps > 0.5) {
          adaptiveTps *= 0.9;
        }
        await abortableDelay(backoffMs, signal);
      }

      if (signal && signal.aborted) return;

      if (!result.success || !result.rawData) {
        const errMsg = result.error ? result.error.message : 'Unknown error';
        failedPages.push(n);
        doc.warningHandler({ message: `Recognition failed for page ${n}: ${errMsg}`, page: n });
        doc.pageStore.setPage(n, new OcrPage(n, doc.pageMetrics[n].dims), engineName);
        consecutiveFailures++;
        lastErrorMessage = errMsg;
        if (consecutiveFailures >= maxConsecutiveFailures) {
          quitEarly = true;
        }
        return;
      }

      consecutiveFailures = 0;

      const rawData = result.rawData;
      if (scribeDocDefaults.keepRawData) doc.ocrRaw[engineName][n] = rawData;

      await convertModelRawPage(doc, rawData, n, model);
    })().then(() => executing.delete(p));

    executing.add(p);
    if (executing.size >= concurrency) await Promise.race(executing);
  }

  await Promise.allSettled(executing);

  // On abort: preserve whatever pages completed and throw an AbortError.
  // A caller (e.g. the server proxy's resume-cache layer) may want the partial results.
  if (signal && signal.aborted) {
    doc.pageStore.active = engineName;
    if (scribeDocDefaults.keepRawData) doc.ocrRaw.active = doc.ocrRaw[engineName];
    throwIfAborted(signal);
  }

  if (consecutiveFailures === doc.images.pageCount) {
    throw new Error(
      `Recognition failed for all pages. Last error message: ${lastErrorMessage}`,
    );
  }

  if (quitEarly) {
    throw new Error(
      `Recognition aborted after ${consecutiveFailures} consecutive failures. Last error message: ${lastErrorMessage}`,
    );
  }

  if (failedPages.length > 0) {
    failedPages.sort((a, b) => a - b);
    doc.warningHandler({ message: `Recognition failed for ${failedPages.length} page(s) (${failedPages.join(', ')}). These pages will have no OCR data.` });
  }

  // Set active OCR to custom model results
  doc.pageStore.active = engineName;
  if (scribeDocDefaults.keepRawData) {
    doc.ocrRaw.active = doc.ocrRaw[engineName];
  }
}

/**
 * Recognize all pages in this document.
 * Files for recognition should already be imported using `importFiles` before calling this function.
 * The results of recognition can be exported by calling `exportData` after this function.
 * @param {ScribeDoc} doc
 * @param {Object} options
 * @param {'speed'|'quality'} [options.mode='quality'] - Recognition mode. `'quality'` runs the default engine set, both engines under the built-in model and the LSTM engine under `vanillaMode`.
 *    `'speed'` runs the LSTM engine alone.
 * @param {Array<string>} [options.langs=['eng']] - Language(s) in document.
 * @param {'lstm'|'legacy'|'combined'} [options.modeAdv='combined'] - Alternative method of setting recognition mode.
 * @param {'conf'|'data'|'none'} [options.combineMode='data'] - Method of combining OCR results. Used if OCR data already exists.
 * @param {('all'|'auto'|'autoShallow'|'autoDeep'|'none'|boolean[])} [options.ocrPages] - Which pages to OCR. Defaults to `scribeDocDefaults.ocrPages` (`'all'`).
 *    `'autoShallow'` decides per document: it skips a text-native document and OCRs an image-based one in full,
 *    re-OCRing one that already carries an OCR layer unless `usePDFText.ocr.main` trusts that layer.
 *     `'autoDeep'` (alias `'auto'`) is a strict superset of `'autoShallow'` that also OCRs the pages of an otherwise-skipped document that may hold baked-in text.
 *    `'all'`/`'none'` force every/no page; a boolean array (length === page count) selects pages explicitly.
 *    Image inputs, and any document with uploaded OCR, always OCR every page.
 * @param {typeof scribeDocDefaults.usePDFText} [options.usePDFText] - How to use a PDF's own extracted text, for this call.
 *    Defaults to `scribeDocDefaults.usePDFText`. For a document with an existing OCR layer, `ocr.main: true` trusts that
 *    layer as primary and skips OCR; `ocr.supp: true` merges it into a fresh OCR run; both false re-OCRs and discards it.
 * @param {boolean} [options.vanillaMode=false] - Use the unmodified Tesseract.js model, whose cores carry no merge.
 *    One engine runs, `modeAdv` `'lstm'` (the default under this option) or `'legacy'`.
 *    `'combined'` throws.
 * @param {Object<string, string>} [options.config={}] - Config params to pass to to Tesseract.js.
 * @param {RecognitionModel} [options.model] - Custom recognition model. See docs.
 * @param {Object} [options.modelOptions={}] - Options passed to the model's `recognizeImage` method.
 * @param {AbortSignal} [options.signal] - Optional abort signal. Once it fires, no further page is scheduled and the call throws an AbortError when the pages already on a worker have landed.
 *    A built-in run then puts the document back exactly as it was before the call, as it also does when a run fails.
 *    The end of a `'quality'` run, font optimization and the compare pass, still completes once every page has landed.
 *    A custom-model run instead keeps the pages that completed, and drains its in-flight requests before throwing.
 */
export async function recognize(doc, options = {}) {
  if (!doc.inputData.pdfMode && !doc.inputData.imageMode) throw new Error('No PDF or image data found to recognize.');
  if (options.vanillaMode && options.modeAdv === 'combined') {
    throw new Error("modeAdv 'combined' is not available with vanillaMode: the unmodified Tesseract.js cores carry no merge. Use modeAdv 'lstm' or 'legacy'.");
  }
  const signal = options.signal;
  throwIfAborted(signal);

  await doc.textReady;
  if (doc._textMissing) throw new Error('The document could not be loaded, so it was not recognized.');
  throwIfAborted(signal);

  // Decide which pages require OCR based on document contents and options specified.
  const ocrPages = options.ocrPages ?? scribeDocDefaults.ocrPages;
  const usePDFText = options.usePDFText ?? scribeDocDefaults.usePDFText;
  const pageCount = doc.inputData.pageCount;
  const stats = doc.inputData.pageStats;

  // A `.scribe` session restored beside its PDF carries the PDF's own parsed text under 'User Upload', because that import runs no parse of its own.
  // Page selection and combining therefore treat the layer as native text rather than as user-supplied OCR.
  // A page the engine or a user produced carries another `textSource`, which keeps a saved recognition on the user-OCR path.
  const store = doc.pageStore;
  const restoredNative = !store.has('pdf') && store.has('User Upload') && doc.inputData.pdfMode
    && store.pageList('User Upload').every((page) => !page || page.lines.length === 0 || page.textSource === 'pdf');
  const userOcr = store.has('User Upload') && !restoredNative ? 'User Upload' : null;
  const nativeText = store.has('pdf') ? 'pdf' : (restoredNative ? 'User Upload' : null);

  /** @type {boolean[]} */
  let ocrPageMask;
  if (Array.isArray(ocrPages) && !userOcr) {
    // An explicit per-page mask is used directly, independent of parse-time stats.
    if (ocrPages.length !== pageCount) {
      throw new Error(`ocrPages array length (${ocrPages.length}) must equal the page count (${pageCount}).`);
    }
    ocrPageMask = ocrPages.map(Boolean);
  } else if (userOcr || !stats || stats.length !== pageCount) {
    // Uploaded OCR keeps the existing whole-document combine path (back-compat): OCR every page unless explicitly told `'none'`.
    // The same whole-document fallback applies when per-page stats are unavailable.
    ocrPageMask = Array(pageCount).fill(ocrPages !== 'none');
  } else {
    ocrPageMask = selectOcrPages(stats, doc.inputData.pdfType, /** @type {'all'|'none'|'auto'|'autoShallow'|'autoDeep'} */ (ocrPages), usePDFText);
  }
  // Every place a built-in run writes, so a cancel or a failure can put the document back; a new per-page write belongs here too.
  // Angles are copied because a page can change the angle of an existing metrics object rather than replacing the object.
  const before = {
    active: store.active,
    ocrApplied: doc.inputData.ocrApplied,
    combined: store.has('Combined') ? Array.from({ length: store.slotCount('Combined') }, (_, n) => store.snapshot(n, 'Combined')) : null,
    pageMetrics: doc.pageMetrics.slice(),
    angles: doc.pageMetrics.map((metrics) => (metrics ? metrics.angle : undefined)),
    convertPageWarn: doc.convertPageWarn.slice(),
    tables: doc.layoutDataTables.pages.slice(),
    xmlMode: doc.inputData.xmlMode.slice(),
    ocrTiming: doc.ocrTiming.slice(),
  };

  doc.inputData.ocrApplied = ocrPageMask.slice();
  const fullOcr = ocrPageMask.every(Boolean);
  // The keep/discard gate runs only for the `auto*` ocrPages modes (not `all`, `none`, or an explicit mask).
  const gateApplies = ocrPages === 'autoDeep' || ocrPages === 'auto' || ocrPages === 'autoShallow';

  // Custom recognition model path
  if (options.model) {
    await recognizeCustomModel(doc, /** @type {{ model: RecognitionModel }} */ (options), ocrPageMask, nativeText);
    buildCombinedLayer(doc, /** @type {string} */ (store.active), ocrPageMask, gateApplies, fullOcr, nativeText, userOcr);
    return;
  }

  if (!ocrPageMask.some(Boolean)) {
    // No page needs OCR: keep the parsed native/existing text layer as the active layer and skip recognition.
    if (nativeText) store.active = nativeText;
    return;
  }

  try {
    await gs.getGeneralScheduler();

    const combineMode = options && options.combineMode ? options.combineMode : 'data';
    const vanillaMode = options && options.vanillaMode !== undefined ? options.vanillaMode : false;
    const config = options && options.config ? options.config : {};

    const langs = options && options.langs ? options.langs : ['eng'];
    let oemMode = vanillaMode ? 'lstm' : 'combined';
    if (options && options.modeAdv) {
      oemMode = options.modeAdv;
    } else if (options && options.mode === 'speed') {
      oemMode = 'lstm';
    }

    const fontPromiseArr = [];
    // Chinese requires loading a separate font.
    if (langs.includes('chi_sim')) fontPromiseArr.push(loadChiSimFont());
    // Greek and Cyrillic require loading a version of the base fonts that include these characters.
    if (langs.includes('rus') || langs.includes('ukr') || langs.includes('ell')) fontPromiseArr.push(loadBuiltInFontsRaw('all'));
    await Promise.all(fontPromiseArr);

    let forceMainData = false;
    let existingOCR;
    if (userOcr) {
      existingOCR = userOcr;
    } else if (
      nativeText
      && ((doc.inputData.pdfType === 'text' && usePDFText.native.supp)
        || (doc.inputData.pdfType === 'ocr' && usePDFText.ocr.supp))
    ) {
      existingOCR = nativeText;
      forceMainData = !((doc.inputData.pdfType === 'text' && usePDFText.native.main)
        || (doc.inputData.pdfType === 'ocr' && usePDFText.ocr.main));
    }

    // Tesseract is the "main" data, which the page metrics come from, unless user-uploaded data exists.
    const dual = oemMode === 'combined';
    await recognizeAllPages(doc, oemMode !== 'lstm', oemMode !== 'legacy', !existingOCR, langs, vanillaMode, config, ocrPageMask, signal);

    if (!dual) {
      // Metrics from the LSTM model are so inaccurate they are not worth using.
      if (oemMode === 'legacy') {
        const charMetrics = await calcCharMetricsLayer(store, 'Combined');
        if (Object.keys(charMetrics).length > 0) {
          clearObjectProperties(doc.fonts.state.charMetrics);
          Object.assign(doc.fonts.state.charMetrics, charMetrics);
        }
        await doc.runOptimization('Combined').catch((err) => {
          if (err?.name === 'WorkerTerminatedError') throw err;
          doc.warningHandler({ message: `Font optimization failed, so the default fonts are used: ${err?.message || err}` });
        });
      }
    } else {
      const progressCb = () => doc.progressHandler({ type: 'recognize' });

      if (scribeDocDefaults.saveDebugImages) {
        doc.debug.debugImg.Combined = new Array(doc.images.pageCount);
        for (let i = 0; i < doc.images.pageCount; i++) {
          doc.debug.debugImg.Combined[i] = [];
        }
      }

      const recognizedPages = [...Array(doc.images.pageCount).keys()].filter((i) => ocrPageMask[i]);
      // The font eval skips pages without OCR data, so binarizing an unrecognized page would cost a render plus an engine pass for nothing.
      const fontEvalPages = recognizedPages.slice(0, 6);

      await doc.images.preRenderRange({ pageArr: fontEvalPages, binary: true });
      const charMetrics = await calcCharMetricsLayer(store, 'Combined');
      if (Object.keys(charMetrics).length > 0) {
        clearObjectProperties(doc.fonts.state.charMetrics);
        Object.assign(doc.fonts.state.charMetrics, charMetrics);
      }
      await doc.runOptimization('Combined').catch((err) => {
        if (err?.name === 'WorkerTerminatedError') throw err;
        doc.warningHandler({ message: `Font optimization failed, so the default fonts are used: ${err?.message || err}` });
      });

      if (existingOCR && (userOcr || fullOcr)) {
        /** @type {Set<number>} */
        const kept = new Set();
        const takeMerged = (/** @type {number} */ i, /** @type {OcrPage} */ page) => {
          store.setSnapshot(i, 'Combined', PageStore.snapshotOfPage(page));
          kept.add(i);
        };
        /** @type {?Awaited<ReturnType<typeof compareOCR>>} */
        let res = null;
        if (combineMode === 'conf') {
          /** @type {Parameters<import('./worker/compareOCRModule.js').compareOCRPageImp>[0]['options']} */
          const compOptions = {
            debugLabel: scribeDocDefaults.saveDebugImages ? 'Combined' : undefined,
            supplementComp: true,
            ignoreCap: scribeDocDefaults.ignoreCap,
            ignorePunct: scribeDocDefaults.ignorePunct,
            confThreshHigh: scribeDocDefaults.confThreshHigh,
            confThreshMed: scribeDocDefaults.confThreshMed,
            editConf: true,
          };

          res = await compareOCR(doc, existingOCR, 'Combined', compOptions, progressCb, takeMerged);
        } else if (combineMode === 'data') {
          /** @type {Parameters<import('./worker/compareOCRModule.js').compareOCRPageImp>[0]['options']} */
          const compOptions = {
            mode: 'comb',
            debugLabel: 'Combined',
            ignoreCap: scribeDocDefaults.ignoreCap,
            ignorePunct: scribeDocDefaults.ignorePunct,
            confThreshHigh: scribeDocDefaults.confThreshHigh,
            confThreshMed: scribeDocDefaults.confThreshMed,
            combinedA: forceMainData,
            // If the existing data was invisible OCR text extracted from a PDF, it is assumed to not have accurate bounding boxes.
            useBboxB: !forceMainData && existingOCR === nativeText && doc.inputData.pdfMode && !!doc.inputData.pdfType && ['image', 'ocr'].includes(doc.inputData.pdfType),
          };

          if (forceMainData) {
            res = await compareOCR(doc, 'Combined', existingOCR, compOptions, progressCb, takeMerged);
          } else {
            res = await compareOCR(doc, existingOCR, 'Combined', compOptions, progressCb, takeMerged);
          }
        }

        if (res) {
          if (doc.debug.debugImg.Combined) doc.debug.debugImg.Combined = res.debug;

          for (const [i, err] of Object.entries(res.errors)) {
            kept.add(Number(i));
            doc.warningHandler({ message: `Page ${Number(i) + 1}: the comparison with the existing text failed (${err && err.message ? err.message : err}); the recognition is kept as it is.` });
          }
          for (let i = 0; i < store.slotCount('Combined'); i++) if (!kept.has(i)) store.removePage(i, 'Combined');
        }
      }
    }

    buildCombinedLayer(doc, 'Combined', ocrPageMask, gateApplies, fullOcr, nativeText, userOcr);
  } catch (err) {
    const restore = (arr, saved) => {
      // A page's timing row can land past the end of an array the run found empty, so the length comes back too.
      arr.length = saved.length;
      for (let n = 0; n < saved.length; n++) {
        if (n in saved) arr[n] = saved[n];
        else delete arr[n];
      }
    };
    if (before.combined) {
      before.combined.forEach((snap, n) => {
        if (snap) store.setSnapshot(n, 'Combined', snap);
        else store.removePage(n, 'Combined');
      });
    } else {
      store.remove('Combined');
    }
    store.active = before.active;
    doc.inputData.ocrApplied = before.ocrApplied;
    restore(doc.pageMetrics, before.pageMetrics);
    doc.pageMetrics.forEach((metrics, n) => { if (metrics) metrics.angle = before.angles[n]; });
    restore(doc.convertPageWarn, before.convertPageWarn);
    restore(doc.layoutDataTables.pages, before.tables);
    restore(doc.inputData.xmlMode, before.xmlMode);
    restore(doc.ocrTiming, before.ocrTiming);
    throw err;
  }
}
