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
 * Calculate a document's font metrics from the character boxes of one text layer.
 * @param {import('./containers/pageStore.js').PageStore} store
 * @param {string} layer - Name of a text layer, or `'active'`.
 * @returns {Promise<Object.<string, CharMetricsFamily>>}
 */
export async function calcCharMetricsLayer(store, layer) {
  /** @type {Object.<string, CharMetricsRawFamily>} */
  const raw = {};

  const pageCount = store.slotCount(layer);
  let sliceStart = Date.now();
  for (let n = 0; n < pageCount; n++) {
    if (Date.now() - sliceStart > 40) {
      await new Promise((resolve) => { setTimeout(resolve, 0); });
      sliceStart = Date.now();
    }
    const pageObj = store.readOnlyPage(n, layer, true);
    if (!pageObj) continue;

    for (const lineObj of pageObj.lines) {
      for (const wordObj of lineObj.words) {
        if (!wordObj.chars) continue;

        if (wordObj.chars.length !== wordObj.text.length) continue;

        if (wordObj.conf < 80 || wordObj.lang === 'chi_sim' || wordObj.style.sup || wordObj.style.smallCaps) continue;

        const styleLookup = getStyleLookup(wordObj.style);
        if (!['normal', 'italic', 'bold'].includes(styleLookup)) continue;

        const wordFontFamily = determineSansSerif(wordObj.style.font) || 'Default';

        for (let k = 0; k < wordObj.chars.length; k++) {
          const charObj = wordObj.chars[k];

          const charHeight = charObj.bbox.bottom - charObj.bbox.top;
          const charWidth = charObj.bbox.right - charObj.bbox.left;

          // Number-only lines have no x-height characters, so lineObj.xHeight is null there.
          const charNorm = /\d/.test(charObj.text) ? lineObj.ascHeight : lineObj.xHeight;

          if (!charNorm) continue;

          const charUnicode = String(charObj.text.charCodeAt(0));

          if (!raw[wordFontFamily]) raw[wordFontFamily] = new CharMetricsRawFamily();
          const rawFont = raw[wordFontFamily][styleLookup];

          if (!rawFont.width[charUnicode]) {
            rawFont.width[charUnicode] = [];
            rawFont.height[charUnicode] = [];
          }

          rawFont.width[charUnicode].push(charWidth / charNorm);
          rawFont.height[charUnicode].push(charHeight / charNorm);
          rawFont.obs += 1;

          if (k + 1 < wordObj.chars.length) {
            const charObjNext = wordObj.chars[k + 1];
            const trailingSpace = charObjNext.bbox.left - charObj.bbox.right;
            const charWidthNext = charObjNext.bbox.right - charObjNext.bbox.left;

            // Skip pairs where the next character does not advance past the current one, such as Tesseract identifying the same character twice.
            if (trailingSpace + charWidthNext > 0) {
              const bigramUnicode = `${charUnicode},${wordObj.chars[k + 1].text.charCodeAt(0)}`;

              if (!rawFont.kerning[bigramUnicode]) {
                rawFont.kerning[bigramUnicode] = [];
                rawFont.kerning2[bigramUnicode] = [];
              }
              rawFont.kerning[bigramUnicode].push(trailingSpace / charNorm);
              rawFont.kerning2[bigramUnicode].push((trailingSpace + charWidthNext) / charNorm);
            }
          }
        }
      }
    }
  }

  /** @type {Object.<string, CharMetricsFamily>} */
  const charMetricsOut = {};

  for (const [family, obj] of Object.entries(raw)) {
    charMetricsOut[family] = new CharMetricsFamily();
    for (const [style, obj2] of Object.entries(obj)) {
      charMetricsOut[family][style] = calculateCharMetrics(obj2);
      charMetricsOut[family].obs += charMetricsOut[family][style].obs;
    }
  }

  return charMetricsOut;
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
