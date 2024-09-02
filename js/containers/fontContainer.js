// File summary:
// Utility functions used for loading fonts.
// To make sure what the user sees on the canvas matches the final pdf output,
// all fonts should have an identical OpenType.js and FontFace version.

// Node.js case
import opentype from '../../lib/opentype.module.js';
import { determineSansSerif } from '../utils/miscUtils.js';

if (typeof process === 'object') {
  // @ts-ignore
  globalThis.self = globalThis;
  // @ts-ignore
  const { createRequire } = await import('module');
  globalThis.require = createRequire(import.meta.url);
  const { fileURLToPath } = await import('url');
  const { dirname } = await import('path');
  globalThis.__dirname = dirname(fileURLToPath(import.meta.url));
}

/**
 * Checks whether `multiFontMode` should be enabled or disabled.
 * @param {Object.<string, FontMetricsFamily>} fontMetricsObj
 *
 * Usually (including when the built-in OCR engine is used) we will have metrics for individual font families,
 * which are used to optimize the appropriate fonts ("multiFontMode" is `true` in this case).
 * However, it is possible for the user to upload input data with character-level positioning information
 * but no font identification information for most or all words.
 * If this is encountered the "default" metric is applied to the default font ("multiFontMode" is `false` in this case).
 */
export function checkMultiFontMode(fontMetricsObj) {
  let defaultFontObs = 0;
  let namedFontObs = 0;
  if (fontMetricsObj.Default?.obs) { defaultFontObs += (fontMetricsObj.Default?.obs || 0); }
  if (fontMetricsObj.SerifDefault?.obs) { namedFontObs += (fontMetricsObj.SerifDefault?.obs || 0); }
  if (fontMetricsObj.SansDefault?.obs) { namedFontObs += (fontMetricsObj.SansDefault?.obs || 0); }

  return namedFontObs > defaultFontObs;
}

/**
 * @param {string|ArrayBuffer} src
 * @param {?Object.<string, number>} [kerningPairs=null]
 */
export async function loadOpentype(src, kerningPairs = null) {
  const font = typeof (src) === 'string' ? await opentype.load(src) : await opentype.parse(src, { lowMemory: false });
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
 * @param {string} fontStyle - Font style.  May only be "normal" or "italic",
 *   as small-caps fonts should be loaded as a "normal" variant with a different font name.
 * @param {string} fontWeight
 * @param {string|ArrayBuffer} src - Font source
 */
export function loadFontFace(fontFamily, fontStyle, fontWeight, src) {
  const src1 = typeof (src) === 'string' ? `url(${src})` : src;

  const fontFace = new FontFace(fontFamily, src1, { style: fontStyle, weight: fontWeight });

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
 * Load font from source and return a FontContainerFont object.
 * This function is used to load the Chinese font.
 * @param {string} family
 * @param {string} style
 * @param {("sans"|"serif")} type
 * @param {ArrayBuffer} src
 * @param {boolean} opt
 *
 */
export async function loadFont(family, style, type, src, opt) {
  const fontObj = await loadOpentype(src);
  return new FontContainerFont(family, style, src, opt, fontObj);
}

/**
 *
 * @param {string} family
 * @param {string} style
 * @param {ArrayBuffer} src
 * @param {boolean} opt
 * @param {opentype.Font} opentypeObj - Kerning paris to re-apply
 * @property {string} family -
 * @property {string} style -
 * @property {ArrayBuffer} src
 * @property {opentype.Font} opentype -
 * @property {string} fontFaceName -
 * @property {string} fontFaceStyle -
 * @property {boolean} opt -
 * @property {string} type -
 *
 * A FontFace object is created and added to the document FontFaceSet, however this FontFace object is intentionally not included in the `fontContainerFont` object.
 * First, it is not necessary.  Setting the font on a canvas (the only reason loading a `FontFace` is needed) is done through refering `fontFaceName` and `fontFaceStyle`.
 * Second, it results in errors being thrown when used in Node.js, as `FontFace` will be undefined in this case.
 */
export function FontContainerFont(family, style, src, opt, opentypeObj) {
  // As FontFace objects are included in the document FontFaceSet object,
  // they need to all have unique names.
  let fontFaceName = family;
  if (opt) fontFaceName += ' Opt';

  /** @type {string} */
  this.family = family;
  /** @type {string} */
  this.style = style;
  /** @type {boolean} */
  this.opt = opt;
  /** @type {ArrayBuffer} */
  this.src = src;
  /** @type {opentype.Font} */
  this.opentype = opentypeObj;
  /** @type {string} */
  this.fontFaceName = fontFaceName;
  /** @type {('normal'|'italic')} */
  this.fontFaceStyle = this.style === 'italic' ? 'italic' : 'normal';
  /** @type {('normal'|'bold')} */
  this.fontFaceWeight = this.style === 'bold' ? 'bold' : 'normal';
  /** @type {("sans"|"serif")} */
  this.type = determineSansSerif(this.family) === 'SansDefault' ? 'sans' : 'serif';
  this.smallCapsMult = 0.75;

  if (typeof FontFace !== 'undefined') loadFontFace(this.fontFaceName, this.fontFaceStyle, this.fontFaceWeight, this.src);
}

/**
 *
 * @param {string} family
 * @param {fontSrcBuiltIn|fontSrcUpload} src
 * @param {boolean} opt
 * @returns {Promise<FontContainerFamily>}
 */
export async function loadFontContainerFamily(family, src, opt = false) {
  /** @type {FontContainerFamily} */
  const res = {
    normal: null,
    italic: null,
    bold: null,
  };

  /**
   *
   * @param {('normal'|'bold'|'italic')} type
   * @returns
   */
  const loadType = (type) => new Promise((resolve) => {
    const srcType = (src[type]);
    if (!srcType) {
      resolve(false);
      return;
    }
    // const scrNormal = typeof srcType === 'string' ? getFontAbsPath(srcType) : srcType;
    loadOpentype(srcType).then((font) => {
      res[type] = new FontContainerFont(family, type, srcType, opt, font);
      resolve(true);
    });
  });

  Promise.allSettled([loadType('normal'), loadType('italic'), loadType('bold')]);

  return res;
}

/**
 * @param {Object<string, fontSrcBuiltIn|fontSrcUpload>} srcObj
 * @param {boolean} opt
 * @returns
 */
export async function loadFontsFromSource(srcObj, opt = false) {
  /** @type {Object<string, Promise<FontContainerFamily>>} */
  const fontObjPromise = {};
  for (const [family, src] of Object.entries(srcObj)) {
    fontObjPromise[family] = loadFontContainerFamily(family, src, opt);
  }
  /** @type {Object<string, FontContainerFamily>} */
  const fontObj = {};
  for (const [key, value] of Object.entries(fontObjPromise)) {
    fontObj[key] = await value;
  }
  return fontObj;
}

// FontCont must contain no font data when initialized, and no data should be defined in this file.
// This is because this file is run both from the main thread and workers, and fonts are defined different ways in each.
// In the main thread, "raw" fonts are loaded from fetch requests, however in workers they are loaded from the main thread.
export class FontCont {
  /** @type {?FontContainer} */
  static raw = null;

  /** @type {?FontContainer} */
  static opt = null;

  /** @type {?FontContainer} */
  static export = null;

  static supp = {
    /** @type {?FontContainerFont} */
    chi_sim: null,
  };

  /** Optimized fonts will be used when believed to improve quality. */
  static enableOpt = false;

  /** Optimized fonts will always be used when they exist, even if believed to reduce quality. */
  static forceOpt = false;

  /** @type {?Awaited<ReturnType<import('../fontEval.js').evaluateFonts>>} */
  static rawMetrics = null;

  /** @type {?Awaited<ReturnType<import('../fontEval.js').evaluateFonts>>} */
  static optMetrics = null;

  static defaultFontName = 'SerifDefault';

  static serifDefaultName = 'NimbusRomNo9L';

  static sansDefaultName = 'NimbusSans';

  /** @type {?('latin'|'all')} */
  static glyphSet = null;

  /**
   * Decide whether to use the optimized version of a font family.
   * Note that even when this function returns `true`, optimized versions of every style will not exist.
   * @param {string} family - Font family name.
   */
  static useOptFamily = (family) => {
    const raw = FontCont.raw?.[family]?.normal;
    if (!raw) return false;
    const opt = FontCont.opt?.[family]?.normal;
    if (opt && FontCont.forceOpt) {
      return true;
    // If optimized fonts are enabled (but not forced), the optimized version of a font will be used if:
    // (1) The optimized version exists
    // (2) The optimized version has a better metric (so quality should improve).
    // (3) The optimized version of the default sans/serif font also has a better metric.
    // This last condition avoids font optimization being enabled in the UI when it only improves an unused font.
    } if (opt && FontCont.enableOpt) {
      const defaultFamily = raw.type === 'serif' ? FontCont.serifDefaultName : FontCont.sansDefaultName;

      const rawMetricDefault = FontCont.rawMetrics?.[defaultFamily];
      const optMetricDefault = FontCont.optMetrics?.[defaultFamily];

      const rawMetric = FontCont.rawMetrics?.[family];
      const optMetric = FontCont.optMetrics?.[family];
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
     * @param {('Default'|'SansDefault'|'SerifDefault'|string)} family - Font family name.
     * @param {('normal'|'italic'|'bold'|string)} [style='normal']
     * @param {string} [lang='eng']
     * @returns {FontContainerFont}
     */
  static getFont = (family, style = 'normal', lang = 'eng') => {
    if (lang === 'chi_sim') {
      if (!FontCont.supp.chi_sim) throw new Error('chi_sim font does not exist.');
      return FontCont.supp.chi_sim;
    }

    if (!FontCont.raw) throw new Error('Raw fonts not yet initialized.');

    // Option 1: If we have access to the font, use it.
    // Option 2: If we do not have access to the font, but it closely resembles a built-in font, use the built-in font.
    if (!FontCont.raw?.[family]?.[style]) {
      if (/Times/i.test(family)) {
        family = 'NimbusRomNo9L';
      } else if (/Helvetica/i.test(family)) {
        family = 'NimbusSans';
      } else if (/Arial/i.test(family)) {
        family = 'NimbusSans';
      } else if (/Century/i.test(family)) {
        family = 'Century';
      } else if (/Palatino/i.test(family)) {
        family = 'Palatino';
      } else if (/Garamond/i.test(family)) {
        family = 'Garamond';
      } else if (/Carlito/i.test(family)) {
        family = 'Carlito';
      } else if (/Calibri/i.test(family)) {
        family = 'Carlito';
      }
    }

    // Option 3: If the font still is not identified, use the default sans/serif font.
    if (!FontCont.raw?.[family]?.[style]) {
      family = determineSansSerif(family);
    }

    // This needs to come first as `defaultFontName` maps to either 'SerifDefault' or 'SansDefault'.
    if (family === 'Default') family = FontCont.defaultFontName;

    if (family === 'SerifDefault') family = FontCont.serifDefaultName;
    if (family === 'SansDefault') family = FontCont.sansDefaultName;

    /** @type {FontContainerFont} */
    let fontRes = FontCont.raw?.[family]?.[style];
    if (!fontRes) throw new Error(`Font container does not contain ${family} (${style}).`);

    const opt = FontCont.opt?.[family]?.[style];
    const useOpt = FontCont.useOptFamily(family);
    if (opt && useOpt) fontRes = opt;

    return fontRes;
  };

  /**
   *
   * @param {OcrWord} word
   */
  static getWordFont = (word) => {
    const wordFontFamily = word.font || FontCont.defaultFontName;
    return FontCont.getFont(wordFontFamily, word.style, word.lang);
  };

  /**
   * Reset font container to original state but do not unload default resources.
   */
  static clear = () => {
    FontCont.opt = null;
    FontCont.rawMetrics = null;
    FontCont.optMetrics = null;

    FontCont.defaultFontName = 'SerifDefault';
    FontCont.serifDefaultName = 'NimbusRomNo9L';
    FontCont.sansDefaultName = 'NimbusSans';
  };

  static terminate = () => {
    FontCont.clear();
    FontCont.raw = null;
    FontCont.glyphSet = null;
  };
}
