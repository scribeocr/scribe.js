import { scribeDocDefaults } from './containers/scribeDocDefaults.js';
import { loadBuiltInFontsRaw, loadChiSimFont } from './fontContainerMain.js';
import { addCircularRefsDataTables } from './objects/layoutObjects.js';
import { determinePdfType } from './pdf/parsePdfDoc.js';
import { computeRequiresOCR } from './pdf/ocrPageSelection.js';

/** @typedef {import('./containers/scribeDoc.js').ScribeDoc} ScribeDoc */

/**
 * Extract and parse text from this document's loaded PDF.
 * @param {ScribeDoc} doc
 * @param {Object} [options]
 * @param {typeof scribeDocDefaults.usePDFText} [options.usePDFText]
 *    How to use the extracted native/OCR text. Defaults to `scribeDocDefaults.usePDFText`.
 * @param {boolean} [options.keepPDFTextAlways]
 *    Always convert and retain the PDF text even if it would otherwise be discarded.
 *    Defaults to `scribeDocDefaults.keepPDFTextAlways`.
 */
export async function extractInternalPDFText(doc, options = {}) {
  if (!doc.images.pdfData) throw new Error('No PDF data loaded');

  const usePDFText = options.usePDFText ?? scribeDocDefaults.usePDFText;
  const keepPDFTextAlways = options.keepPDFTextAlways ?? scribeDocDefaults.keepPDFTextAlways;

  const pdfScheduler = await doc.images.getPdfScheduler();
  const pageCount = doc.images.pageCount;

  const pageDPI = doc.images.pdfDims300.map((x) => 300 * Math.min(x.width, 3500) / x.width);
  // Dispatch parse jobs in a rolling window rather than staging every page at once: the scheduler runs same-tier jobs FIFO,
  // so a fully staged backlog would starve every render queued behind it (e.g. thumbnails during a deferred import) until the last page parses.
  // The window is sized to keep all workers saturated while still letting other jobs interleave.
  const workerCount = pdfScheduler.workers?.length || 1;
  /** @type {Array<Awaited<ReturnType<typeof pdfScheduler.parsePdfPage>>>} */
  const pageResults = new Array(pageCount);
  let nextPage = 0;
  const pump = async () => {
    while (nextPage < pageCount) {
      const i = nextPage++;
      pageResults[i] = await pdfScheduler.parsePdfPage({ pageIndex: i, dpi: pageDPI[i] });
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(workerCount * 2, 4), pageCount || 1) }, pump));

  doc.inputData.pageStats = pageResults.map((r) => r.pageStats || null);

  doc.inputData.requiresOCR = computeRequiresOCR(doc.inputData.pageStats);

  const { type } = determinePdfType(pageResults.map((r) => r.pageStats), pageCount);
  doc.inputData.pdfType = type;

  for (let i = 0; i < pageCount; i++) {
    const parsed = pageResults[i].annotations || [];
    const existing = doc.annotations.pages[i];
    // Merge rather than overwrite: the user may have added annotations (e.g. a highlight) while the deferred extraction was in flight.
    // Parsed annotations come first, matching document order.
    doc.annotations.pages[i] = existing && existing.length ? [...parsed, ...existing] : parsed;
  }

  const extractPDFTextNative = usePDFText.native.main || usePDFText.native.supp;
  const extractPDFTextOCR = usePDFText.ocr.main || usePDFText.ocr.supp;

  /** @type {{ content: ?Array<OcrPage>, type: string }} */
  const res = { content: null, type };

  if (!keepPDFTextAlways) {
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

  const isMainData = (type === 'text' && usePDFText.native.main)
    || (type === 'ocr' && usePDFText.ocr.main);

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
