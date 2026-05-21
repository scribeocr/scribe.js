import { opt } from './containers/app.js';
import { loadBuiltInFontsRaw, loadChiSimFont } from './fontContainerMain.js';
import { addCircularRefsDataTables } from './objects/layoutObjects.js';
import { determinePdfType } from './pdf/parsePdfDoc.js';

/** @typedef {import('./containers/scribeDoc.js').ScribeDoc} ScribeDoc */

/**
 * Extract and parse text from this document's loaded PDF.
 * @param {ScribeDoc} doc
 */
export async function extractInternalPDFText(doc) {
  if (!doc.images.pdfData) throw new Error('No PDF data loaded');

  const pdfScheduler = await doc.images.getPdfScheduler();
  const pageCount = doc.images.pageCount;

  const pageDPI = doc.images.pdfDims300.map((x) => 300 * Math.min(x.width, 3500) / x.width);
  const pageResults = await Promise.all(
    Array.from({ length: pageCount }, (_, i) => pdfScheduler.parsePdfPage({ pageIndex: i, dpi: pageDPI[i] })),
  );

  const { type } = determinePdfType(pageResults.map((r) => r.charStats), pageCount);
  doc.inputData.pdfType = type;

  for (let i = 0; i < pageCount; i++) {
    doc.annotations.pages[i] = pageResults[i].annotations || [];
  }

  const extractPDFTextNative = opt.usePDFText.native.main || opt.usePDFText.native.supp;
  const extractPDFTextOCR = opt.usePDFText.ocr.main || opt.usePDFText.ocr.supp;

  /** @type {{ content: ?Array<OcrPage>, type: string }} */
  const res = { content: null, type };

  if (!opt.keepPDFTextAlways) {
    if (!extractPDFTextOCR && type === 'ocr') return res;
    if (!extractPDFTextNative && type === 'text') return res;
  }

  doc.ocr.pdf = pageResults.map((result) => result.pageObj);

  const tablePages = pageResults.map((result) => result.dataTablePage);
  addCircularRefsDataTables(tablePages);
  for (let i = 0; i < tablePages.length; i++) {
    doc.layoutDataTables.pages[i] = tablePages[i];
  }

  const fontPromiseArr = [loadBuiltInFontsRaw()];
  if (pageResults.some((r) => r.langSet && r.langSet.has('chi_sim'))) {
    fontPromiseArr.push(loadChiSimFont());
  }
  await Promise.all(fontPromiseArr);

  const isMainData = (type === 'text' && opt.usePDFText.native.main)
    || (type === 'ocr' && opt.usePDFText.ocr.main);

  for (let n = 0; n < doc.ocr.pdf.length; n++) {
    if (isMainData && doc.ocr.pdf[n] && doc.pageMetrics[n]) {
      doc.pageMetrics[n].angle = doc.ocr.pdf[n].angle;
    }
    doc.inputData.xmlMode[n] = true;
  }

  if (isMainData) {
    doc.ocr.active = doc.ocr.pdf;
  }

  res.content = doc.ocr.pdf;

  return res;
}
