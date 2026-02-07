import getEnvironment from '../utils/getEnvironment.js';
import isURL from '../utils/isURL.js';
import { simd, relaxedSimd } from '../utils/wasmFeatureDetect.js';
import arrayBufferToBase64 from './utils/arrayBufferToBase64.js';
import {
  OEM, PSM, imageType, defaultParams, defaultOutput,
} from '../constants.js';

const env = getEnvironment('type');

const cache = {
  readCache: async (...args) => {
    let readCacheImp;
    if (env === 'browser') {
      readCacheImp = (await import('./browser/cache.js')).readCache;
    } else {
      readCacheImp = (await import('./node/cache.js')).readCache;
    }
    return readCacheImp(...args);
  },
  writeCache: async (...args) => {
    let writeCacheImp;
    if (env === 'browser') {
      writeCacheImp = (await import('./browser/cache.js')).writeCache;
    } else {
      writeCacheImp = (await import('./node/cache.js')).writeCache;
    }
    return writeCacheImp(...args);
  },
  deleteCache: async (...args) => {
    let deleteCacheImp;
    if (env === 'browser') {
      deleteCacheImp = (await import('./browser/cache.js')).deleteCache;
    } else {
      deleteCacheImp = (await import('./node/cache.js')).deleteCache;
    }
    return deleteCacheImp(...args);
  },
};

/**
 * setImage
 *
 * @name setImage
 * @function set image in tesseract for recognition
 * @access public
 */
const setImage = (TessModule, api, image, angle = 0, upscale = false) => {
  const exif = parseInt(image.slice(0, 500).join(' ').match(/1 18 0 3 0 0 0 1 0 (\d)/)?.[1], 10) || 1;

  TessModule.FS.writeFile('/input', image);

  const res = api.SetImageFile(exif, angle, upscale);
  if (res === 1) throw Error('Error attempting to read image.');
};

/**
 * Decompresses gzip data using native browser DecompressionStream API
 * @param {Uint8Array} data - The gzipped data to decompress
 * @returns {Promise<Uint8Array>} The decompressed data
 */
async function gunzip(data) {
  const ds = new DecompressionStream('gzip');
  const blob = new Blob([data]);
  const decompressedStream = blob.stream().pipeThrough(ds);
  const decompressedBlob = await new Response(decompressedStream).blob();
  const arrayBuffer = await decompressedBlob.arrayBuffer();
  return new Uint8Array(arrayBuffer);
}

const parentPort = typeof process === 'undefined' ? globalThis : (await import('node:worker_threads')).parentPort;
if (!parentPort) throw new Error('This file must be run in a worker');

let TesseractCore = null;

const getCore = async (oem, vanillaEngine, res) => {
  if (TesseractCore === null) {
    const statusText = 'loading tesseract core';

    const simdSupport = await simd();
    const relaxedSimdSupport = await relaxedSimd();
    res.progress({ status: statusText, progress: 0 });

    if (vanillaEngine) {
      if (relaxedSimdSupport) {
        if ([OEM.DEFAULT, OEM.LSTM_ONLY].includes(oem)) {
          TesseractCore = (await import('../core_vanilla/tesseract-core-relaxedsimd-lstm.js')).default;
        } else {
          TesseractCore = (await import('../core_vanilla/tesseract-core-relaxedsimd.js')).default;
        }
      } else if (simdSupport) {
        if ([OEM.DEFAULT, OEM.LSTM_ONLY].includes(oem)) {
          TesseractCore = (await import('../core_vanilla/tesseract-core-simd-lstm.js')).default;
        } else {
          TesseractCore = (await import('../core_vanilla/tesseract-core-simd.js')).default;
        }
      } else {
        throw Error('This runtime is not supported (WASM SIMD required).');
      }
    } else if (relaxedSimdSupport) {
      if ([OEM.DEFAULT, OEM.LSTM_ONLY].includes(oem)) {
        TesseractCore = (await import('../core/tesseract-core-relaxedsimd-lstm.js')).default;
      } else {
        TesseractCore = (await import('../core/tesseract-core-relaxedsimd.js')).default;
      }
    } else if (simdSupport) {
      if ([OEM.DEFAULT, OEM.LSTM_ONLY].includes(oem)) {
        TesseractCore = (await import('../core/tesseract-core-simd-lstm.js')).default;
      } else {
        TesseractCore = (await import('../core/tesseract-core-simd.js')).default;
      }
    } else {
      throw Error('This runtime is not supported (WASM SIMD required).');
    }

    res.progress({ status: statusText, progress: 1 });
  }
  return TesseractCore;
};

/**
 * deindent
 *
 * The generated HOCR is excessively indented, so
 * we get rid of that indentation
 *
 * @name deindent
 * @function deindent string
 * @access public
 */
const deindent = (html) => {
  const lines = html.split('\n');
  if (lines[0].substring(0, 2) === '  ') {
    for (let i = 0; i < lines.length; i += 1) {
      if (lines[i].substring(0, 2) === '  ') {
        lines[i] = lines[i].slice(2);
      }
    }
  }
  return lines.join('\n');
};

/**
 * dump
 *
 * @name dump
 * @function dump recognition result to a JSON object
 * @access public
 */
const dump = (TessModule, api, output, options) => {
  const enumToString = (value, prefix) => (
    Object.keys(TessModule)
      .filter((e) => (e.startsWith(`${prefix}_`) && TessModule[e] === value))
      .map((e) => e.slice(prefix.length + 1))[0]
  );

  const getImage = (type) => {
    api.WriteImage(type, '/image.png');
    const pngBuffer = TessModule.FS.readFile('/image.png');
    const pngStr = `data:image/png;base64,${arrayBufferToBase64(pngBuffer.buffer)}`;
    TessModule.FS.unlink('/image.png');
    return pngStr;
  };

  const getPDFInternal = (title, textonly) => {
    const pdfRenderer = new TessModule.TessPDFRenderer('tesseract-ocr', '/', textonly);
    pdfRenderer.BeginDocument(title);
    pdfRenderer.AddImage(api);
    pdfRenderer.EndDocument();
    TessModule._free(pdfRenderer);

    return TessModule.FS.readFile('/tesseract-ocr.pdf');
  };

  return {
    text: output.text ? api.GetUTF8Text() : null,
    hocr: output.hocr ? deindent(api.GetHOCRText()) : null,
    tsv: output.tsv ? api.GetTSVText() : null,
    box: output.box ? api.GetBoxText() : null,
    unlv: output.unlv ? api.GetUNLVText() : null,
    osd: output.osd ? api.GetOsdText() : null,
    pdf: output.pdf ? getPDFInternal(options.pdfTitle ?? 'Tesseract OCR Result', options.pdfTextOnly ?? false) : null,
    imageColor: output.imageColor ? getImage(imageType.COLOR) : null,
    imageGrey: output.imageGrey ? getImage(imageType.GREY) : null,
    imageBinary: output.imageBinary ? getImage(imageType.BINARY) : null,
    confidence: !options.skipRecognition ? api.MeanTextConf() : null,
    blocks: output.blocks && !options.skipRecognition ? JSON.parse(api.GetJSONText()).blocks : null,
    layoutBlocks: output.layoutBlocks && options.skipRecognition
      ? JSON.parse(api.GetJSONText()).blocks : null,
    psm: enumToString(api.GetPageSegMode(), 'PSM'),
    oem: enumToString(api.oem(), 'OEM'),
    version: api.Version(),
    debug: output.debug ? TessModule.FS.readFile('/debugInternal.txt', { encoding: 'utf8', flags: 'a+' }) : null,
    debugVis: output.debugVis ? TessModule.FS.readFile('/debugVisInternal.txt', { encoding: 'utf8', flags: 'a+' }) : null,
  };
};

/*
 * Tesseract Module returned by TesseractCore.
 */
let TessModule;
/*
 * TessearctBaseAPI instance
 */
let api = null;
let latestJob;
let params = defaultParams;
let loadLanguageLangsWorker;
let loadLanguageOptionsWorker;
let dataFromCache = false;

const load = async ({ workerId, jobId, payload: { options: { lstmOnly, vanillaEngine } } }, res) => { // eslint-disable-line max-len
  const statusText = 'initializing tesseract';

  if (!TessModule) {
    const Core = await getCore(lstmOnly, vanillaEngine, res);

    res.progress({ workerId, status: statusText, progress: 0 });

    Core({
      TesseractProgress(percent) {
        latestJob.progress({
          workerId,
          jobId,
          status: 'recognizing text',
          progress: Math.max(0, (percent - 30) / 70),
        });
      },
    }).then((tessModule) => {
      TessModule = tessModule;
      res.progress({ workerId, status: statusText, progress: 1 });
      res.resolve({ loaded: true });
    });
  } else {
    res.resolve({ loaded: true });
  }
};

const loadLanguage = async (
  {
    workerId,
    payload: {
      langs,
      options: {
        langPath,
        dataPath,
        cachePath,
        cacheMethod,
        gzip = true,
        lstmOnly,
      },
    },
  },
  res,
) => {
  // Remember options for later, as cache may be deleted if `initialize` fails
  loadLanguageLangsWorker = langs;
  loadLanguageOptionsWorker = {
    langPath,
    dataPath,
    cachePath,
    cacheMethod,
    gzip,
    lstmOnly,
  };

  const statusText = 'loading language traineddata';

  const langsArr = typeof langs === 'string' ? langs.split('+') : langs;
  let progress = 0;

  const loadAndGunzipFile = async (_lang) => {
    const lang = typeof _lang === 'string' ? _lang : _lang.code;
    const readCache = ['refresh', 'none'].includes(cacheMethod)
      ? () => Promise.resolve()
      : cache.readCache;
    let data = null;
    let newData = false;

    // Check for existing .traineddata file in cache
    // This automatically fails if cacheMethod is set to 'refresh' or 'none'
    try {
      const _data = await readCache(`${cachePath || '.'}/${lang}.traineddata`);
      if (typeof _data !== 'undefined') {
        data = _data;
        dataFromCache = true;
      } else {
        throw Error('Not found in cache');
      }
    // Attempt to fetch new .traineddata file
    } catch (e) {
      newData = true;
      if (typeof _lang === 'string') {
        let path = null;

        // If `langPath` if not explicitly set by the user, the jsdelivr CDN is used.
        // Data supporting the Legacy model is only included if `lstmOnly` is not true.
        // This saves a significant amount of data for the majority of users that use LSTM only.
        const langPathDownload = langPath || (lstmOnly ? `https://cdn.jsdelivr.net/npm/@tesseract.js-data/${lang}/4.0.0_best_int` : `https://cdn.jsdelivr.net/npm/@tesseract.js-data/${lang}/4.0.0`);

        // For Node.js, langPath may be a URL or local file path
        // For the browser version, langPath is assumed to be a URL
        if (env !== 'node' || isURL(langPathDownload) || langPathDownload.startsWith('moz-extension://') || langPathDownload.startsWith('chrome-extension://') || langPathDownload.startsWith('file://')) { /** When langPathDownload is an URL */
          path = langPathDownload.replace(/\/$/, '');
        }

        // langPathDownload is a URL, fetch from server
        if (path !== null) {
          const fetchUrl = `${path}/${lang}.traineddata${gzip ? '.gz' : ''}`;
          const resp = await fetch(fetchUrl);
          if (!resp.ok) {
            throw Error(`Network error while fetching ${fetchUrl}. Response code: ${resp.status}`);
          }
          data = new Uint8Array(await resp.arrayBuffer());

        // langPathDownload is a local file, read .traineddata from local filesystem
        // (cache.readCache is a generic file read function in Node.js version)
        } else {
          data = await cache.readCache(`${langPathDownload}/${lang}.traineddata${gzip ? '.gz' : ''}`);
        }
      } else {
        data = _lang.data; // eslint-disable-line
      }
    }

    progress += 0.5 / langsArr.length;
    if (res) res.progress({ workerId, status: statusText, progress });

    // Check for gzip magic numbers (1F and 8B in hex)
    const isGzip = (data[0] === 31 && data[1] === 139) || (data[1] === 31 && data[0] === 139);

    if (isGzip) {
      data = await gunzip(data);
    }

    if (TessModule) {
      if (dataPath) {
        try {
          TessModule.FS.mkdir(dataPath);
        } catch (err) {
          if (res) res.reject(err.toString());
        }
      }
      TessModule.FS.writeFile(`${dataPath || '.'}/${lang}.traineddata`, data);
    }

    if (newData && ['write', 'refresh', undefined].includes(cacheMethod)) {
      try {
        await cache.writeCache(`${cachePath || '.'}/${lang}.traineddata`, data);
      // eslint-disable-next-line no-empty
      } catch (err) {
      }
    }

    progress += 0.5 / langsArr.length;
    // Make sure last progress message is 1 (not 0.9999)
    if (Math.round(progress * 100) === 100) progress = 1;
    if (res) res.progress({ workerId, status: statusText, progress });
  };

  if (res) res.progress({ workerId, status: statusText, progress: 0 });
  try {
    await Promise.all(langsArr.map(loadAndGunzipFile));
    if (res) res.resolve(langs);
  } catch (err) {
    if (res) res.reject(err.toString());
  }
};

const setParameters = async ({ payload: { params: _params } }, res) => {
  // A small number of parameters can only be set at initialization.
  // These can only be set using (1) the `oem` argument of `initialize` (for setting the oem)
  // or (2) the `config` argument of `initialize` (for all other settings).
  // Attempting to set these using this function will have no impact so a warning is printed.
  // This list is generated by searching the Tesseract codebase for parameters
  // defined with `[type]_INIT_MEMBER` rather than `[type]_MEMBER`.
  const initParamNames = ['ambigs_debug_level', 'user_words_suffix', 'user_patterns_suffix', 'user_patterns_suffix',
    'load_system_dawg', 'load_freq_dawg', 'load_unambig_dawg', 'load_punc_dawg', 'load_number_dawg', 'load_bigram_dawg',
    'tessedit_ocr_engine_mode', 'tessedit_init_config_only', 'language_model_ngram_on', 'language_model_use_sigmoidal_certainty'];

  const initParamStr = Object.keys(_params)
    .filter((k) => initParamNames.includes(k))
    .join(', ');

  if (initParamStr.length > 0) console.log(`Attempted to set parameters that can only be set during initialization: ${initParamStr}`);

  Object.keys(_params)
    .filter((k) => !k.startsWith('tessjs_'))
    .forEach((key) => {
      api.SetVariable(key, _params[key]);
    });
  params = { ...params, ..._params };

  if (typeof res !== 'undefined') {
    res.resolve(params);
  }
};

const initialize = async ({
  workerId,
  payload: { langs: _langs, oem, config },
}, res) => {
  const langs = (typeof _langs === 'string')
    ? _langs
    : _langs.map((l) => ((typeof l === 'string') ? l : l.data)).join('+');

  const statusText = 'initializing api';

  try {
    res.progress({
      workerId, status: statusText, progress: 0,
    });
    if (api !== null) {
      api.End();
    }
    let configFile;
    let configStr;
    // config argument may either be config file text, or object with key/value pairs
    // In the latter case we convert to config file text here
    if (config && typeof config === 'object' && Object.keys(config).length > 0) {
      configStr = JSON.stringify(config).replace(/,/g, '\n').replace(/:/g, ' ').replace(/["'{}]/g, '');
    } else if (config && typeof config === 'string') {
      configStr = config;
    }
    if (typeof configStr === 'string') {
      configFile = '/config';
      TessModule.FS.writeFile(configFile, configStr);
    }

    api = new TessModule.TessBaseAPI();
    let status = api.Init(null, langs, oem, configFile);
    if (status === -1) {
      // Cache is deleted if initialization fails to avoid keeping bad data in cache
      // This assumes that initialization failing only occurs due to bad .traineddata,
      // this should be refined if other reasons for init failing are encountered.
      // The "if" condition skips this section if either (1) cache is disabled [so the issue
      // is definitely unrelated to cached data] or (2) cache is set to read-only
      // [so we do not have permission to make any changes].
      if (['write', 'refresh', undefined].includes(loadLanguageOptionsWorker.cacheMethod)) {
        const langsArr = langs.split('+');
        const delCachePromise = langsArr.map((lang) => cache.deleteCache(`${loadLanguageOptionsWorker.cachePath || '.'}/${lang}.traineddata`));
        await Promise.all(delCachePromise);

        // Check for the case when (1) data was loaded from the cache and
        // (2) the data does not support the requested OEM.
        // In this case, loadLanguage is re-run and initialization is attempted a second time.
        // This is because `loadLanguage` has no mechanism for checking whether the cached data
        // supports the requested model, so this only becomes apparent when initialization fails.

        // Check for this error message:
        // eslint-disable-next-line
        // "Tesseract (legacy) engine requested, but components are not present in ./eng.traineddata!!""
        // The .wasm build of Tesseract saves this message in a separate file
        // (in addition to the normal debug file location).
        const debugStr = TessModule.FS.readFile('/debugDev.txt', { encoding: 'utf8', flags: 'a+' });
        if (dataFromCache && /components are not present/.test(debugStr)) {
          // In this case, language data is re-loaded
          await loadLanguage({ workerId, payload: { langs: loadLanguageLangsWorker, options: loadLanguageOptionsWorker } }); // eslint-disable-line max-len
          status = api.Init(null, langs, oem, configFile);
          if (status === -1) {
            const delCachePromise2 = langsArr.map((lang) => cache.deleteCache(`${loadLanguageOptionsWorker.cachePath || '.'}/${lang}.traineddata`));
            await Promise.all(delCachePromise2);
          }
        }
      }
    }

    if (status === -1) {
      res.reject('initialization failed');
    }

    res.progress({
      workerId, status: statusText, progress: 1,
    });
    res.resolve();
  } catch (err) {
    res.reject(err.toString());
  }
};

// Combines default output with user-specified options and
// counts (1) total output formats requested and (2) outputs that require OCR
const processOutput = (output) => {
  const workingOutput = JSON.parse(JSON.stringify(defaultOutput));
  // Output formats were set using `setParameters` in previous versions
  // These settings are copied over for compatability
  if (params.tessjs_create_box === '1') workingOutput.box = true;
  if (params.tessjs_create_hocr === '1') workingOutput.hocr = true;
  if (params.tessjs_create_osd === '1') workingOutput.osd = true;
  if (params.tessjs_create_tsv === '1') workingOutput.tsv = true;
  if (params.tessjs_create_unlv === '1') workingOutput.unlv = true;

  const nonRecOutputs = ['imageColor', 'imageGrey', 'imageBinary', 'layoutBlocks', 'debug'];
  let recOutputCount = 0;
  for (const prop of Object.keys(output)) {
    workingOutput[prop] = output[prop];
  }
  for (const prop of Object.keys(workingOutput)) {
    if (workingOutput[prop]) {
      if (!nonRecOutputs.includes(prop)) {
        recOutputCount += 1;
      }
    }
  }
  const skipRecognition = recOutputCount === 0;
  return { workingOutput, skipRecognition };
};

// List of options for Tesseract.js (rather than passed through to Tesseract),
// not including those with prefix "tessjs_"
const tessjsOptions = ['rectangle', 'pdfTitle', 'pdfTextOnly', 'rotateAuto', 'rotateRadians', 'lstm', 'legacy', 'upscale'];

const recognize = async ({
  payload: {
    image, options, output,
  },
}, res) => {
  try {
    const upscale = options.upscale || false;
    const optionsTess = {};
    if (typeof options === 'object' && Object.keys(options).length > 0) {
      // The options provided by users contain a mix of options for Tesseract.js
      // and parameters passed through to Tesseract.
      for (const param of Object.keys(options)) {
        if (!param.startsWith('tessjs_') && !tessjsOptions.includes(param)) {
          optionsTess[param] = options[param];
        }
      }
    }
    if (output.debug) {
      optionsTess.debug_file = '/debugInternal.txt';
      TessModule.FS.writeFile('/debugInternal.txt', '');
    }
    // If any parameters are changed here they are changed back at the end
    if (Object.keys(optionsTess).length > 0) {
      api.SaveParameters();
      for (const prop of Object.keys(optionsTess)) {
        api.SetVariable(prop, optionsTess[prop]);
      }
    }

    const { workingOutput, skipRecognition } = processOutput(output);

    // When the auto-rotate option is True, setImage is called with no angle,
    // then the angle is calculated by Tesseract and then setImage is re-called.
    // Otherwise, setImage is called once using the user-provided rotateRadiansFinal value.
    let rotateRadiansFinal;
    if (options.rotateAuto) {
      // The angle is only detected if auto page segmentation is used
      // Therefore, if this is not the mode specified by the user, it is enabled temporarily here
      const psmInit = api.GetPageSegMode();
      let psmEdit = false;
      if (![PSM.AUTO, PSM.AUTO_ONLY, PSM.OSD].includes(psmInit)) {
        psmEdit = true;
        api.SetVariable('tessedit_pageseg_mode', String(PSM.AUTO));
      }

      setImage(TessModule, api, image, 0, upscale);
      api.FindLines();

      // The function GetAngle will be replaced with GetGradient in 4.0.4,
      // but for now we want to maintain compatibility.
      // We can switch to only using GetGradient in v5.
      const rotateRadiansCalc = api.GetGradient ? api.GetGradient() : api.GetAngle();

      // Restore user-provided PSM setting
      if (psmEdit) {
        api.SetVariable('tessedit_pageseg_mode', String(psmInit));
      }

      // Small angles (<0.005 radians/~0.3 degrees) are ignored to save on runtime
      if (Math.abs(rotateRadiansCalc) >= 0.005) {
        rotateRadiansFinal = rotateRadiansCalc;
        setImage(TessModule, api, image, rotateRadiansFinal, upscale);
      } else {
        // Image needs to be reset if run with different PSM setting earlier
        if (psmEdit) {
          setImage(TessModule, api, image, 0, upscale);
        }
        rotateRadiansFinal = 0;
      }
    } else {
      rotateRadiansFinal = options.rotateRadians || 0;
      setImage(TessModule, api, image, rotateRadiansFinal, upscale);
    }

    const rec = options.rectangle;
    if (typeof rec === 'object') {
      api.SetRectangle(rec.left, rec.top, rec.width, rec.height);
    }

    if (!skipRecognition) {
      api.Recognize(null);
    } else if (output.layoutBlocks) {
      api.AnalyseLayout();
    }
    const { pdfTitle } = options;
    const { pdfTextOnly } = options;
    const result = dump(TessModule, api, workingOutput, { pdfTitle, pdfTextOnly, skipRecognition });
    result.rotateRadians = rotateRadiansFinal;

    if (output.debug) TessModule.FS.unlink('/debugInternal.txt');

    if (Object.keys(optionsTess).length > 0) {
      api.RestoreParameters();
    }

    res.resolve(result);
  } catch (err) {
    res.reject(err.toString());
  }
};

const recognize2 = async ({
  payload: {
    image, options, output,
  },
}, res, resB) => {
  try {
    const lstm = options.lstm || false;
    const legacy = options.legacy || false;
    const upscale = options.upscale || false;

    const optionsTess = {};
    if (typeof options === 'object' && Object.keys(options).length > 0) {
      // The options provided by users contain a mix of options for Tesseract.js
      // and parameters passed through to Tesseract.
      for (const param of Object.keys(options)) {
        if (!param.startsWith('tessjs_') && !tessjsOptions.includes(param)) {
          optionsTess[param] = options[param];
        }
      }
    }
    if (output.debug) {
      optionsTess.debug_file = '/debugInternal.txt';
      TessModule.FS.writeFile('/debugInternal.txt', '');
    }
    if (output.debugVis) {
      optionsTess.vis_file = '/debugVisInternal.txt';

      // Enable debugging options
      optionsTess.textord_tabfind_show_blocks = '1';
      optionsTess.textord_tabfind_show_strokewidths = '1';
      optionsTess.textord_tabfind_show_initialtabs = '1';
      optionsTess.textord_tabfind_show_images = '1';
      optionsTess.textord_tabfind_show_reject_blobs = '1';
      optionsTess.textord_tabfind_show_finaltabs = '1';
      optionsTess.textord_tabfind_show_columns = '1';
      optionsTess.textord_tabfind_show_initial_partitions = '1';
      optionsTess.textord_show_tables = '1';
      optionsTess.textord_tabfind_show_partitions = '1';
      optionsTess.textord_tabfind_show_vlines_scrollview = '1';
      optionsTess.tessedit_dump_pageseg_images = '1';
      optionsTess.textord_debug_nontext = '1';
      optionsTess.textord_show_word_blobs = '1';

      TessModule.FS.writeFile('/debugVisInternal.txt', '');
    }
    // If any parameters are changed here they are changed back at the end
    if (Object.keys(optionsTess).length > 0) {
      api.SaveParameters();
      for (const prop of Object.keys(optionsTess)) {
        api.SetVariable(prop, optionsTess[prop]);
      }
    }

    const { workingOutput, skipRecognition } = processOutput(output);

    // When the auto-rotate option is True, setImage is called with no angle,
    // then the angle is calculated by Tesseract and then setImage is re-called.
    // Otherwise, setImage is called once using the user-provided rotateRadiansFinal value.
    let rotateRadiansFinal;

    // TODO: Auto upscaling only works when auto rotation is enabled.
    // This is fine for Scribe.js but we may want to change this in the future.
    let upscaleFinal = upscale;
    if (options.rotateAuto) {
      // The angle is only detected if auto page segmentation is used
      // Therefore, if this is not the mode specified by the user, it is enabled temporarily here
      const psmInit = api.GetPageSegMode();
      let psmEdit = false;
      if (![PSM.AUTO, PSM.AUTO_ONLY, PSM.OSD].includes(String(psmInit))) {
        psmEdit = true;
        api.SetVariable('tessedit_pageseg_mode', String(PSM.AUTO));
      }

      setImage(TessModule, api, image, 0, upscale);
      api.FindLines();

      // The function GetAngle will be replaced with GetGradient in 4.0.4,
      // but for now we want to maintain compatibility.
      // We can switch to only using GetGradient in v5.
      const rotateRadiansCalc = api.GetGradient ? api.GetGradient() : api.GetAngle();

      const estimatedResolution = api.GetEstimatedResolution();

      upscaleFinal = estimatedResolution < 200 ? true : upscale;
      const upscaleEdit = upscaleFinal !== upscale;

      // Restore user-provided PSM setting
      if (psmEdit) {
        api.SetVariable('tessedit_pageseg_mode', String(psmInit));
      }

      // Small angles (<0.005 radians/~0.3 degrees) are ignored to save on runtime
      if (Math.abs(rotateRadiansCalc) >= 0.005) {
        rotateRadiansFinal = rotateRadiansCalc;
        // Clear debug visualization file to avoid duplicative visualizations
        if (output.debugVis) TessModule.FS.writeFile('/debugVisInternal.txt', '');
        setImage(TessModule, api, image, rotateRadiansFinal, upscaleFinal);
      } else {
        // Image needs to be reset if run with different PSM setting earlier
        if (psmEdit || upscaleEdit) {
          // Clear debug visualization file to avoid duplicative visualizations
          if (output.debugVis) TessModule.FS.writeFile('/debugVisInternal.txt', '');
          setImage(TessModule, api, image, 0, upscaleFinal);
        }
        rotateRadiansFinal = 0;
      }
    } else {
      rotateRadiansFinal = options.rotateRadians || 0;
      setImage(TessModule, api, image, rotateRadiansFinal, upscale);
    }

    const rec = options.rectangle;
    if (typeof rec === 'object') {
      api.SetRectangle(rec.left, rec.top, rec.width, rec.height);
    }

    if (!skipRecognition) {
      if (legacy) {
        api.SetVariable('tessedit_ocr_engine_mode', '0');
      } else {
        api.SetVariable('tessedit_ocr_engine_mode', '1');
      }
      api.Recognize(null);
    } else if (output.layoutBlocks) {
      api.AnalyseLayout();
    }
    const { pdfTitle } = options;
    const { pdfTextOnly } = options;
    const result = dump(TessModule, api, workingOutput, { pdfTitle, pdfTextOnly, skipRecognition });
    result.rotateRadians = rotateRadiansFinal;
    result.upscale = upscaleFinal;

    if (output.debugVis) {
      // Disable debugging options.
      // This should happen before running the LSTM model to avoid duplicating visualizations.
      api.SetVariable('textord_tabfind_show_blocks', '0');
      api.SetVariable('textord_tabfind_show_strokewidths', '0');
      api.SetVariable('textord_tabfind_show_initialtabs', '0');
      api.SetVariable('textord_tabfind_show_images', '0');
      api.SetVariable('textord_tabfind_show_reject_blobs', '0');
      api.SetVariable('textord_tabfind_show_finaltabs', '0');
      api.SetVariable('textord_tabfind_show_columns', '0');
      api.SetVariable('textord_tabfind_show_initial_partitions', '0');
      api.SetVariable('textord_show_tables', '0');
      api.SetVariable('textord_tabfind_show_partitions', '0');
      api.SetVariable('textord_tabfind_show_vlines_scrollview', '0');
      api.SetVariable('tessedit_dump_pageseg_images', '0');
      api.SetVariable('textord_debug_nontext', '0');
      api.SetVariable('textord_show_word_blobs', '0');
    }

    res.resolve(result);

    let result2;
    if (!skipRecognition && legacy && lstm) {
      api.SetVariable('tessedit_ocr_engine_mode', '1');
      api.Recognize(null);
      // Intermediate images are only returned in the first promise.
      // They would be identical, so there is no reason to incur more memory/runtime costs.
      workingOutput.imageColor = false;
      workingOutput.imageGrey = false;
      workingOutput.imageBinary = false;
      result2 = dump(TessModule, api, workingOutput, { pdfTitle, pdfTextOnly, skipRecognition });
    }

    if (output.debug) TessModule.FS.unlink('/debugInternal.txt');
    if (output.debugVis) TessModule.FS.unlink('/debugVisInternal.txt');

    if (Object.keys(optionsTess).length > 0) {
      api.RestoreParameters();
    }

    resB.resolve(result2);
  } catch (err) {
    res.reject(err.toString());
  }
};

const terminate = async (_, res) => {
  try {
    if (api !== null) {
      api.End();
    }
    res.resolve({ terminated: true });
  } catch (err) {
    res.reject(err.toString());
  }
};

/**
 * dispatchHandlers
 *
 * @name dispatchHandlers
 * @function worker data handler
 * @access public
 * @param {object} data
 * @param {string} data.jobId - unique job id
 * @param {string} data.action - action of the job, only recognize and detect for now
 * @param {object} data.payload - data for the job
 * @param {function} send - trigger job to work
 */
export const dispatchHandlers = (packet, send) => {
  const res = (status, data) => {
    // Return only the necessary info to avoid sending unnecessarily large messages
    const packetRes = {
      jobId: packet.jobId,
      workerId: packet.workerId,
      action: packet.action,
    };
    send({
      ...packetRes,
      status,
      data,
    });
  };
  res.resolve = res.bind(this, 'resolve');
  res.reject = res.bind(this, 'reject');
  res.progress = res.bind(this, 'progress');

  latestJob = res;

  const resB = (status, data) => {
    // Return only the necessary info to avoid sending unnecessarily large messages
    const packetRes = {
      jobId: `${packet.jobId}b`,
      workerId: packet.workerId,
      action: packet.action,
    };
    send({
      ...packetRes,
      status,
      data,
    });
  };
  resB.resolve = resB.bind(this, 'resolve');
  resB.reject = resB.bind(this, 'reject');
  resB.progress = resB.bind(this, 'progress');

  ({
    load,
    loadLanguage,
    initialize,
    setParameters,
    recognize,
    recognize2,
    terminate,
  })[packet.action](packet, res, resB)
    .catch((err) => res.reject(err.toString()));
};

if (typeof process === 'undefined') {
  globalThis.addEventListener('message', ({ data }) => {
    dispatchHandlers(data, (obj) => postMessage(obj));
  });
} else {
  parentPort.on('message', (packet) => {
    dispatchHandlers(packet, (obj) => parentPort.postMessage(obj));
  });
}

parentPort.postMessage({
  data: 'ready', jobId: 'ready', status: 'resolve', action: 'ready',
});
