import { opt } from './js/containers/app.js';
import coords from './js/coordinates.js';
import { drawDebugImages } from './js/debug.js';
import { convertToCsv, writeDebugCsv } from './js/export/exportDebugCsv.js';
import { writePdf } from './js/export/pdf/writePdf.js';
import { replaceType3FontsWithCorrected } from './js/export/pdf/replaceType3Fonts.js';
import { extractType3DistinctGlyphs } from './js/pdf/fonts/parsePdfFonts.js';
import { writeHocr } from './js/export/writeHocr.js';
import { writeText } from './js/export/writeText.js';
import { createTablesFromText, extractSingleTableContent, extractTextFromTables } from './js/extractTables.js';
import { loadBuiltInFontsRaw } from './js/fontContainerMain.js';
import { GlobalFonts } from './js/containers/fontContainer.js';
import { gs } from './js/generalWorkerMain.js';
import { combineOCRPage } from './js/modifyOCR.js';
import {
  calcBoxOverlap, countSubstringOccurrences, getRandomAlphanum, replaceSmartQuotes,
  saveAs,
} from './js/utils/miscUtils.js';
import layout, { calcTableBbox } from './js/objects/layoutObjects.js';
import ocr from './js/objects/ocrObjects.js';
import { calcEvalStatsDoc } from './js/recognizeConvert.js';
import { calcWordMetrics } from './js/utils/fontUtils.js';
import { imageStrToBlob } from './js/utils/imageUtils.js';
import {
  calcConf, checkOcrWordsAdjacent, mergeOcrWords, splitOcrWord,
} from './js/utils/ocrUtils.js';
import { assignParagraphs } from './js/utils/reflowPars.js';
import { writeXlsx, writeXlsxFromRows } from './js/export/writeTabular.js';
import { calcColumnBounds, detectTablesInPage, makeTableFromBbox } from './js/utils/detectTables.js';
import { ScribeDoc } from './js/containers/scribeDoc.js';

/**
 * Initialize the program and optionally pre-load shared resources.
 * @public
 * @param {Object} [params]
 * @param {boolean} [params.ocr=false] - Load OCR engine.
 * @param {boolean} [params.font=false] - Load built-in fonts.
 * The OCR engine and built-in fonts are loaded automatically when needed; pre-loading only reduces
 * first-use latency. Each document's PDF renderer is created lazily when that document opens a PDF.
 * @param {Parameters<typeof import('./js/generalWorkerMain.js').gs.initTesseract>[0]} [params.ocrParams] - Parameters for initializing OCR.
 */
const init = async (params) => {
  const initOcr = params && params.ocr ? params.ocr : false;
  const initFont = params && params.font ? params.font : false;

  const promiseArr = [];

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
 * Open a new document from the provided files and return a handle to it.
 * The returned `ScribeDoc` can be operated on directly (`doc.recognize()`, `doc.exportData()`,
 * `doc.ocr`, …). Multiple documents can be open at once; each operates on its own state.
 * @public
 * @param {Parameters<ScribeDoc['importFiles']>[0]} files
 * @returns {Promise<ScribeDoc>}
 */
const openDocument = async (files) => {
  await init({ font: true });
  const doc = new ScribeDoc();
  await doc.importFiles(files);
  return doc;
};

/**
 * Function for extracting text from image and PDF files with a single function call.
 * By default, existing text content is extracted for text-native PDF files; otherwise text is extracted using OCR.
 * To control how text from PDF files is handled, set the options in the `opt.usePDFText` object.
 * For more control, use `openDocument` and the document's own `recognize`/`exportData` methods.
 * @public
 * @param {Parameters<ScribeDoc['importFiles']>[0]} files
 * @param {Array<string>} [langs=['eng']]
 * @param {Parameters<ScribeDoc['exportData']>[0]} [outputFormat='txt']
 * @param {Object} [options]
 * @param {boolean} [options.skipRecPDFTextNative=true] - Skip recognition if input is text-native PDF.
 * @param {boolean} [options.skipRecPDFTextOCR=false] - Skip recognition if input is image-based PDF with existing invisible text layer.
 */
const extractText = async (files, langs = ['eng'], outputFormat = 'txt', options = {}) => {
  const skipRecPDFTextNative = options?.skipRecPDFTextNative ?? true;
  const skipRecPDFTextOCR = options?.skipRecPDFTextOCR ?? false;
  const doc = await openDocument(files);
  if (!doc.inputData.xmlMode[0] && !doc.inputData.imageMode && !doc.inputData.pdfMode) {
    await doc.terminate();
    throw new Error('No relevant files to process.');
  }
  const skipRecPDF = doc.inputData.pdfMode && (doc.inputData.pdfType === 'text' && skipRecPDFTextNative || doc.inputData.pdfType === 'ocr' && skipRecPDFTextOCR);
  const skipRecOCR = doc.inputData.xmlMode[0] && !doc.inputData.imageMode && !doc.inputData.pdfMode;
  if (!skipRecPDF && !skipRecOCR) await doc.recognize({ langs });
  const output = await doc.exportData(outputFormat);
  await doc.terminate();
  return output;
};

/**
 *
 * @param {Array<Array<CompDebugNode>>} compDebugArrArr
 * @param {string} filePath
 * @public
 */
async function writeDebugImages(compDebugArrArr, filePath) {
  if (typeof process === 'undefined') {
    throw new Error('This function is only available in Node.js.');
  } else {
    const canvas = await drawDebugImages({ compDebugArrArr, context: 'node' });

    const imgURL = canvas.toDataURL();
    const imgData = new Uint8Array(atob(imgURL.split(',')[1])
      .split('')
      .map((c) => c.charCodeAt(0)));
    const fs = await import('node:fs');
    fs.writeFileSync(filePath, imgData);
  }
}

/**
 * Dump all of a document's debug images to directory `dir`.
 * Only available in Node.js.
 * @param {ScribeDoc} doc
 * @param {string} dir
 * @returns
 */
async function dumpDebugImages(doc, dir) {
  if (typeof process === 'undefined') {
    throw new Error('This function is only available in Node.js.');
  } else {
    if (!doc.debug.debugImg.Combined || doc.debug.debugImg.Combined.length === 0) {
      console.log('No debug images to dump.');
      return;
    }

    for (const [name, imgArr] of Object.entries(doc.debug.debugImg)) {
      if (!imgArr || imgArr.length === 0) continue;
      for (let i = 0; i < imgArr.length; i++) {
        const filePath = `${dir}/${name}_${i}.png`;
        await writeDebugImages([imgArr[i]], filePath);
      }
    }
  }
}

/**
 * Dump each of a document's OCR versions to a `.hocr` file in directory `dir`.
 * Only available in Node.js.
 * @param {ScribeDoc} doc
 * @param {string} dir
 */
async function dumpHOCR(doc, dir) {
  if (typeof process === 'undefined') {
    throw new Error('This function is only available in Node.js.');
  } else {
    const activeCurrent = doc.ocr.active;

    const fs = await import('node:fs');
    for (const [name, pages] of Object.entries(doc.ocr)) {
      doc.ocr.active = pages;
      const hocrStr = await doc.exportData('hocr');
      fs.writeFileSync(`${dir}/${name}.hocr`, hocrStr);
    }

    doc.ocr.active = activeCurrent;
  }
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

  static replaceType3FontsWithCorrected = replaceType3FontsWithCorrected;

  static extractType3DistinctGlyphs = extractType3DistinctGlyphs;

  static writeHocr = writeHocr;

  static writeText = writeText;

  static writeXlsx = writeXlsx;

  static writeXlsxFromRows = writeXlsxFromRows;

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

  static saveAs = saveAs;
}

/**
 * Terminate the shared resources (the general/OCR worker pool and built-in fonts).
 * Per-document resources are released with `doc.terminate()`.
 * @public
 */
const terminate = async () => {
  await gs.terminate();
  GlobalFonts.raw = null;
};

export default {
  combineOCRPage,
  createTablesFromText,
  init,
  layout,
  opt,
  openDocument,
  ScribeDoc,
  extractText,
  extractTextFromTables,
  terminate,
  utils,
};
