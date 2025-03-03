import { clearData } from './js/clear.js';
import { inputData, opt } from './js/containers/app.js';
import {
  DebugData,
  layoutDataTables,
  layoutRegions,
  ocrAll, pageMetricsArr, visInstructions,
} from './js/containers/dataContainer.js';
import { FontCont } from './js/containers/fontContainer.js';
import { ImageCache } from './js/containers/imageContainer.js';
import coords from './js/coordinates.js';
import { drawDebugImages, renderPageStatic } from './js/debug.js';
import { download, exportData } from './js/export/export.js';
import { convertToCsv, writeDebugCsv } from './js/export/exportDebugCsv.js';
import { writePdf } from './js/export/writePdf.js';
import { writeHocr } from './js/export/writeHocr.js';
import { writeText } from './js/export/writeText.js';
import { extractInternalPDFText } from './js/extractPDFText.js';
import { extractSingleTableContent } from './js/extractTables.js';
import { enableFontOpt, loadBuiltInFontsRaw } from './js/fontContainerMain.js';
import { gs } from './js/generalWorkerMain.js';
import { importFiles, importFilesSupp } from './js/import/import.js';
import { combineOCRPage } from './js/modifyOCR.js';
import {
  calcBoxOverlap, countSubstringOccurrences, getRandomAlphanum, replaceSmartQuotes,
  saveAs,
} from './js/utils/miscUtils.js';
import layout, { calcTableBbox } from './js/objects/layoutObjects.js';
import ocr from './js/objects/ocrObjects.js';
import {
  calcEvalStatsDoc,
  compareOCR,
  convertOCRPage,
  evalOCRPage,
  recognize, recognizePageImp,
} from './js/recognizeConvert.js';
import { calcWordMetrics } from './js/utils/fontUtils.js';
import { imageStrToBlob } from './js/utils/imageUtils.js';
import {
  calcConf, checkOcrWordsAdjacent, mergeOcrWords, splitOcrWord,
} from './js/utils/ocrUtils.js';
import { assignParagraphs } from './js/utils/reflowPars.js';
import { writeXlsx } from './js/export/writeTabular.js';
import { calcColumnBounds, detectTablesInPage, makeTableFromBbox } from './js/utils/detectTables.js';
import { ca } from './js/canvasAdapter.js';

/**
 * Initialize the program and optionally pre-load resources.
 * @public
 * @param {Object} [params]
 * @param {boolean} [params.pdf=false] - Load PDF renderer.
 * @param {boolean} [params.ocr=false] - Load OCR engine.
 * @param {boolean} [params.font=false] - Load built-in fonts.
 * The PDF renderer and OCR engine are automatically loaded when needed.
 * Therefore, the only reason to set `pdf` or `ocr` to `true` is to pre-load them.
 * @param {Parameters<typeof import('./js/generalWorkerMain.js').gs.initTesseract>[0]} [params.ocrParams] - Parameters for initializing OCR.
 */
const init = async (params) => {
  const initPdf = params && params.pdf ? params.pdf : false;
  const initOcr = params && params.ocr ? params.ocr : false;
  const initFont = params && params.font ? params.font : false;

  const promiseArr = [];

  promiseArr.push(initPdf ? ImageCache.getMuPDFScheduler() : Promise.resolve());

  promiseArr.push(gs.getGeneralScheduler());

  if (initOcr) {
    const ocrParams = params && params.ocrParams ? params.ocrParams : {};
    promiseArr.push(gs.initTesseract(ocrParams));
  }

  if (initFont) {
    promiseArr.push(loadBuiltInFontsRaw());
  }

  await Promise.all(promiseArr);
};

/**
 * Function for extracting text from image and PDF files with a single function call.
 * By default, existing text content is extracted for text-native PDF files; otherwise text is extracted using OCR.
 * To control how text from PDF files is handled, set the options in the `opt.usePDFText` object.
 * For more control, use `init`, `importFiles`, `recognize`, and `exportData` separately.
 * @public
 * @param {Parameters<typeof importFiles>[0]} files
 * @param {Array<string>} [langs=['eng']]
 * @param {Parameters<typeof exportData>[0]} [outputFormat='txt']
 */
const extractText = async (files, langs = ['eng'], outputFormat = 'txt', options = {}) => {
  const skipRecPDFTextNative = options?.skipRecPDFTextNative ?? true;
  const skipRecPDFTextOCR = options?.skipRecPDFTextOCR ?? false;
  init({ ocr: true, font: true });
  await importFiles(files);
  if (!inputData.xmlMode[0] && !inputData.imageMode && !inputData.pdfMode) throw new Error('No relevant files to process.');
  const skipRecPDF = inputData.pdfMode && (inputData.pdfType === 'text' && skipRecPDFTextNative || inputData.pdfType === 'ocr' && skipRecPDFTextOCR);
  const skipRecOCR = inputData.xmlMode[0] && !inputData.imageMode && !inputData.pdfMode;
  if (!skipRecPDF && !skipRecOCR) await recognize({ langs });
  return exportData(outputFormat);
};

/**
 *
 * @param {OffscreenCanvas} canvas
 * @param {Array<Array<CompDebugNode>>} compDebugArrArr
 * @param {string} filePath
 * @public
 */
async function writeDebugImages(canvas, compDebugArrArr, filePath) {
  if (typeof process === 'undefined') {
    throw new Error('This function is only available in Node.js.');
  } else {
    const canvas = await drawDebugImages({ compDebugArrArr, context: 'node' });

    const imgURL = canvas.toDataURL();
    const imgData = new Uint8Array(atob(imgURL.split(',')[1])
      .split('')
      .map((c) => c.charCodeAt(0)));
    const fs = await import('fs');
    fs.writeFileSync(filePath, imgData);
  }
}

/**
 * Dump all debug images to directory `dir`.
 * Only available in Node.js.
 * @param {string} dir
 * @returns
 */
async function dumpDebugImages(dir) {
  if (typeof process === 'undefined') {
    throw new Error('This function is only available in Node.js.');
  } else {
    if (!DebugData.debugImg.Combined || DebugData.debugImg.Combined.length === 0) {
      console.log('No debug images to dump.');
      return;
    }

    const canvasAlt = await ca.createCanvas(200, 200);
    const ctxDebug = canvasAlt.getContext('2d');

    for (const [name, imgArr] of Object.entries(DebugData.debugImg)) {
      if (!imgArr || imgArr.length === 0) continue;
      for (let i = 0; i < imgArr.length; i++) {
        const filePath = `${dir}/${name}_${i}.png`;
        await writeDebugImages(canvasAlt, [imgArr[i]], filePath);
      }
    }
  }
}

async function dumpHOCR(dir) {
  if (typeof process === 'undefined') {
    throw new Error('This function is only available in Node.js.');
  } else {
    const activeCurrent = ocrAll.active;

    const fs = await import('fs');
    for (const [name, pages] of Object.entries(ocrAll)) {
      ocrAll.active = pages;
      const hocrStr = await exportData('hocr');
      fs.writeFileSync(`${dir}/${name}.hocr`, hocrStr);
    }

    ocrAll.active = activeCurrent;
  }
}

class data {
  // TODO: Modify such that debugging data is not calculated by default.
  static debug = DebugData;

  static font = FontCont;

  static image = ImageCache;

  static layoutRegions = layoutRegions;

  static layoutDataTables = layoutDataTables;

  static ocr = ocrAll;

  static pageMetrics = pageMetricsArr;

  static vis = visInstructions;
}

class utils {
  // OCR utils
  static assignParagraphs = assignParagraphs;

  static calcConf = calcConf;

  static calcEvalStatsDoc = calcEvalStatsDoc;

  static mergeOcrWords = mergeOcrWords;

  static checkOcrWordsAdjacent = checkOcrWordsAdjacent;

  static splitOcrWord = splitOcrWord;

  static ocr = ocr;

  // Layout utils
  static calcColumnBounds = calcColumnBounds;

  static calcTableBbox = calcTableBbox;

  static extractSingleTableContent = extractSingleTableContent;

  static detectTablesInPage = detectTablesInPage;

  static makeTableFromBbox = makeTableFromBbox;

  // Font utils
  static calcWordMetrics = calcWordMetrics;

  // Export functions
  static writePdf = writePdf;

  static writeHocr = writeHocr;

  static writeText = writeText;

  static writeXlsx = writeXlsx;

  // Misc utils
  static calcBoxOverlap = calcBoxOverlap;

  static convertToCSV = convertToCsv;

  static replaceSmartQuotes = replaceSmartQuotes;

  static getRandomAlphanum = getRandomAlphanum;

  static countSubstringOccurrences = countSubstringOccurrences;

  static coords = coords;

  static imageStrToBlob = imageStrToBlob;

  static writeDebugCsv = writeDebugCsv;

  static drawDebugImages = drawDebugImages;

  static dumpDebugImages = dumpDebugImages;

  static dumpHOCR = dumpHOCR;

  static renderPageStatic = renderPageStatic;

  static saveAs = saveAs;
}

/**
 * Clears all document-specific data.
 * @public
 */
const clear = async () => {
  clearData();
};

/**
 * Terminates the program and releases resources.
 * @public
 */
const terminate = async () => {
  console.log('Terminating program...');
  clearData();
  console.log('gs.terminate');
  await gs.terminate();
  console.log('ImageCache.terminate');
  await ImageCache.terminate();
  console.log('FontCont.terminate');
  await FontCont.terminate();
  console.log('Program terminated.');
  // await Promise.allSettled([gs.terminate(), ImageCache.terminate(), FontCont.terminate()]);
};

export default {
  clear,
  combineOCRPage,
  compareOCR,
  convertOCRPage,
  data,
  enableFontOpt,
  evalOCRPage,
  exportData,
  download,
  importFiles,
  importFilesSupp,
  inputData,
  init,
  layout,
  opt,
  recognize,
  recognizePageImp,
  extractText,
  extractInternalPDFText,
  terminate,
  utils,
};
