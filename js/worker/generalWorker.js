import { convertPageAbbyy } from '../import/convertPageAbbyy.js';
import { convertPageAlto } from '../import/convertPageAlto.js';
import { convertPageBlocks } from '../import/convertPageBlocks.js';
import { convertPageHocr } from '../import/convertPageHocr.js';
import { convertPageStext } from '../import/convertPageStext.js';
import { convertDocTextract } from '../import/convertDocTextract.js';
import { convertDocAzureDocIntel } from '../import/convertDocAzureDocIntel.js';
import { convertPageGoogleVision } from '../import/convertPageGoogleVision.js';
import { convertPageText } from '../import/convertPageText.js';
import { convertDocDocx } from '../import/convertDocDocx.js';

import { FontCont, loadFontsFromSource } from '../containers/fontContainer.js';
import {
  compareOCRPageImp,
  evalPageBase,
  evalPageFont,
  evalWords,
  nudgePageBaseline,
  nudgePageFontSize,
  renderPageStaticImp,
} from './compareOCRModule.js';
import { optimizeFont } from './optimizeFontModule.js';

const parentPort = typeof process === 'undefined' ? globalThis : (await import('node:worker_threads')).parentPort;
if (!parentPort) throw new Error('This file must be run in a worker');

const Tesseract = typeof process === 'undefined' ? (await import('../../tess/tesseract.esm.min.js')).default : await import('@scribe.js/tesseract.js');

// TODO: Add back support for multiple PSM modes.
// There is already an advanced option in the UI that claims to switch this, but it currently does nothing.
// tessedit_pageseg_mode: Tesseract.PSM["SINGLE_COLUMN"],

const defaultConfigsVanilla = {
  tessedit_pageseg_mode: Tesseract.PSM.AUTO,
};

const defaultConfigs = {
  tessedit_pageseg_mode: Tesseract.PSM.AUTO,

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

// Explicitly setting these paths with `URL` is necessary for this to work with Webpack.
// While Tesseract.js users are advised to always point `corePath` to a directory rather than a file,
// pointing to a file should be fined here.
// First, we never want to use the LSTM-only version, as every recognition mode (aside from some fringe advanced options) use the Legacy engine.
// Second, >99% of devices now support the SIMD version, so only using the SIMD version is fine.
let corePath;
if (vanillaMode_) {
  corePath = new URL('../../tess/core_vanilla/tesseract-core-simd.wasm.js', import.meta.url).href;
} else {
  corePath = new URL('../../tess/core/tesseract-core-simd.wasm.js', import.meta.url).href;
}

const workerPath = new URL('../../tess/worker.min.js', import.meta.url).href;

// Custom build is currently only used for browser version, while the Node.js version uses the published npm package.
// If recognition capabilities are ever added for the Node.js version, then we should use the same build for consistency. .
const tessOptions = typeof process === 'undefined' ? {
  corePath,
  workerPath,
  // langPath: '/tess/tessdata_dist',
  legacyCore: true,
  legacyLang: true,
  workerBlobURL: false,
} : { legacyCore: true, legacyLang: true };

/** @type {?Tesseract.Worker} */
let worker;

let workerLegacy;
let workerLSTM;

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
 */
const reinitialize = async ({
  langs, oem, vanillaMode, config,
}) => {
  const langArr = typeof langs === 'string' ? langs.split('+') : langs;
  const changeLang = langs && JSON.stringify(langArr.sort()) !== JSON.stringify(langArrCurrent.sort());
  // oem can be 0, so using "truthy" checks does not work
  const changeOEM = oem !== null && oem !== undefined && oem !== oemCurrent;
  const changeVanilla = vanillaMode && vanillaMode !== vanillaMode_;

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
      tessOptions.corePath = new URL('../../tess/core_vanilla/tesseract-core-simd.wasm.js', import.meta.url).href;
    } else {
      tessOptions.corePath = new URL('../../tess/core/tesseract-core-simd.wasm.js', import.meta.url).href;
    }

    if (worker) await worker.terminate();
    worker = await Tesseract.createWorker(langArrCurrent, oemCurrent, tessOptions, initConfigs);
  } else {
    await worker.reinitialize(langArrCurrent, oemCurrent, initConfigs);
  }
};

/**
 * Alternative version of `reinitialize` that uses two workers and allows for parallelizing recognition for the same image.
 * This is experimental and not currently called by anything.
 * Function to change language, OEM, and vanilla mode.
 * All arguments can be set to `null` to keep the current settings.
 * This function should return early if requested settings match the current settings.
 *
 * @param {Object} param
 * @param {?Array<string>} param.langs
 * @param {?number} param.oem
 * @param {?boolean} param.vanillaMode
 */
const reinitialize2 = async ({ langs, vanillaMode }) => {
  const langArr = typeof langs === 'string' ? langs.split('+') : langs;
  const changeLang = langs && JSON.stringify(langArr.sort()) !== JSON.stringify(langArrCurrent.sort());
  const changeVanilla = vanillaMode && vanillaMode !== vanillaMode_;

  if (!changeLang && !changeVanilla && workerLegacy && workerLSTM) return;
  if (changeLang) langArrCurrent = langArr;
  if (changeVanilla) vanillaMode_ = vanillaMode;

  const initConfigs = vanillaMode_ ? defaultInitConfigsVanilla : defaultInitConfigs;

  // The worker only needs to be created from scratch if the build of Tesseract being used changes,
  // or if it was never created in the first place.
  if (changeVanilla || !workerLegacy || !workerLSTM) {
    if (vanillaMode_) {
      tessOptions.corePath = new URL('../../tess/core_vanilla/tesseract-core-simd.wasm.js', import.meta.url).href;
    } else {
      tessOptions.corePath = new URL('../../tess/core/tesseract-core-simd.wasm.js', import.meta.url).href;
    }

    if (workerLegacy) {
      console.log('terminating legacy');
      await workerLegacy.terminate();
      workerLegacy = null;
    }
    if (workerLSTM) {
      console.log('terminating lstm');
      await workerLSTM.terminate();
      workerLSTM = null;
    }

    workerLegacy = await Tesseract.createWorker(langArrCurrent, 0, tessOptions, initConfigs);
    workerLSTM = await Tesseract.createWorker(langArrCurrent, 1, tessOptions, initConfigs);
  } else if (changeLang) {
    await workerLegacy.reinitialize(langArrCurrent, 0, initConfigs);
    await workerLSTM.reinitialize(langArrCurrent, 1, initConfigs);
  }

  const config = vanillaMode_ ? defaultConfigsVanilla : defaultConfigs;

  await workerLegacy.setParameters(config);
  await workerLSTM.setParameters(config);
};

/**
 * Asynchronously recognizes or processes an image based on specified options and parameters.
 *
 * @param {Object} params -
 * @param {ArrayBuffer} params.image -
 * @param {Object} params.options -
 * @param {Parameters<Tesseract.Worker['recognize']>[2]} params.output
 * @param {number} params.n -
 * @param {dims} params.pageDims - Original (unrotated) dimensions of input image.
 * @param {?number} [params.knownAngle] - The known angle, or `null` if the angle is not known at the time of recognition.
 * @param {?string} [params.engineName] -
 * Exported for type inference purposes, should not be imported anywhere.
 */
export const recognizeAndConvert = async ({
  image, options, output, n, knownAngle = null, pageDims,
}) => {
  if (!worker) throw new Error('Worker not initialized');

  const res1 = await worker.recognize(image, options, output);

  const angle = knownAngle === null || knownAngle === undefined ? (res1.data.rotateRadians || 0) * (180 / Math.PI) * -1 : knownAngle;

  const keepItalic = oemCurrent === 0;

  const ocrBlocks = /** @type {Array<import('@scribe.js/tesseract.js').Block>} */(res1.data.blocks);

  const res2 = await convertPageBlocks({
    ocrBlocks, n, pageDims, rotateAngle: angle, keepItalic,
  });

  return { recognize: res1.data, convert: res2 };
};

/**
 * Asynchronously recognizes or processes an image based on specified options and parameters.
 *
 * @param {Object} params -
 * @param {ArrayBuffer} params.image -
 * @param {Object} params.options -
 * @param {Parameters<Tesseract.Worker['recognize']>[2]} params.output
 * @param {number} params.n -
 * @param {dims} params.pageDims - Original (unrotated) dimensions of input image.
 * @param {?number} [params.knownAngle] - The known angle, or `null` if the angle is not known at the time of recognition.
 * @param {?string} [params.engineName] -
 * Exported for type inference purposes, should not be imported anywhere.
 */
export const recognizeAndConvert2 = async ({
  image, options, output, n, pageDims, knownAngle = null,
}, id) => {
  if (!worker && !(workerLegacy && workerLSTM)) throw new Error('Worker not initialized');

  // Disable output formats that are not used.
  // Leaving these enabled can significantly inflate runtimes for no benefit.
  if (!output) output = {};
  output.hocr = false;
  output.tsv = false;
  output.text = false;

  output.debug = false;

  // The function `worker.recognize2` returns 2 promises.
  // If both Legacy and LSTM data are requested, only the second promise will contain the LSTM data.
  // This allows the Legacy data to be used immediately, which halves the amount of delay between user
  // input and something appearing on screen.
  let resArr;
  if (workerLegacy && workerLSTM) {
    if (options.legacy && !options.lstm) {
      const res1Promise = workerLegacy.recognize(image, options, output);
      resArr = [res1Promise];
    } else if (!options.legacy && options.lstm) {
      const res1Promise = workerLSTM.recognize(image, options, output);
      resArr = [res1Promise];
    } else {
      const res1Promise = workerLegacy.recognize(image, options, output);
      const res2Promise = workerLSTM.recognize(image, options, output);
      resArr = [res1Promise, res2Promise];
    }
  } else {
    resArr = await worker.recognize2(image, options, output);
  }

  const res0 = await resArr[0];

  const angle = knownAngle === null || knownAngle === undefined ? (res0.data.rotateRadians || 0) * (180 / Math.PI) * -1 : knownAngle;

  let resLegacy;
  let resLSTM;
  if (options.lstm && options.legacy) {
    const legacyBlocks = /** @type {Array<import('@scribe.js/tesseract.js').Block>} */(res0.data.blocks);
    resLegacy = await convertPageBlocks({
      ocrBlocks: legacyBlocks, n, pageDims, rotateAngle: angle, keepItalic: true, upscale: res0.data.upscale,
    });
    (async () => {
      const res1 = await resArr[1];

      const lstmBlocks = /** @type {Array<import('@scribe.js/tesseract.js').Block>} */(res1.data.blocks);
      resLSTM = await convertPageBlocks({
        ocrBlocks: lstmBlocks, n, pageDims, rotateAngle: angle, keepItalic: false, upscale: res0.data.upscale,
      });

      const xB = { recognize: res1.data, convert: { legacy: null, lstm: resLSTM } };

      parentPort.postMessage({ data: xB, id: `${id}b`, status: 'resolve' });
    })();
  } else if (!options.lstm && options.legacy) {
    const legacyBlocks = /** @type {Array<import('@scribe.js/tesseract.js').Block>} */(res0.data.blocks);
    resLegacy = await convertPageBlocks({
      ocrBlocks: legacyBlocks, n, pageDims, rotateAngle: angle, keepItalic: true, upscale: res0.data.upscale,
    });
  } else if (options.lstm && !options.legacy) {
    const lstmBlocks = /** @type {Array<import('@scribe.js/tesseract.js').Block>} */(res0.data.blocks);
    resLSTM = await convertPageBlocks({
      ocrBlocks: lstmBlocks, n, pageDims, rotateAngle: angle, keepItalic: false, upscale: res0.data.upscale,
    });
  }

  const x = { recognize: res0.data, convert: { legacy: resLegacy, lstm: resLSTM } };

  parentPort.postMessage({ data: x, id, status: 'resolve' });

  // Both promises must resolve for the scheduler to move on, even if only one OCR engine is being run.
  if (!options.legacy || !options.lstm) parentPort.postMessage({ data: null, id: `${id}b` });
};

/**
 * @template {Partial<Tesseract.OutputFormats>} TO
 * @param {Object} args
 * @param {Parameters<Tesseract.Worker['recognize']>[0]} args.image
 * @param {Parameters<Tesseract.Worker['recognize']>[1]} args.options
 * @param {TO} args.output
 * @returns {Promise<Tesseract.Page<TO>>}
 * Exported for type inference purposes, should not be imported anywhere.
 */
export const recognize = async ({ image, options, output }) => {
  if (!worker) throw new Error('Worker not initialized');
  const res1 = await worker.recognize(image, options, output);
  return res1.data;
};

/**
 * Sets font data in `fontAll`.
 * Used to set font data in workers.
 * @param {Object} args
 * @param {Parameters<loadFontsFromSource>[0]} args.src
 * @param {Parameters<loadFontsFromSource>[1]} args.opt
 */
async function loadFontsWorker({ src, opt }) {
  const fonts = await loadFontsFromSource(src, opt);
  if (opt) {
    if (FontCont.opt) {
      Object.assign(FontCont.opt, fonts);
    } else {
      FontCont.opt = fonts;
    }
  } else if (FontCont.raw) {
    Object.assign(FontCont.raw, fonts);
  } else {
    FontCont.raw = fonts;
  }
  return true;
}

async function updateFontContWorker({
  rawMetrics, optMetrics, defaultFontName, sansDefaultName, serifDefaultName, enableOpt, forceOpt,
}) {
  if (sansDefaultName) FontCont.state.sansDefaultName = sansDefaultName;
  if (serifDefaultName) FontCont.state.serifDefaultName = serifDefaultName;
  if (defaultFontName) FontCont.state.defaultFontName = defaultFontName;
  if (rawMetrics) FontCont.rawMetrics = rawMetrics;
  if (optMetrics) FontCont.optMetrics = optMetrics;
  if (enableOpt === true || enableOpt === false) FontCont.state.enableOpt = enableOpt;
  if (forceOpt === true || forceOpt === false) FontCont.state.forceOpt = forceOpt;
}

async function compareOCRPageImpWrap(args) {
  args.options.tessWorker = worker;
  return await compareOCRPageImp(args);
}

const handleMessage = async (data) => {
  const func = data[0];
  const args = data[1];
  const id = data[2];

  if (func === 'recognizeAndConvert2') {
    recognizeAndConvert2(args, id);
    return;
  }

  ({
    // Convert page functions
    convertPageAbbyy,
    convertPageAlto,
    convertPageHocr,
    convertPageStext,
    convertDocTextract,
    convertDocAzureDocIntel,
    convertPageGoogleVision,
    convertPageBlocks,
    convertPageText,
    convertDocDocx,

    // Optimize font functions
    optimizeFont,

    // OCR comparison/evaluation functions
    evalPageFont,
    evalPageBase,
    evalWords,
    compareOCRPageImp: compareOCRPageImpWrap,
    nudgePageFontSize,
    nudgePageBaseline,
    renderPageStaticImp,

    // Recognition
    reinitialize,
    reinitialize2,
    recognize,
    recognizeAndConvert,

    // Change state of worker
    loadFontsWorker,
    updateFontContWorker,
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
