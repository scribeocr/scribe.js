import { convertPageAbbyy } from '../import/convertPageAbbyy.js';
import { convertPageAlto } from '../import/convertPageAlto.js';
import { convertPageBlocks, convertPageBlocksVanilla } from '../import/convertPageBlocks.js';
import { convertPageHocr } from '../import/convertPageHocr.js';
import { convertPageStext } from '../import/convertPageStext.js';
import { convertDocTextract } from '../import/convertDocTextract.js';
import { convertDocAzureDocIntel } from '../import/convertDocAzureDocIntel.js';
import { convertDocGoogleDocAI } from '../import/convertDocGoogleDocAI.js';
import { convertPageGoogleVision } from '../import/convertPageGoogleVision.js';
import { convertPageText } from '../import/convertPageText.js';
import { convertDocDocx } from '../import/convertDocDocx.js';
import { convertDocMd } from '../import/convertDocMd.js';

import {
  DocFonts, GlobalFonts, loadFontsFromSource, setActiveDocFonts, unregisterFontFacesMatching,
} from '../containers/fontContainer.js';
import { ca } from '../canvasAdapter.js';
import {
  compareOCRPageImp,
  evalPageBase,
  evalPageFont,
  evalWords,
  renderPageStaticImp,
} from './compareOCRModule.js';
import { optimizeFont } from './optimizeFontModule.js';
import { TessWorker } from '../../tess/TessWorker.js';

const parentPort = typeof process === 'undefined' ? globalThis : (await import('node:worker_threads')).parentPort;
if (!parentPort) throw new Error('This file must be run in a worker');

// TODO: Add back support for multiple PSM modes.
// There is already an advanced option in the UI that claims to switch this, but it currently does nothing.
// tessedit_pageseg_mode: Tesseract.PSM["SINGLE_COLUMN"],

const defaultConfigsVanilla = {
  tessedit_pageseg_mode: TessWorker.PSM.AUTO,
};

const defaultConfigs = {
  tessedit_pageseg_mode: TessWorker.PSM.AUTO,
  // This is virtually always a false positive (usually "I").
  tessedit_char_blacklist: '|',
  // This option disables an undesirable behavior where Tesseract categorizes blobs *of any size* as noise,
  // simply because they are too rectangular.  This option should always be enabled outside of debugging purposes.
  textord_noise_area_ratio: '1',
  // Table detection appears to interfere with the layout analysis of some documents with multi-column layouts,
  // causing columns to be combined into a single line.  This should be investigated in more detail,
  // but disabling as it does not seem to improve results even when the input document is a table.
  textord_tabfind_find_tables: '0',
};

// The core caps the Legacy engine's per-page cache of static-classifier results at 4 MB per worker.
// Raising it to 8 MB gains 2 to 4 percent of the Legacy pass, most of that on dense or harshly scanned pages.
const largeCache = await (async () => {
  if (typeof process === 'undefined') {
    const nav = globalThis.navigator;
    const mobile = nav?.userAgentData?.mobile === true || /Mobi|Android|iPhone|iPad/i.test(nav?.userAgent || '');
    return !mobile && (nav?.deviceMemory || 0) >= 8;
  }
  const os = await import('node:os');
  return os.totalmem() >= 8 * 1024 ** 3;
})();
if (largeCache) defaultConfigs.classify_static_cache_mb = '8';

const defaultInitConfigsVanilla = {};

const defaultInitConfigs = {
  // load_system_dawg: '0',
  load_freq_dawg: '0',
  // load_unambig_dawg: '0',
  // load_punc_dawg: '0',
  // load_number_dawg: '0',
  // load_bigram_dawg: '0',
};

let oemCurrent = 2;
let langArrCurrent = ['eng'];

let vanillaMode_ = false;

// Custom build is currently only used for browser version, while the Node.js version uses the published npm package.
// If recognition capabilities are ever added for the Node.js version, then we should use the same build for consistency. .
const tessOptions = typeof process === 'undefined' ? {
  legacyLang: true,
  workerBlobURL: false,
} : { legacyLang: true };

/** @type {?TessWorker} */
let worker;

/** @type {?number} */
let lastDocId = null;

// Per-document font state, keyed by document id. The built-in raw fonts are shared globally on
// `GlobalFonts`; only per-document fonts/metrics/settings live here.
// Font-dependent jobs carry their `docId` and the dispatcher points `setActiveDocFonts` at the matching entry before the job runs.
// This is safe without a lock because the scheduler runs one compute job per worker at a time,
// and font-load/state messages only write their own entry (they never repoint the active pointer).
/** @type {Map<number, DocFonts>} */
const workerFonts = new Map();

/** @param {number} [docId] */
const getWorkerFonts = (docId) => {
  const key = docId ?? 0;
  let docFonts = workerFonts.get(key);
  if (!docFonts) {
    docFonts = new DocFonts();
    docFonts.id = key;
    workerFonts.set(key, docFonts);
  }
  return docFonts;
};

const fontDependentFuncs = new Set([
  'compareOCRPageImp', 'evalPageBase', 'evalWords', 'evalPageFont', 'renderPageStaticImp',
  'convertDocDocx',
]);

/**
 * Function to change language, OEM, and vanilla mode.
 * All arguments can be set to `null` to keep the current settings.
 * This function should return early if requested settings match the current settings.
 *
 * @param {Object} param
 * @param {?Array<string>} param.langs
 * @param {?number} param.oem
 * @param {?boolean} param.vanillaMode
 * @param {Object<string, string>} param.config - Config params to pass to to Tesseract.js.
 * @param {?string} [param.langPath] - Custom path/URL to load `.traineddata` files from.
 *   Forwarded to `tessOptions.langPath` so subsequent worker creates load language data
 *   from this location instead of the default CDN. `null`/`undefined` leaves the current
 *   value unchanged.
 */
const reinitialize = async ({
  langs, oem, vanillaMode, config, langPath,
}) => {
  if (langPath !== undefined && langPath !== null) tessOptions.langPath = langPath;
  const langArr = typeof langs === 'string' ? langs.split('+') : langs;
  const changeLang = langs && JSON.stringify(langArr.sort()) !== JSON.stringify(langArrCurrent.sort());
  // oem can be 0, so using "truthy" checks does not work
  const changeOEM = oem !== null && oem !== undefined && oem !== oemCurrent;
  const changeVanilla = vanillaMode !== null && vanillaMode !== undefined && vanillaMode !== vanillaMode_;

  if (!changeLang && !changeOEM && !changeVanilla && worker) {
    if (config && Object.keys(config).length > 0) {
      await worker.setParameters(config);
    }
    return;
  }
  if (changeLang) langArrCurrent = langArr;
  if (changeOEM) oemCurrent = oem;
  if (changeVanilla) vanillaMode_ = vanillaMode;

  const initConfigs = vanillaMode_ ? structuredClone(defaultInitConfigsVanilla) : structuredClone(defaultInitConfigs);

  const defaultConfigsI = vanillaMode_ ? defaultConfigsVanilla : defaultConfigs;
  for (const [key, value] of Object.entries(defaultConfigsI)) {
    initConfigs[key] = value;
  }

  if (config) {
    for (const [key, value] of Object.entries(config)) {
      initConfigs[key] = value;
    }
  }

  // The worker only needs to be created from scratch if the build of Tesseract being used changes,
  // or if it was never created in the first place.
  if (changeVanilla || !worker) {
    if (vanillaMode_) {
      tessOptions.vanillaEngine = true;
    } else {
      tessOptions.vanillaEngine = false;
    }

    if (worker) await worker.terminate();
    worker = await TessWorker.create(langArrCurrent, oemCurrent, tessOptions, initConfigs);
  } else {
    await worker.reinitialize(langArrCurrent, oemCurrent, initConfigs);
  }
};

/**
 * Recognize one page image and convert the result into this library's page objects.
 * @param {Object} params
 * @param {Parameters<TessWorker['recognize']>[0]} params.image
 * @param {Parameters<TessWorker['recognize']>[1]} params.options
 * @param {Parameters<TessWorker['recognize']>[2]} params.output
 * @param {number} params.n
 * @param {dims} params.pageDims - Original (unrotated) dimensions of input image.
 * @param {?number} [params.knownAngle] - The known angle, or `null` if the angle is not known at the time of recognition.
 * @param {?Array<string>} [params.langs] - Languages for this job.
 * @param {boolean} [params.vanillaMode]
 * @param {?number} [params.docId]
 * Exported for type inference purposes, should not be imported anywhere.
 */
export const recognizeAndConvert = async ({
  image, options, output, n, pageDims, knownAngle = null, langs = null, vanillaMode = false, docId = null,
}) => {
  // Ensure this worker's Tesseract engine matches the job's language before recognizing.
  // This makes the config part of the job (not a separate broadcast another document could race),
  // so documents in different languages can share the pool.
  // `reinitialize` early-returns when the config is unchanged, so same-language documents pay nothing.
  if (langs) {
    await reinitialize({
      langs, oem: null, vanillaMode, config: {},
    });
  }

  if (!worker) throw new Error('Worker not initialized');
  if (docId !== lastDocId) {
    await worker.resetState();
    lastDocId = docId;
  }
  const startTime = performance.now();
  const res = await worker.recognize(image, options, output);
  const recognize = res.data;

  const angle = knownAngle === null || knownAngle === undefined ? (recognize.rotateRadians || 0) * (180 / Math.PI) * -1 : knownAngle;
  if (!recognize.blocks) throw new Error('No OCR blocks returned from recognition.');
  const page = vanillaMode_
    ? await convertPageBlocksVanilla({
      ocrBlocks: /** @type {TessBlockVanilla[]} */ (recognize.blocks), n, pageDims, rotateAngle: angle, legacy: !!options.legacy, upscale: recognize.upscale,
    })
    : await convertPageBlocks({
      ocrBlocks: /** @type {TessBlock[]} */ (recognize.blocks), n, pageDims, rotateAngle: angle, upscale: recognize.upscale,
    });
  // The block JSON is already converted, so dropping it keeps a large payload out of the message to the main thread.
  delete recognize.blocks;

  return { recognize, convert: { page }, recognitionTime: performance.now() - startTime };
};

/**
 * @param {Object} args
 * @param {Parameters<TessWorker['recognize']>[0]} args.image
 * @param {Parameters<TessWorker['recognize']>[1]} args.options
 * @param {Parameters<TessWorker['recognize']>[2]} args.output
 * Exported for type inference purposes, should not be imported anywhere.
 */
export const recognize = async ({ image, options, output }) => {
  if (!worker) throw new Error('Worker not initialized');
  const res1 = await worker.recognize(image, options, output);
  return res1.data;
};

/**
 * Set font data in this worker.
 * Built-in raw fonts (`kind` unset and `opt` false) are stored globally.
 * Optimized and document fonts are stored per document under `docId`.
 * @param {Object} args
 * @param {Parameters<loadFontsFromSource>[0]} args.src
 * @param {Parameters<loadFontsFromSource>[1]} args.opt
 * @param {number} [args.docId]
 * @param {('raw'|'opt'|'doc')} [args.kind]
 */
async function loadFontsWorker({
  src, opt, docId, kind,
}) {
  const fonts = await loadFontsFromSource(src, opt, docId);
  if (kind === 'opt' || (kind === undefined && opt)) {
    const docFonts = getWorkerFonts(docId);
    docFonts.opt = docFonts.opt ? Object.assign(docFonts.opt, fonts) : fonts;
  } else if (kind === 'doc') {
    const docFonts = getWorkerFonts(docId);
    docFonts.doc = docFonts.doc ? Object.assign(docFonts.doc, fonts) : fonts;
  } else {
    GlobalFonts.raw = GlobalFonts.raw ? Object.assign(GlobalFonts.raw, fonts) : fonts;
  }
  return true;
}

/**
 * @param {Object} args
 * @param {number} [args.docId]
 * @param {?Awaited<ReturnType<import('../fontEval.js').evaluateFonts>>} [args.rawMetrics]
 * @param {?Awaited<ReturnType<import('../fontEval.js').evaluateFonts>>} [args.optMetrics]
 * @param {string} [args.defaultFontName]
 * @param {string} [args.sansDefaultName]
 * @param {string} [args.serifDefaultName]
 * @param {boolean} [args.enableOpt]
 * @param {boolean} [args.forceOpt]
 */
async function updateFontContWorker({
  docId, rawMetrics, optMetrics, defaultFontName, sansDefaultName, serifDefaultName, enableOpt, forceOpt,
}) {
  const docFonts = getWorkerFonts(docId);
  if (sansDefaultName) docFonts.state.sansDefaultName = sansDefaultName;
  if (serifDefaultName) docFonts.state.serifDefaultName = serifDefaultName;
  if (defaultFontName) docFonts.state.defaultFontName = defaultFontName;
  if (rawMetrics) docFonts.rawMetrics = rawMetrics;
  if (optMetrics) docFonts.optMetrics = optMetrics;
  if (enableOpt === true || enableOpt === false) docFonts.state.enableOpt = enableOpt;
  if (forceOpt === true || forceOpt === false) docFonts.state.forceOpt = forceOpt;
}

/**
 * Drop a document's per-document fonts from this worker and unregister its optimized FontFaces.
 * The process-wide raw fonts (shared across all documents) are left intact.
 * @param {Object} args
 * @param {number} [args.docId]
 */
async function dropFontsWorker({ docId }) {
  const key = docId ?? 0;
  workerFonts.delete(key);
  ca.unregisterFontsMatching((name) => name.endsWith(` Opt d${key}`));
  unregisterFontFacesMatching((family) => family.endsWith(` Opt d${key}`));
  return true;
}

async function compareOCRPageImpWrap(args) {
  args.options.tessWorker = worker;
  return await compareOCRPageImp(args);
}

const handleMessage = async (data) => {
  const func = data[0];
  const args = data[1];
  const id = data[2];

  // Point font lookups at the requesting document's fonts before the job runs.
  if (fontDependentFuncs.has(func)) setActiveDocFonts(getWorkerFonts(args?.docId));

  ({
    // Convert page functions
    convertPageAbbyy,
    convertPageAlto,
    convertPageHocr,
    convertPageStext,
    convertDocTextract,
    convertDocAzureDocIntel,
    convertDocGoogleDocAI,
    convertPageGoogleVision,
    convertPageBlocks,
    convertPageText,
    convertDocDocx,
    convertDocMd,

    // Optimize font functions
    optimizeFont,

    // OCR comparison/evaluation functions
    evalPageFont,
    evalPageBase,
    evalWords,
    compareOCRPageImp: compareOCRPageImpWrap,
    renderPageStaticImp,

    // Recognition
    reinitialize,
    recognize,
    recognizeAndConvert,

    // Change state of worker
    loadFontsWorker,
    updateFontContWorker,
    dropFontsWorker,
  })[func](args)
    .then((x) => parentPort.postMessage({ data: x, id, status: 'resolve' }))
    .catch((err) => parentPort.postMessage({ data: err, id, status: 'reject' }));
};

if (typeof process === 'undefined') {
  onmessage = (event) => handleMessage(event.data);
} else {
  parentPort.on('message', handleMessage);
}

parentPort.postMessage({ data: 'ready', id: 0, status: 'resolve' });
