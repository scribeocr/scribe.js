import {
  checkMultiFontMode,
  FontCont,
  FontContainerFont,
  loadFont,
  loadFontsFromSource,
  loadOpentype,
} from './containers/fontContainer.js';
import { gs } from './generalWorkerMain.js';

/**
 * Load all raw (unoptimized) fonts.  This function is where font file names are hard-coded.
 * @param {('latin'|'all')} [glyphSet='latin'] - The set of glyphs to load.  'latin' includes only Latin characters, while 'all' includes Latin, Greek, and Cyrillic characters.
 *    This parameter does not matter for Node.js, which loads a `.ttf` version of the `all` set, regardless of this option.
 */
export async function loadBuiltInFontsRaw(glyphSet = 'latin') {
  // Return early if the font set is already loaded, or a superset of the requested set is loaded.
  if (FontCont.state.glyphSet === glyphSet || FontCont.state.glyphSet === 'all' && glyphSet === 'latin') return;

  FontCont.state.glyphSet = glyphSet;

  // Note: this function is intentionally verbose, and should not be refactored to generate the paths dynamically.
  // Build systems will not be able to resolve the paths if they are generated dynamically.
  let /** @type {Promise<ArrayBuffer>} */carlitoNormal;
  let /** @type {Promise<ArrayBuffer>} */carlitoItalic;
  let /** @type {Promise<ArrayBuffer>} */carlitoBold;
  let /** @type {Promise<ArrayBuffer>} */carlitoBoldItalic;
  let /** @type {Promise<ArrayBuffer>} */centuryNormal;
  let /** @type {Promise<ArrayBuffer>} */centuryItalic;
  let /** @type {Promise<ArrayBuffer>} */centuryBold;
  let /** @type {Promise<ArrayBuffer>} */centuryBoldItalic;
  let /** @type {Promise<ArrayBuffer>} */garamondNormal;
  let /** @type {Promise<ArrayBuffer>} */garamondItalic;
  let /** @type {Promise<ArrayBuffer>} */garamondBold;
  let /** @type {Promise<ArrayBuffer>} */garamondBoldItalic;
  let /** @type {Promise<ArrayBuffer>} */palatinoNormal;
  let /** @type {Promise<ArrayBuffer>} */palatinoItalic;
  let /** @type {Promise<ArrayBuffer>} */palatinoBold;
  let /** @type {Promise<ArrayBuffer>} */palatinoBoldItalic;
  let /** @type {Promise<ArrayBuffer>} */nimbusRomanNormal;
  let /** @type {Promise<ArrayBuffer>} */nimbusRomanItalic;
  let /** @type {Promise<ArrayBuffer>} */nimbusRomanBold;
  let /** @type {Promise<ArrayBuffer>} */nimbusRomanBoldItalic;
  let /** @type {Promise<ArrayBuffer>} */nimbusSansNormal;
  let /** @type {Promise<ArrayBuffer>} */nimbusSansItalic;
  let /** @type {Promise<ArrayBuffer>} */nimbusSansBold;
  let /** @type {Promise<ArrayBuffer>} */nimbusSansBoldItalic;
  let /** @type {Promise<ArrayBuffer>} */nimbusMonoNormal;
  let /** @type {Promise<ArrayBuffer>} */nimbusMonoItalic;
  let /** @type {Promise<ArrayBuffer>} */nimbusMonoBold;
  let /** @type {Promise<ArrayBuffer>} */nimbusMonoBoldItalic;
  let /** @type {Promise<ArrayBuffer>} */gothicNormal;
  let /** @type {Promise<ArrayBuffer>} */gothicItalic;
  let /** @type {Promise<ArrayBuffer>} */gothicBold;
  let /** @type {Promise<ArrayBuffer>} */gothicBoldItalic;
  if (typeof process === 'undefined') {
    if (glyphSet === 'latin') {
      carlitoNormal = fetch(new URL('../fonts/latin/Carlito-Regular.woff', import.meta.url)).then((res) => res.arrayBuffer());
      carlitoItalic = fetch(new URL('../fonts/latin/Carlito-Italic.woff', import.meta.url)).then((res) => res.arrayBuffer());
      carlitoBold = fetch(new URL('../fonts/latin/Carlito-Bold.woff', import.meta.url)).then((res) => res.arrayBuffer());
      carlitoBoldItalic = fetch(new URL('../fonts/latin/Carlito-BoldItalic.woff', import.meta.url)).then((res) => res.arrayBuffer());
      centuryNormal = fetch(new URL('../fonts/latin/Century-Regular.woff', import.meta.url)).then((res) => res.arrayBuffer());
      centuryItalic = fetch(new URL('../fonts/latin/Century-Italic.woff', import.meta.url)).then((res) => res.arrayBuffer());
      centuryBold = fetch(new URL('../fonts/latin/Century-Bold.woff', import.meta.url)).then((res) => res.arrayBuffer());
      centuryBoldItalic = fetch(new URL('../fonts/latin/Century-BoldItalic.woff', import.meta.url)).then((res) => res.arrayBuffer());
      garamondNormal = fetch(new URL('../fonts/latin/Garamond-Regular.woff', import.meta.url)).then((res) => res.arrayBuffer());
      garamondItalic = fetch(new URL('../fonts/latin/Garamond-Italic.woff', import.meta.url)).then((res) => res.arrayBuffer());
      garamondBold = fetch(new URL('../fonts/latin/Garamond-Bold.woff', import.meta.url)).then((res) => res.arrayBuffer());
      garamondBoldItalic = fetch(new URL('../fonts/latin/Garamond-BoldItalic.woff', import.meta.url)).then((res) => res.arrayBuffer());
      palatinoNormal = fetch(new URL('../fonts/latin/Palatino-Regular.woff', import.meta.url)).then((res) => res.arrayBuffer());
      palatinoItalic = fetch(new URL('../fonts/latin/Palatino-Italic.woff', import.meta.url)).then((res) => res.arrayBuffer());
      palatinoBold = fetch(new URL('../fonts/latin/Palatino-Bold.woff', import.meta.url)).then((res) => res.arrayBuffer());
      palatinoBoldItalic = fetch(new URL('../fonts/latin/Palatino-BoldItalic.woff', import.meta.url)).then((res) => res.arrayBuffer());
      nimbusRomanNormal = fetch(new URL('../fonts/latin/NimbusRoman-Regular.woff', import.meta.url)).then((res) => res.arrayBuffer());
      nimbusRomanItalic = fetch(new URL('../fonts/latin/NimbusRoman-Italic.woff', import.meta.url)).then((res) => res.arrayBuffer());
      nimbusRomanBold = fetch(new URL('../fonts/latin/NimbusRoman-Bold.woff', import.meta.url)).then((res) => res.arrayBuffer());
      nimbusRomanBoldItalic = fetch(new URL('../fonts/latin/NimbusRoman-BoldItalic.woff', import.meta.url)).then((res) => res.arrayBuffer());
      nimbusSansNormal = fetch(new URL('../fonts/latin/NimbusSans-Regular.woff', import.meta.url)).then((res) => res.arrayBuffer());
      nimbusSansItalic = fetch(new URL('../fonts/latin/NimbusSans-Italic.woff', import.meta.url)).then((res) => res.arrayBuffer());
      nimbusSansBold = fetch(new URL('../fonts/latin/NimbusSans-Bold.woff', import.meta.url)).then((res) => res.arrayBuffer());
      nimbusSansBoldItalic = fetch(new URL('../fonts/latin/NimbusSans-BoldItalic.woff', import.meta.url)).then((res) => res.arrayBuffer());
      nimbusMonoNormal = fetch(new URL('../fonts/latin/NimbusMono-Regular.woff', import.meta.url)).then((res) => res.arrayBuffer());
      nimbusMonoItalic = fetch(new URL('../fonts/latin/NimbusMono-Italic.woff', import.meta.url)).then((res) => res.arrayBuffer());
      nimbusMonoBold = fetch(new URL('../fonts/latin/NimbusMono-Bold.woff', import.meta.url)).then((res) => res.arrayBuffer());
      nimbusMonoBoldItalic = fetch(new URL('../fonts/latin/NimbusMono-BoldItalic.woff', import.meta.url)).then((res) => res.arrayBuffer());
      gothicNormal = fetch(new URL('../fonts/latin/URWGothicBook-Regular.woff', import.meta.url)).then((res) => res.arrayBuffer());
      gothicItalic = fetch(new URL('../fonts/latin/URWGothicBook-Italic.woff', import.meta.url)).then((res) => res.arrayBuffer());
      gothicBold = fetch(new URL('../fonts/latin/URWGothicBook-Bold.woff', import.meta.url)).then((res) => res.arrayBuffer());
      gothicBoldItalic = fetch(new URL('../fonts/latin/URWGothicBook-BoldItalic.woff', import.meta.url)).then((res) => res.arrayBuffer());
    } else {
      carlitoNormal = fetch(new URL('../fonts/all/Carlito-Regular.woff', import.meta.url)).then((res) => res.arrayBuffer());
      carlitoItalic = fetch(new URL('../fonts/all/Carlito-Italic.woff', import.meta.url)).then((res) => res.arrayBuffer());
      carlitoBold = fetch(new URL('../fonts/all/Carlito-Bold.woff', import.meta.url)).then((res) => res.arrayBuffer());
      carlitoBoldItalic = fetch(new URL('../fonts/all/Carlito-BoldItalic.woff', import.meta.url)).then((res) => res.arrayBuffer());
      centuryNormal = fetch(new URL('../fonts/all/Century-Regular.woff', import.meta.url)).then((res) => res.arrayBuffer());
      centuryItalic = fetch(new URL('../fonts/all/Century-Italic.woff', import.meta.url)).then((res) => res.arrayBuffer());
      centuryBold = fetch(new URL('../fonts/all/Century-Bold.woff', import.meta.url)).then((res) => res.arrayBuffer());
      centuryBoldItalic = fetch(new URL('../fonts/all/Century-BoldItalic.woff', import.meta.url)).then((res) => res.arrayBuffer());
      garamondNormal = fetch(new URL('../fonts/all/Garamond-Regular.woff', import.meta.url)).then((res) => res.arrayBuffer());
      garamondItalic = fetch(new URL('../fonts/all/Garamond-Italic.woff', import.meta.url)).then((res) => res.arrayBuffer());
      garamondBold = fetch(new URL('../fonts/all/Garamond-Bold.woff', import.meta.url)).then((res) => res.arrayBuffer());
      garamondBoldItalic = fetch(new URL('../fonts/all/Garamond-BoldItalic.woff', import.meta.url)).then((res) => res.arrayBuffer());
      palatinoNormal = fetch(new URL('../fonts/all/Palatino-Regular.woff', import.meta.url)).then((res) => res.arrayBuffer());
      palatinoItalic = fetch(new URL('../fonts/all/Palatino-Italic.woff', import.meta.url)).then((res) => res.arrayBuffer());
      palatinoBold = fetch(new URL('../fonts/all/Palatino-Bold.woff', import.meta.url)).then((res) => res.arrayBuffer());
      palatinoBoldItalic = fetch(new URL('../fonts/all/Palatino-BoldItalic.woff', import.meta.url)).then((res) => res.arrayBuffer());
      nimbusRomanNormal = fetch(new URL('../fonts/all/NimbusRoman-Regular.woff', import.meta.url)).then((res) => res.arrayBuffer());
      nimbusRomanItalic = fetch(new URL('../fonts/all/NimbusRoman-Italic.woff', import.meta.url)).then((res) => res.arrayBuffer());
      nimbusRomanBold = fetch(new URL('../fonts/all/NimbusRoman-Bold.woff', import.meta.url)).then((res) => res.arrayBuffer());
      nimbusRomanBoldItalic = fetch(new URL('../fonts/all/NimbusRoman-BoldItalic.woff', import.meta.url)).then((res) => res.arrayBuffer());
      nimbusSansNormal = fetch(new URL('../fonts/all/NimbusSans-Regular.woff', import.meta.url)).then((res) => res.arrayBuffer());
      nimbusSansItalic = fetch(new URL('../fonts/all/NimbusSans-Italic.woff', import.meta.url)).then((res) => res.arrayBuffer());
      nimbusSansBold = fetch(new URL('../fonts/all/NimbusSans-Bold.woff', import.meta.url)).then((res) => res.arrayBuffer());
      nimbusSansBoldItalic = fetch(new URL('../fonts/all/NimbusSans-BoldItalic.woff', import.meta.url)).then((res) => res.arrayBuffer());
      nimbusMonoNormal = fetch(new URL('../fonts/all/NimbusMono-Regular.woff', import.meta.url)).then((res) => res.arrayBuffer());
      nimbusMonoItalic = fetch(new URL('../fonts/all/NimbusMono-Italic.woff', import.meta.url)).then((res) => res.arrayBuffer());
      nimbusMonoBold = fetch(new URL('../fonts/all/NimbusMono-Bold.woff', import.meta.url)).then((res) => res.arrayBuffer());
      nimbusMonoBoldItalic = fetch(new URL('../fonts/all/NimbusMono-BoldItalic.woff', import.meta.url)).then((res) => res.arrayBuffer());
      gothicNormal = fetch(new URL('../fonts/all/URWGothicBook-Regular.woff', import.meta.url)).then((res) => res.arrayBuffer());
      gothicItalic = fetch(new URL('../fonts/all/URWGothicBook-Italic.woff', import.meta.url)).then((res) => res.arrayBuffer());
      gothicBold = fetch(new URL('../fonts/all/URWGothicBook-Bold.woff', import.meta.url)).then((res) => res.arrayBuffer());
      gothicBoldItalic = fetch(new URL('../fonts/all/URWGothicBook-BoldItalic.woff', import.meta.url)).then((res) => res.arrayBuffer());
    }
  } else {
    const { readFile } = await import('node:fs/promises');
    carlitoNormal = readFile(new URL('../fonts/all/Carlito-Regular.woff', import.meta.url)).then((res) => res.buffer);
    carlitoItalic = readFile(new URL('../fonts/all/Carlito-Italic.woff', import.meta.url)).then((res) => res.buffer);
    carlitoBold = readFile(new URL('../fonts/all/Carlito-Bold.woff', import.meta.url)).then((res) => res.buffer);
    carlitoBoldItalic = readFile(new URL('../fonts/all/Carlito-BoldItalic.woff', import.meta.url)).then((res) => res.buffer);
    centuryNormal = readFile(new URL('../fonts/all/Century-Regular.woff', import.meta.url)).then((res) => res.buffer);
    centuryItalic = readFile(new URL('../fonts/all/Century-Italic.woff', import.meta.url)).then((res) => res.buffer);
    centuryBold = readFile(new URL('../fonts/all/Century-Bold.woff', import.meta.url)).then((res) => res.buffer);
    centuryBoldItalic = readFile(new URL('../fonts/all/Century-BoldItalic.woff', import.meta.url)).then((res) => res.buffer);
    garamondNormal = readFile(new URL('../fonts/all/Garamond-Regular.woff', import.meta.url)).then((res) => res.buffer);
    garamondItalic = readFile(new URL('../fonts/all/Garamond-Italic.woff', import.meta.url)).then((res) => res.buffer);
    garamondBold = readFile(new URL('../fonts/all/Garamond-Bold.woff', import.meta.url)).then((res) => res.buffer);
    garamondBoldItalic = readFile(new URL('../fonts/all/Garamond-BoldItalic.woff', import.meta.url)).then((res) => res.buffer);
    palatinoNormal = readFile(new URL('../fonts/all/Palatino-Regular.woff', import.meta.url)).then((res) => res.buffer);
    palatinoItalic = readFile(new URL('../fonts/all/Palatino-Italic.woff', import.meta.url)).then((res) => res.buffer);
    palatinoBold = readFile(new URL('../fonts/all/Palatino-Bold.woff', import.meta.url)).then((res) => res.buffer);
    palatinoBoldItalic = readFile(new URL('../fonts/all/Palatino-BoldItalic.woff', import.meta.url)).then((res) => res.buffer);
    nimbusRomanNormal = readFile(new URL('../fonts/all/NimbusRoman-Regular.woff', import.meta.url)).then((res) => res.buffer);
    nimbusRomanItalic = readFile(new URL('../fonts/all/NimbusRoman-Italic.woff', import.meta.url)).then((res) => res.buffer);
    nimbusRomanBold = readFile(new URL('../fonts/all/NimbusRoman-Bold.woff', import.meta.url)).then((res) => res.buffer);
    nimbusRomanBoldItalic = readFile(new URL('../fonts/all/NimbusRoman-BoldItalic.woff', import.meta.url)).then((res) => res.buffer);
    nimbusSansNormal = readFile(new URL('../fonts/all/NimbusSans-Regular.woff', import.meta.url)).then((res) => res.buffer);
    nimbusSansItalic = readFile(new URL('../fonts/all/NimbusSans-Italic.woff', import.meta.url)).then((res) => res.buffer);
    nimbusSansBold = readFile(new URL('../fonts/all/NimbusSans-Bold.woff', import.meta.url)).then((res) => res.buffer);
    nimbusSansBoldItalic = readFile(new URL('../fonts/all/NimbusSans-BoldItalic.woff', import.meta.url)).then((res) => res.buffer);
    nimbusMonoNormal = readFile(new URL('../fonts/all/NimbusMono-Regular.woff', import.meta.url)).then((res) => res.buffer);
    nimbusMonoItalic = readFile(new URL('../fonts/all/NimbusMono-Italic.woff', import.meta.url)).then((res) => res.buffer);
    nimbusMonoBold = readFile(new URL('../fonts/all/NimbusMono-Bold.woff', import.meta.url)).then((res) => res.buffer);
    nimbusMonoBoldItalic = readFile(new URL('../fonts/all/NimbusMono-BoldItalic.woff', import.meta.url)).then((res) => res.buffer);
    gothicNormal = readFile(new URL('../fonts/all/URWGothicBook-Regular.woff', import.meta.url)).then((res) => res.buffer);
    gothicItalic = readFile(new URL('../fonts/all/URWGothicBook-Italic.woff', import.meta.url)).then((res) => res.buffer);
    gothicBold = readFile(new URL('../fonts/all/URWGothicBook-Bold.woff', import.meta.url)).then((res) => res.buffer);
    gothicBoldItalic = readFile(new URL('../fonts/all/URWGothicBook-BoldItalic.woff', import.meta.url)).then((res) => res.buffer);
  }

  const srcObj = {
    Carlito: {
      normal: await carlitoNormal, italic: await carlitoItalic, bold: await carlitoBold, boldItalic: await carlitoBoldItalic,
    },
    Century: {
      normal: await centuryNormal, italic: await centuryItalic, bold: await centuryBold, boldItalic: await centuryBoldItalic,
    },
    Garamond: {
      normal: await garamondNormal, italic: await garamondItalic, bold: await garamondBold, boldItalic: await garamondBoldItalic,
    },
    Gothic: {
      normal: await gothicNormal, italic: await gothicItalic, bold: await gothicBold, boldItalic: await gothicBoldItalic,
    },
    Palatino: {
      normal: await palatinoNormal, italic: await palatinoItalic, bold: await palatinoBold, boldItalic: await palatinoBoldItalic,
    },
    NimbusRoman: {
      normal: await nimbusRomanNormal, italic: await nimbusRomanItalic, bold: await nimbusRomanBold, boldItalic: await nimbusRomanBoldItalic,
    },
    NimbusSans: {
      normal: await nimbusSansNormal, italic: await nimbusSansItalic, bold: await nimbusSansBold, boldItalic: await nimbusSansBoldItalic,
    },
    NimbusMono: {
      normal: await nimbusMonoNormal, italic: await nimbusMonoItalic, bold: await nimbusMonoBold, boldItalic: await nimbusMonoBoldItalic,
    },
  };

  FontCont.raw = await /** @type {FontContainer} */(/** @type {any} */(loadFontsFromSource(srcObj)));

  // This assumes that the scheduler `init` method has at least started.
  if (gs.schedulerReady === null) console.warn('Failed to load fonts to workers as workers have not been initialized yet.');
  await gs.schedulerReady;
  // If this is running, presumably a new glyphset is being loaded, so the fonts should be forced to be updated.
  await updateFontContWorkerMain({ loadRaw: true });

  return;
}

let chiReadyRes;
let chiReady;

/**
 * Loads chi_sim font. Returns early if already loaded.
 */
export async function loadChiSimFont() {
  if (chiReady) return chiReady;

  chiReady = new Promise((resolve, reject) => {
    chiReadyRes = resolve;
  });

  let /** @type {Promise<ArrayBuffer>} */chiSimSrc;
  if (typeof process === 'undefined') {
    chiSimSrc = fetch(new URL('../fonts/NotoSansSC-Regular.ttf', import.meta.url)).then((res) => res.arrayBuffer());
  } else {
    const { readFile } = await import('node:fs/promises');
    chiSimSrc = readFile(new URL('../fonts/NotoSansSC-Regular.ttf', import.meta.url)).then((res) => res.buffer);
  }

  FontCont.supp.chi_sim = await loadFont('NotoSansSC', 'normal', 'sans', await chiSimSrc, false);

  chiReadyRes();

  return chiReady;
}

let dingbatsReadyRes;
let dingbatsReady;

/**
 * Loads dingbats font. Returns early if already loaded.
 */
export async function loadDingbatsFont() {
  console.log('Loading Dingbats font');
  if (dingbatsReady) return dingbatsReady;

  dingbatsReady = new Promise((resolve, reject) => {
    dingbatsReadyRes = resolve;
  });

  let /** @type {Promise<ArrayBuffer>} */ dingbatsSrc;
  if (typeof process === 'undefined') {
    dingbatsSrc = fetch(new URL('../fonts/Dingbats.woff', import.meta.url)).then((res) => res.arrayBuffer());
  } else {
    const { readFile } = await import('node:fs/promises');
    dingbatsSrc = readFile(new URL('../fonts/Dingbats.woff', import.meta.url)).then((res) => res.buffer);
  }

  FontCont.supp.dingbats = await loadFont('Dingbats', 'normal', 'sans', await dingbatsSrc, false);

  dingbatsReadyRes();

  return dingbatsReady;
}

/**
 * Enable or disable font optimization settings.
 * This function is used rather than exposing the settings using the `opt` object, as these settings exist on the font container in both the main thread and the worker threads.
 * @param {boolean} enableOpt
 * @param {boolean} [forceOpt]
 */
export async function enableFontOpt(enableOpt, forceOpt) {
  let change = false;
  if (enableOpt === true || enableOpt === false) {
    if (FontCont.state.enableOpt !== enableOpt) {
      change = true;
      FontCont.state.enableOpt = enableOpt;
    }
  }
  if (forceOpt === true || forceOpt === false) {
    if (FontCont.state.forceOpt !== forceOpt) {
      change = true;
      FontCont.state.forceOpt = forceOpt;
    }
  }

  await updateFontContWorkerMain();
}

/**
 * @param {Object} [params]
 * @param {boolean} [params.loadRaw] - By default, raw fonts are loaded if they have not been loaded before.
 *    Set `loadRaw` to `true` or `false` to force the raw fonts to be loaded or not loaded, respectively.
 * @param {boolean} [params.loadOpt] - By default, optimized fonts are loaded if they have not been loaded before.
 *   Set `loadOpt` to `true` or `false` to force the optimized fonts to be loaded or not loaded, respectively.
 * @param {boolean} [params.loadDoc] - By default, fonts extracted from PDF documents are loaded if they have not been loaded before.
 *  Set `loadDoc` to `true` or `false` to force the document fonts to be loaded or not loaded, respectively.
 * @param {boolean} [params.updateProps]
 */
export async function updateFontContWorkerMain(params = {}) {
  const loadRaw = params.loadRaw === true || (params.loadRaw !== false && FontCont.raw && !gs.loadedBuiltInFontsRawWorker);
  const loadOpt = params.loadOpt === true || (params.loadOpt !== false && FontCont.opt && !gs.loadedBuiltInFontsOptWorker);
  const loadDoc = params.loadDoc === true || (params.loadDoc !== false && FontCont.doc && !gs.loadedBuiltInFontsDocWorker);

  // If the active font data is not already loaded, load it now.
  // This assumes that only one version of the raw/optimized fonts ever exist--
  // it does not check whether the current optimized font changed since it was last loaded.
  for (const [type, load] of [['raw', loadRaw], ['opt', loadOpt], ['doc', loadDoc]]) {
    if (!load) continue;

    const resArr = [];

    const input = { opt: type === 'opt', src: {} };
    for (const [key, value] of Object.entries(FontCont[type])) {
      if (!value || !value.normal) continue;
      input.src[key] = {
        normal: value.normal.src,
      };
      if (value.italic) input.src[key].italic = value.italic.src;
      if (value.bold) input.src[key].bold = value.bold.src;
      if (value.boldItalic) input.src[key].boldItalic = value.boldItalic.src;
    }

    for (let i = 0; i < gs.schedulerInner.workers.length; i++) {
      const worker = gs.schedulerInner.workers[i];
      const res = worker.loadFontsWorker(input);
      resArr.push(res);

      // TODO: consider the race condition when `setBuiltInFontsWorkers` is called multiple times quickly and `loadFontsWorker` is still running.
      if (type === 'opt') {
        gs.loadedBuiltInFontsOptWorker = true;
      } else if (type === 'raw') {
        gs.loadedBuiltInFontsRawWorker = true;
      } else if (type === 'doc') {
        gs.loadedBuiltInFontsDocWorker = true;
      }
    }
    await Promise.all(resArr);
  }

  // Set the active font in the workers to match the active font in `fontAll`
  const resArr = [];
  for (let i = 0; i < gs.schedulerInner.workers.length; i++) {
    const worker = gs.schedulerInner.workers[i];
    const res = worker.updateFontContWorker({
      rawMetrics: FontCont.rawMetrics,
      optMetrics: FontCont.optMetrics,
      sansDefaultName: FontCont.state.sansDefaultName,
      serifDefaultName: FontCont.state.serifDefaultName,
      defaultFontName: FontCont.state.defaultFontName,
      enableOpt: FontCont.state.enableOpt,
      forceOpt: FontCont.state.forceOpt,
    });
    resArr.push(res);
  }
  await Promise.all(resArr);
}

/**
 * WIP: Import fonts embedded in PDFs.
 * This function is out of date and not currently used.
 * @param {*} scheduler
 */
export async function setUploadFontsWorker(scheduler) {
  if (!FontCont.active) return;

  /** @type {Object<string, fontSrcBuiltIn|fontSrcUpload>} */
  const fontsUpload = {};
  for (const [key, value] of Object.entries(FontCont.active)) {
    if (!['Carlito', 'Century', 'Garamond', 'Palatino', 'NimbusRoman', 'NimbusSans', 'NimbusMono'].includes(key)) {
      fontsUpload[key] = {
        normal: value?.normal?.src, italic: value?.italic?.src, bold: value?.bold?.src,
      };
    }
  }

  if (Object.keys(fontsUpload).length === 0) return;

  const resArr1 = [];
  for (let i = 0; i < scheduler.workers.length; i++) {
    const worker = scheduler.workers[i];
    const res = worker.loadFontsWorker({
      src: fontsUpload,
      opt: false, // Uploaded fonts are not modified.
    });
    resArr1.push(res);
  }
  await Promise.all(resArr1);

  // Set the active font in the workers to match the active font in `fontAll`
  const resArr = [];
  const opt = FontCont.active.Carlito.normal.opt || FontCont.active.NimbusRoman.normal.opt;
  for (let i = 0; i < scheduler.workers.length; i++) {
    const worker = scheduler.workers[i];
    const res = worker.updateFontContWorker({
      rawMetrics: FontCont.rawMetrics,
      optMetrics: FontCont.optMetrics,
      sansDefaultName: FontCont.state.sansDefaultName,
      serifDefaultName: FontCont.state.serifDefaultName,
      defaultFontName: FontCont.state.defaultFontName,
      enableOpt: FontCont.state.enableOpt,
      forceOpt: FontCont.state.forceOpt,
    });
    resArr.push(res);
  }
  await Promise.all(resArr);
}

/**
 * Automatically sets the default font to whatever font is most common in the provided font metrics.
 *
 */
export function setDefaultFontAuto(charMetricsObj) {
  const multiFontMode = checkMultiFontMode(charMetricsObj);

  // Return early if the OCR data does not contain font info.
  if (!multiFontMode) return;

  // Change default font to whatever named font appears more
  if ((charMetricsObj.SerifDefault?.obs || 0) > (charMetricsObj.SansDefault?.obs || 0)) {
    FontCont.state.defaultFontName = 'SerifDefault';
  } else {
    FontCont.state.defaultFontName = 'SansDefault';
  }

  if (gs.schedulerInner) {
    for (let i = 0; i < gs.schedulerInner.workers.length; i++) {
      const worker = gs.schedulerInner.workers[i];
      worker.updateFontContWorker({ defaultFontName: FontCont.state.defaultFontName });
    }
  }
}

/**
 *
 * @param {FontContainerFamilyBuiltIn} fontFamily
 * @param {Object.<string, CharMetricsFamily>} charMetricsObj
 */
export async function optimizeFontContainerFamily(fontFamily, charMetricsObj) {
  // When we have metrics for individual fonts families, those are used to optimize the appropriate fonts.
  // Otherwise, the "default" metric is applied to whatever font the user has selected as the default font.
  const multiFontMode = checkMultiFontMode(charMetricsObj);
  let charMetricsType = 'Default';
  if (multiFontMode) {
    if (fontFamily.normal.type === 'sans') {
      charMetricsType = 'SansDefault';
    } else {
      charMetricsType = 'SerifDefault';
    }
  }

  // If there are no statistics to use for optimization, create "optimized" font by simply copying the raw font without modification.
  // This should only occur when `multiFontMode` is true, but a document contains no sans words or no serif words.
  if (!charMetricsObj[charMetricsType] || !charMetricsObj[charMetricsType][fontFamily.normal.style] || charMetricsObj[charMetricsType][fontFamily.normal.style].obs < 200) {
    return null;
  }

  const metricsNormal = charMetricsObj[charMetricsType][fontFamily.normal.style];
  const normalOptFont = gs.optimizeFont({ fontData: fontFamily.normal.src, charMetricsObj: metricsNormal, style: fontFamily.normal.style })
    .then(async (x) => {
      const font = await loadOpentype(x.fontData, x.kerningPairs);
      return new FontContainerFont(fontFamily.normal.family, fontFamily.normal.style, x.fontData, true, font);
    });

  const metricsItalic = charMetricsObj[charMetricsType][fontFamily.italic.style];
  /** @type {?FontContainerFont|Promise<FontContainerFont>} */
  let italicOptFont = null;
  if (metricsItalic && metricsItalic.obs >= 200) {
    italicOptFont = gs.optimizeFont({ fontData: fontFamily.italic.src, charMetricsObj: metricsItalic, style: fontFamily.italic.style })
      .then(async (x) => {
        const font = await loadOpentype(x.fontData, x.kerningPairs);
        return new FontContainerFont(fontFamily.italic.family, fontFamily.italic.style, x.fontData, true, font);
      });
  }

  // Bold fonts are not optimized, as we currently have no accurate way to determine if characters are bold within OCR, so do not have bold metrics.
  return {
    normal: await normalOptFont, italic: await italicOptFont, bold: null,
  };
}

/**
 * Optimize all fonts.
 * If a font cannot be optimized, then the raw font is returned.
 * @param {Object<string, FontContainerFamilyBuiltIn>} fontPrivate
 * @param {Object.<string, CharMetricsFamily>} charMetricsObj
 */
export async function optimizeFontContainerAll(fontPrivate, charMetricsObj) {
  const carlitoPromise = optimizeFontContainerFamily(fontPrivate.Carlito, charMetricsObj);
  const centuryPromise = optimizeFontContainerFamily(fontPrivate.Century, charMetricsObj);
  const garamondPromise = optimizeFontContainerFamily(fontPrivate.Garamond, charMetricsObj);
  const gothicPromise = optimizeFontContainerFamily(fontPrivate.Gothic, charMetricsObj);
  const palatinoPromise = optimizeFontContainerFamily(fontPrivate.Palatino, charMetricsObj);
  const nimbusRomanPromise = optimizeFontContainerFamily(fontPrivate.NimbusRoman, charMetricsObj);
  const nimbusSansPromise = optimizeFontContainerFamily(fontPrivate.NimbusSans, charMetricsObj);
  const nimbusMonoPromise = optimizeFontContainerFamily(fontPrivate.NimbusMono, charMetricsObj);

  const results = await Promise.all([carlitoPromise, centuryPromise, garamondPromise, gothicPromise,
    palatinoPromise, nimbusRomanPromise, nimbusSansPromise, nimbusMonoPromise]);

  if (results.every((x) => x === null)) return null;

  return {
    Carlito: results[0],
    Century: results[1],
    Garamond: results[2],
    Gothic: results[3],
    Palatino: results[4],
    NimbusRoman: results[5],
    NimbusSans: results[6],
    NimbusMono: results[7],
  };
}
