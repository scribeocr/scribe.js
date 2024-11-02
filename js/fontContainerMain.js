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
  if (FontCont.glyphSet === glyphSet || FontCont.glyphSet === 'all' && glyphSet === 'latin') return;

  FontCont.glyphSet = glyphSet;

  // Note: this function is intentionally verbose, and should not be refactored to generate the paths dynamically.
  // Build systems will not be able to resolve the paths if they are generated dynamically.
  let /** @type {Promise<ArrayBuffer>} */carlitoNormal;
  let /** @type {Promise<ArrayBuffer>} */carlitoItalic;
  let /** @type {Promise<ArrayBuffer>} */carlitoBold;
  let /** @type {Promise<ArrayBuffer>} */centuryNormal;
  let /** @type {Promise<ArrayBuffer>} */centuryItalic;
  let /** @type {Promise<ArrayBuffer>} */centuryBold;
  let /** @type {Promise<ArrayBuffer>} */garamondNormal;
  let /** @type {Promise<ArrayBuffer>} */garamondItalic;
  let /** @type {Promise<ArrayBuffer>} */garamondBold;
  let /** @type {Promise<ArrayBuffer>} */palatinoNormal;
  let /** @type {Promise<ArrayBuffer>} */palatinoItalic;
  let /** @type {Promise<ArrayBuffer>} */palatinoBold;
  let /** @type {Promise<ArrayBuffer>} */nimbusRomNo9LNormal;
  let /** @type {Promise<ArrayBuffer>} */nimbusRomNo9LItalic;
  let /** @type {Promise<ArrayBuffer>} */nimbusRomNo9LBold;
  let /** @type {Promise<ArrayBuffer>} */nimbusSansNormal;
  let /** @type {Promise<ArrayBuffer>} */nimbusSansItalic;
  let /** @type {Promise<ArrayBuffer>} */nimbusSansBold;
  let /** @type {Promise<ArrayBuffer>} */nimbusMonoNormal;
  let /** @type {Promise<ArrayBuffer>} */nimbusMonoItalic;
  let /** @type {Promise<ArrayBuffer>} */nimbusMonoBold;
  if (typeof process === 'undefined') {
    if (glyphSet === 'latin') {
      carlitoNormal = fetch(new URL('../fonts/latin/Carlito-Regular.woff', import.meta.url)).then((res) => res.arrayBuffer());
      carlitoItalic = fetch(new URL('../fonts/latin/Carlito-Italic.woff', import.meta.url)).then((res) => res.arrayBuffer());
      carlitoBold = fetch(new URL('../fonts/latin/Carlito-Bold.woff', import.meta.url)).then((res) => res.arrayBuffer());
      centuryNormal = fetch(new URL('../fonts/latin/C059-Roman.woff', import.meta.url)).then((res) => res.arrayBuffer());
      centuryItalic = fetch(new URL('../fonts/latin/C059-Italic.woff', import.meta.url)).then((res) => res.arrayBuffer());
      centuryBold = fetch(new URL('../fonts/latin/C059-Bold.woff', import.meta.url)).then((res) => res.arrayBuffer());
      garamondNormal = fetch(new URL('../fonts/latin/EBGaramond-Regular.woff', import.meta.url)).then((res) => res.arrayBuffer());
      garamondItalic = fetch(new URL('../fonts/latin/EBGaramond-Italic.woff', import.meta.url)).then((res) => res.arrayBuffer());
      garamondBold = fetch(new URL('../fonts/latin/EBGaramond-Bold.woff', import.meta.url)).then((res) => res.arrayBuffer());
      palatinoNormal = fetch(new URL('../fonts/latin/P052-Roman.woff', import.meta.url)).then((res) => res.arrayBuffer());
      palatinoItalic = fetch(new URL('../fonts/latin/P052-Italic.woff', import.meta.url)).then((res) => res.arrayBuffer());
      palatinoBold = fetch(new URL('../fonts/latin/P052-Bold.woff', import.meta.url)).then((res) => res.arrayBuffer());
      nimbusRomNo9LNormal = fetch(new URL('../fonts/latin/NimbusRoman-Regular.woff', import.meta.url)).then((res) => res.arrayBuffer());
      nimbusRomNo9LItalic = fetch(new URL('../fonts/latin/NimbusRoman-Italic.woff', import.meta.url)).then((res) => res.arrayBuffer());
      nimbusRomNo9LBold = fetch(new URL('../fonts/latin/NimbusRoman-Bold.woff', import.meta.url)).then((res) => res.arrayBuffer());
      nimbusSansNormal = fetch(new URL('../fonts/latin/NimbusSans-Regular.woff', import.meta.url)).then((res) => res.arrayBuffer());
      nimbusSansItalic = fetch(new URL('../fonts/latin/NimbusSans-Italic.woff', import.meta.url)).then((res) => res.arrayBuffer());
      nimbusSansBold = fetch(new URL('../fonts/latin/NimbusSans-Bold.woff', import.meta.url)).then((res) => res.arrayBuffer());
      nimbusMonoNormal = fetch(new URL('../fonts/latin/NimbusMonoPS-Regular.woff', import.meta.url)).then((res) => res.arrayBuffer());
      nimbusMonoItalic = fetch(new URL('../fonts/latin/NimbusMonoPS-Italic.woff', import.meta.url)).then((res) => res.arrayBuffer());
      nimbusMonoBold = fetch(new URL('../fonts/latin/NimbusMonoPS-Bold.woff', import.meta.url)).then((res) => res.arrayBuffer());
    } else {
      carlitoNormal = fetch(new URL('../fonts/all/Carlito-Regular.woff', import.meta.url)).then((res) => res.arrayBuffer());
      carlitoItalic = fetch(new URL('../fonts/all/Carlito-Italic.woff', import.meta.url)).then((res) => res.arrayBuffer());
      carlitoBold = fetch(new URL('../fonts/all/Carlito-Bold.woff', import.meta.url)).then((res) => res.arrayBuffer());
      centuryNormal = fetch(new URL('../fonts/all/C059-Roman.woff', import.meta.url)).then((res) => res.arrayBuffer());
      centuryItalic = fetch(new URL('../fonts/all/C059-Italic.woff', import.meta.url)).then((res) => res.arrayBuffer());
      centuryBold = fetch(new URL('../fonts/all/C059-Bold.woff', import.meta.url)).then((res) => res.arrayBuffer());
      garamondNormal = fetch(new URL('../fonts/all/EBGaramond-Regular.woff', import.meta.url)).then((res) => res.arrayBuffer());
      garamondItalic = fetch(new URL('../fonts/all/EBGaramond-Italic.woff', import.meta.url)).then((res) => res.arrayBuffer());
      garamondBold = fetch(new URL('../fonts/all/EBGaramond-Bold.woff', import.meta.url)).then((res) => res.arrayBuffer());
      palatinoNormal = fetch(new URL('../fonts/all/P052-Roman.woff', import.meta.url)).then((res) => res.arrayBuffer());
      palatinoItalic = fetch(new URL('../fonts/all/P052-Italic.woff', import.meta.url)).then((res) => res.arrayBuffer());
      palatinoBold = fetch(new URL('../fonts/all/P052-Bold.woff', import.meta.url)).then((res) => res.arrayBuffer());
      nimbusRomNo9LNormal = fetch(new URL('../fonts/all/NimbusRoman-Regular.woff', import.meta.url)).then((res) => res.arrayBuffer());
      nimbusRomNo9LItalic = fetch(new URL('../fonts/all/NimbusRoman-Italic.woff', import.meta.url)).then((res) => res.arrayBuffer());
      nimbusRomNo9LBold = fetch(new URL('../fonts/all/NimbusRoman-Bold.woff', import.meta.url)).then((res) => res.arrayBuffer());
      nimbusSansNormal = fetch(new URL('../fonts/all/NimbusSans-Regular.woff', import.meta.url)).then((res) => res.arrayBuffer());
      nimbusSansItalic = fetch(new URL('../fonts/all/NimbusSans-Italic.woff', import.meta.url)).then((res) => res.arrayBuffer());
      nimbusSansBold = fetch(new URL('../fonts/all/NimbusSans-Bold.woff', import.meta.url)).then((res) => res.arrayBuffer());
      nimbusMonoNormal = fetch(new URL('../fonts/all/NimbusMonoPS-Regular.woff', import.meta.url)).then((res) => res.arrayBuffer());
      nimbusMonoItalic = fetch(new URL('../fonts/all/NimbusMonoPS-Italic.woff', import.meta.url)).then((res) => res.arrayBuffer());
      nimbusMonoBold = fetch(new URL('../fonts/all/NimbusMonoPS-Bold.woff', import.meta.url)).then((res) => res.arrayBuffer());
    }
  } else {
    const { readFile } = await import('fs/promises');
    carlitoNormal = readFile(new URL('../fonts/all_ttf/Carlito-Regular.ttf', import.meta.url)).then((res) => res.buffer);
    carlitoItalic = readFile(new URL('../fonts/all_ttf/Carlito-Italic.ttf', import.meta.url)).then((res) => res.buffer);
    carlitoBold = readFile(new URL('../fonts/all_ttf/Carlito-Bold.ttf', import.meta.url)).then((res) => res.buffer);
    centuryNormal = readFile(new URL('../fonts/all_ttf/C059-Roman.ttf', import.meta.url)).then((res) => res.buffer);
    centuryItalic = readFile(new URL('../fonts/all_ttf/C059-Italic.ttf', import.meta.url)).then((res) => res.buffer);
    centuryBold = readFile(new URL('../fonts/all_ttf/C059-Bold.ttf', import.meta.url)).then((res) => res.buffer);
    garamondNormal = readFile(new URL('../fonts/all_ttf/EBGaramond-Regular.ttf', import.meta.url)).then((res) => res.buffer);
    garamondItalic = readFile(new URL('../fonts/all_ttf/EBGaramond-Italic.ttf', import.meta.url)).then((res) => res.buffer);
    garamondBold = readFile(new URL('../fonts/all_ttf/EBGaramond-Bold.ttf', import.meta.url)).then((res) => res.buffer);
    palatinoNormal = readFile(new URL('../fonts/all_ttf/P052-Roman.ttf', import.meta.url)).then((res) => res.buffer);
    palatinoItalic = readFile(new URL('../fonts/all_ttf/P052-Italic.ttf', import.meta.url)).then((res) => res.buffer);
    palatinoBold = readFile(new URL('../fonts/all_ttf/P052-Bold.ttf', import.meta.url)).then((res) => res.buffer);
    nimbusRomNo9LNormal = readFile(new URL('../fonts/all_ttf/NimbusRoman-Regular.ttf', import.meta.url)).then((res) => res.buffer);
    nimbusRomNo9LItalic = readFile(new URL('../fonts/all_ttf/NimbusRoman-Italic.ttf', import.meta.url)).then((res) => res.buffer);
    nimbusRomNo9LBold = readFile(new URL('../fonts/all_ttf/NimbusRoman-Bold.ttf', import.meta.url)).then((res) => res.buffer);
    nimbusSansNormal = readFile(new URL('../fonts/all_ttf/NimbusSans-Regular.ttf', import.meta.url)).then((res) => res.buffer);
    nimbusSansItalic = readFile(new URL('../fonts/all_ttf/NimbusSans-Italic.ttf', import.meta.url)).then((res) => res.buffer);
    nimbusSansBold = readFile(new URL('../fonts/all_ttf/NimbusSans-Bold.ttf', import.meta.url)).then((res) => res.buffer);
    nimbusMonoNormal = readFile(new URL('../fonts/all_ttf/NimbusMonoPS-Regular.ttf', import.meta.url)).then((res) => res.buffer);
    nimbusMonoItalic = readFile(new URL('../fonts/all_ttf/NimbusMonoPS-Italic.ttf', import.meta.url)).then((res) => res.buffer);
    nimbusMonoBold = readFile(new URL('../fonts/all_ttf/NimbusMonoPS-Bold.ttf', import.meta.url)).then((res) => res.buffer);
  }

  const srcObj = {
    Carlito: { normal: await carlitoNormal, italic: await carlitoItalic, bold: await carlitoBold },
    Century: { normal: await centuryNormal, italic: await centuryItalic, bold: await centuryBold },
    Garamond: { normal: await garamondNormal, italic: await garamondItalic, bold: await garamondBold },
    Palatino: { normal: await palatinoNormal, italic: await palatinoItalic, bold: await palatinoBold },
    NimbusRomNo9L: { normal: await nimbusRomNo9LNormal, italic: await nimbusRomNo9LItalic, bold: await nimbusRomNo9LBold },
    NimbusSans: { normal: await nimbusSansNormal, italic: await nimbusSansItalic, bold: await nimbusSansBold },
    NimbusMono: { normal: await nimbusMonoNormal, italic: await nimbusMonoItalic, bold: await nimbusMonoBold },
  };

  FontCont.raw = await /** @type {FontContainer} */(/** @type {any} */(loadFontsFromSource(srcObj)));

  if (typeof process === 'undefined') {
    // This assumes that the scheduler `init` method has at least started.
    if (gs.schedulerReady === null) console.warn('Failed to load fonts to workers as workers have not been initialized yet.');
    await gs.schedulerReady;
    // If this is running, presumably a new glyphset is being loaded, so the fonts should be forced to be updated.
    await updateFontContWorkerMain({ loadRaw: true });
  }

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
    const { readFile } = await import('fs/promises');
    chiSimSrc = readFile(new URL('../fonts/NotoSansSC-Regular.ttf', import.meta.url)).then((res) => res.buffer);
  }

  FontCont.supp.chi_sim = await loadFont('NotoSansSC', 'normal', 'sans', await chiSimSrc, false);

  chiReadyRes();

  return chiReady;
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
    if (FontCont.enableOpt !== enableOpt) {
      change = true;
      FontCont.enableOpt = enableOpt;
    }
  }
  if (forceOpt === true || forceOpt === false) {
    if (FontCont.forceOpt !== forceOpt) {
      change = true;
      FontCont.forceOpt = forceOpt;
    }
  }

  if (typeof process === 'undefined' && change) {
    await updateFontContWorkerMain();
  }
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
      sansDefaultName: FontCont.sansDefaultName,
      serifDefaultName: FontCont.serifDefaultName,
      defaultFontName: FontCont.defaultFontName,
      enableOpt: FontCont.enableOpt,
      forceOpt: FontCont.forceOpt,
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
    if (!['Carlito', 'Century', 'Garamond', 'Palatino', 'NimbusRomNo9L', 'NimbusSans', 'NimbusMono'].includes(key)) {
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
  const opt = FontCont.active.Carlito.normal.opt || FontCont.active.NimbusRomNo9L.normal.opt;
  for (let i = 0; i < scheduler.workers.length; i++) {
    const worker = scheduler.workers[i];
    const res = worker.updateFontContWorker({
      rawMetrics: FontCont.rawMetrics,
      optMetrics: FontCont.optMetrics,
      sansDefaultName: FontCont.sansDefaultName,
      serifDefaultName: FontCont.serifDefaultName,
      defaultFontName: FontCont.defaultFontName,
      enableOpt: FontCont.enableOpt,
      forceOpt: FontCont.forceOpt,
    });
    resArr.push(res);
  }
  await Promise.all(resArr);
}

/**
 * Automatically sets the default font to whatever font is most common in the provided font metrics.
 *
 */
export function setDefaultFontAuto(fontMetricsObj) {
  const multiFontMode = checkMultiFontMode(fontMetricsObj);

  // Return early if the OCR data does not contain font info.
  if (!multiFontMode) return;

  // Change default font to whatever named font appears more
  if ((fontMetricsObj.SerifDefault?.obs || 0) > (fontMetricsObj.SansDefault?.obs || 0)) {
    FontCont.defaultFontName = 'SerifDefault';
  } else {
    FontCont.defaultFontName = 'SansDefault';
  }

  if (gs.schedulerInner) {
    for (let i = 0; i < gs.schedulerInner.workers.length; i++) {
      const worker = gs.schedulerInner.workers[i];
      worker.updateFontContWorker({ defaultFontName: FontCont.defaultFontName });
    }
  }
}

/**
 *
 * @param {FontContainerFamilyBuiltIn} fontFamily
 * @param {Object.<string, FontMetricsFamily>} fontMetricsObj
 */
export async function optimizeFontContainerFamily(fontFamily, fontMetricsObj) {
  // When we have metrics for individual fonts families, those are used to optimize the appropriate fonts.
  // Otherwise, the "default" metric is applied to whatever font the user has selected as the default font.
  const multiFontMode = checkMultiFontMode(fontMetricsObj);
  let fontMetricsType = 'Default';
  if (multiFontMode) {
    if (fontFamily.normal.type === 'sans') {
      fontMetricsType = 'SansDefault';
    } else {
      fontMetricsType = 'SerifDefault';
    }
  }

  // If there are no statistics to use for optimization, create "optimized" font by simply copying the raw font without modification.
  // This should only occur when `multiFontMode` is true, but a document contains no sans words or no serif words.
  if (!fontMetricsObj[fontMetricsType] || !fontMetricsObj[fontMetricsType][fontFamily.normal.style] || fontMetricsObj[fontMetricsType][fontFamily.normal.style].obs < 200) {
    return null;
  }

  const metricsNormal = fontMetricsObj[fontMetricsType][fontFamily.normal.style];
  const normalOptFont = gs.optimizeFont({ fontData: fontFamily.normal.src, fontMetricsObj: metricsNormal, style: fontFamily.normal.style })
    .then(async (x) => {
      const font = await loadOpentype(x.fontData, x.kerningPairs);
      return new FontContainerFont(fontFamily.normal.family, fontFamily.normal.style, x.fontData, true, font);
    });

  const metricsItalic = fontMetricsObj[fontMetricsType][fontFamily.italic.style];
  /** @type {?FontContainerFont|Promise<FontContainerFont>} */
  let italicOptFont = null;
  if (metricsItalic && metricsItalic.obs >= 200) {
    italicOptFont = gs.optimizeFont({ fontData: fontFamily.italic.src, fontMetricsObj: metricsItalic, style: fontFamily.italic.style })
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
 * @param {Object.<string, FontMetricsFamily>} fontMetricsObj
 */
export async function optimizeFontContainerAll(fontPrivate, fontMetricsObj) {
  const carlitoPromise = optimizeFontContainerFamily(fontPrivate.Carlito, fontMetricsObj);
  const centuryPromise = optimizeFontContainerFamily(fontPrivate.Century, fontMetricsObj);
  const garamondPromise = optimizeFontContainerFamily(fontPrivate.Garamond, fontMetricsObj);
  const palatinoPromise = optimizeFontContainerFamily(fontPrivate.Palatino, fontMetricsObj);
  const nimbusRomNo9LPromise = optimizeFontContainerFamily(fontPrivate.NimbusRomNo9L, fontMetricsObj);
  const nimbusSansPromise = optimizeFontContainerFamily(fontPrivate.NimbusSans, fontMetricsObj);
  const nimbusMonoPromise = optimizeFontContainerFamily(fontPrivate.NimbusMono, fontMetricsObj);

  const results = await Promise.all([carlitoPromise, centuryPromise, garamondPromise, palatinoPromise, nimbusRomNo9LPromise, nimbusSansPromise, nimbusMonoPromise]);

  if (results.every((x) => x === null)) return null;

  return {
    Carlito: results[0],
    Century: results[1],
    Garamond: results[2],
    Palatino: results[3],
    NimbusRomNo9L: results[4],
    NimbusSans: results[5],
    NimbusMono: results[6],
  };
}
