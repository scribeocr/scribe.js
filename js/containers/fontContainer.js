// File summary:
// Utility functions used for loading fonts.
// To make sure what the user sees on the canvas matches the final pdf output,
// all fonts should have an identical OpenType.js and FontFace version.

// Node.js case
import opentype from '../font-parser/src/index.js';
import { determineSansSerif, getStyleLookup, clearObjectProperties } from '../utils/miscUtils.js';
import { ca } from '../canvasAdapter.js';

if (typeof process === 'object') {
  // @ts-ignore
  globalThis.self = globalThis;
  // @ts-ignore
  const { createRequire } = await import('node:module');
  globalThis.require = createRequire(import.meta.url);
  const { fileURLToPath } = await import('node:url');
  const { dirname } = await import('node:path');
  globalThis.__dirname = dirname(fileURLToPath(import.meta.url));
}

/**
 * Checks whether `multiFontMode` should be enabled or disabled.
 * @param {Object.<string, CharMetricsFamily>} charMetricsObj
 *
 * Usually (including when the built-in OCR engine is used) we will have metrics for individual font families,
 * which are used to optimize the appropriate fonts ("multiFontMode" is `true` in this case).
 * However, it is possible for the user to upload input data with character-level positioning information
 * but no font identification information for most or all words.
 * If this is encountered the "default" metric is applied to the default font ("multiFontMode" is `false` in this case).
 */
export function checkMultiFontMode(charMetricsObj) {
  let defaultFontObs = 0;
  let namedFontObs = 0;
  if (charMetricsObj.Default?.obs) { defaultFontObs += (charMetricsObj.Default?.obs || 0); }
  if (charMetricsObj.SerifDefault?.obs) { namedFontObs += (charMetricsObj.SerifDefault?.obs || 0); }
  if (charMetricsObj.SansDefault?.obs) { namedFontObs += (charMetricsObj.SansDefault?.obs || 0); }

  return namedFontObs > defaultFontObs;
}

/**
 * @param {string|ArrayBuffer} src
 * @param {?Object.<string, number>} [kerningPairs=null]
 */
export async function loadOpentype(src, kerningPairs = null) {
  const font = typeof src === 'string'
    ? opentype.parse(await fetch(src).then((r) => r.arrayBuffer()))
    : opentype.parse(src);
  font.tables.gsub = null;
  // Re-apply kerningPairs object so when toArrayBuffer is called on this font later (when making a pdf) kerning data will be included
  if (kerningPairs) font.kerningPairs = kerningPairs;
  return font;
}

const fontFaceObj = {};

/**
 * Load font as FontFace and add to the document FontFaceSet.
 * If a FontFace already exists with the same name, it is deleted and replaced.
 *
 * @param {string} fontFamily - Font family name
 * @param {'normal'|'italic'} fontStyle - Small-caps fonts should be loaded as a
 *   "normal" variant with a different font name.
 * @param {'normal'|'bold'} fontWeight
 * @param {string|ArrayBuffer} src - Font source
 */
export function loadFontFace(fontFamily, fontStyle, fontWeight, src) {
  if (typeof FontFace === 'undefined') {
    const fontBuffer = src instanceof ArrayBuffer ? new Uint8Array(src) : src;
    const loaded = ca.registerFontObj({
      fontFaceName: fontFamily,
      fontFaceStyle: fontStyle,
      fontFaceWeight: fontWeight,
      src: fontBuffer,
    });
    return { loaded, status: 'loaded' };
  }

  const src1 = typeof (src) === 'string' ? `url(${src})` : src;

  const fontFace = new FontFace(fontFamily, src1, { style: fontStyle, weight: fontWeight });

  if (fontFace.status === 'error') throw new Error(`FontFace failed to load: ${fontFamily} ${fontStyle} ${fontWeight}`);

  // Fonts are stored in `document.fonts` for the main thread and `WorkerGlobalScope.fonts` for workers
  const fontSet = globalThis.document ? globalThis.document.fonts : globalThis.fonts;

  // As FontFace objects are added to the document fonts as a side effect,
  // they need to be kept track of and manually deleted to correctly replace.
  if (typeof (fontFaceObj[fontFamily]) === 'undefined') {
    fontFaceObj[fontFamily] = {};
  }

  if (typeof (fontFaceObj[fontFamily][fontStyle]) === 'undefined') {
    fontFaceObj[fontFamily][fontStyle] = {};
  }

  // Delete font if it already exists
  if (typeof (fontFaceObj[fontFamily][fontStyle][fontWeight]) !== 'undefined') {
    fontSet.delete(fontFaceObj[fontFamily][fontStyle][fontWeight]);
  }

  // Stored font for future, so it can be deleted if needed
  fontFaceObj[fontFamily][fontStyle][fontWeight] = fontFace;

  // Force loading to occur now
  fontFace.load();

  // Add font to document
  fontSet.add(fontFace);

  return fontFace;
}

/**
 * Remove every `FontFace` whose family matches `predicate` from
 * `document.fonts` (or `WorkerGlobalScope.fonts`) and from `fontFaceObj`.
 * Browser counterpart to `ca.unregisterFontsMatching`.
 * No-op in Node.
 *
 * @param {(family: string) => boolean} predicate
 */
export function unregisterFontFacesMatching(predicate) {
  if (typeof FontFace === 'undefined') return 0;
  const fontSet = globalThis.document ? globalThis.document.fonts : globalThis.fonts;
  if (!fontSet) return 0;
  let removed = 0;
  for (const family of Object.keys(fontFaceObj)) {
    if (!predicate(family)) continue;
    const styles = fontFaceObj[family];
    for (const style of Object.keys(styles)) {
      const weights = styles[style];
      for (const weight of Object.keys(weights)) {
        fontSet.delete(weights[weight]);
        removed++;
      }
    }
    delete fontFaceObj[family];
  }
  return removed;
}

/**
 * Load font from source and return a FontContainerFont object.
 * This function is used to load the Chinese font.
 * @param {string} family
 * @param {StyleLookup} styleLookup
 * @param {("sans"|"serif"|"symbol")} type
 * @param {ArrayBuffer} src
 * @param {boolean} opt
 *
 */
export async function loadFont(family, styleLookup, type, src, opt) {
  const fontObj = await loadOpentype(src);
  const font = new FontContainerFont(family, styleLookup, src, opt, fontObj);
  await font.registered;
  return font;
}

/**
 *
 * @param {string} family
 * @param {StyleLookup} styleLookup
 * @param {ArrayBuffer} src
 * @param {boolean} opt
 * @param {opentype.Font} opentypeObj - Kerning paris to re-apply
 * @param {number} [docId=0] - Owning document id. Scopes optimized-font names so two documents'
 *   optimized versions of the same family do not collide in the shared canvas/FontFace registry.
 * @property {string} family -
 * @property {StyleLookup} style -
 * @property {ArrayBuffer} src
 * @property {opentype.Font} opentype -
 * @property {string} fontFaceName -
 * @property {string} fontFaceStyle -
 * @property {boolean} opt -
 * @property {string} type -
 * @property {Promise<void>} registered - Resolves once this font's registry registration has settled.
 *
 * A FontFace object is created and added to the document FontFaceSet, however this FontFace object is intentionally not included in the `fontContainerFont` object.
 * First, it is not necessary.  Setting the font on a canvas (the only reason loading a `FontFace` is needed) is done through refering `fontFaceName` and `fontFaceStyle`.
 * Second, it results in errors being thrown when used in Node.js, as `FontFace` will be undefined in this case.
 */
export function FontContainerFont(family, styleLookup, src, opt, opentypeObj, docId = 0) {
  // FontFace objects share one process-wide FontFaceSet, so names must be unique across documents.
  // Optimized fonts differ per document, so their names carry the owning document id.
  let fontFaceName = family;
  if (opt) fontFaceName += ` Opt d${docId}`;

  /** @type {string} */
  this.family = family;
  /** @type {StyleLookup} */
  this.style = styleLookup;
  /** @type {boolean} */
  this.opt = opt;
  /** @type {ArrayBuffer} */
  this.src = src;
  /** @type {opentype.Font} */
  this.opentype = opentypeObj;
  /** @type {string} */
  this.fontFaceName = fontFaceName;
  /** @type {('normal'|'italic')} */
  this.fontFaceStyle = ['italic', 'boldItalic'].includes(this.style) ? 'italic' : 'normal';
  /** @type {('normal'|'bold')} */
  this.fontFaceWeight = ['bold', 'boldItalic'].includes(this.style) ? 'bold' : 'normal';
  /** @type {("sans"|"serif"|"symbol")} */
  this.type = (() => {
    const category = determineSansSerif(this.family);
    if (category === 'SansDefault') return 'sans';
    if (category === 'SymbolDefault') return 'symbol';
    return 'serif';
  })();
  this.smallCapsMult = 0.75;
  /**
   * @type {boolean} - Disable font. This is used to prevent a flawed font extracted from a PDF from being used.
   */
  this.disable = false;

  if (typeof FontFace !== 'undefined') {
    loadFontFace(this.fontFaceName, this.fontFaceStyle, this.fontFaceWeight, this.src);
    this.registered = Promise.resolve();
  } else {
    this.registered = ca.registerFontObj(this).catch((err) => {
      console.error(`Failed to register font ${this.fontFaceName}:`, err);
    });
  }
}

/**
 *
 * @param {string} family
 * @param {fontSrcBuiltIn|fontSrcUpload} src
 * @param {boolean} opt
 * @param {number} [docId=0] - Owning document id, used to scope optimized-font names.
 * @returns {Promise<FontContainerFamily>}
 */
export async function loadFontContainerFamily(family, src, opt = false, docId = 0) {
  /** @type {FontContainerFamily} */
  const res = {
    normal: null,
    italic: null,
    bold: null,
    boldItalic: null,
  };

  /**
   * @param {StyleLookup} styleLookup
   */
  const loadType = async (styleLookup) => {
    const srcType = src[styleLookup];
    if (!srcType) return;
    const font = await loadOpentype(srcType);
    const fontContainer = new FontContainerFont(family, styleLookup, srcType, opt, font, docId);
    await fontContainer.registered;
    res[styleLookup] = fontContainer;
  };

  await Promise.allSettled([loadType('normal'), loadType('italic'), loadType('bold'), loadType('boldItalic')]);

  return res;
}

/**
 * @param {Object<string, fontSrcBuiltIn|fontSrcUpload>} srcObj
 * @param {boolean} opt
 * @param {number} [docId=0] - Owning document id, used to scope optimized-font names.
 * @returns
 */
export async function loadFontsFromSource(srcObj, opt = false, docId = 0) {
  /** @type {Object<string, Promise<FontContainerFamily>>} */
  const fontObjPromise = {};
  for (const [family, src] of Object.entries(srcObj)) {
    fontObjPromise[family] = loadFontContainerFamily(family, src, opt, docId);
  }
  /** @type {Object<string, FontContainerFamily>} */
  const fontObj = {};
  for (const [key, value] of Object.entries(fontObjPromise)) {
    fontObj[key] = await value;
  }
  return fontObj;
}

/**
 * Process-wide fonts shared across all documents: the built-in raw fonts and the supplemental (CJK/Dingbats) fonts.
 * Loaded once per process. Per-document selection/optimization state lives on `DocFonts`.
 * Font lookups take a `DocFonts` so the same built-ins serve every document.
 */
export class GlobalFonts {
  /** @type {?FontContainer} */
  static raw = null;

  /** @type {?FontContainer} */
  static export = null;

  static supp = {
    /** @type {?FontContainerFont} */
    chi_sim: null,
    /** @type {?FontContainerFont} */
    dingbats: null,
  };

  /**
   * Decide whether to use the optimized version of a font family.
   * Note that even when this function returns `true`, optimized versions of every style will not exist.
   * @param {string} family - Font family name.
   * @param {DocFonts} docFonts - Per-document font state.
   */
  static useOptFamily = (family, docFonts) => {
    const raw = GlobalFonts.raw?.[family]?.normal;
    if (!raw) return false;
    const opt = docFonts.opt?.[family]?.normal;
    if (opt && docFonts.state.forceOpt) {
      return true;
    // If optimized fonts are enabled (but not forced), the optimized version of a font will be used if:
    // (1) The optimized version exists
    // (2) The optimized version has a better metric (so quality should improve).
    // (3) The optimized version of the default sans/serif font also has a better metric.
    // This last condition avoids font optimization being enabled in the UI when it only improves an unused font.
    } if (opt && docFonts.state.enableOpt) {
      const defaultFamily = raw.type === 'sans' ? docFonts.state.sansDefaultName : docFonts.state.serifDefaultName;

      const rawMetricDefault = docFonts.rawMetrics?.[defaultFamily];
      const optMetricDefault = docFonts.optMetrics?.[defaultFamily];

      const rawMetric = docFonts.rawMetrics?.[family];
      const optMetric = docFonts.optMetrics?.[family];
      if (rawMetric && optMetric && optMetric < rawMetric && optMetricDefault < rawMetricDefault) {
        return true;
      }
    }
    return false;
  };

  /**
   * Gets a font object.  Unlike accessing the font containers directly,
   * this method allows for special values 'Default', 'SansDefault', and 'SerifDefault' to be used.
   *
   * @param {Partial<Style>} style
   * @param {DocFonts} docFonts - Per-document font state.
   * @param {string} [lang='eng']
   * @returns {FontContainerFont}
   */
  static getFont = (style, docFonts, lang = 'eng') => {
    let family = style.font || docFonts.state.defaultFontName;

    const styleLookup = getStyleLookup(style);

    if (docFonts.doc?.[family]?.[styleLookup] && !docFonts.doc?.[family]?.[styleLookup]?.disable) {
      return docFonts.doc[family][styleLookup];
    }

    if (lang === 'chi_sim') {
      if (!GlobalFonts.supp.chi_sim) throw new Error('chi_sim font does not exist.');
      return GlobalFonts.supp.chi_sim;
    }

    if (!GlobalFonts.raw) throw new Error('Raw fonts not yet initialized.');

    // Option 1: If we have access to the font, use it.
    // Option 2: If we do not have access to the font, but it closely resembles a built-in font, use the built-in font.
    if (!GlobalFonts.raw?.[family]?.[styleLookup]) {
      if (/NimbusRom/i.test(family)) {
        family = 'NimbusRoman';
      } else if (/Times/i.test(family)) {
        family = 'NimbusRoman';
      } else if (/NimbusSan/i.test(family)) {
        family = 'NimbusSans';
      } else if (/Helvetica/i.test(family)) {
        family = 'NimbusSans';
      } else if (/Arial/i.test(family)) {
        family = 'NimbusSans';
      } else if (/CenturySch/i.test(family)) {
        family = 'Century';
      } else if (/Palatino/i.test(family)) {
        family = 'Palatino';
      } else if (/Garamond/i.test(family)) {
        family = 'Garamond';
      } else if (/CenturyGothic/i.test(family)) {
        family = 'Gothic';
      } else if (/AvantGarde/i.test(family)) {
        family = 'Gothic';
      } else if (/Carlito/i.test(family)) {
        family = 'Carlito';
      } else if (/Calibri/i.test(family)) {
        family = 'Carlito';
      } else if (/Courier/i.test(family) && docFonts.state.enableCleanToNimbusMono) {
        family = 'NimbusMono';
      } else if (/NimbusMono/i.test(family) && docFonts.state.enableCleanToNimbusMono) {
        family = 'NimbusMono';
      }
    }

    // Option 3: If the font still is not identified, use the default sans/serif font.
    if (!GlobalFonts.raw?.[family]?.[styleLookup]) {
      family = determineSansSerif(family);
    }

    // This needs to come first as `defaultFontName` maps to either 'SerifDefault' or 'SansDefault'.
    if (family === 'Default' || family === 'SymbolDefault') family = docFonts.state.defaultFontName;

    if (family === 'SerifDefault') family = docFonts.state.serifDefaultName;
    if (family === 'SansDefault') family = docFonts.state.sansDefaultName;

    /** @type {FontContainerFont} */
    let fontRes = GlobalFonts.raw?.[family]?.[styleLookup];
    if (!fontRes) throw new Error(`Font container does not contain ${family} (${styleLookup}).`);

    const opt = docFonts.opt?.[family]?.[styleLookup];
    const useOpt = GlobalFonts.useOptFamily(family, docFonts);
    if (opt && useOpt) fontRes = opt;

    return fontRes;
  };

  /**
   * @param {OcrWord} word
   * @param {DocFonts} docFonts - Per-document font state.
   */
  static getWordFont = (word, docFonts) => GlobalFonts.getFont(word.style, docFonts, word.lang);
}

/**
 * Per-document font state: optimized fonts derived from this document's text, fonts embedded in or
 * uploaded for this document, font-evaluation metrics, and font-selection settings.
 * The built-in raw and supplemental fonts are shared process-wide on `GlobalFonts`.
 */
export class DocFonts {
  /**
   * Owning document id, used to key this document's fonts/metrics/settings in the workers'
   * `Map<docId, DocFonts>`. `0` for the standalone facade instance.
   * @type {number}
   */
  id = 0;

  /** @type {?FontContainer} */
  opt = null;

  /** @type {?Object<string, FontContainerFamilyUpload>} */
  doc = null;

  /** @type {?Awaited<ReturnType<import('../fontEval.js').evaluateFonts>>} */
  rawMetrics = null;

  /** @type {?Awaited<ReturnType<import('../fontEval.js').evaluateFonts>>} */
  optMetrics = null;

  /**
   * Settings and metrics saved/restored from intermediate .scribe files. Each document has its own.
   * @type {FontState}
   */
  state = {
    /** Optimized fonts will be used when believed to improve quality. */
    enableOpt: false,

    /** Optimized fonts will always be used when they exist, even if believed to reduce quality. */
    forceOpt: false,

    /**
     * If `false`, 'Courier' will not be cleaned to Nimbus Mono.
     * This setting is useful because Tesseract sometimes misidentifies fonts as Courier, and when not the document default, Nimbus Mono is almost always incorrect.
     * Even with this setting `false`, Nimbus Mono will still be used when the font is exactly 'NimbusMono' and Nimbus Mono can still be the document default font.
     */
    enableCleanToNimbusMono: false,

    defaultFontName: 'SerifDefault',

    serifDefaultName: 'NimbusRoman',

    sansDefaultName: 'NimbusSans',

    glyphSet: null,

    /** @type {Object.<string, CharMetricsFamily>} */
    charMetrics: {},
  };

  /**
   * @param {Partial<Style>} style
   * @param {string} [lang='eng']
   * @returns {FontContainerFont}
   */
  getFont(style, lang = 'eng') { return GlobalFonts.getFont(style, this, lang); }

  /** @param {OcrWord} word */
  getWordFont(word) { return GlobalFonts.getFont(word.style, this, word.lang); }

  /** @param {string} family */
  useOptFamily(family) { return GlobalFonts.useOptFamily(family, this); }

  /**
   * Load fonts from an ArrayBuffer containing arbitrary font data.
   * Supports .ttf, .otf, and .woff formats.
   * This function should only be used for fonts we do not provide, such as user-uploaded fonts.
   * @param {ArrayBuffer} src
   */
  addFontFromFile = async (src) => {
    let fontObj;
    let fontData;
    try {
      fontObj = await loadOpentype(src);
      // It is common for raw fonts embedded in PDFs to be invalid and rejected by the OTS, but running them through opentype.js fixes them.
      // This appears to be because of the way that fonts are subsetted in PDFs.
      fontData = fontObj.toArrayBuffer();
    } catch (error) {
      console.error('Error loading font.');
      console.error(error);
      return;
    }

    const fontNameEmbedded = fontObj.names.postScriptName.en;

    let styleLookup = /** @type {StyleLookup} */ ('normal');
    if (fontNameEmbedded.match(/boldit|bdit/i)) {
      styleLookup = 'boldItalic';
    } else if (fontNameEmbedded.match(/italic/i)) {
      styleLookup = 'italic';
    } else if (fontNameEmbedded.match(/bold/i)) {
      styleLookup = 'bold';
    }

    // mupdf makes changes to font names, so we need to do the same.
    // Font names in the form `MEDJCO+CenturySchoolbook` are changed to `CenturySchoolbook`.
    // Spaces are replaced with underscores.
    const fontName = fontNameEmbedded.replace(/[^+]+\+/g, '').replace(/\s/g, '_');

    if (!this.doc?.[fontName]?.[styleLookup]) {
      try {
        const fontContainer = new FontContainerFont(fontName, styleLookup, fontData, false, fontObj);
        await fontContainer.registered;

        if (!this.doc) {
          this.doc = {};
        }

        if (!this.doc[fontName]) {
          this.doc[fontName] = {};
        }

        this.doc[fontName][styleLookup] = fontContainer;
      } catch (error) {
        console.error(`Error loading font ${fontName} ${styleLookup}.`);
      }
    } else {
      console.warn(`Font ${fontName} ${styleLookup} already exists.`);
    }
  };

  /**
   * Reset this document's font state. Does not unload process-wide built-in fonts.
   */
  clear() {
    this.opt = null;
    this.rawMetrics = null;
    this.optMetrics = null;

    this.state.enableCleanToNimbusMono = false;

    this.state.defaultFontName = 'SerifDefault';
    this.state.serifDefaultName = 'NimbusRoman';
    this.state.sansDefaultName = 'NimbusSans';

    clearObjectProperties(this.state.charMetrics);

    ca.unregisterFontsMatching((name) => name.endsWith(` Opt d${this.id}`));
    unregisterFontFacesMatching((family) => family.endsWith(` Opt d${this.id}`));
  }
}

// Worker per-job font slot. The OCR/general worker processes one job at a time; its dispatcher points
// `activeDocFonts` at that job's document fonts (by `docId`) via `setActiveDocFonts` before running it.
// `FontCont` reads this slot so worker modules (compareOCRModule, convertPageText, convertDocDocx)
// resolve the current job's document fonts. This is worker-only. Main-thread code passes a document's
// `DocFonts` explicitly and must not rely on this slot.
let activeDocFonts = new DocFonts();

/** @param {DocFonts} docFonts */
export const setActiveDocFonts = (docFonts) => { activeDocFonts = docFonts; };

export class FontCont {
  static get raw() { return GlobalFonts.raw; }

  static set raw(v) { GlobalFonts.raw = v; }

  static get export() { return GlobalFonts.export; }

  static set export(v) { GlobalFonts.export = v; }

  static get supp() { return GlobalFonts.supp; }

  static set supp(v) { GlobalFonts.supp = v; }

  static get opt() { return activeDocFonts.opt; }

  static set opt(v) { activeDocFonts.opt = v; }

  static get doc() { return activeDocFonts.doc; }

  static set doc(v) { activeDocFonts.doc = v; }

  static get rawMetrics() { return activeDocFonts.rawMetrics; }

  static set rawMetrics(v) { activeDocFonts.rawMetrics = v; }

  static get optMetrics() { return activeDocFonts.optMetrics; }

  static set optMetrics(v) { activeDocFonts.optMetrics = v; }

  static get state() { return activeDocFonts.state; }

  static set state(v) { activeDocFonts.state = v; }

  static getFont = (style, lang = 'eng') => GlobalFonts.getFont(style, activeDocFonts, lang);

  static getWordFont = (word) => GlobalFonts.getFont(word.style, activeDocFonts, word.lang);

  static useOptFamily = (family) => GlobalFonts.useOptFamily(family, activeDocFonts);

  static addFontFromFile = (src) => activeDocFonts.addFontFromFile(src);

  static clear = () => activeDocFonts.clear();

  static terminate = () => {
    activeDocFonts.clear();
    GlobalFonts.raw = null;
    activeDocFonts.state.glyphSet = null;
  };
}
