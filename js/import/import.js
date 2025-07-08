import { clearData } from '../clear.js';
import { inputData, opt } from '../containers/app.js';
import {
  convertPageWarn,
  layoutDataTables,
  layoutRegions,
  ocrAll,
  ocrAllRaw,
  pageMetricsArr,
} from '../containers/dataContainer.js';
import { FontCont } from '../containers/fontContainer.js';
import { ImageCache, ImageWrapper } from '../containers/imageContainer.js';
import { extractInternalPDFText } from '../extractPDFText.js';
import {
  enableFontOpt,
  loadBuiltInFontsRaw,
  optimizeFontContainerAll, setDefaultFontAuto,
} from '../fontContainerMain.js';
import { runFontOptimization } from '../fontEval.js';
import { calcCharMetricsFromPages } from '../fontStatistics.js';
import { calcSuppFontInfo } from '../fontSupp.js';
import { gs } from '../generalWorkerMain.js';
import { imageUtils } from '../objects/imageObjects.js';
import { addCircularRefsDataTables, LayoutDataTablePage, LayoutPage } from '../objects/layoutObjects.js';
import { addCircularRefsOcr } from '../objects/ocrObjects.js';
import { PageMetrics } from '../objects/pageMetricsObjects.js';
import { checkCharWarn, convertOCR } from '../recognizeConvert.js';
import {
  readOcrFile, clearObjectProperties, objectAssignDefined, readTextFile,
} from '../utils/miscUtils.js';
import { importOCRFiles } from './importOCR.js';

/**
 * Automatically detects the image type (jpeg or png).
 * @param {Uint8Array} image
 * @returns {('jpeg'|'png')}
 */
const detectImageFormat = (image) => {
  if (image[0] === 0xFF && image[1] === 0xD8) {
    return 'jpeg';
  } if (image[0] === 0x89 && image[1] === 0x50) {
    return 'png';
  }
  throw new Error('Unsupported image type');
};

/**
 *
 * @param {File|FileNode|ArrayBuffer} file
 * @returns {Promise<string>}
 */
const importImageFile = async (file) => new Promise((resolve, reject) => {
  if (file instanceof ArrayBuffer) {
    const imageUint8 = new Uint8Array(file);
    const format = detectImageFormat(imageUint8);
    const binary = String.fromCharCode(...imageUint8);
    resolve(`data:image/${format};base64,${btoa(binary)}`);
    return;
  }

  // The `typeof process` condition is necessary to avoid error in Node.js versions <20, where `File` is not defined.
  if (typeof process === 'undefined' && file instanceof File) {
    const reader = new FileReader();

    reader.onloadend = async () => {
      resolve(/** @type {string} */(reader.result));
    };

    reader.onerror = (error) => {
      reject(error);
    };

    reader.readAsDataURL(file);
    return;
  }

  if (typeof process !== 'undefined') {
    if (!file?.name) reject(new Error('Invalid input. Must be a FileNode or ArrayBuffer.'));
    const format = file.name.match(/jpe?g$/i) ? 'jpeg' : 'png';
    // @ts-ignore
    resolve(`data:image/${format};base64,${file.fileData.toString('base64')}`);
    return;
  }

  reject(new Error('Invalid input. Must be a File or ArrayBuffer.'));
});

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

    // TODO: Investigate whether other file formats are supported (without additional changes)
    // Tesseract.js definitely supports more formats, so if the .pdfs we make also support a format,
    // then we should be able to expand the list of supported types without issue.
    // Update: It looks like .bmp does not work.
    if (['png', 'jpeg', 'jpg'].includes(fileExt)) {
      imageFilesAll.push(file);
      // All .gz files are assumed to be OCR data (xml) since all other file types can be compressed already
    } else if (['hocr', 'xml', 'html', 'gz', 'stext', 'json'].includes(fileExt)) {
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
      if ([''].includes(fileExt) && typeof process === 'undefined' && file instanceof File) {
        const content = await readTextFile(file);
        if (/"AnalyzeDocumentModelVersion"/i.test(content)) {
          ocrFilesAll.push(file);
          continue;
        }
      }

      unsupportedFilesAll.push(file);
      unsupportedExt[fileExt] = true;
    }
  }

  if (unsupportedFilesAll.length > 0) {
    const errorText = `Import includes unsupported file types: ${Object.keys(unsupportedExt).join(', ')}`;
    opt.warningHandler(errorText);
  }

  imageFilesAll.sort((a, b) => ((a.name > b.name) ? 1 : ((b.name > a.name) ? -1 : 0)));
  ocrFilesAll.sort((a, b) => ((a.name > b.name) ? 1 : ((b.name > a.name) ? -1 : 0)));

  return {
    pdfFiles: pdfFilesAll, imageFiles: imageFilesAll, ocrFiles: ocrFilesAll, scribeFiles: scribeFilesAll,
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
 * Import files for processing.
 * An object with `pdfFiles`, `imageFiles`, and `ocrFiles` arrays can be provided to import multiple types of files.
 * Alternatively, for `File` objects (browser) and file paths (Node.js), a single array can be provided, which is sorted based on extension.
 * @public
 * @param {Array<File>|FileList|Array<string>|SortedInputFiles} files
 */
export async function importFiles(files) {
  if (!files) throw new Error('No files provided.');

  clearData();
  gs.getGeneralScheduler();

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
    opt.errorHandler(errorText);
    return;
  } if (pdfFiles.length > 0 && imageFiles.length > 0) {
    const errorText = 'PDF and image files cannot be imported together. Only first PDF file will be imported.';
    opt.warningHandler(errorText);
    pdfFiles.length = 1;
    imageFiles.length = 0;
  } else if (pdfFiles.length > 1) {
    const errorText = 'Multiple PDF files are not supported. Only first PDF file will be imported.';
    opt.warningHandler(errorText);
    pdfFiles.length = 1;
    imageFiles.length = 0;
  }

  if (pdfFiles[0] && !(pdfFiles[0] instanceof ArrayBuffer)) {
    inputData.inputFileNames = [pdfFiles[0].name];
  } else if (imageFiles[0] && !(imageFiles[0] instanceof ArrayBuffer)) {
    // @ts-ignore
    inputData.inputFileNames = imageFiles.map((x) => x.name);
  }

  // Set default download name
  if (pdfFiles.length > 0 && 'name' in pdfFiles[0]) {
    inputData.defaultDownloadFileName = `${pdfFiles[0].name.replace(/\.\w{1,6}$/, '')}.pdf`;
  } else if (imageFiles.length > 0 && 'name' in imageFiles[0]) {
    inputData.defaultDownloadFileName = `${imageFiles[0].name.replace(/\.\w{1,6}$/, '')}.pdf`;
  } else if (ocrFiles.length > 0 && 'name' in ocrFiles[0]) {
    inputData.defaultDownloadFileName = `${ocrFiles[0].name.replace(/\.\w{1,6}$/, '')}.pdf`;
  } else if (scribeFiles.length > 0 && 'name' in scribeFiles[0]) {
    inputData.defaultDownloadFileName = `${scribeFiles[0].name.replace(/\.\w{1,6}$/, '')}.pdf`;
  }

  let existingLayout = false;
  let existingLayoutDataTable = false;

  inputData.pdfMode = pdfFiles.length === 1;
  inputData.imageMode = !!(imageFiles.length > 0 && !inputData.pdfMode);
  ImageCache.inputModes.image = !!(imageFiles.length > 0 && !inputData.pdfMode);

  if (scribeFiles.length > 0) {
    const scribeRestoreStr = await readOcrFile(scribeFiles[0]);
    /** @type {ScribeSaveData} */
    const scribeRestoreObj = JSON.parse(scribeRestoreStr);
    if (scribeRestoreObj.fontState) {
      objectAssignDefined(FontCont.state, scribeRestoreObj.fontState);
      await runFontOptimization(ocrAll.active);
    }
    if (scribeRestoreObj.layoutRegions) {
      existingLayout = true;
      layoutRegions.pages = scribeRestoreObj.layoutRegions;
    }
    if (scribeRestoreObj.layoutDataTables) {
      existingLayoutDataTable = true;
      addCircularRefsDataTables(scribeRestoreObj.layoutDataTables);
      layoutDataTables.pages = scribeRestoreObj.layoutDataTables;
    }

    const oemName = 'User Upload';
    if (!ocrAll[oemName]) ocrAll[oemName] = Array(inputData.pageCount);
    addCircularRefsOcr(scribeRestoreObj.ocr);
    ocrAll[oemName] = scribeRestoreObj.ocr;
    ocrAll.active = ocrAll[oemName];

    for (let i = 0; i < ocrAll[oemName].length; i++) {
      inputData.xmlMode[i] = true;
      if (ocrAll[oemName][i].dims.height && ocrAll[oemName][i].dims.width) {
        pageMetricsArr[i] = new PageMetrics(ocrAll[oemName][i].dims);
      }
      pageMetricsArr[i].angle = ocrAll[oemName][i].angle;
    }
  }

  const xmlModeImport = ocrFiles.length > 0;

  let pageCount;
  let pageCountImage;
  let abbyyMode = false;
  let textractMode = false;
  let reimportHocrMode = false;

  if (inputData.pdfMode) {
    const pdfFile = pdfFiles[0];

    // Start loading mupdf workers as soon as possible, without waiting for `pdfFile.arrayBuffer` (which can take a while).
    ImageCache.getMuPDFScheduler();

    ImageCache.pdfData = pdfFile instanceof ArrayBuffer ? pdfFile : await pdfFile.arrayBuffer();

    // If no XML data is provided, page sizes are calculated using muPDF alone
    await ImageCache.openMainPDF(ImageCache.pdfData, opt.omitNativeText);

    pageCountImage = ImageCache.pageCount;
    ImageCache.loadCount = ImageCache.pageCount;
  } else if (inputData.imageMode) {
    pageCountImage = imageFiles.length;
  }

  let existingOpt = false;
  const oemName = 'User Upload';
  let stextMode;
  if (xmlModeImport) {
    // Initialize a new array on `ocrAll` if one does not already exist
    if (!ocrAll[oemName]) ocrAll[oemName] = Array(inputData.pageCount);
    ocrAll.active = ocrAll[oemName];

    const ocrData = await importOCRFiles(Array.from(ocrFiles));

    ocrAllRaw.active = ocrData.hocrRaw;
    // Subset OCR data to avoid uncaught error that occurs when there are more pages of OCR data than image data.
    // While this should be rare, it appears to be fairly common with Archive.org documents.
    // TODO: Add warning message displayed to user for this.
    // Textract JSON data is returned in arbitrary chunks (multiple pages may be in one file, or one page may be in multiple files).
    // Therefore, it is impossible to know how many pages of OCR data there are based only on the length of `ocrAllRaw.active`.
    if (pageCountImage && ocrAllRaw.active.length > pageCountImage && !ocrData.textractMode) {
      console.log(`Identified ${ocrAllRaw.active.length} pages of OCR data but ${pageCountImage} pages of image/pdf data. Only first ${pageCountImage} pages will be used.`);
      ocrAllRaw.active = ocrAllRaw.active.slice(0, pageCountImage);
    }

    objectAssignDefined(FontCont.state, ocrData.fontState);

    // Restore font metrics and optimize font from previous session (if applicable)
    if (ocrData.fontState.charMetrics && Object.keys(ocrData.fontState.charMetrics).length > 0) {
      const fontPromise = loadBuiltInFontsRaw();

      existingOpt = true;

      await gs.schedulerReady;
      setDefaultFontAuto(FontCont.state.charMetrics);

      // If `ocrData.enableOpt` is `false`, then the metrics are present but ignored.
      // This occurs if optimization was found to decrease accuracy for both sans and serif,
      // not simply because the user disabled optimization in the view settings.
      // If no `enableOpt` property exists but metrics are present, then optimization is enabled.
      if (ocrData.enableOpt === 'false') {
        FontCont.state.enableOpt = false;
      } else {
        await fontPromise;
        if (!FontCont.raw) throw new Error('Raw font data not found.');
        FontCont.opt = await optimizeFontContainerAll(FontCont.raw, FontCont.state.charMetrics);
        FontCont.state.enableOpt = true;
        await enableFontOpt(true);
      }
    }

    // Restore layout data from previous session (if applicable)
    if (ocrData.layoutObj) {
      for (let i = 0; i < ocrData.layoutObj.length; i++) {
        layoutRegions.pages[i] = ocrData.layoutObj[i];
      }
      existingLayout = true;
    }

    if (ocrData.layoutDataTableObj) {
      for (let i = 0; i < ocrData.layoutDataTableObj.length; i++) {
        layoutDataTables.pages[i] = ocrData.layoutDataTableObj[i];
      }
      existingLayoutDataTable = true;
    }

    abbyyMode = ocrData.abbyyMode;
    reimportHocrMode = ocrData.reimportHocrMode;

    stextMode = ocrData.stextMode;
    textractMode = ocrData.textractMode;
  }

  let pageCountOcr = ocrAllRaw.active?.length || ocrAll.active?.length || 0;

  // For Textract, `ocrAllRaw.active[0]` is a string containing the Textract JSON data for all pages.
  // This ad-hoc solution counts the number of "PAGE" blocks in the Textract JSON data.
  if (textractMode && ocrAllRaw.active?.length) {
    pageCountOcr = ocrAllRaw.active[0].match(/"BLOCKTYPE":\s*"PAGE"/ig)?.length || pageCountOcr;
  }

  // If both OCR data and image data are present, confirm they have the same number of pages
  if (xmlModeImport && (inputData.imageMode || inputData.pdfMode)) {
    if (pageCountImage !== pageCountOcr) {
      const warningHTML = `Page mismatch detected. Image data has ${pageCountImage} pages while OCR data has ${pageCountOcr} pages.`;
      opt.warningHandler(warningHTML);
    }
  }

  inputData.pageCount = pageCountImage ?? pageCountOcr;

  ocrAllRaw.active = ocrAllRaw.active || Array(pageCount);

  if (!existingLayout) {
    for (let i = 0; i < inputData.pageCount; i++) {
      layoutRegions.pages[i] = new LayoutPage(i);
    }
  }

  if (!existingLayoutDataTable) {
    for (let i = 0; i < inputData.pageCount; i++) {
      layoutDataTables.pages[i] = new LayoutDataTablePage(i);
    }
  }

  // Render first page for PDF only
  if (inputData.pdfMode && !xmlModeImport) {
    opt.progressHandler({ n: 0, type: 'importPDF', info: { } });
  }

  if (inputData.imageMode) {
    ImageCache.pageCount = inputData.pageCount;
    for (let i = 0; i < inputData.pageCount; i++) {
      ImageCache.nativeSrc[i] = await importImageFile(imageFiles[i]).then(async (imgStr) => {
        const imgWrapper = new ImageWrapper(i, imgStr, 'native', false, false);
        const imageDims = await imageUtils.getDims(imgWrapper);
        pageMetricsArr[i] = new PageMetrics(imageDims);
        return imgWrapper;
      });
      ImageCache.loadCount++;
      opt.progressHandler({ n: i, type: 'importImage', info: { } });
    }
  }

  if (xmlModeImport) {
    /** @type {("hocr" | "abbyy" | "stext" | "textract")} */
    let format = 'hocr';
    if (abbyyMode) format = 'abbyy';
    if (stextMode) format = 'stext';
    if (textractMode) format = 'textract';

    // Process HOCR using web worker, reading from file first if that has not been done already
    await convertOCR(ocrAllRaw.active, true, format, oemName, reimportHocrMode, pageMetricsArr).then(async () => {
      // Skip this step if optimization info was already restored from a previous session, or if using stext (which is character-level but not visually accurate).
      if (!existingOpt && !stextMode) {
        await checkCharWarn(convertPageWarn);
        const charMetrics = calcCharMetricsFromPages(ocrAll.active);

        if (Object.keys(charMetrics).length > 0) {
          clearObjectProperties(FontCont.state.charMetrics);
          Object.assign(FontCont.state.charMetrics, charMetrics);
        }
        await runFontOptimization(ocrAll.active);
      }
    });
  } else if (inputData.pdfMode && (opt.usePDFText.native.main || opt.usePDFText.native.supp || opt.usePDFText.ocr.main || opt.usePDFText.ocr.supp)) {
    await extractInternalPDFText();
    if (inputData.pdfType === 'text' && opt.usePDFText.native.main || inputData.pdfType === 'ocr' && opt.usePDFText.ocr.main) {
      if (inputData.pdfType === 'text') FontCont.state.enableCleanToNimbusMono = true;
      if (opt.calcSuppFontInfo) await calcSuppFontInfo(ocrAll.pdf);
    }
  }
}

/**
 * Import supplemental OCR files, such as an alternate OCR version or ground truth data.
 * This function should not be used to import the main OCR files.
 * @param {Array<File>|FileList|Array<string>} files
 * @param {string} ocrName - Name of the OCR version (e.g. "Ground Truth")
 */
export async function importFilesSupp(files, ocrName) {
  if (!files || files.length === 0) return;

  if (!ocrAll[ocrName]) ocrAll[ocrName] = Array(inputData.pageCount);

  const curFiles = await standardizeFiles(files);

  /** @type {Array<File|FileNode>} */
  const ocrFilesAll = [];
  for (let i = 0; i < curFiles.length; i++) ocrFilesAll.push(curFiles[i]);

  ocrFilesAll.sort((a, b) => ((a.name > b.name) ? 1 : ((b.name > a.name) ? -1 : 0)));

  const ocrData = await importOCRFiles(ocrFilesAll);

  const pageCountHOCR = ocrData.hocrRaw.length;

  // If both OCR data and image data are present, confirm they have the same number of pages
  if (ImageCache.pageCount > 0 && ImageCache.pageCount !== pageCountHOCR) {
    const warningHTML = `Page mismatch detected. Image data has ${ImageCache.pageCount} pages while OCR data has ${pageCountHOCR} pages.`;
    opt.warningHandler(warningHTML);
  }

  /** @type {("hocr" | "abbyy" | "stext" | "textract")} */
  let format = 'hocr';
  if (ocrData.abbyyMode) format = 'abbyy';
  if (ocrData.stextMode) format = 'stext';
  if (ocrData.textractMode) format = 'textract';

  await convertOCR(ocrData.hocrRaw, false, format, ocrName, ocrData.reimportHocrMode);
}
