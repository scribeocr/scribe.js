// File summary:
// Utility functions used for loading fonts.
// To make sure what the user sees on the canvas matches the final pdf output,
// all fonts should have an identical OpenType.js and FontFace version.

// Node.js case
import opentype from '../../lib/opentype.module.js';
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
 * Load font from source and return a FontContainerFont object.
 * This function is used to load the Chinese font.
 * @param {string} family
 * @param {StyleLookup} styleLookup
 * @param {("sans"|"serif")} type
 * @param {ArrayBuffer} src
 * @param {boolean} opt
 *
 */
export async function loadFont(family, styleLookup, type, src, opt) {
  const fontObj = await loadOpentype(src);
  return new FontContainerFont(family, styleLookup, src, opt, fontObj);
}

/**
 *
 * @param {string} family
 * @param {StyleLookup} styleLookup
 * @param {ArrayBuffer} src
 * @param {boolean} opt
 * @param {opentype.Font} opentypeObj - Kerning paris to re-apply
 * @property {string} family -
 * @property {StyleLookup} style -
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
export function FontContainerFont(family, styleLookup, src, opt, opentypeObj) {
  // As FontFace objects are included in the document FontFaceSet object,
  // they need to all have unique names.
  let fontFaceName = family;
  if (opt) fontFaceName += ' Opt';

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
  /** @type {("sans"|"serif")} */
  this.type = determineSansSerif(this.family) === 'SansDefault' ? 'sans' : 'serif';
  this.smallCapsMult = 0.75;
  /**
   * @type {boolean} - Disable font. This is used to prevent a flawed font extracted from a PDF from being used.
   */
  this.disable = false;

  if (typeof FontFace !== 'undefined') {
    loadFontFace(this.fontFaceName, this.fontFaceStyle, this.fontFaceWeight, this.src);
  } else {
    ca.registerFontObj(this);
  }
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
    boldItalic: null,
  };

  /**
   *
   * @param {StyleLookup} styleLookup
   */
  const loadType = (styleLookup) => new Promise((resolve) => {
    const srcType = (src[styleLookup]);
    if (!srcType) {
      resolve(false);
      return;
    }
    loadOpentype(srcType).then((font) => {
      res[styleLookup] = new FontContainerFont(family, styleLookup, srcType, opt, font);
      resolve(true);
    });
  });

  Promise.allSettled([loadType('normal'), loadType('italic'), loadType('bold'), loadType('boldItalic')]);

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

  /** @type {?Object<string, FontContainerFamilyUpload>} */
  static doc = null;

  /** @type {?FontContainer} */
  static export = null;

  static supp = {
    /** @type {?FontContainerFont} */
    chi_sim: null,
  };

  /**
   * This object contains all data that is saved and restored from intermediate .scribe files.
   * Anything outside of this object is not saved or restored.
   * @type {FontState}
   */
  static state = {
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

  /** @type {?Awaited<ReturnType<import('../fontEval.js').evaluateFonts>>} */
  static rawMetrics = null;

  /** @type {?Awaited<ReturnType<import('../fontEval.js').evaluateFonts>>} */
  static optMetrics = null;

  /**
   * Load fonts from an ArrayBuffer containing arbitrary font data.
   * Supports .ttf, .otf, and .woff formats.
   * This function should only be used for fonts we do not provide, such as user-uploaded fonts.
   * @param {ArrayBuffer} src
   */
  static addFontFromFile = async (src) => {
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

    if (!FontCont.doc?.[fontName]?.[styleLookup]) {
      try {
        const fontContainer = new FontContainerFont(fontName, styleLookup, fontData, false, fontObj);

        if (!FontCont.doc) {
          FontCont.doc = {};
        }

        if (!FontCont.doc[fontName]) {
          FontCont.doc[fontName] = {};
        }

        FontCont.doc[fontName][styleLookup] = fontContainer;
      } catch (error) {
        console.error(`Error loading font ${fontName} ${styleLookup}.`);
      }
    } else {
      console.warn(`Font ${fontName} ${styleLookup} already exists.`);
    }
  };

  /**
   * Decide whether to use the optimized version of a font family.
   * Note that even when this function returns `true`, optimized versions of every style will not exist.
   * @param {string} family - Font family name.
   */
  static useOptFamily = (family) => {
    const raw = FontCont.raw?.[family]?.normal;
    if (!raw) return false;
    const opt = FontCont.opt?.[family]?.normal;
    if (opt && FontCont.state.forceOpt) {
      return true;
    // If optimized fonts are enabled (but not forced), the optimized version of a font will be used if:
    // (1) The optimized version exists
    // (2) The optimized version has a better metric (so quality should improve).
    // (3) The optimized version of the default sans/serif font also has a better metric.
    // This last condition avoids font optimization being enabled in the UI when it only improves an unused font.
    } if (opt && FontCont.state.enableOpt) {
      const defaultFamily = raw.type === 'serif' ? FontCont.state.serifDefaultName : FontCont.state.sansDefaultName;

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
   * @param {Partial<Style>} style
   * @param {string} [lang='eng']
   * @returns {FontContainerFont}
   */
  static getFont = (style, lang = 'eng') => {
    let family = style.font || FontCont.state.defaultFontName;

    const styleLookup = getStyleLookup(style);

    if (FontCont.doc?.[family]?.[styleLookup] && !FontCont.doc?.[family]?.[styleLookup]?.disable) {
      return FontCont.doc[family][styleLookup];
    }

    if (lang === 'chi_sim') {
      if (!FontCont.supp.chi_sim) throw new Error('chi_sim font does not exist.');
      return FontCont.supp.chi_sim;
    }

    if (!FontCont.raw) throw new Error('Raw fonts not yet initialized.');

    // Option 1: If we have access to the font, use it.
    // Option 2: If we do not have access to the font, but it closely resembles a built-in font, use the built-in font.
    if (!FontCont.raw?.[family]?.[styleLookup]) {
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
      } else if (/Courier/i.test(family) && FontCont.state.enableCleanToNimbusMono) {
        family = 'NimbusMono';
      } else if (/NimbusMono/i.test(family) && FontCont.state.enableCleanToNimbusMono) {
        family = 'NimbusMono';
      }
    }

    // Option 3: If the font still is not identified, use the default sans/serif font.
    if (!FontCont.raw?.[family]?.[styleLookup]) {
      family = determineSansSerif(family);
    }

    // This needs to come first as `defaultFontName` maps to either 'SerifDefault' or 'SansDefault'.
    if (family === 'Default') family = FontCont.state.defaultFontName;

    if (family === 'SerifDefault') family = FontCont.state.serifDefaultName;
    if (family === 'SansDefault') family = FontCont.state.sansDefaultName;

    /** @type {FontContainerFont} */
    let fontRes = FontCont.raw?.[family]?.[styleLookup];
    if (!fontRes) throw new Error(`Font container does not contain ${family} (${styleLookup}).`);

    const opt = FontCont.opt?.[family]?.[styleLookup];
    const useOpt = FontCont.useOptFamily(family);
    if (opt && useOpt) fontRes = opt;

    return fontRes;
  };

  /**
   *
   * @param {OcrWord} word
   */
  static getWordFont = (word) => FontCont.getFont(word.style, word.lang);

  /**
   * Reset font container to original state but do not unload default resources.
   */
  static clear = () => {
    FontCont.opt = null;
    FontCont.rawMetrics = null;
    FontCont.optMetrics = null;

    FontCont.state.enableCleanToNimbusMono = false;

    FontCont.state.defaultFontName = 'SerifDefault';
    FontCont.state.serifDefaultName = 'NimbusRoman';
    FontCont.state.sansDefaultName = 'NimbusSans';

    clearObjectProperties(FontCont.state.charMetrics);
  };

  static terminate = () => {
    FontCont.clear();
    FontCont.raw = null;
    FontCont.state.glyphSet = null;
  };
}
