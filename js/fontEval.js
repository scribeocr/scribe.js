import { pageMetricsAll } from './containers/dataContainer.js';
import { FontCont } from './containers/fontContainer.js';
import { ImageCache } from './containers/imageContainer.js';
import {
  loadBuiltInFontsRaw,
  optimizeFontContainerAll, setDefaultFontAuto,
  updateFontContWorkerMain,
} from './fontContainerMain.js';
import { gs } from './generalWorkerMain.js';

/**
 * Compute the RMSD between OCR character widths and a font's glyph advance widths.
 *
 * @param {opentype.Font} fontOpentype
 * @param {CharMetricsFont} charMetrics
 * @returns {number}
 */
function calcFontWidthRMSD(fontOpentype, charMetrics) {
  const oMetrics = fontOpentype.charToGlyph('o').getMetrics();
  const xHeight = oMetrics.yMax - oMetrics.yMin;
  if (!xHeight || xHeight <= 0) return Infinity;

  let sumSqDiff = 0;
  let count = 0;

  for (const [charCode, ocrWidth] of Object.entries(charMetrics.width)) {
    const char = String.fromCharCode(parseInt(charCode));
    const glyph = fontOpentype.charToGlyph(char);
    if (!glyph || !glyph.advanceWidth) continue;

    const fontWidth = glyph.advanceWidth / xHeight;
    const diff = ocrWidth - fontWidth;
    sumSqDiff += diff * diff;
    count++;
  }

  if (count === 0) return Infinity;
  return Math.sqrt(sumSqDiff / count);
}

/**
 * Check whether the document is monospace using ratio between narrow and wide character widths.
 *
 * @param {CharMetricsFont} serifMetrics
 */
export function checkMonoWidthRatio(serifMetrics) {
  const minObs = 5;
  const getWidth = (char) => {
    const code = String(char.charCodeAt(0));
    if ((serifMetrics.widthObs[code] || 0) < minObs) return null;
    return serifMetrics.width[code] ?? null;
  };

  const narrowWidths = ['i', 'l'].map(getWidth).filter((w) => w !== null);
  const wideWidths = ['m', 'w'].map(getWidth).filter((w) => w !== null);

  if (narrowWidths.length === 0 || wideWidths.length === 0) return false;

  const narrowMean = narrowWidths.reduce((a, b) => a + b) / narrowWidths.length;
  const wideMean = wideWidths.reduce((a, b) => a + b) / wideWidths.length;

  return narrowMean / wideMean > 0.7;
}

/**
 * Check for monospace using font names in OCR data.
 *
 * @param {Array<OcrPage>} ocrArr
 */
export function checkMonoCourierPct(ocrArr) {
  let courierWords = 0;
  let totalWords = 0;
  for (const page of ocrArr) {
    for (const line of page.lines) {
      for (const word of line.words) {
        totalWords++;
        if (/Courier/i.test(word.style.font)) courierWords++;
      }
    }
  }
  if (totalWords === 0) return false;
  return courierWords / totalWords > 0.5;
}

/**
 * Use character metrics to select candidate serif fonts for evaluation.
 *
 * @param {Object.<string, CharMetricsFamily>} charMetricsObj
 * @param {Array<OcrPage>} ocrArr
 */
function getSerifCandidateFonts(charMetricsObj, ocrArr) {
  const allSerifFonts = ['Century', 'Palatino', 'Garamond', 'NimbusRoman', 'NimbusMono'];

  const serifMetrics = charMetricsObj?.SerifDefault?.normal;
  if (!serifMetrics || serifMetrics.obs < 200 || Object.keys(serifMetrics.width).length < 5) {
    return new Set(allSerifFonts);
  }

  const monoByWidth = checkMonoWidthRatio(serifMetrics);
  const monoByCourier = checkMonoCourierPct(ocrArr);

  if (monoByWidth && monoByCourier) {
    return new Set(['NimbusMono']);
  }

  const candidates = new Set();

  if (monoByWidth || monoByCourier) {
    candidates.add('NimbusMono');
  }

  // Keep the top 3 candidate proportional serif fonts
  const serifFonts = allSerifFonts.filter((f) => f !== 'NimbusMono');
  const rmsdScores = [];

  for (const fontName of serifFonts) {
    const fontObj = FontCont.raw?.[fontName]?.normal;
    if (!fontObj?.opentype) continue;
    rmsdScores.push({ fontName, rmsd: calcFontWidthRMSD(fontObj.opentype, serifMetrics) });
  }

  rmsdScores.sort((a, b) => a.rmsd - b.rmsd);

  for (let i = 0; i < Math.min(3, rmsdScores.length); i++) {
    candidates.add(rmsdScores[i].fontName);
  }

  return candidates;
}

/**
 * Evaluate how well a font matches the provided array of pages.
 * @param {string} font - Name of font family.
 * @param {Array<OcrPage>} pageArr
 * @param {boolean} opt - Whether to use optimized fonts.
 * @param {number} n - Number of words to compare
 */
export async function evalPagesFont(font, pageArr, opt, n = 500) {
  let metricTotal = 0;
  let wordsTotal = 0;

  for (let i = 0; i < pageArr.length; i++) {
    if (wordsTotal > n) break;

    const imageI = await ImageCache.getBinary(i);

    const res = await gs.evalPageFont({
      font,
      page: pageArr[i],
      binaryImage: imageI,
      pageMetricsObj: pageMetricsAll[i],
      opt,
    });

    metricTotal += res.metricTotal;
    wordsTotal += res.wordsTotal;
  }

  return { wordsTotal, metricTotal };
}

/**
 * @param {Array<OcrPage>} pageArr
 * @param {boolean} opt - Whether to use optimized fonts.
 * @param {Set<string>|null} [serifCandidates] - Serif font names to evaluate (from pre-filtering).
 *    If omitted or null, all serif fonts will be evaluated.
 */
export async function evaluateFonts(pageArr, opt, serifCandidates = null) {
  const evalCarlito = !!(opt ? FontCont.opt?.Carlito : FontCont.raw?.Carlito);
  const evalNimbusSans = !!(opt ? FontCont.opt?.NimbusSans : FontCont.raw?.NimbusSans);
  const evalCentury = (!serifCandidates || serifCandidates.has('Century')) && !!(opt ? FontCont.opt?.Century : FontCont.raw?.Century);
  const evalPalatino = (!serifCandidates || serifCandidates.has('Palatino')) && !!(opt ? FontCont.opt?.Palatino : FontCont.raw?.Palatino);
  const evalGaramond = (!serifCandidates || serifCandidates.has('Garamond')) && !!(opt ? FontCont.opt?.Garamond : FontCont.raw?.Garamond);
  const evalGothic = !!(opt ? FontCont.opt?.Gothic : FontCont.raw?.Gothic);
  const evalNimbusRoman = (!serifCandidates || serifCandidates.has('NimbusRoman')) && !!(opt ? FontCont.opt?.NimbusRoman : FontCont.raw?.NimbusRoman);
  const evalNimbusMono = (!serifCandidates || serifCandidates.has('NimbusMono')) && !!(opt ? FontCont.opt?.NimbusMono : FontCont.raw?.NimbusMono);

  const fontMetricsPromises = {
    carlito: evalCarlito ? evalPagesFont('Carlito', pageArr, opt) : null,
    nimbusSans: evalNimbusSans ? evalPagesFont('NimbusSans', pageArr, opt) : null,
    century: evalCentury ? evalPagesFont('Century', pageArr, opt) : null,
    palatino: evalPalatino ? evalPagesFont('Palatino', pageArr, opt) : null,
    garamond: evalGaramond ? evalPagesFont('Garamond', pageArr, opt) : null,
    gothic: evalGothic ? evalPagesFont('Gothic', pageArr, opt) : null,
    nimbusRoman: evalNimbusRoman ? evalPagesFont('NimbusRoman', pageArr, opt) : null,
    nimbusMono: evalNimbusMono ? evalPagesFont('NimbusMono', pageArr, opt) : null,
  };

  const fontMetricsTmp = {
    carlito: await fontMetricsPromises.carlito,
    nimbusSans: await fontMetricsPromises.nimbusSans,
    century: await fontMetricsPromises.century,
    palatino: await fontMetricsPromises.palatino,
    garamond: await fontMetricsPromises.garamond,
    gothic: await fontMetricsPromises.gothic,
    nimbusRoman: await fontMetricsPromises.nimbusRoman,
    nimbusMono: await fontMetricsPromises.nimbusMono,
  };

  const fontMetrics = {
    Carlito: fontMetricsTmp.carlito ? fontMetricsTmp.carlito.metricTotal / fontMetricsTmp.carlito.wordsTotal : null,
    NimbusSans: fontMetricsTmp.nimbusSans ? fontMetricsTmp.nimbusSans.metricTotal / fontMetricsTmp.nimbusSans.wordsTotal : null,
    Century: fontMetricsTmp.century ? fontMetricsTmp.century.metricTotal / fontMetricsTmp.century.wordsTotal : null,
    Palatino: fontMetricsTmp.palatino ? fontMetricsTmp.palatino.metricTotal / fontMetricsTmp.palatino.wordsTotal : null,
    Garamond: fontMetricsTmp.garamond ? fontMetricsTmp.garamond.metricTotal / fontMetricsTmp.garamond.wordsTotal : null,
    Gothic: fontMetricsTmp.gothic ? fontMetricsTmp.gothic.metricTotal / fontMetricsTmp.gothic.wordsTotal : null,
    NimbusRoman: fontMetricsTmp.nimbusRoman ? fontMetricsTmp.nimbusRoman.metricTotal / fontMetricsTmp.nimbusRoman.wordsTotal : null,
    NimbusMono: fontMetricsTmp.nimbusMono ? fontMetricsTmp.nimbusMono.metricTotal / fontMetricsTmp.nimbusMono.wordsTotal : null,
  };

  return fontMetrics;
}

/**
 *
 * @param {Awaited<ReturnType<evaluateFonts>>} fontMetrics
 */
const calcBestFonts = (fontMetrics) => {
  let minKeySans = 'NimbusSans';
  let minValueSans = Number.MAX_VALUE;

  for (const [key, value] of Object.entries(fontMetrics)) {
    if (!['Carlito', 'Gothic', 'NimbusSans'].includes(key)) continue;
    if (value && value < minValueSans) {
      minValueSans = value;
      minKeySans = key;
    }
  }

  let minKeySerif = 'NimbusRoman';
  let minValueSerif = Number.MAX_VALUE;

  for (const [key, value] of Object.entries(fontMetrics)) {
    if (!['Century', 'Palatino', 'Garamond', 'NimbusRoman', 'NimbusMono'].includes(key)) continue;
    if (value && value < minValueSerif) {
      minValueSerif = value;
      minKeySerif = key;
    }
  }

  return {
    minKeySans,
    minKeySerif,
  };
};

/**
 * Runs font optimization and validation. Sets `fontAll` defaults to best fonts,
 * and returns `true` if sans or serif could be improved through optimization.
 *
 * @param {Array<OcrPage>} ocrArr - Array of OCR pages to use for font optimization.
 *
 * This function should still be run, even if no character-level OCR data is present,
 * as it is responsible for picking the correct default sans/serif font.
 * The only case where this function does nothing is when (1) there is no character-level OCR data
 * and (2) no images are provided to compare against.
 */
export async function runFontOptimization(ocrArr) {
  await loadBuiltInFontsRaw();

  const calculateOpt = FontCont.state.charMetrics && Object.keys(FontCont.state.charMetrics).length > 0;

  let enableOptSerif = false;
  let enableOptSans = false;

  let optimizeFontContainerAllPromise;
  if (calculateOpt) {
    setDefaultFontAuto(FontCont.state.charMetrics);

    optimizeFontContainerAllPromise = optimizeFontContainerAll(FontCont.raw, FontCont.state.charMetrics)
      .then((res) => {
        FontCont.opt = res;
      });
  }

  // If image data exists, select the correct font by comparing to the image.
  if (ImageCache.inputModes.image || ImageCache.inputModes.pdf) {
    // Evaluate default fonts using up to 5 pages.
    const pageNum = Math.min(ImageCache.pageCount, 5);

    const serifCandidates = getSerifCandidateFonts(FontCont.state.charMetrics, ocrArr);

    FontCont.rawMetrics = await evaluateFonts(ocrArr.slice(0, pageNum), false, serifCandidates);
    const bestMetricsRaw = calcBestFonts(FontCont.rawMetrics);

    await optimizeFontContainerAllPromise;
    if (FontCont.opt && Object.keys(FontCont.opt).length > 0) {
      await updateFontContWorkerMain();

      FontCont.optMetrics = await evaluateFonts(ocrArr.slice(0, pageNum), true, serifCandidates);

      const bestMetricsOpt = calcBestFonts(FontCont.optMetrics);

      // The default font for both the optimized and unoptimized versions are set to the same font.
      // This ensures that switching on/off "font optimization" does not change the font, which would be confusing.
      if (FontCont.optMetrics[bestMetricsOpt.minKeySans] < FontCont.rawMetrics[bestMetricsRaw.minKeySans]) {
        enableOptSans = true;
        FontCont.state.sansDefaultName = bestMetricsOpt.minKeySans;
      } else {
        FontCont.state.sansDefaultName = bestMetricsRaw.minKeySans;
      }

      // Repeat for serif fonts
      if (FontCont.optMetrics[bestMetricsOpt.minKeySerif] < FontCont.rawMetrics[bestMetricsRaw.minKeySerif]) {
        enableOptSerif = true;
        FontCont.state.serifDefaultName = bestMetricsOpt.minKeySerif;
      } else {
        FontCont.state.serifDefaultName = bestMetricsRaw.minKeySerif;
      }
    } else {
      FontCont.state.sansDefaultName = bestMetricsRaw.minKeySans;
      FontCont.state.serifDefaultName = bestMetricsRaw.minKeySerif;
    }

    FontCont.state.enableOpt = enableOptSerif || enableOptSans;

    // Send updated state to all workers.
    await updateFontContWorkerMain();
  }

  return FontCont.state.enableOpt;
}
