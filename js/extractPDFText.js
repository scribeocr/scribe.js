import { inputData, opt } from './containers/app.js';
import { ocrAll, ocrAllRaw } from './containers/dataContainer.js';
import { ImageCache } from './containers/imageContainer.js';
import { convertOCR } from './recognizeConvert.js';

/**
 * Extract raw text content from currently loaded PDF.
 * Reports whether PDF is text-native, contains invisible OCR text, or is image-only.
 */
const extractInternalPDFTextRaw = async () => {
  const muPDFScheduler = await ImageCache.getMuPDFScheduler(3);

  const pdfContentStats = {
    /** Total number of letters in the source PDF. */
    letterCountTotal: 0,
    /** Total number of visible letters in the source PDF. */
    letterCountVis: 0,
    /** Total number of pages with 100+ letters in the source PDF. */
    pageCountTotalText: 0,
    /** Total number of pages with 100+ visible letters in the source PDF. */
    pageCountVisText: 0,
  };

  const stextArr = /** @type {Array<string>} */ ([]);
  const pageDPI = ImageCache.pdfDims300.map((x) => 300 * Math.min(x.width, 3500) / x.width);
  const resArr = pageDPI.map(async (x, i) => {
    // While using `pageTextJSON` would save some parsing, unfortunately that format only includes line-level granularity.
    // The XML format is the only built-in mupdf format that includes character-level granularity.
    const res = await muPDFScheduler.pageText({
      page: i + 1, dpi: x, format: 'xml', calcStats: true,
    });
    pdfContentStats.letterCountTotal += res.letterCountTotal;
    pdfContentStats.letterCountVis += res.letterCountVis;
    if (res.letterCountTotal >= 100) pdfContentStats.pageCountTotalText++;
    if (res.letterCountVis >= 100) pdfContentStats.pageCountVisText++;
    stextArr[i] = res.content;
  });
  await Promise.all(resArr);

  /** @type {"image" | "text" | "ocr"} */
  let type = 'image';

  // Determine whether the PDF is text-native, image-only, or image + OCR.
  {
    // The PDF is considered text-native if:
    // (1) The total number of visible letters is at least 100 per page on average.
    // (2) The total number of visible letters is at least 90% of the total number of letters.
    // (3) The total number of pages with 100+ visible letters is at least half of the total number of pages.
    if (pdfContentStats.letterCountTotal >= ImageCache.pageCount * 100
      && pdfContentStats.letterCountVis >= pdfContentStats.letterCountTotal * 0.9
      && pdfContentStats.pageCountVisText >= ImageCache.pageCount / 2) {
      type = 'text';
      // The PDF is considered ocr-native if:
      // (1) The total number of letters is at least 100 per page on average.
      // (2) The total number of letters is at least half of the total number of letters.
    } else if (pdfContentStats.letterCountTotal >= ImageCache.pageCount * 100
      && pdfContentStats.pageCountTotalText >= ImageCache.pageCount / 2) {
      type = 'ocr';
      // Otherwise, the PDF is considered image-native.
      // This includes both literally image-only PDFs, as well as PDFs that have invalid encodings or other issues that prevent valid text extraction.
    } else {
      type = 'image';
    }
  }

  return { contentRaw: stextArr, content: /** @type {?Array<OcrPage>} */ (null), type };
};

/**
 * Extract and parse text from currently loaded PDF.
 */
export const extractInternalPDFText = async () => {
  const extractPDFTextNative = opt.usePDFText.native.main || opt.usePDFText.native.supp;
  const extractPDFTextOCR = opt.usePDFText.ocr.main || opt.usePDFText.ocr.supp;
  const extractPDFTextImage = false;

  const res = await extractInternalPDFTextRaw();

  inputData.pdfType = res.type;
  ocrAllRaw.pdf = res.contentRaw;

  if (!extractPDFTextImage && res.type === 'image') return res;

  if (!extractPDFTextOCR && res.type === 'ocr') return res;

  if (!extractPDFTextNative && res.type === 'text') return res;

  ocrAll.pdf = Array(ImageCache.pageCount);

  if (inputData.pdfType === 'text' && opt.usePDFText.native.main || inputData.pdfType === 'ocr' && opt.usePDFText.ocr.main) {
    ocrAllRaw.active = ocrAllRaw.pdf;
    ocrAll.active = ocrAll.pdf;
  }

  const format = 'stext';

  // Process HOCR using web worker, reading from file first if that has not been done already
  await convertOCR(ocrAllRaw.pdf, true, format, 'pdf', false);

  res.content = ocrAll.pdf;

  return res;
};
