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
import { combineOCRPage, buildConsensusLayer } from './js/modifyOCR.js';
import {
  calcBoxOverlap, countSubstringOccurrences, getRandomAlphanum, replaceSmartQuotes,
  saveAs,
} from './js/utils/miscUtils.js';
import layout, { calcTableBbox } from './js/objects/layoutObjects.js';
import ocr from './js/objects/ocrObjects.js';
import { calcEvalStatsDoc } from './js/recognizeConvert.js';
import { calcWordMetrics } from './js/utils/fontUtils.js';
import { base64ToBytes, imageStrToBlob } from './js/utils/imageUtils.js';
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

  // With `opt.inProcess`, the general worker pool is not pre-warmed.
  // It is still created on first use by features that require it (e.g. OCR).
  if (!opt.inProcess) promiseArr.push(gs.getGeneralScheduler());

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
 * @param {Parameters<ScribeDoc['importFiles']>[1]} [options]
 * @returns {Promise<ScribeDoc>}
 */
const openDocument = async (files, options) => {
  if (options && options.deferText) {
    // Not awaited: the render critical path needs neither the general worker pool nor the built-in fonts,
    // and the background extraction awaits the fonts it needs itself, so gating init here would only delay first paint.
    // It still starts now to be warm for later verbs.
    init({ font: true }).catch((err) => console.error(err));
  } else {
    await init({ font: true });
  }
  const doc = new ScribeDoc();
  await doc.importFiles(files, options);
  return doc;
};

/**
 * Function for extracting text from image and PDF files with a single function call.
 * By default, existing text content is extracted for text-native PDF files; otherwise text is extracted using OCR.
 * To control how text from PDF files is handled, set `ScribeDoc.defaults.usePDFText` (process default) or pass `options.usePDFText` to `extractText` / `importFiles`.
 * For more control, use `openDocument` and the document's own `recognize`/`exportData` methods.
 * @public
 * @param {Parameters<ScribeDoc['importFiles']>[0]} files
 * @param {Array<string>} [langs=['eng']]
 * @param {Parameters<ScribeDoc['exportData']>[0]} [outputFormat='txt']
 * @param {Object} [options]
 * @param {('all'|'auto'|'autoShallow'|'autoDeep'|'none'|boolean[])} [options.ocrPages='autoShallow'] - Which pages to OCR.
 *    `'autoShallow'` (default) leaves text-native documents alone (OCRing only detected scanned sections, broken-encoding pages, and existing-OCR pages).
 *    `'autoDeep'` (alias `'auto'`) also OCRs lone image pages and image-borne text on native pages.
 *    `'all'`/`'none'` force every/no page
 *    A boolean array selects pages explicitly.
 * @param {(typeof import('./js/containers/scribeDocDefaults.js').scribeDocDefaults)['usePDFText']} [options.usePDFText] - How to use a PDF's own extracted text.
 *    For a document with an existing OCR layer, `ocr.main: true` trusts and keeps it (skips OCR); `ocr.supp: true` merges it into a fresh run; both false re-OCRs and discards it.
 * @param {boolean} [options.skipRecPDFTextNative] - Deprecated, prefer `ocrPages`. When explicitly set,
 *    forces a whole-document skip for text-native PDFs.
 * @param {boolean} [options.skipRecPDFTextOCR] - Deprecated, prefer `ocrPages`. When explicitly set,
 *    forces a whole-document skip for image-based PDFs with an existing invisible text layer.
 */
const extractText = async (files, langs = ['eng'], outputFormat = 'txt', options = {}) => {
  const ocrPages = options?.ocrPages ?? 'autoShallow';
  const usePDFText = options?.usePDFText;
  // Whether either deprecated skip flag was explicitly passed.
  // Only then do the flags force a whole-document skip (below); otherwise `ocrPages` governs recognition.
  const depSkipSet = options?.skipRecPDFTextNative !== undefined || options?.skipRecPDFTextOCR !== undefined;
  const skipRecPDFTextNative = options?.skipRecPDFTextNative ?? true;
  const skipRecPDFTextOCR = options?.skipRecPDFTextOCR ?? false;
  const doc = await openDocument(files);
  if (!doc.inputData.xmlMode[0] && !doc.inputData.imageMode && !doc.inputData.pdfMode) {
    await doc.terminate();
    throw new Error('No relevant files to process.');
  }
  const skipRecPDF = depSkipSet && doc.inputData.pdfMode
  && (doc.inputData.pdfType === 'text' && skipRecPDFTextNative || doc.inputData.pdfType === 'ocr' && skipRecPDFTextOCR);
  const skipRecOCR = doc.inputData.xmlMode[0] && !doc.inputData.imageMode && !doc.inputData.pdfMode;
  if (!skipRecPDF && !skipRecOCR) await doc.recognize({ langs, ocrPages, usePDFText });
  const output = await doc.exportData(outputFormat);
  await doc.terminate();
  return output;
};

/** @type {ScribeDoc | null} */
let legacyDoc = null;
/** @type {Set<string>} */
const legacyWarned = new Set();

/** @param {string} name */
const warnLegacy = (name) => {
  if (legacyWarned.has(name)) return;
  legacyWarned.add(name);
  opt.warningHandler(
    `scribe.${name}() is deprecated and will be removed in a future release. `
    + 'Use `scribe.openDocument(files)` and the returned `ScribeDoc` methods instead. '
    + 'See https://github.com/scribeocr/scribe.js/blob/master/docs/guide.md',
  );
};

/**
 * @deprecated Use `scribe.openDocument(files)` and operate on the returned `ScribeDoc`.
 * Compatibility wrapper that imports `files` into a single implicit document held at module
 * scope. Any previously imported implicit document is terminated first. Only one such document
 * exists at a time. New code should use `openDocument` to support multiple documents.
 * @param {Parameters<ScribeDoc['importFiles']>[0]} files
 * @param {Parameters<ScribeDoc['importFiles']>[1]} [options]
 */
const importFiles = async (files, options) => {
  warnLegacy('importFiles');
  if (legacyDoc) await legacyDoc.terminate();
  await init({ font: true });
  legacyDoc = new ScribeDoc();
  return legacyDoc.importFiles(files, options);
};

/**
 * @deprecated Use `doc.importFilesSupp(files, ocrName)` on a `ScribeDoc` from `scribe.openDocument(...)`.
 * @param {Parameters<ScribeDoc['importFilesSupp']>[0]} files
 * @param {Parameters<ScribeDoc['importFilesSupp']>[1]} ocrName
 */
const importFilesSupp = async (files, ocrName) => {
  warnLegacy('importFilesSupp');
  if (!legacyDoc) {
    await init({ font: true });
    legacyDoc = new ScribeDoc();
  }
  return legacyDoc.importFilesSupp(files, ocrName);
};

/**
 * @deprecated Use `doc.recognize(options)` on a `ScribeDoc` from `scribe.openDocument(...)`.
 * @param {Parameters<ScribeDoc['recognize']>[0]} [options]
 */
const recognize = async (options) => {
  warnLegacy('recognize');
  if (!legacyDoc) throw new Error('scribe.recognize() requires scribe.importFiles() first.');
  return legacyDoc.recognize(options);
};

/**
 * @deprecated Use `doc.download(format, fileName, options)` on a `ScribeDoc` from `scribe.openDocument(...)`.
 * @param {Parameters<ScribeDoc['download']>[0]} format
 * @param {Parameters<ScribeDoc['download']>[1]} fileName
 * @param {Parameters<ScribeDoc['download']>[2]} [options]
 */
const download = async (format, fileName, options) => {
  warnLegacy('download');
  if (!legacyDoc) throw new Error('scribe.download() requires scribe.importFiles() first.');
  return legacyDoc.download(format, fileName, options);
};

/**
 * @deprecated Use `doc.exportData(format, options)` on a `ScribeDoc` from `scribe.openDocument(...)`.
 * @param {Parameters<ScribeDoc['exportData']>[0]} [format]
 * @param {Parameters<ScribeDoc['exportData']>[1]} [options]
 */
const exportData = async (format, options) => {
  warnLegacy('exportData');
  if (!legacyDoc) throw new Error('scribe.exportData() requires scribe.importFiles() first.');
  return legacyDoc.exportData(format ?? 'txt', options);
};

/**
 * @deprecated Call `doc.terminate()` on a `ScribeDoc` from `scribe.openDocument(...)` instead.
 * Terminates the implicit document held by the legacy `scribe.importFiles` flow, if any.
 */
const clear = async () => {
  warnLegacy('clear');
  if (legacyDoc) {
    await legacyDoc.terminate();
    legacyDoc = null;
  }
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
    const imgData = base64ToBytes(imgURL);
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

/**
 * Extract each document's existing text (no OCR) from a directory of PDFs/images, writing one output file per input. Node.js only.
 * A file that fails to parse is skipped and reported in the returned summary, never aborting the batch.
 * @public
 * @param {string} inputDir - Directory to read input files from.
 * @param {string} outputDir - Directory to write output files into (mirrors the input tree).
 * @param {Parameters<typeof import('./js/extractTextDir.js').extractTextDir>[2]} [options]
 * @returns {ReturnType<typeof import('./js/extractTextDir.js').extractTextDir>}
 */
async function extractTextDir(inputDir, outputDir, options = {}) {
  if (typeof process === 'undefined') throw new Error('This function is only available in Node.js.');
  const { extractTextDir: impl } = await import('./js/extractTextDir.js');
  return impl(inputDir, outputDir, options);
}

/**
 * Per-file generator behind `extractTextDir` that yields `{ inputPath, text | error }` without writing output. Node.js only.
 * Results arrive in completion order, not directory order.
 * @public
 * @param {string} inputDir - Directory to read input files from.
 * @param {Parameters<typeof import('./js/extractTextDir.js').extractTextDirIter>[1]} [options]
 */
async function* extractTextDirIter(inputDir, options = {}) {
  if (typeof process === 'undefined') throw new Error('This function is only available in Node.js.');
  const { extractTextDirIter: impl } = await import('./js/extractTextDir.js');
  yield* impl(inputDir, options);
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
  buildConsensusLayer,
  createTablesFromText,
  init,
  layout,
  opt,
  openDocument,
  ScribeDoc,
  extractText,
  extractTextDir,
  extractTextDirIter,
  extractTextFromTables,
  terminate,
  utils,
  importFiles,
  importFilesSupp,
  recognize,
  download,
  exportData,
  clear,
};
