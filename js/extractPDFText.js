import { inputData, opt } from './containers/app.js';
import {
  annotations, layoutDataTables, ocrAll, pageMetricsAll,
} from './containers/dataContainer.js';
import { ImageCache } from './containers/imageContainer.js';
import { loadBuiltInFontsRaw } from './fontContainerMain.js';
import { addCircularRefsDataTables } from './objects/layoutObjects.js';
import { determinePdfType } from './pdf/parsePdfDoc.js';

/**
 * Extract and parse text from currently loaded PDF.
 */
export const extractInternalPDFText = async () => {
  if (!ImageCache.pdfData) throw new Error('No PDF data loaded');

  const pdfScheduler = await ImageCache.getPdfScheduler();
  const pageCount = ImageCache.pageCount;

  const pageDPI = ImageCache.pdfDims300.map((x) => 300 * Math.min(x.width, 3500) / x.width);
  const avgDPI = pageDPI.reduce((a, b) => a + b, 0) / pageDPI.length;
  const pageResults = await Promise.all(
    Array.from({ length: pageCount }, (_, i) => pdfScheduler.parsePdfPage({ pageIndex: i, dpi: avgDPI })),
  );

  const { type } = determinePdfType(pageResults.map((r) => r.charStats), pageCount);
  inputData.pdfType = type;

  for (let i = 0; i < pageCount; i++) {
    annotations.pages[i] = pageResults[i].annotations || [];
  }

  const extractPDFTextNative = opt.usePDFText.native.main || opt.usePDFText.native.supp;
  const extractPDFTextOCR = opt.usePDFText.ocr.main || opt.usePDFText.ocr.supp;

  /** @type {{ content: ?Array<OcrPage>, type: string }} */
  const res = { content: null, type };

  if (!opt.keepPDFTextAlways) {
    if (!extractPDFTextOCR && type === 'ocr') return res;
    if (!extractPDFTextNative && type === 'text') return res;
  }

  ocrAll.pdf = pageResults.map((result) => result.pageObj);

  const tablePages = pageResults.map((result) => result.dataTablePage);
  addCircularRefsDataTables(tablePages);
  for (let i = 0; i < tablePages.length; i++) {
    layoutDataTables.pages[i] = tablePages[i];
  }

  await loadBuiltInFontsRaw();

  const isMainData = (type === 'text' && opt.usePDFText.native.main)
    || (type === 'ocr' && opt.usePDFText.ocr.main);

  for (let n = 0; n < ocrAll.pdf.length; n++) {
    if (isMainData && ocrAll.pdf[n] && pageMetricsAll[n]) {
      pageMetricsAll[n].angle = ocrAll.pdf[n].angle;
    }
    inputData.xmlMode[n] = true;
  }

  if (isMainData) {
    ocrAll.active = ocrAll.pdf;
  }

  res.content = ocrAll.pdf;

  return res;
};
