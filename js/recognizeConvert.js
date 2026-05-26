import { opt } from './containers/app.js';
import { loadBuiltInFontsRaw, loadChiSimFont } from './fontContainerMain.js';
import { calcCharMetricsFromPages } from './fontStatistics.js';
import { gs } from './generalWorkerMain.js';
import { ImageWrapper } from './objects/imageObjects.js';
import { LayoutDataTablePage, LayoutPage } from './objects/layoutObjects.js';
import { OcrPage } from './objects/ocrObjects.js';
import { PageMetrics } from './objects/pageMetricsObjects.js';
import { clearObjectProperties } from './utils/miscUtils.js';

/** @typedef {import('./containers/scribeDoc.js').ScribeDoc} ScribeDoc */

/**
 * Display warning/error message to user if missing character-level data.
 *
 * @param {Array<Object.<string, string>>} warnArr - Array of objects containing warning/error messages from convertPage
 */
export function checkCharWarn(warnArr) {
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
      opt.errorHandler(errorHTML);
    } else {
      const errorText = `No character-level OCR data detected. Abbyy XML is only supported with character-level data.
        See: https://docs.scribeocr.com/faq.html#is-character-level-ocr-data-required--why`;
      opt.errorHandler(errorText);
    }
  } if (charGoodCt === 0 && charWarnCt > 0 && typeof process === 'undefined') {
    const warningHTML = `No character-level OCR data detected. Font optimization features will be disabled.
      <a href="https://docs.scribeocr.com/faq.html#is-character-level-ocr-data-required--why" target="_blank" class="alert-link">Learn more.</a>`;
    opt.warningHandler(warningHTML);
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
 * Compare two sets of OCR data.
 * @param {ScribeDoc} doc
 * @param {Array<OcrPage>} ocrA
 * @param {Array<OcrPage>} ocrB
 * @param  {Parameters<import('./worker/compareOCRModule.js').compareOCRPageImp>[0]['options']} [options]
 * @param {?function} [progressCallback=null]
 */
export async function compareOCR(doc, ocrA, ocrB, options, progressCallback = null) {
  /** @type {Parameters<import('./worker/compareOCRModule.js').compareOCRPageImp>[0]['options']} */
  const compOptions = {
    ignorePunct: opt.ignorePunct,
    ignoreCap: opt.ignoreCap,
    confThreshHigh: opt.confThreshHigh,
    confThreshMed: opt.confThreshMed,
  };

  if (options) Object.assign(compOptions, options);

  /** @type {Array<OcrPage>} */
  const ocrArr = [];
  /** @type {Array<?EvalMetrics>} */
  const metricsArr = [];
  /** @type {Array<Array<CompDebugBrowser | CompDebugNode>>} */
  const debugImageArr = [];

  const comparePageI = async (i) => {
    const pageA = ocrA[i];
    // Some option combinations need the page image and some do not.
    // Skip it when unneeded for performance, and so accuracy benchmarks can run without an image.
    const mode = compOptions.mode || 'stats';
    const evalConflicts = compOptions.evalConflicts ?? true;
    const supplementComp = compOptions.supplementComp ?? false;
    const skipImage = (mode === 'stats' && !supplementComp) || (mode === 'comb' && !evalConflicts && !supplementComp);
    const binaryImage = skipImage ? null : await doc.images.getBinary(pageA.n);
    const res = await gs.compareOCRPageImp({
      pageA,
      pageB: ocrB[i],
      binaryImage,
      pageMetricsObj: doc.pageMetrics[pageA.n],
      options: compOptions,
      docId: doc.id,
    });

    ocrArr[i] = res.page;

    metricsArr[i] = res.metrics;

    if (res.debugImg) debugImageArr[i] = res.debugImg;
    if (progressCallback) progressCallback();
  };

  const indices = [...Array(ocrA.length).keys()];
  const compPromises = indices.map(async (i) => comparePageI(i));
  await Promise.allSettled(compPromises);

  return { ocr: ocrArr, metrics: metricsArr, debug: debugImageArr };
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

  let saveNativeImage = false;
  let saveBinaryImageArg = false;

  // Images are not saved when using "recognize area" as these intermediate images are cropped.
  if (!areaMode) {
    const binaryN = await doc.images.binary[n];
    // Images are saved if either (1) we do not have any such image at present or (2) the current version is not rotated but the user has the "auto rotate" option enabled.
    if (autoRotate && !nativeN.rotated[n] && (!angleKnown || Math.abs(rotateRadians) > angleThresh)) saveNativeImage = true;
    if (!binaryN || autoRotate && !binaryN.rotated && (!angleKnown || Math.abs(rotateRadians) > angleThresh)) saveBinaryImageArg = true;
  }

  return {
    angleThresh,
    angleKnown,
    rotateRadians,
    saveNativeImage,
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
 * @param {boolean} legacy -
 * @param {boolean} lstm -
 * @param {boolean} areaMode -
 * @param {Object<string, string>} tessOptions - Options to pass to Tesseract.js.
 * @param {boolean} [debugVis=false] - Generate instructions for debugging visualizations.
 * @param {?Array<string>} [langs=null] - Languages for this job. When set, the worker ensures its
 *    engine matches before recognizing, so concurrent documents in different languages stay isolated.
 * @param {boolean} [vanillaMode=false] - Use the vanilla Tesseract.js model.
 */
export async function recognizePageImp(doc, n, legacy, lstm, areaMode, tessOptions = {}, debugVis = false, langs = null, vanillaMode = false) {
  const {
    angleThresh, angleKnown, rotateRadians, saveNativeImage, saveBinaryImageArg,
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

  // If `legacy` and `lstm` are both `false`, recognition is not run, but layout analysis is.
  // This combination of options would be set for debug mode, where the point of running Tesseract
  // is to get debugging images for layout analysis rather than get text.
  const runRecognition = legacy || lstm;

  const resArr = await gs.recognizeAndConvert2({
    image: nativeN.src,
    options: config,
    output: {
      // text, blocks, hocr, and tsv must all be `false` to disable recognition
      text: runRecognition,
      blocks: runRecognition,
      hocr: runRecognition,
      tsv: runRecognition,
      layoutBlocks: !runRecognition,
      imageBinary: saveBinaryImageArg,
      imageColor: saveNativeImage,
      debug: true,
      debugVis,
    },
    n,
    knownAngle: doc.pageMetrics[n].angle,
    pageDims,
    langs,
    vanillaMode,
  });

  const res0 = await resArr[0];

  if (opt.printRecognitionTime) {
    console.log(`Page ${n} recognition time: ${(res0.recognitionTime / 1000).toFixed(2)}s`);
  }

  if (!angleKnown) doc.pageMetrics[n].angle = (res0.recognize.rotateRadians || 0) * (180 / Math.PI) * -1;

  // An image is rotated if either the source was rotated or rotation was applied by Tesseract.
  const isRotated = Boolean(res0.recognize.rotateRadians || 0) || nativeN.rotated;

  // Images from Tesseract should not overwrite the existing images in the case where rotateAuto is true,
  // but no significant rotation was actually detected.
  const significantRotation = Math.abs(res0.recognize.rotateRadians || 0) > angleThresh;

  const upscale = res0.recognize.upscale || false;
  if (saveBinaryImageArg && res0.recognize.imageBinary && (significantRotation || !doc.images.binary[n])) {
    doc.images.binaryProps[n] = { rotated: isRotated, upscaled: upscale, colorMode: 'binary' };
    doc.images.binary[n] = new ImageWrapper(n, res0.recognize.imageBinary, 'binary', isRotated, upscale);
  }

  if (saveNativeImage && res0.recognize.imageColor && significantRotation) {
    doc.images.nativeProps[n] = { rotated: isRotated, upscaled: upscale, colorMode: opt.colorMode };
    doc.images.native[n] = new ImageWrapper(n, res0.recognize.imageColor, 'native', isRotated, upscale);
  }

  return resArr;
}

/**
 * Convert from raw OCR data to the internal hocr format used here
 * Currently supports .hocr (used by Tesseract), Abbyy .xml, and stext (an intermediate data format used by mupdf).
 *
 * @param {string} ocrRaw - String containing raw OCR data for single page.
 * @param {number} n - Page number
 * @param {TextSource} format - Format of raw data.
 * @param {boolean} [scribeMode=false] - Whether this is HOCR data from this program.
 * @returns {Promise<Awaited<ReturnType<typeof import('./worker/generalWorker.js').recognizeAndConvert>>['convert']>}
 */
async function convertOCRPage(ocrRaw, n, format, scribeMode = false) {
  await gs.getGeneralScheduler();
  let res;
  if (format === 'hocr') {
    res = await gs.convertPageHocr({ ocrStr: ocrRaw, n, scribeMode });
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
  } else if (format === 'docx') {
    console.error('format does not support page-level import.');
    // res = await gs.convertDocDocx({ docxData: ocrRaw });
  } else {
    throw new Error(`Invalid format: ${format}`);
  }

  return res;
}

/**
 * This function is called after running a `convertPage` (or `recognizeAndConvert`) function, updating this document with the results.
 * This needs to be a separate function from `convertOCRPage`, given that sometimes recognition and conversion are combined by using `recognizeAndConvert`.
 *
 * @param {ScribeDoc} doc
 * @param {Awaited<ReturnType<typeof import('./worker/generalWorker.js').recognizeAndConvert>>['convert']} params
 * @param {number} n
 * @param {boolean} mainData
 * @param {string} engineName - Name of OCR engine.
 */
async function convertPageCallback(doc, {
  pageObj, dataTables, warn, langSet, fontSet,
}, n, mainData, engineName) {
  const fontPromiseArr = [];
  if (langSet && langSet.has('chi_sim')) fontPromiseArr.push(loadChiSimFont());
  if (langSet && (langSet.has('rus') || langSet.has('ukr') || langSet.has('ell'))) {
    fontPromiseArr.push(loadBuiltInFontsRaw('all'));
  } else {
    fontPromiseArr.push(loadBuiltInFontsRaw());
  }
  // if (fontSet && fontSet.has('Dingbats')) fontPromiseArr.push(loadDingbatsFont());
  await Promise.all(fontPromiseArr);

  if (['Tesseract Legacy', 'Tesseract LSTM'].includes(engineName)) doc.ocr['Tesseract Latest'][n] = pageObj;

  if (engineName) doc.ocr[engineName][n] = pageObj;

  // If this is flagged as the "main" data, then save the stats.
  if (mainData) {
    doc.convertPageWarn[n] = warn;

    // The main OCR data is always preferred for setting page metrics.
    // This matters when the user uploads their own data, as the images are expected to be rendered at the same resolution as the OCR data.
    if (pageObj.dims.height && pageObj.dims.width) doc.pageMetrics[n] = new PageMetrics(pageObj.dims);

    doc.pageMetrics[n].angle = pageObj.angle;
  }

  doc.inputData.xmlMode[n] = true;

  // Layout boxes are only overwritten if none exist yet for the page
  if (Object.keys(doc.layoutDataTables.pages[n].tables).length === 0) doc.layoutDataTables.pages[n] = dataTables;

  opt.progressHandler({ n, type: 'convert', info: { engineName } });
}

/**
 * Convert from raw OCR data to the internal hocr format used here
 * Currently supports .hocr (used by Tesseract), Abbyy .xml, and stext (an intermediate data format used by mupdf).
 *
 * @param {ScribeDoc} doc
 * @param {string[]} ocrRawArr - Array with raw OCR data, with an element for each page
 * @param {boolean} mainData - Whether this is the "main" data that document metrics are calculated from.
 *  For imports of user-provided data, the first data provided should be flagged as the "main" data.
 *  For Tesseract.js recognition, the Tesseract Legacy results should be flagged as the "main" data.
 * @param {TextSource} format - Format of raw data.
 * @param {string} engineName - Name of OCR engine.
 * @param {boolean} [scribeMode=false] - Whether this is HOCR data from this program.
 * @param {?PageMetrics[]} [pageMetrics=null] - Page metrics to use for the pages (Textract only).
 */
export async function convertOCR(doc, ocrRawArr, mainData, format, engineName, scribeMode, pageMetrics = null) {
  const promiseArr = [];
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

  if (format === 'text') {
    const res = await gs.convertPageText({ textStr: ocrRawArr[0] });

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

  if (format === 'docx') {
    const res = await gs.convertDocDocx({ docxData: ocrRawArr[0], lineSplitMode: opt.docxLineSplitMode, docId: doc.id });

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

  for (let n = 0; n < ocrRawArr.length; n++) {
    promiseArr.push(convertOCRPage(ocrRawArr[n], n, format, scribeMode)
      .then((res) => convertPageCallback(doc, res, n, mainData, engineName)));
  }
  await Promise.all(promiseArr);
}

/**
 * @param {ScribeDoc} doc
 * @param {boolean} legacy
 * @param {boolean} lstm
 * @param {boolean} mainData
 * @param {Array<string>} [langs=['eng']]
 * @param {boolean} [vanillaMode=false]
 * @param {Object<string, string>} [config={}]
 */
async function recognizeAllPages(doc, legacy = true, lstm = true, mainData = false, langs = ['eng'], vanillaMode = false, config = {}) {
  // Render all PDF pages to PNG if needed
  // This step should not create binarized images as they will be created by Tesseract during recognition.
  if (doc.inputData.pdfMode) await doc.images.preRenderRange({ min: 0, max: doc.images.pageCount - 1, binary: false });

  if (legacy) {
    const oemText = 'Tesseract Legacy';
    if (!doc.ocr[oemText]) doc.ocr[oemText] = Array(doc.inputData.pageCount);
    doc.ocr.active = doc.ocr[oemText];
  }

  if (lstm) {
    const oemText = 'Tesseract LSTM';
    if (!doc.ocr[oemText]) doc.ocr[oemText] = Array(doc.inputData.pageCount);
    doc.ocr.active = doc.ocr[oemText];
  }

  // 'Tesseract Latest' includes the last version of Tesseract to run.
  // It exists only so that data can be consistently displayed during recognition,
  // should never be enabled after recognition is complete, and should never be editable by the user.
  {
    const oemText = 'Tesseract Latest';
    if (!doc.ocr[oemText]) doc.ocr[oemText] = Array(doc.inputData.pageCount);
    doc.ocr.active = doc.ocr[oemText];
  }

  await gs.initTesseract({
    anyOk: false, vanillaMode, langs, config,
  });

  // If Legacy and LSTM are both requested, LSTM completion is tracked by a second array of promises (`promisesB`).
  // In this case, `convertPageCallbackBrowser` can be run after the Legacy recognition is finished,
  // however this function only returns after all recognition is completed.
  // This provides no performance benefit in absolute terms, however halves the amount of time the user has to wait
  // before seeing the initial recognition results.
  const inputPages = [...Array(doc.images.pageCount).keys()];
  const promisesA = [];
  const resolvesA = [];
  const promisesB = [];
  const resolvesB = [];

  for (let i = 0; i < inputPages.length; i++) {
    promisesA.push(new Promise((resolve, reject) => {
      resolvesA[i] = { resolve, reject };
    }));
    promisesB.push(new Promise((resolve, reject) => {
      resolvesB[i] = { resolve, reject };
    }));
  }

  // Upscaling is enabled only for image data, and only if the user has explicitly enabled it.
  // For PDF data, if upscaling is desired, that should be handled by rendering the PDF at a higher resolution.
  const upscale = doc.inputData.imageMode && opt.enableUpscale;

  const configPage = { upscale };

  for (const x of inputPages) {
    recognizePageImp(doc, x, legacy, lstm, false, configPage, opt.debugVis, langs, vanillaMode).then(async (resArr) => {
      const res0 = await resArr[0];

      if (res0.recognize.debugVis) {
        const { ScrollView } = await import('../scrollview-web/scrollview/ScrollView.js');
        const sv = new ScrollView({
          lightTheme: true,
        });
        await sv.processVisStr(res0.recognize.debugVis);
        doc.vis[x] = await sv.getAll(true);
      }

      if (legacy) {
        await convertPageCallback(doc, res0.convert.legacy, x, mainData, 'Tesseract Legacy');
        resolvesA[x].resolve();
      } else if (lstm) {
        await convertPageCallback(doc, res0.convert.lstm, x, false, 'Tesseract LSTM');
        resolvesA[x].resolve();
      }

      if (legacy && lstm) {
        (async () => {
          const res1 = await resArr[1];
          await convertPageCallback(doc, res1.convert.lstm, x, false, 'Tesseract LSTM');
          resolvesB[x].resolve();
        })();
      }
    });
  }

  await Promise.all(promisesA);

  if (mainData) {
    await checkCharWarn(doc.convertPageWarn);
  }

  if (legacy && lstm) await Promise.all(promisesB);

  if (lstm) {
    const oemText = 'Tesseract LSTM';
    doc.ocr.active = doc.ocr[oemText];
  } else {
    const oemText = 'Tesseract Legacy';
    doc.ocr.active = doc.ocr[oemText];
  }
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
 * Document-mode recognition path: the model consumes the whole PDF at once (e.g. a
 * server proxy that renders pages and runs OCR remotely) and streams back per-page raw
 * results. Skips browser-side pre-rendering and the per-image dispatch loop entirely.
 * @param {ScribeDoc} doc
 * @param {Object} options
 * @param {RecognitionModel} options.model
 * @param {Object} [options.modelOptions]
 * @param {AbortSignal} [options.signal]
 */
async function recognizeCustomModelDocumentMode(doc, options) {
  const model = options.model;
  const modelOptions = options.modelOptions || {};
  const signal = options.signal;
  const engineName = model.config.name;
  // modelOptions passed to the model has `signal` merged in so network-backed models
  // can cancel their in-flight HTTP requests. We keep the caller's modelOptions object
  // untouched to avoid mutating a user-supplied reference.
  const modelOptionsWithSignal = { ...modelOptions, signal };

  if (!doc.ocr[engineName]) doc.ocr[engineName] = Array(doc.inputData.pageCount);
  if (opt.keepRawData && !doc.ocrRaw[engineName]) doc.ocrRaw[engineName] = Array(doc.inputData.pageCount);

  throwIfAborted(signal);

  const pageDims = doc.pageMetrics.map((m) => m.dims);
  const pdfBytes = doc.inputData.pdfMode && doc.images.pdfData ? new Uint8Array(doc.images.pdfData) : null;

  const stream = await model.recognizeDocument(
    { pdfBytes, pageCount: doc.inputData.pageCount, pageDims },
    modelOptionsWithSignal,
  );

  const failedPagesDoc = [];
  let lastErrMsg = '';
  let docAborted = false;
  try {
    for await (const entry of stream) {
      if (signal && signal.aborted) { docAborted = true; break; }
      if (!entry) continue;
      if (entry.error) {
        const errMsg = entry.error.message || String(entry.error);
        failedPagesDoc.push(entry.pageNum);
        lastErrMsg = errMsg;
        opt.warningHandler(`Recognition failed for page ${entry.pageNum}: ${errMsg}`);
        doc.ocr[engineName][entry.pageNum] = new OcrPage(entry.pageNum, doc.pageMetrics[entry.pageNum].dims);
        continue;
      }
      const { pageNum, rawData } = entry;
      if (opt.keepRawData) doc.ocrRaw[engineName][pageNum] = rawData;
      opt.progressHandler({
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
  doc.ocr.active = doc.ocr[engineName];
  if (opt.keepRawData) doc.ocrRaw.active = doc.ocrRaw[engineName];

  // Always throw if the signal is aborted, regardless of whether the library or the
  // model's own early-return terminated the for-await loop first.
  throwIfAborted(signal);

  if (failedPagesDoc.length === doc.inputData.pageCount) {
    throw new Error(`Recognition failed for all pages. Last error message: ${lastErrMsg}`);
  }
  if (failedPagesDoc.length > 0) {
    failedPagesDoc.sort((a, b) => a - b);
    opt.warningHandler(
      `Recognition failed for ${failedPagesDoc.length} page(s) (${failedPagesDoc.join(', ')}). These pages will have no OCR data.`,
    );
  }

  return doc.ocr.active;
}

/**
 * Recognize all pages using a custom (external) recognition model.
 * Called by `recognize` when `options.model` is provided.
 *
 * @param {ScribeDoc} doc
 * @param {Object} options - Options object from `recognize`, guaranteed non-null with `model` set.
 * @param {RecognitionModel} options.model
 * @param {Object} [options.modelOptions]
 * @param {Array<string>} [options.langs]
 * @param {AbortSignal} [options.signal] - Optional abort signal.
 *   When aborted, recognition stops scheduling new pages, drains in-flight work,
 *   preserves whatever pages completed, and throws an AbortError.
 */
async function recognizeCustomModel(doc, options) {
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

  if (model.config.documentMode) return recognizeCustomModelDocumentMode(doc, options);

  // Pre-render PDF pages to images if needed
  if (doc.inputData.pdfMode) await doc.images.preRenderRange({ min: 0, max: doc.images.pageCount - 1, binary: false });

  // Initialize array for custom model results
  if (!doc.ocr[engineName]) doc.ocr[engineName] = Array(doc.inputData.pageCount);
  if (opt.keepRawData && !doc.ocrRaw[engineName]) doc.ocrRaw[engineName] = Array(doc.inputData.pageCount);

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

  // Process all pages with limited concurrency
  const pages = [...Array(doc.images.pageCount).keys()];
  const executing = new Set();

  const maxConsecutiveFailures = 3;
  let consecutiveFailures = 0;
  let lastErrorMessage = '';
  let quitEarly = false;
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
        opt.warningHandler(`No image found for page ${n}, skipping.`);
        doc.ocr[engineName][n] = new OcrPage(n, doc.pageMetrics[n].dims);
        return;
      }

      // Convert base64 data URL to Uint8Array for the model
      const base64Data = nativeN.src.split(',')[1];
      const binaryStr = atob(base64Data);
      const imageData = new Uint8Array(binaryStr.length);
      for (let i = 0; i < binaryStr.length; i++) {
        imageData[i] = binaryStr.charCodeAt(i);
      }

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

        opt.progressHandler({ n, type: 'recognize', info: { status: 'sending', engineName, timestamp: Date.now() } });
        const recognizeStart = Date.now();
        result = await model.recognizeImage(imageData, modelOptionsWithSignal);

        if (result.success) {
          if (opt.printRecognitionTime) {
            console.log(`Page ${n} recognition time: ${((Date.now() - recognizeStart) / 1000).toFixed(2)}s`);
          }
          break;
        }

        // Only throttling errors are retried.
        const isThrottle = model.isThrottlingError && result.error && model.isThrottlingError(result.error);
        if (!isThrottle) break;

        if (attempt === maxThrottleRetries) {
          opt.warningHandler(`Page ${n}: throttled ${maxThrottleRetries + 1} times, giving up.`);
          break;
        }
        const backoffMs = Math.min(1000 * (2 ** attempt), 16000);
        opt.warningHandler(`Page ${n}: throttled by API, retrying in ${backoffMs}ms (attempt ${attempt + 1}/${maxThrottleRetries})`);
        if (adaptiveTps != null && adaptiveTps > 0.5) {
          adaptiveTps *= 0.9;
        }
        await abortableDelay(backoffMs, signal);
      }

      if (signal && signal.aborted) return;

      if (!result.success || !result.rawData) {
        const errMsg = result.error ? result.error.message : 'Unknown error';
        failedPages.push(n);
        opt.warningHandler(`Recognition failed for page ${n}: ${errMsg}`);
        doc.ocr[engineName][n] = new OcrPage(n, doc.pageMetrics[n].dims);
        consecutiveFailures++;
        lastErrorMessage = errMsg;
        if (consecutiveFailures >= maxConsecutiveFailures) {
          quitEarly = true;
        }
        return;
      }

      consecutiveFailures = 0;

      const rawData = result.rawData;
      if (opt.keepRawData) doc.ocrRaw[engineName][n] = rawData;

      await convertModelRawPage(doc, rawData, n, model);
    })().then(() => executing.delete(p));

    executing.add(p);
    if (executing.size >= concurrency) await Promise.race(executing);
  }

  await Promise.allSettled(executing);

  // On abort: preserve whatever pages completed and throw an AbortError.
  // A caller (e.g. the server proxy's resume-cache layer) may want the partial results.
  if (signal && signal.aborted) {
    doc.ocr.active = doc.ocr[engineName];
    if (opt.keepRawData) doc.ocrRaw.active = doc.ocrRaw[engineName];
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
    opt.warningHandler(
      `Recognition failed for ${failedPages.length} page(s) (${failedPages.join(', ')}). These pages will have no OCR data.`,
    );
  }

  // Set active OCR to custom model results
  doc.ocr.active = doc.ocr[engineName];
  if (opt.keepRawData) {
    doc.ocrRaw.active = doc.ocrRaw[engineName];
  }
  return doc.ocr.active;
}

/**
 * Recognize all pages in this document.
 * Files for recognition should already be imported using `importFiles` before calling this function.
 * The results of recognition can be exported by calling `exportData` after this function.
 * @param {ScribeDoc} doc
 * @param {Object} options
 * @param {'speed'|'quality'} [options.mode='quality'] - Recognition mode.
 * @param {Array<string>} [options.langs=['eng']] - Language(s) in document.
 * @param {'lstm'|'legacy'|'combined'} [options.modeAdv='combined'] - Alternative method of setting recognition mode.
 * @param {'conf'|'data'|'none'} [options.combineMode='data'] - Method of combining OCR results. Used if OCR data already exists.
 * @param {boolean} [options.vanillaMode=false] - Whether to use the vanilla Tesseract.js model.
 * @param {Object<string, string>} [options.config={}] - Config params to pass to to Tesseract.js.
 * @param {RecognitionModel} [options.model] - Custom recognition model. See docs.
 * @param {Object} [options.modelOptions={}] - Options passed to the model's `recognizeImage` method.
 * @param {AbortSignal} [options.signal] - Optional abort signal for cancelling a custom-model
 *    recognition run. When aborted, scribe.js stops scheduling new pages, drains any in-flight
 *    page requests (so their network activity is not wasted), preserves the OCR data of pages
 *    that already completed, and throws an AbortError. Only applies when `options.model` is set.
 */
export async function recognize(doc, options = {}) {
  if (!doc.inputData.pdfMode && !doc.inputData.imageMode) throw new Error('No PDF or image data found to recognize.');

  // Custom recognition model path
  if (options.model) {
    return recognizeCustomModel(doc, /** @type {{ model: RecognitionModel }} */ (options));
  }

  await gs.getGeneralScheduler();

  const combineMode = options && options.combineMode ? options.combineMode : 'data';
  const vanillaMode = options && options.vanillaMode !== undefined ? options.vanillaMode : false;
  const config = options && options.config ? options.config : {};

  const langs = options && options.langs ? options.langs : ['eng'];
  let oemMode = 'combined';
  if (options && options.modeAdv) {
    oemMode = options.modeAdv;
  } else if (options && options.mode) {
    oemMode = options.mode === 'speed' ? 'lstm' : 'legacy';
  }

  const fontPromiseArr = [];
  // Chinese requires loading a separate font.
  if (langs.includes('chi_sim')) fontPromiseArr.push(loadChiSimFont());
  // Greek and Cyrillic require loading a version of the base fonts that include these characters.
  if (langs.includes('rus') || langs.includes('ukr') || langs.includes('ell')) fontPromiseArr.push(loadBuiltInFontsRaw('all'));
  await Promise.all(fontPromiseArr);

  let forceMainData = false;
  let existingOCR;
  if (doc.ocr['User Upload']) {
    existingOCR = doc.ocr['User Upload'];
  } else if (doc.ocr.pdf && (doc.inputData.pdfType === 'text' && opt.usePDFText.native.supp || doc.inputData.pdfType === 'ocr' && opt.usePDFText.ocr.supp)) {
    existingOCR = doc.ocr.pdf;
    // If the PDF text is not the active data, it is assumed to be for supplemental purposes only.
    forceMainData = doc.ocr.pdf !== doc.ocr.active;
  }

  // A single Tesseract engine can be used (Legacy or LSTM) or the results from both can be used and combined.
  if (oemMode === 'legacy' || oemMode === 'lstm') {
    // Tesseract is used as the "main" data unless user-uploaded data exists and only the LSTM model is being run.
    // This is because Tesseract Legacy provides very strong metrics, and Abbyy often does not.
    await recognizeAllPages(doc, oemMode === 'legacy', oemMode === 'lstm', !existingOCR, langs, vanillaMode, config);

    // Metrics from the LSTM model are so inaccurate they are not worth using.
    if (oemMode === 'legacy') {
      const charMetrics = calcCharMetricsFromPages(doc.ocr['Tesseract Legacy']);
      if (Object.keys(charMetrics).length > 0) {
        clearObjectProperties(doc.fonts.state.charMetrics);
        Object.assign(doc.fonts.state.charMetrics, charMetrics);
      }
      await doc.runOptimization(doc.ocr['Tesseract Legacy']);
    }
  } else if (oemMode === 'combined') {
    await recognizeAllPages(doc, true, true, !existingOCR, langs, vanillaMode, config);

    const progressCb = () => opt.progressHandler({ type: 'recognize' });

    if (opt.saveDebugImages) {
      doc.debug.debugImg.Combined = new Array(doc.images.pageCount);
      for (let i = 0; i < doc.images.pageCount; i++) {
        doc.debug.debugImg.Combined[i] = [];
      }
    }

    if (existingOCR) {
      const oemText = 'Tesseract Combined';
      if (!doc.ocr[oemText]) doc.ocr[oemText] = Array(doc.inputData.pageCount);
      doc.ocr.active = doc.ocr[oemText];

      if (opt.saveDebugImages) {
        doc.debug.debugImg['Tesseract Combined'] = new Array(doc.images.pageCount);
        for (let i = 0; i < doc.images.pageCount; i++) {
          doc.debug.debugImg['Tesseract Combined'][i] = [];
        }
      }
    }

    // A new version of OCR data is created for font optimization and validation purposes.
    // This version has the bounding box and style data from the Legacy data, however uses the text from the LSTM data whenever conflicts occur.
    // Additionally, confidence is set to 0 when conflicts occur. Using this version benefits both font optimiztion and validation.
    // For optimization, using this version rather than Tesseract Legacy excludes data that conflicts with Tesseract LSTM and is therefore likely incorrect,
    // as low-confidence words are excluded when calculating overall character metrics.
    // For validation, this version is superior to both Legacy and LSTM, as it combines the more accurate bounding boxes/style data from Legacy
    // with the more accurate (on average) text data from LSTM.
    if (!doc.ocr['Tesseract Combined Temp']) doc.ocr['Tesseract Combined Temp'] = Array(doc.inputData.pageCount);

    {
      /** @type {Parameters<typeof doc.compareOCR>[2]} */
      const compOptions = {
        mode: 'comb',
        evalConflicts: false,
        legacyLSTMComb: true,
      };

      const res = await compareOCR(doc, doc.ocr['Tesseract Legacy'], doc.ocr['Tesseract LSTM'], compOptions, progressCb);

      clearObjectProperties(doc.ocr['Tesseract Combined Temp']);
      Object.assign(doc.ocr['Tesseract Combined Temp'], res.ocr);
    }

    // Evaluate default fonts using up to 5 pages.
    const pageNum = Math.min(doc.images.pageCount - 1, 5);
    await doc.images.preRenderRange({ min: 0, max: pageNum, binary: true });
    const charMetrics = calcCharMetricsFromPages(doc.ocr['Tesseract Combined Temp']);
    if (Object.keys(charMetrics).length > 0) {
      clearObjectProperties(doc.fonts.state.charMetrics);
      Object.assign(doc.fonts.state.charMetrics, charMetrics);
    }
    await doc.runOptimization(doc.ocr['Tesseract Combined Temp']);

    const oemText = 'Combined';
    if (!doc.ocr[oemText]) doc.ocr[oemText] = Array(doc.inputData.pageCount);
    doc.ocr.active = doc.ocr[oemText];

    {
      const tessCombinedLabel = existingOCR ? 'Tesseract Combined' : 'Combined';

      /** @type {Parameters<import('./worker/compareOCRModule.js').compareOCRPageImp>[0]['options']} */
      const compOptions = {
        mode: 'comb',
        debugLabel: opt.saveDebugImages ? tessCombinedLabel : undefined,
        ignoreCap: opt.ignoreCap,
        ignorePunct: opt.ignorePunct,
        confThreshHigh: opt.confThreshHigh,
        confThreshMed: opt.confThreshMed,
        legacyLSTMComb: true,
      };

      const res = await compareOCR(doc, doc.ocr['Tesseract Legacy'], doc.ocr['Tesseract LSTM'], compOptions, progressCb);

      if (doc.debug.debugImg[tessCombinedLabel]) doc.debug.debugImg[tessCombinedLabel] = res.debug;

      clearObjectProperties(doc.ocr[tessCombinedLabel]);
      Object.assign(doc.ocr[tessCombinedLabel], res.ocr);
    }

    if (existingOCR) {
      if (combineMode === 'conf') {
        /** @type {Parameters<import('./worker/compareOCRModule.js').compareOCRPageImp>[0]['options']} */
        const compOptions = {
          debugLabel: opt.saveDebugImages ? 'Combined' : undefined,
          supplementComp: true,
          ignoreCap: opt.ignoreCap,
          ignorePunct: opt.ignorePunct,
          confThreshHigh: opt.confThreshHigh,
          confThreshMed: opt.confThreshMed,
          editConf: true,
        };

        const res = await compareOCR(doc, existingOCR, doc.ocr['Tesseract Combined'], compOptions, progressCb);

        if (doc.debug.debugImg.Combined) doc.debug.debugImg.Combined = res.debug;

        clearObjectProperties(doc.ocr.Combined);
        Object.assign(doc.ocr.Combined, res.ocr);
      } else if (combineMode === 'data') {
        /** @type {Parameters<import('./worker/compareOCRModule.js').compareOCRPageImp>[0]['options']} */
        const compOptions = {
          mode: 'comb',
          debugLabel: 'Combined',
          ignoreCap: opt.ignoreCap,
          ignorePunct: opt.ignorePunct,
          confThreshHigh: opt.confThreshHigh,
          confThreshMed: opt.confThreshMed,
          // If the existing data was invisible OCR text extracted from a PDF, it is assumed to not have accurate bounding boxes.
          useBboxB: !forceMainData && existingOCR === doc.ocr.pdf && doc.inputData.pdfMode && !!doc.inputData.pdfType && ['image', 'ocr'].includes(doc.inputData.pdfType),
        };

        let res;
        if (forceMainData) {
          res = await compareOCR(doc, doc.ocr['Tesseract Combined'], existingOCR, compOptions, progressCb);
        } else {
          res = await compareOCR(doc, existingOCR, doc.ocr['Tesseract Combined'], compOptions, progressCb);
        }

        if (doc.debug.debugImg.Combined) doc.debug.debugImg.Combined = res.debug;

        clearObjectProperties(doc.ocr.Combined);
        Object.assign(doc.ocr.Combined, res.ocr);
      }
    }
  }

  return (doc.ocr.active);
}
