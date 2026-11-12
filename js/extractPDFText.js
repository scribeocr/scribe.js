import { scribeDocDefaults } from './containers/scribeDocDefaults.js';
import { loadBuiltInFontsRaw, loadChiSimFont } from './fontContainerMain.js';
import { addCircularRefsDataTables } from './objects/layoutObjects.js';
import { determinePdfType, applyDocParagraphLayout, promoteContinuationTables } from './pdf/parsePdfDoc.js';
import { assignPageLineNums } from './import/assignPageLineNums.js';
import { computeRequiresOCR, hasBrokenFontRun } from './pdf/ocrPageSelection.js';
import { findXrefOffset, parseXref, getPageObjects } from './pdf/parsePdfUtils.js';
import { ObjectCache } from './pdf/objectCache.js';

/** @typedef {import('./containers/scribeDoc.js').ScribeDoc} ScribeDoc */

/**
 * Install the annotations parsed from page `i` of the PDF.
 * @param {ScribeDoc} doc
 * @param {number} i
 * @param {Array<Annotation>} parsed - The page's own annotations, in document order.
 * @param {?import('./import/import.js').SeededLoad} seeded - The on-demand load the parse serves, or null for an import.
 */
export function installParsedAnnotations(doc, i, parsed, seeded) {
  const existing = doc.annotations.pages[i];
  const baseline = seeded?.annotBaseline.get(i);
  if (baseline !== undefined) {
    // The page already holds a host's earlier read of its own annotations, so merging the parse in as below would duplicate them.
    // The parse replaces that copy only while the user has not edited it.
    if (JSON.stringify(existing) === baseline) doc.annotations.pages[i] = parsed;
    return;
  }
  // The user may have added annotations while the deferred extraction was in flight, so merge rather than overwrite.
  if (existing && existing.length) {
    doc.annotations.pages[i] = [...parsed, ...existing];
    // The parsed rows are not an edit, so the undo timeline's states of this page gain them too, and undoing the user's edit leaves them in place.
    doc.docHistory.prependAnnotRows(doc.annotations, i, parsed);
  } else {
    doc.annotations.pages[i] = parsed;
  }
}

/**
 * Extract and parse text from this document's loaded PDF.
 * @param {ScribeDoc} doc
 * @param {Object} [options]
 * @param {typeof scribeDocDefaults.usePDFText} [options.usePDFText]
 *    How to use the extracted native/OCR text. Defaults to `scribeDocDefaults.usePDFText`.
 * @param {boolean} [options.keepPDFTextAlways]
 *    Always convert and retain the PDF text even if it would otherwise be discarded.
 *    Defaults to `scribeDocDefaults.keepPDFTextAlways`.
 * @param {boolean} [options.supplemental]
 *    Another source already owns the active text layer, so the parsed text is retained beside it rather than replacing it.
 * @param {import('./import/import.js').SeededLoad} [options.seeded]
 *    The on-demand load this extraction serves.
 *    The words a host showed for single pages give way to the parse.
 *    Nothing is written when the load has been abandoned.
 */
export async function extractInternalPDFText(doc, options = {}) {
  if (!doc.images.pdfData) throw new Error('No PDF data loaded');

  const usePDFText = options.usePDFText ?? scribeDocDefaults.usePDFText;
  const keepPDFTextAlways = options.keepPDFTextAlways ?? scribeDocDefaults.keepPDFTextAlways;
  const supplemental = options.supplemental ?? false;

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

  // A document closed mid-extraction tears its pool down and the pump's remaining jobs settle as skipped, so there is nothing to compute on.
  if (pageResults.some((r) => !r || typeof r !== 'object')) return null;

  const { type } = determinePdfType(pageResults.map((r) => r.pageStats), pageCount);
  const extractPDFTextNative = usePDFText.native.main || usePDFText.native.supp;
  const extractPDFTextOCR = usePDFText.ocr.main || usePDFText.ocr.supp;
  const keepText = keepPDFTextAlways || !((!extractPDFTextOCR && type === 'ocr') || (!extractPDFTextNative && type === 'text'));

  // Awaited before any write, so the writes below run without yielding and a viewer never sees the text half-written.
  if (keepText) {
    const fontPromiseArr = [loadBuiltInFontsRaw()];
    if (pageResults.some((r) => r.langSet && r.langSet.has('chi_sim'))) {
      fontPromiseArr.push(loadChiSimFont());
    }
    await Promise.all(fontPromiseArr);
  }

  const seeded = options.seeded ?? null;
  if (seeded) {
    if (doc._seeded !== seeded || seeded.closed) return null;
    seeded.beforeCommit?.();
    // The words a host showed for single pages before the load give way to the parse.
    doc.ocr.active = [];
    doc.inputData.xmlMode.length = 0;
    for (let i = 0; i < doc.nativeText.pages.length; i++) doc.nativeText.pages[i] = {};
  }

  doc.inputData.pageStats = pageResults.map((r) => r.pageStats || null);

  doc.inputData.requiresOCR = computeRequiresOCR(doc.inputData.pageStats);

  doc.inputData.pdfType = type;

  // Restored .scribe annotations may embed page-edit remaps and user deletions a fresh lift cannot reflect, so re-merging would duplicate kept entries and resurrect deleted ones.
  if (!doc.annotations.restored) {
    // The same widget object can be listed on several pages, but it is one field.
    const seenFieldRefs = new Set();
    for (let i = 0; i < pageCount; i++) {
      const parsed = (pageResults[i].annotations || []).filter((a) => {
        if (a.type !== 'field' || a.srcRef == null) return true;
        if (seenFieldRefs.has(a.srcRef)) return false;
        seenFieldRefs.add(a.srcRef);
        return true;
      });
      installParsedAnnotations(doc, i, parsed, seeded);
    }
  }

  /** @type {{ content: ?Array<OcrPage>, type: string }} */
  const res = { content: null, type };

  if (!keepText) return res;

  doc.ocr.pdf = pageResults.map((result) => result.pageObj);

  // An edited session carries updated entries a fresh parse cannot know about, so the restored ones win.
  for (let i = 0; i < pageCount; i++) {
    doc.nativeText.pages[i] = { ...(pageResults[i].nativeText || {}), ...(doc.nativeText.pages[i] || {}) };
    /** @type {PageFillShapes} */
    const shapes = {
      squares: pageResults[i].fillSquares,
      marks: pageResults[i].fillMarks,
      marksOverflow: pageResults[i].fillMarksOverflow,
      images: pageResults[i].fillImages,
      paths: pageResults[i].fillPaths,
      pathsIneligible: pageResults[i].fillPathsIneligible,
      glyphBoxes: pageResults[i].fillGlyphBoxes,
    };
    doc.fillShapes.pages[i] = (shapes.squares?.length || shapes.marks?.length || shapes.images?.length
      || shapes.paths?.length || shapes.pathsIneligible || shapes.glyphBoxes?.length) ? shapes : null;
  }

  // Overwrites the per-page assignParagraphs result the workers assigned: no worker sees the whole document.
  try {
    const arr = doc.images.pdfData instanceof Uint8Array ? doc.images.pdfData : new Uint8Array(doc.images.pdfData);
    const objCache = new ObjectCache(arr, parseXref(arr, findXrefOffset(arr)));
    const rawPages = getPageObjects(objCache);
    // Passing whole results would also hand over `dataTablePage`, which this path has never fed to the table-region pass.
    applyDocParagraphLayout(objCache, arr, rawPages, pageResults.map(({ pageObj, wordSignals }) => ({ pageObj, wordSignals })), type);
  } catch { /* */ }

  assignPageLineNums(doc.ocr.pdf);

  doc.tableLinkSuggestions = promoteContinuationTables(pageResults);

  const tablePages = pageResults.map((result) => result.dataTablePage);
  addCircularRefsDataTables(tablePages);
  for (let i = 0; i < tablePages.length; i++) {
    // An accompanying OCR file may carry its own tables, which the parse must not overwrite.
    if (Object.keys(doc.layoutDataTables.pages[i]?.tables || {}).length === 0) doc.layoutDataTables.pages[i] = tablePages[i];
  }

  // An image-based verdict can mean too little text rather than unreadable text.
  const stats = doc.inputData.pageStats || [];
  const parsedLayerTrusted = type === 'image'
    && stats.some((s) => s && (s.printableVis || 0) > 0)
    && stats.every((s) => !s || ((s.invisibleTextChars || 0) === 0 && (s.control || 0) === 0 && !hasBrokenFontRun(s)));
  const isMainData = !supplemental
    && ((type === 'text' && usePDFText.native.main)
      || (type === 'ocr' && usePDFText.ocr.main)
      || (parsedLayerTrusted && usePDFText.native.main));

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
