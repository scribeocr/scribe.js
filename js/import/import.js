import { opt } from '../containers/app.js';
import { scribeDocDefaults } from '../containers/scribeDocDefaults.js';
import { GlobalFonts } from '../containers/fontContainer.js';
import {
  enableOpt,
  loadBuiltInFontsRaw,
  optimizeFontContainerAll,
  setDefaultAuto,
} from '../fontContainerMain.js';
import { calcCharMetricsFromPages } from '../fontStatistics.js';
import { gs } from '../generalWorkerMain.js';
import { imageUtils, ImageWrapper } from '../objects/imageObjects.js';
import { addCircularRefsDataTables, LayoutDataTablePage, LayoutPage } from '../objects/layoutObjects.js';
import { OcrPage, addCircularRefsOcr, updateOcrFormat } from '../objects/ocrObjects.js';
import { PageMetrics } from '../objects/pageMetricsObjects.js';
import { reassignOutlineIds } from '../objects/outlineObjects.js';
import { checkCharWarn, convertOCR } from '../recognizeConvert.js';
import { importImageFileToBase64 } from '../utils/imageUtils.js';
import {
  readOcrFile, clearObjectProperties, objectAssignDefined, readTextFile,
} from '../utils/miscUtils.js';
import { importOCRFiles } from './importOCR.js';
import { extractInternalPDFText } from '../extractPDFText.js';

/** @typedef {import('../containers/scribeDoc.js').ScribeDoc} ScribeDoc */

/**
 * Standardize file-like inputs between platforms.
 * If run in the browser, URLs are fetched and converted to `File` objects.
 * If using Node.js, file paths are converted into `FileNode` objects,
 * which have properties and methods similar to the browser `File` interface.
 * @param {Array<File>|FileList|Array<string>} files
 * @returns {Promise<Array<File>|Array<FileNode>>}
 */
export async function standardizeFiles(files) {
  if (typeof files[0] === 'string') {
    if (typeof process !== 'undefined') {
      const { wrapFilesNode } = await import('./nodeAdapter.js');
      return wrapFilesNode(/** @type {Array<string>} */(files));
    }

    // Fetch all URLs and convert the responses to Blobs
    const blobPromises = files.map((url) => fetch(url).then((response) => {
      if (!response.ok) {
        console.log(response);
        throw new Error(`Failed to fetch ${url}: ${response.statusText}`);
      }
      return response.blob().then((blob) => ({ blob, url }));
    }));

    // Wait for all fetches to complete
    const blobsAndUrls = await Promise.all(blobPromises);

    // Extract file name from URL and convert Blobs to File objects
    return blobsAndUrls.map(({ blob, url }) => {
      const fileName = url.split('/').pop();
      // A valid filename is necessary, as the import function uses the filename.
      if (!fileName) throw new Error(`Failed to extract file name from URL: ${url}`);
      return new File([blob], fileName, { type: blob.type });
    });
  }

  if (globalThis.FileList && files instanceof FileList) {
    return Array.from(files);
  }

  return /** @type {Array<File>} */ (files);
}

/**
 * Sorts single array of files into pdf, image, ocr, and unsupported files.
 * Used for browser interface, where files of multiple types may be uploaded using the same input.
 * @param {Array<File>|Array<FileNode>|FileList} files
 * @returns
 */
export async function sortInputFiles(files) {
  // Sort files into (1) HOCR files, (2) image files, or (3) unsupported using extension.
  /** @type {Array<File|FileNode>} */
  const imageFilesAll = [];
  /** @type {Array<File|FileNode>} */
  const ocrFilesAll = [];
  /** @type {Array<File|FileNode>} */
  const pdfFilesAll = [];
  /** @type {Array<File|FileNode>} */
  const scribeFilesAll = [];
  /** @type {Array<File|FileNode>} */
  const unsupportedFilesAll = [];
  const unsupportedExt = {};
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const fileExt = file.name.match(/\.([^.]+)$/)?.[1].toLowerCase() || '';
    const fileNameLower = file.name.toLowerCase();

    if (fileNameLower.endsWith('.scribe.json')) {
      scribeFilesAll.push(file);
    // TODO: Investigate whether other file formats are supported (without additional changes)
    // Tesseract.js definitely supports more formats, so if the .pdfs we make also support a format,
    // then we should be able to expand the list of supported types without issue.
    // Update: It looks like .bmp does not work.
    } else if (['png', 'jpeg', 'jpg'].includes(fileExt)) {
      imageFilesAll.push(file);
      // All .gz files are assumed to be OCR data (xml) since all other file types can be compressed already
    } else if (['hocr', 'xml', 'html', 'gz', 'stext', 'json', 'txt', 'docx'].includes(fileExt)) {
      ocrFilesAll.push(file);
    } else if (['scribe'].includes(fileExt)) {
      scribeFilesAll.push(file);
    } else if (['pdf'].includes(fileExt)) {
      pdfFilesAll.push(file);
    } else {
      // Check if file without an extension could be a textract JSON file.
      // This is currently a hack and should be re-implemented in a better way.
      // Notably, (1) this only works for Textract JSON files stored in specific object types, and
      // (2) this reads the file content as text and then discards it after checking the content,
      // which is not ideal for performance.
      if ([''].includes(fileExt)) {
        try {
          const content = await readOcrFile(file);
          if (/"AnalyzeDocumentModelVersion"/i.test(content)) {
            ocrFilesAll.push(file);
            continue;
          }
        } catch (error) { /* empty */ }
      }

      unsupportedFilesAll.push(file);
      unsupportedExt[fileExt] = true;
    }
  }

  if (unsupportedFilesAll.length > 0) {
    const errorText = `Import includes unsupported file types: ${Object.keys(unsupportedExt).join(', ')}`;
    opt.warningHandler?.(errorText);
  }

  imageFilesAll.sort((a, b) => ((a.name > b.name) ? 1 : ((b.name > a.name) ? -1 : 0)));
  ocrFilesAll.sort((a, b) => ((a.name > b.name) ? 1 : ((b.name > a.name) ? -1 : 0)));

  return {
    pdfFiles: pdfFilesAll, imageFiles: imageFilesAll, ocrFiles: ocrFilesAll, scribeFiles: scribeFilesAll,
  };
}

/**
 * Read image files and return array of `ImageWrapper` objects,
 * without modifying any global state.
 * @param {Array<File>|FileList|Array<string>} files
 */
export const importImageFilesP = async (files) => {
  const files2 = await standardizeFiles(files);
  /** @type {ImageWrapper[]} */
  const images = [];
  for (let i = 0; i < files2.length; i++) {
    images[i] = await importImageFileToBase64(files2[i]).then(async (imgStr) => {
      const imgWrapper = new ImageWrapper(i, imgStr, 'native', false, false);
      return imgWrapper;
    });
  }
  return images;
};

/**
 * Read a .scribe file and restore session data into this document.
 * @param {ScribeDoc} doc
 * @param {string | File | FileNode | ArrayBuffer} scribeFile
 * @returns {Promise<number[]|null>} Per-page user rotations from the .scribe (or null if absent).
 */
async function restoreSessionFromFile(doc, scribeFile) {
  const scribeRestoreStr = await readOcrFile(scribeFile);
  /** @type {ScribeSaveData} */
  const scribeRestoreObj = JSON.parse(scribeRestoreStr);
  if (scribeRestoreObj.fontState) {
    objectAssignDefined(doc.fonts.state, scribeRestoreObj.fontState);
    await doc.runOptimization(doc.ocr.active);
  }
  if (scribeRestoreObj.layoutRegions) {
    doc.layoutRegions.pages = scribeRestoreObj.layoutRegions;
  }
  if (scribeRestoreObj.layoutDataTables) {
    addCircularRefsDataTables(scribeRestoreObj.layoutDataTables);
    doc.layoutDataTables.pages = scribeRestoreObj.layoutDataTables;
  }
  if (scribeRestoreObj.annotations) {
    doc.annotations.pages = scribeRestoreObj.annotations;
  }

  // `.inputData` added to .scribe in June 2026, do not assume this field exists for re-imports.
  // This line also skips when `inputData` has already been calculated for the active session, which is presumed more accurate.
  if (scribeRestoreObj.inputData) {
    if (doc.inputData.pdfType == null && scribeRestoreObj.inputData.pdfType) {
      doc.inputData.pdfType = scribeRestoreObj.inputData.pdfType;
    }
    if (doc.inputData.pageStats == null && scribeRestoreObj.inputData.pageStats) {
      doc.inputData.pageStats = scribeRestoreObj.inputData.pageStats;
      doc.inputData.requiresOCR = !!scribeRestoreObj.inputData.requiresOCR;
    }
    if (doc.inputData.ocrApplied == null && scribeRestoreObj.inputData.ocrApplied) {
      doc.inputData.ocrApplied = scribeRestoreObj.inputData.ocrApplied;
    }
  }

  const oemName = 'User Upload';
  if (!doc.ocr[oemName]) doc.ocr[oemName] = Array(doc.inputData.pageCount);
  updateOcrFormat(scribeRestoreObj.ocr);
  addCircularRefsOcr(scribeRestoreObj.ocr);
  doc.ocr[oemName] = scribeRestoreObj.ocr;
  doc.ocr.active = doc.ocr[oemName];

  for (let i = 0; i < doc.ocr[oemName].length; i++) {
    if (!doc.ocr[oemName][i]) {
      doc.ocr[oemName][i] = new OcrPage(i, { height: 1920, width: 1080 });
    }
    doc.inputData.xmlMode[i] = true;
    doc.pageMetrics[i] = new PageMetrics(doc.ocr[oemName][i].dims);
    doc.pageMetrics[i].angle = doc.ocr[oemName][i].angle;
    doc.pageMetrics[i].rotation = scribeRestoreObj.pageRotations?.[i] || 0;
    doc.pageMetrics[i].sourcePageN = scribeRestoreObj.pageSourceIndices?.[i] ?? null;
  }

  // The active text layer is now the imported OCR for every page, so mark every page OCR-applied.
  // Skip if a newer .scribe.json already restored an explicit `ocrApplied` array above.
  if (doc.inputData.ocrApplied == null) {
    doc.inputData.ocrApplied = Array(doc.ocr[oemName].length).fill(true);
  }

  // The caller applies `outline` after the PDF loads, since openMainPDF's parse of the source /Outlines would otherwise clobber it.
  // A returned `null` (key absent) means a pre-outline .scribe, so the PDF's own bookmarks win; `[]` means the session deliberately had none.
  return {
    rotations: scribeRestoreObj.pageRotations || null,
    outline: 'outline' in scribeRestoreObj ? (scribeRestoreObj.outline || []) : null,
  };
}

/**
 * Restore session data from legacy HOCR exports into this document.
 * Originally HOCR was used as the primary format for saving and restoring sessions,
 * which lead to a significant amount of session data being stored in HOCR files.
 * This function extracts that data and restores it to the current session format.
 * Eventually this function can be deprecated and removed.
 * Users should use the .scribe format for saving and restoring sessions instead.
 * @param {ScribeDoc} doc
 * @param {Awaited<ReturnType<importOCRFiles>>} ocrData
 */
async function _restoreSessionFromLegacyHocr(doc, ocrData) {
  let existingOpt = false;

  objectAssignDefined(doc.fonts.state, ocrData.fontState);

  // Restore font metrics and optimize font from previous session (if applicable)
  if (ocrData.fontState.charMetrics && Object.keys(ocrData.fontState.charMetrics).length > 0) {
    const fontPromise = loadBuiltInFontsRaw();

    existingOpt = true;

    await gs.schedulerReady;
    setDefaultAuto(doc.fonts, doc.fonts.state.charMetrics);

    // If `ocrData.enableOpt` is `false`, then the metrics are present but ignored.
    // This occurs if optimization was found to decrease accuracy for both sans and serif,
    // not simply because the user disabled optimization in the view settings.
    // If no `enableOpt` property exists but metrics are present, then optimization is enabled.
    if (ocrData.enableOpt === 'false') {
      doc.fonts.state.enableOpt = false;
    } else {
      await fontPromise;
      if (!GlobalFonts.raw) throw new Error('Raw font data not found.');
      doc.fonts.opt = await optimizeFontContainerAll(GlobalFonts.raw, doc.fonts.state.charMetrics, doc.fonts.id);
      doc.fonts.state.enableOpt = true;
      await enableOpt(doc.fonts, true);
    }
  }

  // Restore layout data from previous session (if applicable)
  if (ocrData.layoutObj) {
    for (let i = 0; i < ocrData.layoutObj.length; i++) {
      doc.layoutRegions.pages[i] = ocrData.layoutObj[i];
    }
  }

  if (ocrData.layoutDataTableObj) {
    for (let i = 0; i < ocrData.layoutDataTableObj.length; i++) {
      doc.layoutDataTables.pages[i] = ocrData.layoutDataTableObj[i];
    }
  }

  return {
    existingOpt,
  };
}

/**
 * An object with this shape can be used to provide input to the `importFiles` function,
 * without needing that function to figure out the file types.
 * This is required when using ArrayBuffer inputs.
 * @public
 * @typedef {Object} SortedInputFiles
 * @property {Array<File>|Array<string>|Array<ArrayBuffer>} [pdfFiles]
 * @property {Array<File>|Array<string>|Array<ArrayBuffer>} [imageFiles]
 * @property {Array<File>|Array<string>|Array<ArrayBuffer>} [ocrFiles]
 * @property {Array<File>|Array<string>|Array<ArrayBuffer>} [scribeFiles]
 */

/**
 * Import files for processing into this document.
 * An object with `pdfFiles`, `imageFiles`, and `ocrFiles` arrays can be provided to import multiple types of files.
 * Alternatively, for `File` objects (browser) and file paths (Node.js), a single array can be provided, which is sorted based on extension.
 * @param {ScribeDoc} doc
 * @param {Array<File>|FileList|Array<string>|SortedInputFiles} files
 * @param {Object} [options]
 * @param {typeof import('../containers/scribeDoc.js').ScribeDoc.defaults.usePDFText} [options.usePDFText]
 * @param {boolean} [options.keepPDFTextAlways]
 * @param {boolean} [options.skipFontOpt]
 * @param {boolean} [options.usePdfSharedBuffer]
 * @param {'width' | 'sentence'} [options.docxLineSplitMode]
 * @param {boolean} [options.deferText] - Resolve once the PDF is renderable, running text extraction in the background behind `doc.textReady` instead of blocking on it.
 *   PDF inputs only.
 */
export async function importFiles(doc, files, options = {}) {
  const usePDFText = options.usePDFText ?? scribeDocDefaults.usePDFText;
  const keepPDFTextAlways = options.keepPDFTextAlways ?? scribeDocDefaults.keepPDFTextAlways;
  const skipFontOpt = options.skipFontOpt ?? scribeDocDefaults.skipFontOpt;
  const usePdfSharedBuffer = options.usePdfSharedBuffer ?? opt.usePdfSharedBuffer;
  const docxLineSplitMode = options.docxLineSplitMode ?? scribeDocDefaults.docxLineSplitMode;
  const deferText = options.deferText ?? false;
  if (!files) throw new Error('No files provided.');

  // Wait for any in-flight extraction before clearing, so its workers don't write stale pages into the new document.
  await doc.textReady;

  doc.clear();
  // Pre-warm the general worker pool, except with `opt.inProcess`.
  if (!opt.inProcess) gs.getGeneralScheduler();

  /** @type {Array<File|FileNode|ArrayBuffer>} */
  let pdfFiles = [];
  /** @type {Array<File|FileNode|ArrayBuffer>} */
  let imageFiles = [];
  /** @type {Array<File|FileNode|ArrayBuffer>} */
  let ocrFiles = [];
  /** @type {Array<File|FileNode|ArrayBuffer>} */
  let scribeFiles = [];
  // These statements contain many ts-ignore comments, because the TypeScript interpreter apparently cannot properly narrow arrays.
  // See: https://github.com/microsoft/TypeScript/issues/42384
  if ('pdfFiles' in files || 'imageFiles' in files || 'ocrFiles' in files || 'scribeFiles' in files) {
    if (files.pdfFiles && files.pdfFiles[0] instanceof ArrayBuffer) {
      // @ts-ignore
      pdfFiles = files.pdfFiles;
    } else if (files.pdfFiles) {
      // @ts-ignore
      pdfFiles = await standardizeFiles(files.pdfFiles);
    }
    if (files.imageFiles && files.imageFiles[0] instanceof ArrayBuffer) {
      // @ts-ignore
      imageFiles = files.imageFiles;
    } else if (files.imageFiles) {
      // @ts-ignore
      imageFiles = await standardizeFiles(files.imageFiles);
    }
    if (files.ocrFiles && files.ocrFiles[0] instanceof ArrayBuffer) {
      // @ts-ignore
      ocrFiles = files.ocrFiles;
    } else if (files.ocrFiles) {
      // @ts-ignore
      ocrFiles = await standardizeFiles(files.ocrFiles);
    }
    if (files.scribeFiles && files.scribeFiles[0] instanceof ArrayBuffer) {
      // @ts-ignore
      scribeFiles = files.scribeFiles;
    } else if (files.scribeFiles) {
      // @ts-ignore
      scribeFiles = await standardizeFiles(files.scribeFiles);
    }
  } else {
    // @ts-ignore
    const filesStand = await standardizeFiles(files);
    if (files[0] instanceof ArrayBuffer) throw new Error('ArrayBuffer inputs must be sorted by file type.');
    ({
      pdfFiles, imageFiles, ocrFiles, scribeFiles,
    } = await sortInputFiles(filesStand));
  }

  if (pdfFiles.length === 0 && imageFiles.length === 0 && ocrFiles.length === 0 && scribeFiles.length === 0) {
    const errorText = 'No supported files found.';
    doc.errorHandler({ message: errorText });
    return;
  } if (pdfFiles.length > 0 && imageFiles.length > 0) {
    const errorText = 'PDF and image files cannot be imported together. Only first PDF file will be imported.';
    doc.warningHandler({ message: errorText });
    pdfFiles.length = 1;
    imageFiles.length = 0;
  } else if (pdfFiles.length > 1) {
    const errorText = 'Multiple PDF files are not supported. Only first PDF file will be imported.';
    doc.warningHandler({ message: errorText });
    pdfFiles.length = 1;
    imageFiles.length = 0;
  }

  if (pdfFiles[0] && !(pdfFiles[0] instanceof ArrayBuffer)) {
    doc.inputData.inputFileNames = [pdfFiles[0].name];
  } else if (imageFiles[0] && !(imageFiles[0] instanceof ArrayBuffer)) {
    // @ts-ignore
    doc.inputData.inputFileNames = imageFiles.map((x) => x.name);
  }

  // Set default download name
  if (pdfFiles.length > 0 && 'name' in pdfFiles[0]) {
    doc.inputData.defaultDownloadFileName = `${pdfFiles[0].name.replace(/\.\w{1,6}$/, '')}.pdf`;
  } else if (imageFiles.length > 0 && 'name' in imageFiles[0]) {
    doc.inputData.defaultDownloadFileName = `${imageFiles[0].name.replace(/\.\w{1,6}$/, '')}.pdf`;
  } else if (ocrFiles.length > 0 && 'name' in ocrFiles[0]) {
    doc.inputData.defaultDownloadFileName = `${ocrFiles[0].name.replace(/\.\w{1,6}$/, '')}.pdf`;
  } else if (scribeFiles.length > 0 && 'name' in scribeFiles[0]) {
    doc.inputData.defaultDownloadFileName = `${scribeFiles[0].name.replace(/\.\w{1,6}$/, '')}.pdf`;
  }

  doc.inputData.pdfMode = pdfFiles.length === 1;
  doc.inputData.imageMode = !!(imageFiles.length > 0 && !doc.inputData.pdfMode);
  doc.images.inputModes.image = !!(imageFiles.length > 0 && !doc.inputData.pdfMode);

  /** @type {number[]|null} */
  let restoredRotations = null;
  /** @type {Array<import('../objects/outlineObjects.js').OutlineNode>|null} */
  let restoredOutline = null;
  if (scribeFiles[0]) {
    const restoreRes = await restoreSessionFromFile(doc, scribeFiles[0]);
    restoredRotations = restoreRes.rotations;
    restoredOutline = restoreRes.outline;
  }

  const xmlModeImport = ocrFiles.length > 0;

  let pageCount;
  let pageCountImage;
  /** @type {TextSource} */
  let format;
  let reimportHocrMode = false;

  if (doc.inputData.pdfMode) {
    // If no XML data is provided, page sizes are calculated using muPDF alone
    await doc.images.openMainPDF(pdfFiles[0], { usePdfSharedBuffer });

    pageCountImage = doc.images.pageCount;
    doc.images.loadCount = doc.images.pageCount;
  } else if (doc.inputData.imageMode) {
    pageCountImage = imageFiles.length;
  }

  let existingOpt = false;
  const oemName = 'User Upload';
  if (xmlModeImport) {
    // Initialize a new array on `ocr` if one does not already exist
    if (!doc.ocr[oemName]) doc.ocr[oemName] = Array(doc.inputData.pageCount);
    doc.ocr.active = doc.ocr[oemName];

    const ocrData = await importOCRFiles(Array.from(ocrFiles));

    format = /** @type {("hocr" | "abbyy" | "alto" | "stext" | "textract" | "text")} */ (ocrData.format);

    // The text import function requires built-in fonts to be loaded.
    if (['text', 'docx'].includes(format)) {
      await loadBuiltInFontsRaw();
    }

    doc.ocrRaw.active = ocrData.hocrRaw;
    // Subset OCR data to avoid uncaught error that occurs when there are more pages of OCR data than image data.
    // While this should be rare, it appears to be fairly common with Archive.org documents.
    // TODO: Add warning message displayed to user for doc.
    // Textract JSON data is returned in arbitrary chunks (multiple pages may be in one file, or one page may be in multiple files).
    // Therefore, it is impossible to know how many pages of OCR data there are based only on the length of `doc.ocrRaw.active`.
    if (pageCountImage && doc.ocrRaw.active.length > pageCountImage && ocrData.format !== 'textract' && ocrData.format !== 'google_doc_ai') {
      console.log(`Identified ${doc.ocrRaw.active.length} pages of OCR data but ${pageCountImage} pages of image/pdf data. Only first ${pageCountImage} pages will be used.`);
      doc.ocrRaw.active = doc.ocrRaw.active.slice(0, pageCountImage);
    }

    format = /** @type {("hocr" | "abbyy" | "alto" | "stext" | "textract" | "text")} */ (ocrData.format);
    reimportHocrMode = ocrData.reimportHocrMode;

    if (ocrData.reimportHocrMode) {
      const restoreRes = await _restoreSessionFromLegacyHocr(doc, ocrData);
      existingOpt = restoreRes.existingOpt;
    }
  }

  let pageCountOcr = doc.ocrRaw.active?.length || doc.ocr.active?.length || 0;

  // For Textract, `doc.ocrRaw.active[0]` is a string containing the Textract JSON data for all pages.
  // This ad-hoc solution counts the number of "PAGE" blocks in the Textract JSON data.
  if (format === 'textract' && doc.ocrRaw.active?.length) {
    pageCountOcr = doc.ocrRaw.active[0].match(/"BLOCKTYPE":\s*"PAGE"/ig)?.length || pageCountOcr;
  }

  if (format === 'google_doc_ai' && doc.ocrRaw.active?.length) {
    pageCountOcr = doc.ocrRaw.active[0].match(/"pageNumber":\s*\d+/g)?.length || pageCountOcr;
  }

  // If both OCR data and image data are present, confirm they have the same number of pages
  if (xmlModeImport && (doc.inputData.imageMode || doc.inputData.pdfMode)) {
    if (pageCountImage !== pageCountOcr) {
      const warningHTML = `Page mismatch detected. Image data has ${pageCountImage} pages while OCR data has ${pageCountOcr} pages.`;
      doc.warningHandler({ message: warningHTML });
    }
  }

  doc.inputData.pageCount = pageCountImage ?? pageCountOcr;

  // OCR imported from external files (.hocr/.xml/Textract/etc.) becomes the active layer for every page,
  // so mark each page OCR-applied for the export flatten gate (a category-flagged page flattens iff OCR was applied to it).
  // Skip if a .scribe restore already set an explicit array.
  if (xmlModeImport && doc.inputData.ocrApplied == null) {
    doc.inputData.ocrApplied = Array(doc.inputData.pageCount).fill(true);
  }

  doc.ocrRaw.active = doc.ocrRaw.active || Array(pageCount);

  for (let i = 0; i < doc.inputData.pageCount; i++) {
    if (!doc.layoutRegions.pages[i]) {
      doc.layoutRegions.pages[i] = new LayoutPage(i);
    }
  }

  for (let i = 0; i < doc.inputData.pageCount; i++) {
    if (!doc.layoutDataTables.pages[i]) {
      doc.layoutDataTables.pages[i] = new LayoutDataTablePage(i);
    }
  }

  for (let i = 0; i < doc.inputData.pageCount; i++) {
    if (!doc.annotations.pages[i]) {
      doc.annotations.pages[i] = [];
    }
  }

  // Render first page for PDF only
  if (doc.inputData.pdfMode && !xmlModeImport) {
    doc.progressHandler({ n: 0, type: 'importPDF', info: { } });
  }

  if (doc.inputData.imageMode) {
    doc.images.pageCount = doc.inputData.pageCount;
    for (let i = 0; i < doc.inputData.pageCount; i++) {
      doc.images.nativeSrc[i] = await importImageFileToBase64(imageFiles[i]).then(async (imgStr) => {
        const imgWrapper = new ImageWrapper(i, imgStr, 'native', false, false);
        const imageDims = await imageUtils.getDims(imgWrapper);
        doc.pageMetrics[i] = new PageMetrics(imageDims);
        return imgWrapper;
      });
      doc.images.loadCount++;
      doc.progressHandler({ n: i, type: 'importImage', info: { } });
    }
  }

  // Re-apply page angles from .scribe data after PDF/image loading overwrites pageMetrics.
  // The PDF/image loading creates new PageMetrics with correct dimensions but angle=null.
  if (scribeFiles[0] && doc.ocr.active) {
    for (let i = 0; i < doc.ocr.active.length; i++) {
      if (doc.ocr.active[i]?.angle != null && doc.pageMetrics[i]) {
        doc.pageMetrics[i].angle = doc.ocr.active[i].angle;
      }
      if (restoredRotations?.[i] && doc.pageMetrics[i]) {
        doc.pageMetrics[i].rotation = restoredRotations[i];
      }
    }
    // Re-apply the session's saved bookmarks, overriding those the PDF load parsed from the source's own /Outlines.
    if (restoredOutline != null) {
      doc.outline.length = 0;
      for (const n of reassignOutlineIds(restoredOutline)) doc.outline.push(n);
    }
  }

  if (xmlModeImport) {
    // Process OCR using web worker, reading from file first if that has not been done already
    await convertOCR(doc, doc.ocrRaw.active, true, format, oemName, reimportHocrMode, doc.pageMetrics, { docxLineSplitMode }).then(async () => {
      // Skip this step if optimization info was already restored from a previous session,
      // or if using stext/textract (which are character-level but not visually accurate).
      if (!existingOpt && !skipFontOpt && !['stext', 'textract', 'google_vision', 'google_doc_ai', 'azure_doc_intel'].includes(format)) {
        await checkCharWarn(doc, doc.convertPageWarn);
        const charMetrics = calcCharMetricsFromPages(doc.ocr.active);

        if (Object.keys(charMetrics).length > 0) {
          clearObjectProperties(doc.fonts.state.charMetrics);
          Object.assign(doc.fonts.state.charMetrics, charMetrics);
        }
        await doc.runOptimization(doc.ocr.active);
      }
    });
  } else if (!scribeFiles[0] && doc.inputData.pdfMode && (usePDFText.native.main || usePDFText.native.supp || usePDFText.ocr.main || usePDFText.ocr.supp || keepPDFTextAlways)) {
    if (deferText) {
      // `terminate()` and `clear()` resolve this still-pending promise to null via `_textReadySettle`, so waiters never hang when the worker pool is torn down mid-extraction.
      // Extraction errors also resolve to null rather than reject, so awaiting `textReady` never throws.
      doc.textReady = new Promise((resolve) => {
        doc._textReadySettle = () => resolve(null);
        extractInternalPDFText(doc, { usePDFText, keepPDFTextAlways }).then(
          (res) => {
            doc._textReadySettle = null;
            resolve(res);
          },
          (err) => {
            doc._textReadySettle = null;
            console.error('Deferred PDF text extraction failed:', err);
            resolve(null);
          },
        );
      });
    } else {
      await extractInternalPDFText(doc, { usePDFText, keepPDFTextAlways });
    }
  }
}

/**
 * Import supplemental OCR files into this document, such as an alternate OCR version or ground truth data.
 * This function should not be used to import the main OCR files.
 * @param {ScribeDoc} doc
 * @param {Array<File>|FileList|Array<string>} files
 * @param {string} ocrName - Name of the OCR version (e.g. "Ground Truth")
 */
export async function importFilesSupp(doc, files, ocrName) {
  if (!files || files.length === 0) return;

  if (!doc.ocr[ocrName]) doc.ocr[ocrName] = Array(doc.inputData.pageCount);

  const curFiles = await standardizeFiles(files);

  /** @type {Array<File|FileNode>} */
  const ocrFilesAll = [];
  for (let i = 0; i < curFiles.length; i++) ocrFilesAll.push(curFiles[i]);

  ocrFilesAll.sort((a, b) => ((a.name > b.name) ? 1 : ((b.name > a.name) ? -1 : 0)));

  const ocrData = await importOCRFiles(ocrFilesAll);

  const pageCountHOCR = ocrData.hocrRaw.length;

  // If both OCR data and image data are present, confirm they have the same number of pages
  if (doc.images.pageCount > 0 && doc.images.pageCount !== pageCountHOCR) {
    const warningHTML = `Page mismatch detected. Image data has ${doc.images.pageCount} pages while OCR data has ${pageCountHOCR} pages.`;
    doc.warningHandler({ message: warningHTML });
  }

  const format = /** @type {("hocr" | "abbyy" | "stext" | "textract" | "text")} */ (ocrData.format);

  await convertOCR(doc, ocrData.hocrRaw, false, format, ocrName, ocrData.reimportHocrMode, doc.pageMetrics);
}
