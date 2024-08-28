import {
  checkMultiFontMode,
  fontAll,
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
  if (fontAll.glyphSet === glyphSet || fontAll.glyphSet === 'all' && glyphSet === 'latin') return;

  fontAll.glyphSet = glyphSet;

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
  }

  const srcObj = {
    Carlito: { normal: await carlitoNormal, italic: await carlitoItalic, bold: await carlitoBold },
    Century: { normal: await centuryNormal, italic: await centuryItalic, bold: await centuryBold },
    Garamond: { normal: await garamondNormal, italic: await garamondItalic, bold: await garamondBold },
    Palatino: { normal: await palatinoNormal, italic: await palatinoItalic, bold: await palatinoBold },
    NimbusRomNo9L: { normal: await nimbusRomNo9LNormal, italic: await nimbusRomNo9LItalic, bold: await nimbusRomNo9LBold },
    NimbusSans: { normal: await nimbusSansNormal, italic: await nimbusSansItalic, bold: await nimbusSansBold },
  };

  fontAll.raw = await /** @type {FontContainer} */(/** @type {any} */(loadFontsFromSource(srcObj)));
  if (!fontAll.active || (!fontAll.active.NimbusSans.normal.opt && !fontAll.active.NimbusRomNo9L.normal.opt)) fontAll.active = fontAll.raw;

  if (typeof process === 'undefined') {
    // This assumes that the scheduler `init` method has at least started.
    if (gs.schedulerReady === null) console.warn('Failed to load fonts to workers as workers have not been initialized yet.');
    await gs.schedulerReady;
    await setBuiltInFontsWorker(gs.schedulerInner, true);
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

  fontAll.supp.chi_sim = await loadFont('NotoSansSC', 'normal', 'sans', await chiSimSrc, false);

  chiReadyRes();

  return chiReady;
}

/**
 *
 * @param {boolean} enable
 * @param {boolean} [useInitial=false]
 * @param {boolean} [forceWorkerUpdate=false] - If true, forces the worker to update the font data even if the font data of this type is already loaded.
 *    This should be used when switching from unvalidated to validated optimized fonts.
 */
export async function enableFontOpt(enable, useInitial = false, forceWorkerUpdate = false) {
  // Enable/disable optimized font
  if (enable && useInitial && fontAll.optInitial) {
    fontAll.active = fontAll.optInitial;
  } else if (enable && fontAll.opt) {
    fontAll.active = fontAll.opt;
  } else {
    fontAll.active = fontAll.raw;
  }

  // Enable/disable optimized font in workers
  if (typeof process === 'undefined') {
    await setBuiltInFontsWorker(gs.schedulerInner, forceWorkerUpdate);
  } else {
    // const { setFontAll } = await import('./worker/compareOCRModule.js');
    // setFontAll(fontAll);
  }
}

/**
 *
 * @param {*} scheduler
 * @param {boolean} [force=false] - If true, forces the worker to update the font data even if the font data of this type is already loaded.
 */
export async function setBuiltInFontsWorker(scheduler, force = false) {
  if (!fontAll.active) return;

  const opt = fontAll.active.Carlito.normal.opt || fontAll.active.NimbusRomNo9L.normal.opt;

  const loadedBuiltIn = (!opt && fontAll.loadedBuiltInRawWorker) || (opt && fontAll.loadedBuiltInOptWorker);

  // If the active font data is not already loaded, load it now.
  // This assumes that only one version of the raw/optimized fonts ever exist--
  // it does not check whether the current optimized font changed since it was last loaded.
  if (!loadedBuiltIn || force) {
    const resArr = [];
    for (let i = 0; i < scheduler.workers.length; i++) {
      const worker = scheduler.workers[i];
      const res = worker.loadFontsWorker({
        src: {
          Carlito: {
            normal: fontAll.active.Carlito.normal.src,
            italic: fontAll.active.Carlito.italic.src,
            bold: fontAll.active.Carlito.bold.src,
          },
          Century: {
            normal: fontAll.active.Century.normal.src,
            italic: fontAll.active.Century.italic.src,
            bold: fontAll.active.Century.bold.src,
          },
          Garamond: {
            normal: fontAll.active.Garamond.normal.src,
            italic: fontAll.active.Garamond.italic.src,
            bold: fontAll.active.Garamond.bold.src,
          },
          Palatino: {
            normal: fontAll.active.Palatino.normal.src,
            italic: fontAll.active.Palatino.italic.src,
            bold: fontAll.active.Palatino.bold.src,
          },
          NimbusRomNo9L: {
            normal: fontAll.active.NimbusRomNo9L.normal.src,
            italic: fontAll.active.NimbusRomNo9L.italic.src,
            bold: fontAll.active.NimbusRomNo9L.bold.src,
          },
          NimbusSans: {
            normal: fontAll.active.NimbusSans.normal.src,
            italic: fontAll.active.NimbusSans.italic.src,
            bold: fontAll.active.NimbusSans.bold.src,
          },
        },
        opt,
      });
      resArr.push(res);
    }
    await Promise.all(resArr);

    // Theoretically this should be changed to use promises to avoid the race condition when `setBuiltInFontsWorker` is called multiple times quickly and `loadFontsWorker` is still running.
    if (opt) {
      fontAll.loadedBuiltInOptWorker = true;
    } else {
      fontAll.loadedBuiltInRawWorker = true;
    }
  }

  // Set the active font in the workers to match the active font in `fontAll`
  const resArr = [];
  for (let i = 0; i < scheduler.workers.length; i++) {
    const worker = scheduler.workers[i];
    const res = worker.setFontActiveWorker({ opt, sansDefaultName: fontAll.sansDefaultName, serifDefaultName: fontAll.serifDefaultName });
    resArr.push(res);
  }
  await Promise.all(resArr);
}

/**
 * WIP: Import fonts embedded in PDFs.
 * This function is not currently used.
 * @param {*} scheduler
 */
export async function setUploadFontsWorker(scheduler) {
  if (!fontAll.active) return;

  /** @type {Object<string, fontSrcBuiltIn|fontSrcUpload>} */
  const fontsUpload = {};
  for (const [key, value] of Object.entries(fontAll.active)) {
    if (!['Carlito', 'Century', 'Garamond', 'Palatino', 'NimbusRomNo9L', 'NimbusSans'].includes(key)) {
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
  const opt = fontAll.active.Carlito.normal.opt || fontAll.active.NimbusRomNo9L.normal.opt;
  for (let i = 0; i < scheduler.workers.length; i++) {
    const worker = scheduler.workers[i];
    const res = worker.setFontActiveWorker({ opt, sansDefaultName: fontAll.sansDefaultName, serifDefaultName: fontAll.serifDefaultName });
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
    fontAll.defaultFontName = 'SerifDefault';
  } else {
    fontAll.defaultFontName = 'SansDefault';
  }

  if (gs.schedulerInner) {
    for (let i = 0; i < gs.schedulerInner.workers.length; i++) {
      const worker = gs.schedulerInner.workers[i];
      worker.setDefaultFontNameWorker({ defaultFontName: fontAll.defaultFontName });
    }
  }
}

/**
 *
 * @param {FontContainerFamilyBuiltIn} fontFamily
 * @param {Object.<string, FontMetricsFamily>} fontMetricsObj
 */
export async function optimizeFontContainerFamily(fontFamily, fontMetricsObj) {
  if (!gs.scheduler) throw new Error('GeneralScheduler must be defined before this function can run.');

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
  if (!fontMetricsObj[fontMetricsType] || !fontMetricsObj[fontMetricsType][fontFamily.normal.style]) {
    const opentypeFontArr = await Promise.all([loadOpentype(fontFamily.normal.src, null), loadOpentype(fontFamily.italic.src, null), loadOpentype(fontFamily.bold.src, null)]);
    const normalOptFont = new FontContainerFont(fontFamily.normal.family, fontFamily.normal.style, fontFamily.normal.src, true, opentypeFontArr[0]);
    const italicOptFont = new FontContainerFont(fontFamily.italic.family, fontFamily.italic.style, fontFamily.italic.src, true, opentypeFontArr[1]);
    const boldOptFont = new FontContainerFont(fontFamily.bold.family, fontFamily.bold.style, fontFamily.bold.src, true, opentypeFontArr[2]);
    return {
      normal: await normalOptFont, italic: await italicOptFont, bold: await boldOptFont,
    };
  }

  const metricsNormal = fontMetricsObj[fontMetricsType][fontFamily.normal.style];
  const normalOptFont = gs.scheduler.optimizeFont({ fontData: fontFamily.normal.src, fontMetricsObj: metricsNormal, style: fontFamily.normal.style })
    .then(async (x) => {
      const font = await loadOpentype(x.fontData, x.kerningPairs);
      return new FontContainerFont(fontFamily.normal.family, fontFamily.normal.style, x.fontData, true, font);
    });

  const metricsItalic = fontMetricsObj[fontMetricsType][fontFamily.italic.style];
  /** @type {FontContainerFont|Promise<FontContainerFont>} */
  let italicOptFont;
  if (metricsItalic) {
    italicOptFont = gs.scheduler.optimizeFont({ fontData: fontFamily.italic.src, fontMetricsObj: metricsItalic, style: fontFamily.italic.style })
      .then(async (x) => {
        const font = await loadOpentype(x.fontData, x.kerningPairs);
        return new FontContainerFont(fontFamily.italic.family, fontFamily.italic.style, x.fontData, true, font);
      });
  } else {
    const font = await loadOpentype(fontFamily.italic.src, null);
    italicOptFont = new FontContainerFont(fontFamily.italic.family, fontFamily.italic.style, fontFamily.italic.src, true, font);
  }

  // Bold fonts are not optimized, as we currently have no accurate way to determine if characters are bold within OCR, so do not have bold metrics.
  const boldOptFont = loadOpentype(fontFamily.bold.src, null).then((opentypeFont) => new FontContainerFont(fontFamily.bold.family, fontFamily.bold.style, fontFamily.bold.src, true, opentypeFont));

  return {
    normal: await normalOptFont, italic: await italicOptFont, bold: await boldOptFont,
  };
}

/**
 * Optimize all fonts.
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

  const results = await Promise.all([carlitoPromise, centuryPromise, garamondPromise, palatinoPromise, nimbusRomNo9LPromise, nimbusSansPromise]);

  return {
    Carlito: results[0],
    Century: results[1],
    Garamond: results[2],
    Palatino: results[3],
    NimbusRomNo9L: results[4],
    NimbusSans: results[5],
  };
}
