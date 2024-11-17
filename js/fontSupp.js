import { gs } from './generalWorkerMain.js';
import ocr from './objects/ocrObjects.js';
import { recognizePageImp } from './recognizeConvert.js';
import { calcWordFontSize } from './utils/fontUtils.js';
import {
  calcBboxUnion, determineSansSerif,
  FontProps,
  quantile,
} from './utils/miscUtils.js';

/**
 *
 * @param {Array<OcrWord>} words
 * @returns
 */
const calcSuppFontInfoForWords = async (words) => {
  let sansVotes = 0;
  let serifVotes = 0;
  let fontSizeMult = null;

  const rect0 = calcBboxUnion(words.map((word) => word.bbox));
  const rect = {
    left: rect0.left,
    top: rect0.top,
    width: rect0.right - rect0.left,
    height: rect0.bottom - rect0.top,
  };
  if (rect.width < 5 || rect.height < 5) return { sansVotes, serifVotes, fontSizeMult };

  const legacy = true;
  const lstm = false;

  let pageNew;
  try {
    const res0 = await recognizePageImp(words[0].line.page.n, legacy, lstm, true, { rectangle: rect, tessedit_pageseg_mode: '6' });

    const resLegacy = await res0[0];
    pageNew = resLegacy.convert.legacy.pageObj;
  } catch {
    return { sansVotes, serifVotes, fontSizeMult };
  }

  const wordsRes = ocr.getPageWords(pageNew);
  const fontSizeArr = [];
  for (const word of wordsRes) {
    fontSizeArr.push(calcWordFontSize(word));
    const sansSerif = determineSansSerif(word.font);
    if (sansSerif !== 'Default') {
      if (sansSerif === 'SansDefault') {
        sansVotes++;
      } else {
        serifVotes++;
      }
    }
  }
  if (words[0].size) {
    // @ts-ignore
    fontSizeMult = quantile(fontSizeArr, 0.5) / words[0].size;
  }

  return { sansVotes, serifVotes, fontSizeMult };
};

/**
   *
   * @param {Array<OcrPage>} ocrArr
   * @returns
   * This function runs recognition on certain fonts when we need more information about them.
   * Fonts are included when either (1) we need to know if they are sans or serif or (2) if the text is extracted from a PDF,
   * and we need to determine how large to render the text.
   */
export const calcSuppFontInfo = async (ocrArr) => {
  if (!ocrArr) return;
  await gs.initTesseract({ anyOk: true, langs: ['eng'] });
  // console.time('calcSuppFontInfo');
  const calcFonts = new Set();
  const skipFonts = new Set();

  /** @type {Object<string, Array<Array<OcrWord>>>} */
  const fontExamples = {};
  for (const page of ocrArr) {
    for (const line of page.lines) {
      let wordFontLast;
      let wordFontSizeLast;
      for (const word of line.words) {
        if (word.font) {
          if (skipFonts.has(word.font)) {
            continue;
          // Printing words off screen is a common method of hiding text in PDFs.
          } else if (word.bbox.left < 0 || word.bbox.top < 0 || word.bbox.right > page.dims.width || word.bbox.bottom > page.dims.height) {
            continue;
          } else if (!calcFonts.has(word.font)) {
            const sansSerifUnknown = determineSansSerif(word.font) === 'Default';
            if (sansSerifUnknown || !word.visualCoords) {
              calcFonts.add(word.font);
            } else {
              skipFonts.add(word.font);
              continue;
            }
          }

          if (!fontExamples[word.font]) {
            fontExamples[word.font] = [];
          } else if (fontExamples[word.font].length > 3) {
            continue;
          }

          if (word.font !== wordFontLast || word.size !== wordFontSizeLast) {
            fontExamples[word.font].push([word]);
          } else {
            fontExamples[word.font][fontExamples[word.font].length - 1].push(word);
          }

          wordFontLast = word.font;
          wordFontSizeLast = word.size;
        }
      }
    }
  }

  const resPromises = {};
  for (const [key, value] of Object.entries(fontExamples)) {
    if (value.length < 3) continue;
    resPromises[key] = [];
    for (let i = 0; i < value.length; i++) {
      resPromises[key].push(calcSuppFontInfoForWords(value[i]));
    }
  }

  for (const [key, value] of Object.entries(resPromises)) {
    const resArr = await Promise.all(value);
    let sansVotes = 0;
    let serifVotes = 0;
    const fontSizeMultArr = [];
    for (const res of resArr) {
      if (res.sansVotes) sansVotes += res.sansVotes;
      if (res.serifVotes) serifVotes += res.serifVotes;
      if (res.fontSizeMult) {
        fontSizeMultArr.push(res.fontSizeMult);
      }
    }
    if (fontSizeMultArr.length >= 3) {
      const fontSizeMult = quantile(fontSizeMultArr, 0.5);
      if (fontSizeMult && fontSizeMult > 0.9 && fontSizeMult < 1.5) FontProps.sizeMult[key] = fontSizeMult;
    }

    if (serifVotes > sansVotes) {
      FontProps.serifFontsDoc.add(key);
      // console.log('Serif:', key, serifVotes, sansVotes);
    } else {
      FontProps.sansFontsDoc.add(key);
      // console.log('Sans:', key, serifVotes, sansVotes);
    }
  }

  if (Object.keys(FontProps.sizeMult).length === 0) return;

  for (const page of ocrArr) {
    for (const line of page.lines) {
      for (const word of line.words) {
        if (word.font && word.size && FontProps.sizeMult[word.font]) {
          word.size = Math.round(word.size * FontProps.sizeMult[word.font] * 1000) / 1000;
        }
      }
    }
  }

  // console.timeEnd('calcSuppFontInfo');
};
