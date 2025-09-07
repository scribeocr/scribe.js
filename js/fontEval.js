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
 */
export async function evaluateFonts(pageArr, opt) {
  const evalCarlito = !!(opt ? FontCont.opt?.Carlito : FontCont.raw?.Carlito);
  const evalNimbusSans = !!(opt ? FontCont.opt?.NimbusSans : FontCont.raw?.NimbusSans);
  const evalCentury = !!(opt ? FontCont.opt?.Century : FontCont.raw?.Century);
  const evalPalatino = !!(opt ? FontCont.opt?.Palatino : FontCont.raw?.Palatino);
  const evalGaramond = !!(opt ? FontCont.opt?.Garamond : FontCont.raw?.Garamond);
  const evalGothic = !!(opt ? FontCont.opt?.Gothic : FontCont.raw?.Gothic);
  const evalNimbusRoman = !!(opt ? FontCont.opt?.NimbusRoman : FontCont.raw?.NimbusRoman);
  const evalNimbusMono = !!(opt ? FontCont.opt?.NimbusMono : FontCont.raw?.NimbusMono);

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

    FontCont.rawMetrics = await evaluateFonts(ocrArr.slice(0, pageNum), false);
    const bestMetricsRaw = calcBestFonts(FontCont.rawMetrics);

    await optimizeFontContainerAllPromise;
    if (FontCont.opt && Object.keys(FontCont.opt).length > 0) {
      await updateFontContWorkerMain();

      FontCont.optMetrics = await evaluateFonts(ocrArr.slice(0, pageNum), true);

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
