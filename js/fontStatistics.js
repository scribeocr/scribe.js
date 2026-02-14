// File summary:
// Functions to calculate font metrics and generate new fonts.

import {
  determineSansSerif,
  getStyleLookup,
  quantile,
  round6,
} from './utils/miscUtils.js';

import { CharMetricsFamily, CharMetricsFont, CharMetricsRawFamily } from './objects/charMetricsObjects.js';

/**
 * Combine page-level character statistics to calculate overall font metrics.
 * Run after all files (both image and OCR) have been loaded.
 *
 * @param {Array<OcrPage>} pageArr
 */
export function calcCharMetricsFromPages(pageArr) {
  if (!pageArr || pageArr.length === 0) return {};

  const pageCharMetricsArr = pageArr.map((x) => calcCharMetricsPage(x));

  if (pageCharMetricsArr.length === 0) return {};

  const charMetricsRawObj = pageCharMetricsArr.reduce((x, y) => unionCharMetricsRawObj(x, y));

  /** @type {Object.<string, CharMetricsFamily>} */
  const charMetricsOut = {};

  for (const [family, obj] of Object.entries(charMetricsRawObj)) {
    charMetricsOut[family] = new CharMetricsFamily();
    for (const [style, obj2] of Object.entries(obj)) {
      charMetricsOut[family][style] = calculateCharMetrics(obj2);
      charMetricsOut[family].obs += charMetricsOut[family][style].obs;
    }
  }

  return charMetricsOut;
}

// The following functions are used for combining an array of page-level charMetrics objects produced by convertPage.js into a single document-level object.

/**
 * Adds observations from `charMetricsRawFontB` into `charMetricsRawFontA`. Modifies `charMetricsRawFontA` in place.
 *
 * @param {?CharMetricsRawFont} charMetricsRawFontA
 * @param {?CharMetricsRawFont} charMetricsRawFontB
 * @param {?number} xHeight - If specified, values from `charMetricsRawFontB` will be normalized by dividing by `xHeight`.
 * @returns {?CharMetricsRawFont} - Returns charMetricsRawFontA after modifying in place
 */
function unionCharMetricsFont(charMetricsRawFontA, charMetricsRawFontB, xHeight = null) {
  // If one of the inputs is undefined, return early with the only valid object
  if (!charMetricsRawFontA) {
    if (!charMetricsRawFontB) return null;
    charMetricsRawFontA = structuredClone(charMetricsRawFontB);
    return charMetricsRawFontA;
  }
  if (!charMetricsRawFontB) {
    return charMetricsRawFontA;
  }

  if (charMetricsRawFontB?.obs) charMetricsRawFontA.obs += charMetricsRawFontB.obs;

  for (const [prop, obj] of Object.entries(charMetricsRawFontB)) {
    for (const [key, value] of Object.entries(obj)) {
      if (!charMetricsRawFontA[prop][key]) {
        charMetricsRawFontA[prop][key] = [];
      }
      if (xHeight) {
        const valueNorm = value.map((x) => x / xHeight).filter((x) => x);
        Array.prototype.push.apply(charMetricsRawFontA[prop][key], valueNorm);
      } else {
        Array.prototype.push.apply(charMetricsRawFontA[prop][key], value);
      }
    }
  }
  return (charMetricsRawFontA);
}

/**
 * Adds observations from `charMetricsRawObjB` into `charMetricsRawObjA`. Modifies `charMetricsRawObjA` in place.
 *
 * @param {Object.<string, CharMetricsRawFamily>} charMetricsRawObjA
 * @param {Object.<string, CharMetricsRawFamily>} charMetricsRawObjB
 * @returns {Object.<string, CharMetricsRawFamily>} - Returns charMetricsRawObjA after modifying in place
 */
function unionCharMetricsRawObj(charMetricsRawObjA, charMetricsRawObjB) {
  for (const [family, obj] of Object.entries(charMetricsRawObjB)) {
    for (const [style, obj2] of Object.entries(obj)) {
      if (Object.keys(obj2.width).length === 0) continue;
      if (!charMetricsRawObjA[family]) {
        charMetricsRawObjA[family] = new CharMetricsRawFamily();
      }
    }
  }

  for (const [family, obj] of Object.entries(charMetricsRawObjA)) {
    for (const [style, obj2] of Object.entries(obj)) {
      unionCharMetricsFont(charMetricsRawObjA?.[family]?.[style], charMetricsRawObjB?.[family]?.[style]);
    }
  }

  return (charMetricsRawObjA);
}

/**
 * Calculates final font statistics from individual observations.
 *
 * @param {CharMetricsRawFont} charMetricsRawFontObj
 * @returns {CharMetricsFont} -
 */
function calculateCharMetrics(charMetricsRawFontObj) {
  const fontMetricOut = new CharMetricsFont();

  // Take the median of each array
  for (const prop of ['width', 'height', 'kerning', 'kerning2']) {
    for (const [key, value] of Object.entries(charMetricsRawFontObj[prop])) {
      if (value.length > 0) {
        fontMetricOut[prop][key] = round6(quantile(value, 0.5));
        if (prop === 'width') fontMetricOut.widthObs[key] = value.length;
      }
    }
  }

  // Calculate median hight of capital letters only
  const heightCapsArr = [];
  for (const [key, value] of Object.entries(charMetricsRawFontObj.height)) {
    if (/[A-Z]/.test(String.fromCharCode(parseInt(key)))) {
      Array.prototype.push.apply(heightCapsArr, value);
    }
  }

  fontMetricOut.heightCaps = round6(quantile(heightCapsArr, 0.5));
  fontMetricOut.obsCaps = heightCapsArr.length;

  fontMetricOut.obs = charMetricsRawFontObj.obs;

  // Standardize all metrics be normalized by x-height
  // The raw metrics may be normalized by ascHeight (for numbers) or x-height (for all other characters).
  for (const prop of ['width', 'height', 'kerning', 'kerning2']) {
    for (const [key, value] of Object.entries(charMetricsRawFontObj[prop])) {
      const nameFirst = key.match(/\w+/)[0];
      const charFirst = String.fromCharCode(parseInt(nameFirst));
      if (/\d/.test(charFirst)) {
        fontMetricOut[prop][key] *= fontMetricOut.heightCaps;
      }
    }
  }

  // The `kerning2` observations contain the measurement between the end of char 1 and the end of char 2.
  // Therefore, the width of char 2 must be subtracted to get a measurement comparable with `kerning`.
  for (const prop of ['kerning2']) {
    for (const [key, value] of Object.entries(charMetricsRawFontObj[prop])) {
      if (value.length > 0) {
        const nameSecond = key.match(/\w+$/)[0];

        const widthSecond = fontMetricOut.width[nameSecond];

        fontMetricOut[prop][key] -= widthSecond;
      }
    }
  }

  return (fontMetricOut);
}

function calcTopFont(fontScoresChar) {
  if (!fontScoresChar) return '';

  const fonts = Object.keys(fontScoresChar);
  let maxScore = 0;
  let maxScoreFont = '';
  for (let i = 0; i < fonts.length; i++) {
    const font = fonts[i];
    const score = fontScoresChar[font];
    if (score > maxScore) {
      maxScore = score;
      maxScoreFont = font;
    }
  }
  return maxScoreFont;
}

// Sans fonts with "1" without horizontal base: Arial, Helvetica, Impact, Trebuchet.  All serif fonts are included.
const base1Arr = ['Calibri', 'Comic', 'Franklin', 'Tahoma', 'Verdana', 'Baskerville', 'Book', 'Cambria', 'Century_Schoolbook', 'Courier', 'Garamond', 'Georgia', 'Times'];
const base1Regex = new RegExp(base1Arr.reduce((x, y) => `${x}|${y}`), 'i');

// Fonts with double "g" are: Calibri, Franklin, Trebuchet
const singleGArr = ['Arial', 'Comic', 'DejaVu', 'Helvetica', 'Impact', 'Tahoma', 'Verdana'];
const singleGRegex = new RegExp(singleGArr.reduce((x, y) => `${x}|${y}`), 'i');

// Fonts where italic "y" has an open counter where the lowest point is to the left of the tail
const minYArr = ['Bookman', 'Georgia'];
const minYRegex = new RegExp(minYArr.reduce((x, y) => `${x}|${y}`), 'i');

// Fonts where italic "k" has a closed loop
const closedKArr = ['Century_Schoolbook'];
const closedKRegex = new RegExp(closedKArr.reduce((x, y) => `${x}|${y}`), 'i');

// Fonts where italic "v" and "w" is rounded (rather than pointy)
const roundedVWArr = ['Bookman', 'Century_Schoolbook', 'Georgia'];
const roundedVWRegex = new RegExp(roundedVWArr.reduce((x, y) => `${x}|${y}`), 'i');

const serifStemSerifPQArr = ['Bookman', 'Century_Schoolbook', 'Courier', 'Georgia', 'Times'];
const serifStemSerifPQRegex = new RegExp(serifStemSerifPQArr.reduce((x, y) => `${x}|${y}`), 'i');

// This function is currently unused. Keeping as we may restore this feature in the future.
// While the majority of glyphs can be approximated by applying geometric transformations to a single sans and serif font,
// there are some exceptions (e.g. the lowercase "g" has 2 distinct variations).
// This function identifies variations that require switching out a glyph from the default font entirely.
function identifyFontVariants(fontScores, charMetrics) {
  if (charMetrics?.SansDefault?.normal) {
    const sansG = calcTopFont(fontScores?.SansDefault?.normal?.g);
    charMetrics.SansDefault.normal.variants.sans_g = singleGRegex.test(sansG);
    const sans1 = calcTopFont(fontScores?.SansDefault?.normal?.['1']);
    charMetrics.SansDefault.normal.variants.sans_1 = base1Regex.test(sans1);
  }

  if (charMetrics?.SerifDefault?.italic) {
    const minY = calcTopFont(fontScores?.SerifDefault?.italic?.y);
    charMetrics.SerifDefault.italic.variants.serif_italic_y = minYRegex.test(minY);
    const closedK = calcTopFont(fontScores?.SerifDefault?.italic?.y);
    charMetrics.SerifDefault.italic.variants.serif_open_k = !closedKRegex.test(closedK);

    const roundedV = calcTopFont(fontScores?.SerifDefault?.italic?.v);
    const roundedW = calcTopFont(fontScores?.SerifDefault?.italic?.w);
    charMetrics.SerifDefault.italic.variants.serif_pointy_vw = !(roundedVWRegex.test(roundedV) || roundedVWRegex.test(roundedW));

    const serifItalicP = calcTopFont(fontScores?.SerifDefault?.italic?.p);
    const serifItalicQ = calcTopFont(fontScores?.SerifDefault?.italic?.q);
    charMetrics.SerifDefault.italic.variants.serif_stem_sans_pq = !(serifStemSerifPQRegex.test(serifItalicP) || serifStemSerifPQRegex.test(serifItalicQ));
  }

  return charMetrics;
}

/**
 *
 * @param {OcrPage} pageObj
 */
function calcCharMetricsPage(pageObj) {
  /** @type {Object.<string, CharMetricsRawFamily>} */
  const charMetricsRawPage = {};

  for (const lineObj of pageObj.lines) {
    for (const wordObj of lineObj.words) {
      const wordFontFamily = determineSansSerif(wordObj.style.font) || 'Default';

      // This condition should not occur, however has in the past due to parsing bugs.  Skipping to avoid entire program crashing if this occurs.
      if (wordObj.chars && wordObj.chars.length !== wordObj.text.length) continue;

      // Do not include superscripts, dropcaps, and low-confidence words in statistics for font optimization.
      if (wordObj.conf < 80 || wordObj.lang === 'chi_sim' || wordObj.style.sup || wordObj.style.smallCaps) continue;
      /** @type {Object.<string, CharMetricsRawFamily>} */
      const charMetricsRawLine = {};

      if (wordObj.chars) {
        for (let k = 0; k < wordObj.chars.length; k++) {
          const charObj = wordObj.chars[k];

          const charHeight = charObj.bbox.bottom - charObj.bbox.top;
          const charWidth = charObj.bbox.right - charObj.bbox.left;

          // Numbers are normalized as a proportion of ascHeight, everything else is normalized as a percentage of x-height.
          // This is because x-sized characters are more common in text, however numbers are often in "lines" with only numbers,
          // so do not have any x-sized characters to compare to.
          const charNorm = /\d/.test(charObj.text) ? lineObj.ascHeight : lineObj.xHeight;

          if (!charNorm) continue;

          // Multiple characters within a single <ocrx_cinfo> tag have been observed from Tesseract (even when set to char-level output).
          // May cause future issues as this code assumes one character per <ocrx_cinfo> tag.
          const charUnicode = String(charObj.text.charCodeAt(0));

          if (!charMetricsRawLine[wordFontFamily]) {
            charMetricsRawLine[wordFontFamily] = new CharMetricsRawFamily();
          }

          const styleLookup = getStyleLookup(wordObj.style);

          if (!['normal', 'italic', 'bold'].includes(styleLookup)) continue;

          if (!charMetricsRawLine[wordFontFamily][styleLookup].width[charUnicode]) {
            charMetricsRawLine[wordFontFamily][styleLookup].width[charUnicode] = [];
            charMetricsRawLine[wordFontFamily][styleLookup].height[charUnicode] = [];
          }

          charMetricsRawLine[wordFontFamily][styleLookup].width[charUnicode].push(charWidth / charNorm);
          charMetricsRawLine[wordFontFamily][styleLookup].height[charUnicode].push(charHeight / charNorm);
          charMetricsRawLine[wordFontFamily][styleLookup].obs += 1;

          if (k + 1 < wordObj.chars.length) {
            const charObjNext = wordObj.chars[k + 1];
            const trailingSpace = charObjNext.bbox.left - charObj.bbox.right;
            const charWidthNext = charObjNext.bbox.right - charObjNext.bbox.left;

            // Only record space between characters when text is moving forward
            // This *should* always be true, however there are some fringe cases where this assumption does not hold,
            // such as Tesseract identifying the same character twice.
            if (trailingSpace + charWidthNext > 0) {
              const bigramUnicode = `${charUnicode},${wordObj.chars[k + 1].text.charCodeAt(0)}`;

              if (!charMetricsRawLine[wordFontFamily][styleLookup].kerning[bigramUnicode]) {
                charMetricsRawLine[wordFontFamily][styleLookup].kerning[bigramUnicode] = [];
                charMetricsRawLine[wordFontFamily][styleLookup].kerning2[bigramUnicode] = [];
              }
              charMetricsRawLine[wordFontFamily][styleLookup].kerning[bigramUnicode].push(trailingSpace / charNorm);
              charMetricsRawLine[wordFontFamily][styleLookup].kerning2[bigramUnicode].push((trailingSpace + charWidthNext) / charNorm);
            }
          }
        }
      }

      for (const [family, obj] of Object.entries(charMetricsRawLine)) {
        for (const [style, obj2] of Object.entries(obj)) {
          if (Object.keys(obj2.width).length === 0) continue;
          if (!charMetricsRawPage[family]) {
            charMetricsRawPage[family] = new CharMetricsRawFamily();
          }
        }
      }

      for (const [family, obj] of Object.entries(charMetricsRawPage)) {
        for (const [style, obj2] of Object.entries(obj)) {
          unionCharMetricsFont(charMetricsRawPage?.[family]?.[style], charMetricsRawLine?.[family]?.[style]);
        }
      }
    }
  }

  return charMetricsRawPage;
}
