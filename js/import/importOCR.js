// import { updateDataProgress } from "../main.js";
import { addCircularRefsDataTables } from '../objects/layoutObjects.js';
import { readOcrFile } from '../utils/miscUtils.js';

export const splitHOCRStr = (hocrStrAll) => hocrStrAll.replace(/[\s\S]*?<body>/, '')
  .replace(/<\/body>[\s\S]*$/, '')
  .replace(/<\/body>[\s\S]*$/, '')
  .trim()
  .split(/(?=<div class=['"]ocr_page['"])/);

/**
 *
 * @param {string} ocrStr - The OCR string to detect the format of.
 * @param {string} [ext] - The file extension of the OCR file.
 * @returns {?TextSource}
 */
const detectOcrFormat = (ocrStr, ext) => {
  if (ext) {
    ext = ext.replace(/^\./, '').toLowerCase();
    if (ext === 'hocr') {
      return 'hocr';
    } if (ext === 'stext') {
      return 'stext';
    }
  }

  // Check whether input is Abbyy XML
  // TODO: The auto-detection of formats needs to be more robust.
  // At present, any string that contains ">" and "abbyy" is considered Abbyy XML.
  const node2 = ocrStr.match(/>([^>]+)/)?.[1];

  if (!!node2 && !!/abbyy/i.test(node2)) {
    return 'abbyy';
  }

  if (!!node2 && !!/<document name/.test(node2)) {
    return 'stext';
  }

  if (!node2 && !!/"DetectDocumentTextModelVersion"/i.test(ocrStr)) {
    return 'textract';
  }

  if (!node2 && !!/"AnalyzeDocumentModelVersion"/i.test(ocrStr)) {
    return 'textract';
  }

  if (!node2 && !!/"pages"/i.test(ocrStr) && !!/"fullTextAnnotation"/i.test(ocrStr)) {
    return 'google_vision';
  }

  if (/"createdDateTime"/i.test(ocrStr) && /"analyzeResult"/i.test(ocrStr) && /"modelId"/i.test(ocrStr)) {
    return 'azure_doc_intel';
  }

  if (!!node2 && !!/class=['"]ocr_page['"]/i.test(ocrStr)
      || !!/<\?xml version/i.test(ocrStr)) {
    return 'hocr';
  }

  if (ext && ext.toLowerCase() === 'txt') {
    return 'text';
  }

  return null;
};

/**
 * Import raw OCR data from files.
 * Currently supports .hocr (used by Tesseract), Abbyy .xml, and stext (an intermediate data format used by mupdf).
 *
 * @param {Array<File|FileNode|ArrayBuffer>} ocrFilesAll - Array of OCR files
 */
export async function importOCRFiles(ocrFilesAll) {
  // In the case of 1 HOCR file
  const singleHOCRMode = ocrFilesAll.length === 1;

  let hocrStrStart = null;
  let format = null;
  let reimportHocrMode = false;

  let pageCountHOCR;
  let hocrRaw;
  /** @type {Object.<string, CharMetricsFamily> | undefined} */
  let charMetricsObj;
  /** @type {?LayoutPage} */
  let layoutObj = null;
  /** @type {?LayoutDataTablePage} */
  let layoutDataTableObj = null;
  let defaultFont;
  let enableOpt;
  let sansFont;
  let serifFont;

  if (singleHOCRMode) {
    const hocrStrAll = await readOcrFile(ocrFilesAll[0]);

    format = detectOcrFormat(hocrStrAll, ocrFilesAll[0]?.name?.split('.').pop());

    if (!format) {
      console.error(ocrFilesAll[0]);
      throw new Error('No supported OCR format detected.');
    }

    if (format === 'textract') {
      hocrRaw = [hocrStrAll];
    } else if (format === 'google_vision') {
      hocrRaw = [hocrStrAll];
      if (hocrStrAll.substring(0, 500).includes('"responses"')) {
        const responses = JSON.parse(hocrStrAll).responses;
        hocrRaw = responses
          .sort((a, b) => a.context.pageNumber - b.context.pageNumber)
          .map((resp) => JSON.stringify(resp));
      }
    } else if (format === 'azure_doc_intel') {
      hocrRaw = [hocrStrAll];
    } else if (format === 'abbyy') {
      hocrRaw = hocrStrAll.split(/(?=<page)/).slice(1);
    } else if (format === 'stext') {
      hocrRaw = hocrStrAll.split(/(?=<page)/).slice(1);
    } else if (format === 'text') {
      hocrRaw = [hocrStrAll];
    } else if (format === 'hocr') {
      // `hocrStrStart` will be missing for individual HOCR pages created with Tesseract.js or the Tesseract API.
      hocrStrStart = hocrStrAll.match(/[\s\S]*?<body>/)?.[0];
      hocrRaw = splitHOCRStr(hocrStrAll);
    }

    pageCountHOCR = hocrRaw.length;
  } else {
    pageCountHOCR = ocrFilesAll.length;
    hocrRaw = Array(pageCountHOCR);

    // Check whether input is Abbyy XML using the first file
    const hocrStrFirst = await readOcrFile(ocrFilesAll[0]);

    format = detectOcrFormat(hocrStrFirst, ocrFilesAll[0]?.name?.split('.').pop());

    if (!format) {
      console.error(ocrFilesAll[0]);
      throw new Error('No supported OCR format detected.');
    }

    for (let i = 0; i < pageCountHOCR; i++) {
      const hocrFile = ocrFilesAll[i];
      hocrRaw[i] = await readOcrFile(hocrFile);
    }
  }

  if (format === 'hocr' && hocrStrStart) {
    const getMeta = (name) => {
      const regex = new RegExp(`<meta name=["']${name}["'][^<]+`, 'i');

      const nodeStr = hocrStrStart.match(regex)?.[0];
      if (!nodeStr) return null;
      const contentStr = nodeStr.match(/content=["']([\s\S]+?)(?=["']\s{0,5}\/?>)/i)?.[1];
      if (!contentStr) return null;
      return contentStr.replace(/&quot;/g, '"');
    };

    const ocrSystem = getMeta('ocr-system');
    reimportHocrMode = ocrSystem === 'scribeocr';

    // Font optimization and layout settings are skipped in the fringe case where .hocr files are produced individually using Scribe,
    // and then re-uploaded together for further processing, since only the first page is parsed for metadata.
    // Hopefully this case is rare enough that it does not come up often.
    if (singleHOCRMode) {
      const charMetricsStr = getMeta('font-metrics');
      if (charMetricsStr) {
        charMetricsObj = /** @type  {Object.<string, CharMetricsFamily>} */ (JSON.parse(charMetricsStr));

        // Older versions of the font metrics object used 'small-caps' instead of 'smallCaps'.
        for (const key in charMetricsObj) {
          if (charMetricsObj[key]['small-caps'] && !charMetricsObj[key].smallCaps) charMetricsObj[key].smallCaps = charMetricsObj[key]['small-caps'];
        }
      }

      const layoutStr = getMeta('layout');
      if (layoutStr) layoutObj = /** @type {LayoutPage} */ (JSON.parse(layoutStr));

      const layoutDataTableStr = getMeta('layout-data-table');
      if (layoutDataTableStr) {
        layoutDataTableObj = JSON.parse(layoutDataTableStr);
        addCircularRefsDataTables(layoutDataTableObj);
      }

      const enableOptStr = getMeta('enable-opt');
      if (enableOptStr) enableOpt = enableOptStr;
    }

    const defaultFontStr = getMeta('default-font');
    if (defaultFontStr) defaultFont = defaultFontStr;

    const sansFontStr = getMeta('sans-font');
    if (sansFontStr) sansFont = sansFontStr;

    let serifFontStr = getMeta('serif-font');
    // Older versions of Scribe used 'NimbusRomNo9L' instead of 'NimbusRoman'.
    if (serifFontStr && serifFontStr === 'NimbusRomNo9L') serifFontStr = 'NimbusRoman';
    if (serifFontStr) serifFont = serifFontStr;
  }

  /** @type {Partial<FontState>} */
  const fontState = {
    enableOpt: enableOpt !== undefined ? enableOpt === 'true' || enableOpt === '1' : undefined,
    serifDefaultName: serifFont,
    sansDefaultName: sansFont,
    defaultFontName: defaultFont,
    charMetrics: charMetricsObj,
  };

  return {
    hocrRaw,
    layoutObj,
    fontState,
    layoutDataTableObj,
    format,
    reimportHocrMode,
  };
}
