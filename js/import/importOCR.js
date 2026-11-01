import { readOcrFile } from '../utils/miscUtils.js';

export const splitHOCRStr = (hocrStrAll) => hocrStrAll.replace(/[\s\S]*?<body>/, '')
  .replace(/<\/body>[\s\S]*$/, '')
  .replace(/<\/body>[\s\S]*$/, '')
  .trim()
  .split(/(?=<div class=['"]ocr_page['"])/);

/**
 * Detects an OCR file's format from its content and extension.
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
    // Markdown legitimately contains XML and HTML inside code blocks, which the content sniffing below would read as hOCR, so the extension settles it first.
    if (ext === 'md') {
      return 'md';
    }
  }

  // The root element of an XML or HTML file: the first tag after a byte-order mark, the XML declaration, a doctype and comments.
  const root = ocrStr.slice(0, 2000).match(/^\uFEFF?\s*(?:(?:<\?[\s\S]*?\?>|<![^>]*>|<!--[\s\S]*?-->)\s*)*(<[a-zA-Z][^>]*>)/)?.[1];
  if (root) {
    if (/^<(?:\w+:)?alto[\s>]/i.test(root) && /loc\.gov\/standards\/alto/i.test(root)) {
      return 'alto';
    }
    // mupdf's stext shares its root name with ABBYY's format and carries no namespace.
    if (/^<(?:\w+:)?document[\s>]/i.test(root)) {
      return /abbyy\.com/i.test(root) ? 'abbyy' : 'stext';
    }
    // An XHTML document, or the bare ocr_page fragment tesseract.js writes.
    if (/class=['"]ocr_page['"]/i.test(ocrStr)) {
      return 'hocr';
    }
    return null;
  }

  if (/^\uFEFF?\s*[{[]/.test(ocrStr)) {
    if (/"(?:DetectDocumentText|AnalyzeDocument)ModelVersion"/.test(ocrStr)) {
      return 'textract';
    }
    if (/"fullTextAnnotation"/.test(ocrStr)) {
      return 'google_vision';
    }
    if (/"textAnchor"/.test(ocrStr) && /"tokens"/.test(ocrStr)) {
      return 'google_doc_ai';
    }
    if (/"analyzeResult"/.test(ocrStr) && /"modelId"/.test(ocrStr)) {
      return 'azure_doc_intel';
    }
    return null;
  }

  if (ext && ext.toLowerCase() === 'txt') {
    return 'text';
  }

  if (ext && ext.toLowerCase() === 'docx') {
    return 'docx';
  }

  return null;
};

/**
 * Number of pages in the raw OCR strings of one import.
 * @param {string} format
 * @param {Array<?string>} ocrRaw
 */
export function countOcrPages(format, ocrRaw) {
  const whole = ocrRaw[0];
  if (ocrRaw.length !== 1 || !whole) return ocrRaw.length;
  if (format === 'textract') return whole.match(/"BLOCKTYPE":\s*"PAGE"/ig)?.length || 1;
  if (format === 'google_doc_ai') return whole.match(/"pageNumber":\s*\d+/g)?.length || 1;
  if (format === 'azure_doc_intel') return whole.match(/"unit":\s*"(pixel|inch)"/g)?.length || 1;
  return 1;
}

/**
 * Import raw OCR data from files.
 *
 * @param {Array<File|FileNode|ArrayBuffer>} ocrFilesAll - Array of OCR files
 */
export async function importOCRFiles(ocrFilesAll) {
  // In the case of 1 HOCR file
  const singleHOCRMode = ocrFilesAll.length === 1;

  let hocrStrStart = null;
  let format = null;

  let pageCountHOCR;
  let hocrRaw;

  if (singleHOCRMode) {
    const fileExt = ocrFilesAll[0]?.name?.split('.').pop();
    let ocrFilesContent;
    if (fileExt === 'docx') {
      ocrFilesContent = await ocrFilesAll[0].arrayBuffer();
      format = 'docx';
    } else {
      ocrFilesContent = await readOcrFile(ocrFilesAll[0]);
      format = detectOcrFormat(ocrFilesContent, fileExt);
    }

    if (!format) {
      console.error(ocrFilesAll[0]);
      throw new Error('No supported OCR format detected.');
    }

    if (format === 'textract') {
      hocrRaw = [ocrFilesContent];
    } else if (format === 'google_vision') {
      hocrRaw = [ocrFilesContent];
      if (ocrFilesContent.substring(0, 500).includes('"responses"')) {
        const responses = JSON.parse(ocrFilesContent).responses;
        hocrRaw = responses
          .sort((a, b) => a.context.pageNumber - b.context.pageNumber)
          .map((resp) => JSON.stringify(resp));
      }
    } else if (format === 'azure_doc_intel') {
      hocrRaw = [ocrFilesContent];
    } else if (format === 'google_doc_ai') {
      hocrRaw = [ocrFilesContent];
    } else if (format === 'alto') {
      // Extract the Styles section to prepend to each page
      const stylesMatch = ocrFilesContent.match(/<Styles>[\s\S]*?<\/Styles>/i);
      const stylesSection = stylesMatch ? stylesMatch[0] : '';

      // Split by Page elements
      const pages = ocrFilesContent.split(/(?=<Page\s)/).slice(1);

      // Prepend Styles section to each page so font lookups work
      hocrRaw = pages.map((page) => stylesSection + page);
    } else if (format === 'abbyy') {
      hocrRaw = ocrFilesContent.split(/(?=<page)/).slice(1);
    } else if (format === 'stext') {
      hocrRaw = ocrFilesContent.split(/(?=<page)/).slice(1);
    } else if (format === 'text' || format === 'md') {
      hocrRaw = [ocrFilesContent];
    } else if (format === 'docx') {
      // For .docx, pass the full file contents to the read function.
      hocrRaw = [ocrFilesContent];
    } else if (format === 'hocr') {
      // `hocrStrStart` will be missing for individual HOCR pages created with Tesseract.js or the Tesseract API.
      hocrStrStart = ocrFilesContent.match(/[\s\S]*?<body>/)?.[0];
      hocrRaw = splitHOCRStr(ocrFilesContent);
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
    if (format === 'hocr') hocrStrStart = hocrStrFirst.match(/[\s\S]*?<body>/)?.[0] ?? null;
  }

  /** @type {?Array<string>} */
  let hocrHead = null;
  if (format === 'hocr' && hocrStrStart) {
    hocrHead = [...hocrStrStart.matchAll(/<meta\b[^>]*\bname\s*=\s*["']ocr-[^"']*["'][^>]*>/gi)].map((x) => x[0]);
  }

  return {
    hocrRaw,
    format,
    hocrHead,
  };
}
