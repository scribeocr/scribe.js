import {
  checkMultiFontMode,
  FontContainerFont,
  GlobalFonts,
  loadFont,
  loadFontsFromSource,
  loadOpentype,
} from './containers/fontContainer.js';
import { gs } from './generalWorkerMain.js';

/** @typedef {import('./containers/fontContainer.js').DocFonts} DocFonts */

let loadBuiltInFontsRawInFlight = null;

// Which built-in glyph set ('latin'|'all') is currently loaded into the process-wide `GlobalFonts.raw`.
// This is global state (the built-in fonts are shared across documents), not per-document.
/** @type {?('latin'|'all')} */
let loadedGlyphSet = null;

/**
 * Load all raw (unoptimized) fonts.  This function is where font file names are hard-coded.
 * @param {('latin'|'all')} [glyphSet='latin'] - The set of glyphs to load.  'latin' includes only Latin characters, while 'all' includes Latin, Greek, and Cyrillic characters.
 *    This parameter does not matter for Node.js, which loads a `.ttf` version of the `all` set, regardless of this option.
 */
export async function loadBuiltInFontsRaw(glyphSet = 'latin') {
  // Return early if the font set is already loaded, or a superset of the requested set is loaded.
  if (GlobalFonts.raw && (loadedGlyphSet === glyphSet
    || loadedGlyphSet === 'all' && glyphSet === 'latin')) return;

  // Coalesce with an in-flight call if it's loading the same or a superset.
  // Without this, multiple concurrent calls to `loadBuiltInFontsRaw` (e.g. from `convertPageCallback` during multi-page import) can each trigger a full load.
  if (loadBuiltInFontsRawInFlight
    && (loadBuiltInFontsRawInFlight.glyphSet === glyphSet
      || loadBuiltInFontsRawInFlight.glyphSet === 'all' && glyphSet === 'latin')) {
    return loadBuiltInFontsRawInFlight.promise;
  }

  loadBuiltInFontsRawInFlight = {
    glyphSet,
    promise: loadBuiltInFontsRawInner(glyphSet).finally(() => {
      loadBuiltInFontsRawInFlight = null;
    }),
  };
  return loadBuiltInFontsRawInFlight.promise;
}

/**
 * @param {'latin'|'all'} glyphSet
 */
async function loadBuiltInFontsRawInner(glyphSet) {
  loadedGlyphSet = glyphSet;

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

  GlobalFonts.raw = await /** @type {FontContainer} */(/** @type {any} */(loadFontsFromSource(srcObj)));

  // This assumes that the scheduler `init` method has at least started.
  if (gs.schedulerReady === null) console.warn('Failed to load fonts to workers as workers have not been initialized yet.');
  await gs.schedulerReady;
  // A new glyphset was loaded, so push the (process-wide) raw fonts to every worker.
  await syncBuiltInFontsToWorkers();

  return;
}

/**
 * Push the process-wide built-in raw fonts (`GlobalFonts.raw`) to every worker.
 * These are shared across all documents, so they are stored globally in each worker (no `docId`).
 */
export async function syncBuiltInFontsToWorkers() {
  if (!GlobalFonts.raw || !gs.schedulerInner) return;

  const input = { opt: false, kind: 'raw', src: {} };
  for (const [key, value] of Object.entries(GlobalFonts.raw)) {
    if (!value || !value.normal) continue;
    input.src[key] = { normal: value.normal.src };
    if (value.italic) input.src[key].italic = value.italic.src;
    if (value.bold) input.src[key].bold = value.bold.src;
    if (value.boldItalic) input.src[key].boldItalic = value.boldItalic.src;
  }

  await Promise.all(gs.schedulerInner.workers.map((worker) => worker.loadFontsWorker(input)));
  gs.loadedBuiltInFontsRawWorker = true;
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

  GlobalFonts.supp.chi_sim = await loadFont('NotoSansSC', 'normal', 'sans', await chiSimSrc, false);

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

  GlobalFonts.supp.dingbats = await loadFont('Dingbats', 'normal', 'symbol', await dingbatsSrc, false);

  dingbatsReadyRes();

  return dingbatsReady;
}

let symbolReadyRes;
let symbolReady;

/**
 * Loads the StandardSymbolsPS font (substitute for the non-embedded Base14 Symbol font).
 * Returns early if already loaded. Mirrors `loadDingbatsFont`.
 */
export async function loadSymbolFont() {
  if (symbolReady) return symbolReady;

  symbolReady = new Promise((resolve) => {
    symbolReadyRes = resolve;
  });

  let /** @type {Promise<ArrayBuffer>} */ symbolSrc;
  if (typeof process === 'undefined') {
    symbolSrc = fetch(new URL('../fonts/StandardSymbolsPS.woff', import.meta.url)).then((res) => res.arrayBuffer());
  } else {
    const { readFile } = await import('node:fs/promises');
    symbolSrc = readFile(new URL('../fonts/StandardSymbolsPS.woff', import.meta.url)).then((res) => res.buffer);
  }

  GlobalFonts.supp.symbol = await loadFont('StandardSymbolsPS', 'normal', 'symbol', await symbolSrc, false);

  symbolReadyRes();

  return symbolReady;
}

/**
 * Enable or disable font optimization settings for this document.
 * These settings exist on the font container in both the main thread and the worker threads,
 * so a worker sync is required (this is why they are not plain `opt` fields).
 * @param {DocFonts} docFonts
 * @param {boolean} enableOpt
 * @param {boolean} [forceOpt]
 */
export async function enableOpt(docFonts, enableOptArg, forceOptArg) {
  if (enableOptArg === true || enableOptArg === false) docFonts.state.enableOpt = enableOptArg;
  if (forceOptArg === true || forceOptArg === false) docFonts.state.forceOpt = forceOptArg;
  await syncToWorkers(docFonts);
}

/**
 * Push this document's optimized/document fonts and font settings/metrics to every worker, keyed by
 * `docFonts.id`. The process-wide raw fonts are sent separately via `syncBuiltInFontsToWorkers`.
 * @param {DocFonts} docFonts
 */
export async function syncToWorkers(docFonts) {
  if (!gs.schedulerInner) return;
  const { workers } = gs.schedulerInner;

  for (const kind of /** @type {Array<'opt'|'doc'>} */ (['opt', 'doc'])) {
    const cont = docFonts[kind];
    if (!cont) continue;

    const input = {
      opt: kind === 'opt', kind, docId: docFonts.id, src: {},
    };
    for (const [key, value] of Object.entries(cont)) {
      if (!value || !value.normal) continue;
      input.src[key] = { normal: value.normal.src };
      if (value.italic) input.src[key].italic = value.italic.src;
      if (value.bold) input.src[key].bold = value.bold.src;
      if (value.boldItalic) input.src[key].boldItalic = value.boldItalic.src;
    }
    if (Object.keys(input.src).length === 0) continue;

    await Promise.all(workers.map((worker) => worker.loadFontsWorker(input)));
  }

  await Promise.all(workers.map((worker) => worker.updateFontContWorker({
    docId: docFonts.id,
    rawMetrics: docFonts.rawMetrics,
    optMetrics: docFonts.optMetrics,
    sansDefaultName: docFonts.state.sansDefaultName,
    serifDefaultName: docFonts.state.serifDefaultName,
    defaultFontName: docFonts.state.defaultFontName,
    enableOpt: docFonts.state.enableOpt,
    forceOpt: docFonts.state.forceOpt,
  })));
}

/**
 * Remove this document's fonts from every worker: drop its `Map<docId, DocFonts>` entry and
 * unregister its optimized FontFaces. The process-wide raw fonts are left intact. Called on terminate.
 * @param {DocFonts} docFonts
 */
export async function dropFromWorkers(docFonts) {
  if (!gs.schedulerInner) return;
  await Promise.all(gs.schedulerInner.workers.map((worker) => worker.dropFontsWorker({ docId: docFonts.id })));
}

/**
 * Set this document's default font to whatever font is most common in the provided font metrics.
 * @param {DocFonts} docFonts
 * @param {Object.<string, CharMetricsFamily>} charMetricsObj
 */
export function setDefaultAuto(docFonts, charMetricsObj) {
  const multiFontMode = checkMultiFontMode(charMetricsObj);

  // Return early if the OCR data does not contain font info.
  if (!multiFontMode) return;

  // Change default font to whatever named font appears more
  if ((charMetricsObj.SerifDefault?.obs || 0) > (charMetricsObj.SansDefault?.obs || 0)) {
    docFonts.state.defaultFontName = 'SerifDefault';
  } else {
    docFonts.state.defaultFontName = 'SansDefault';
  }

  if (gs.schedulerInner) {
    for (const worker of gs.schedulerInner.workers) {
      worker.updateFontContWorker({ docId: docFonts.id, defaultFontName: docFonts.state.defaultFontName });
    }
  }
}

/**
 *
 * @param {FontContainerFamilyBuiltIn} fontFamily
 * @param {Object.<string, CharMetricsFamily>} charMetricsObj
 * @param {number} docId - Owning document id, used to scope the optimized-font names.
 */
export async function optimizeFontContainerFamily(fontFamily, charMetricsObj, docId) {
  // When we have metrics for individual fonts families, those are used to optimize the appropriate fonts.
  // Otherwise, the "default" metric is applied to whatever font the user has selected as the default font.
  const multiFontMode = checkMultiFontMode(charMetricsObj);
  let charMetricsType = 'Default';
  if (multiFontMode) {
    if (fontFamily.normal.type === 'sans') {
      charMetricsType = 'SansDefault';
    } else if (fontFamily.normal.type === 'symbol') {
      return null;
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
      const fontContainer = new FontContainerFont(fontFamily.normal.family, fontFamily.normal.style, x.fontData, true, font, docId);
      await fontContainer.registered;
      return fontContainer;
    });

  const metricsItalic = charMetricsObj[charMetricsType][fontFamily.italic.style];
  /** @type {?FontContainerFont|Promise<FontContainerFont>} */
  let italicOptFont = null;
  if (metricsItalic && metricsItalic.obs >= 200) {
    italicOptFont = gs.optimizeFont({ fontData: fontFamily.italic.src, charMetricsObj: metricsItalic, style: fontFamily.italic.style })
      .then(async (x) => {
        const font = await loadOpentype(x.fontData, x.kerningPairs);
        const fontContainer = new FontContainerFont(fontFamily.italic.family, fontFamily.italic.style, x.fontData, true, font, docId);
        await fontContainer.registered;
        return fontContainer;
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
 * @param {number} docId - Owning document id, used to scope the optimized-font names.
 */
export async function optimizeFontContainerAll(fontPrivate, charMetricsObj, docId) {
  const carlitoPromise = optimizeFontContainerFamily(fontPrivate.Carlito, charMetricsObj, docId);
  const centuryPromise = optimizeFontContainerFamily(fontPrivate.Century, charMetricsObj, docId);
  const garamondPromise = optimizeFontContainerFamily(fontPrivate.Garamond, charMetricsObj, docId);
  const gothicPromise = optimizeFontContainerFamily(fontPrivate.Gothic, charMetricsObj, docId);
  const palatinoPromise = optimizeFontContainerFamily(fontPrivate.Palatino, charMetricsObj, docId);
  const nimbusRomanPromise = optimizeFontContainerFamily(fontPrivate.NimbusRoman, charMetricsObj, docId);
  const nimbusSansPromise = optimizeFontContainerFamily(fontPrivate.NimbusSans, charMetricsObj, docId);
  const nimbusMonoPromise = optimizeFontContainerFamily(fontPrivate.NimbusMono, charMetricsObj, docId);

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
