import { scribeDocDefaults } from './containers/scribeDocDefaults.js';
import { loadBuiltInFontsRaw, loadChiSimFont } from './fontContainerMain.js';
import { addCircularRefsDataTables } from './objects/layoutObjects.js';
import ocr from './objects/ocrObjects.js';
import { determinePdfType, pageFillShapes, wordSignalsOf } from './pdf/parsePdfDoc.js';
import { computeRequiresOCR, hasBrokenFontRun } from './pdf/ocrPageSelection.js';
import { PdfSchedulerInProcess } from './pdfWorkerMain.js';
import { PageStore, detailOrderAfter, pageRuns } from './containers/pageStore.js';

/** @typedef {import('./containers/scribeDoc.js').ScribeDoc} ScribeDoc */

/**
 * Extract and parse text from `doc`'s loaded PDF.
 * @param {ScribeDoc} doc
 * @param {Object} [options]
 * @param {typeof scribeDocDefaults.usePDFText} [options.usePDFText]
 * @param {boolean} [options.keepPDFTextAlways]
 * @param {boolean} [options.supplemental] - Store the parsed `'pdf'` layer without making it active.
 * @param {() => void} [options.onProgress] - Called each time a page is parsed or a run of pages is laid out.
 * @returns {Promise<?{ type: 'image' | 'text' | 'ocr' }>} Detected PDF type, or `null` if `doc` closed mid-extraction.
 */
export async function extractInternalPDFText(doc, options = {}) {
  if (!doc.images.pdfData) throw new Error('No PDF data loaded');

  const usePDFText = options.usePDFText ?? scribeDocDefaults.usePDFText;
  const keepPDFTextAlways = options.keepPDFTextAlways ?? scribeDocDefaults.keepPDFTextAlways;
  const supplemental = options.supplemental ?? false;

  const pdfScheduler = await doc.images.getPdfScheduler();
  const pageCount = doc.images.pageCount;
  const inProcess = pdfScheduler instanceof PdfSchedulerInProcess;

  const pageDPI = doc.images.pdfDims300.map((x) => 300 * Math.min(x.width, 3500) / x.width);
  const staged = new PageStore();
  /**
   * Per-page parse metadata kept alongside `staged`.
   * @type {Array<Omit<import('./worker/pdfWorker.js').ParsedPageRecords, 'record'|'detail'>>}
   */
  const parsed = new Array(pageCount);
  // Dispatch parse jobs in a rolling window rather than staging every page at once: the scheduler runs same-tier jobs FIFO,
  // so a fully staged backlog would starve every render queued behind it (e.g. thumbnails during a deferred import) until the last page parses.
  // The window is sized to keep all workers saturated while still letting other jobs interleave.
  const workerCount = pdfScheduler.workers?.length || 1;
  let nextPage = 0;
  const pump = async () => {
    while (nextPage < pageCount) {
      const i = nextPage++;
      if (inProcess) {
        const result = await pdfScheduler.parsePdfPage({ pageIndex: i, dpi: pageDPI[i] });
        if (!result || typeof result !== 'object') continue;
        const { pageObj } = result;
        let words = 0;
        for (const line of pageObj.lines) words += line.words.length;
        parsed[i] = {
          flags: 0,
          words,
          angle: pageObj.angle,
          // Key signals by word ID, since `staged` may evict the page and decode fresh `OcrWord` objects before layout.
          signals: [...(result.wordSignals || [])].map(([word, sig]) => [word.id, sig.artifact, sig.mcid, sig.brokenFont]),
          pageStats: result.pageStats,
          annotations: result.annotations,
          dataTablePage: result.dataTablePage,
          provisionalTables: result.provisionalTables,
          langSet: result.langSet,
        };
        staged.setPage(i, pageObj, 'pdf', { nativeText: result.nativeText || {}, fillShapes: pageFillShapes(result) });
      } else {
        const result = await pdfScheduler.parsePdfPageRecords({ pageIndex: i, dpi: pageDPI[i] });
        if (!result || typeof result !== 'object') continue;
        const { record, detail, ...kept } = result;
        staged.setRecords(i, 'pdf', record, detail, kept.flags, { words: kept.words, nativeWords: kept.nativeWords, textSource: 'pdf' });
        parsed[i] = kept;
      }
      options.onProgress?.();
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(Math.max(workerCount * 2, 4), pageCount || 1) }, pump));

    // Closing the document mid-extraction settles remaining worker jobs to `SKIPPED`, leaving `parsed[i]` unset.
    for (let i = 0; i < pageCount; i++) if (!parsed[i]) return null;

    const { type } = determinePdfType(parsed.map((r) => r.pageStats), pageCount);
    const extractPDFTextNative = usePDFText.native.main || usePDFText.native.supp;
    const extractPDFTextOCR = usePDFText.ocr.main || usePDFText.ocr.supp;
    const keepText = keepPDFTextAlways || !((!extractPDFTextOCR && type === 'ocr') || (!extractPDFTextNative && type === 'text'));

    /** @type {Array<{n: number, prevN: number, tableId: string, prevTableId: string, reason: string}>} */
    const tableLinkSuggestions = [];
    if (keepText) {
      const cuts = pageRuns(parsed.map((r) => r.words));
      const docPageCount = parsed.filter((r) => r.words > 0).length;
      /** @type {?import('./pdf/parsePdfDoc.js').ChunkCarry} */
      let carry = null;
      for (let c = 0; c < cuts.length - 1; c++) {
        const first = cuts[c];
        const last = cuts[c + 1];
        const carryIn = carry;
        let out;
        if (inProcess) {
          out = staged.held(() => {
            const results = [];
            const idsBefore = [];
            for (let n = first; n < last; n++) {
              const pageObj = /** @type {OcrPage} */ (staged.getPage(n, 'pdf'));
              results.push({
                pageObj, wordSignals: wordSignalsOf(pageObj, parsed[n].signals), dataTablePage: parsed[n].dataTablePage, provisionalTables: parsed[n].provisionalTables,
              });
              idsBefore.push(staged.isDetailed(n, 'pdf') ? null : pageObj.lines.flatMap((line) => line.words.map((word) => word.id)));
            }
            const laidOut = pdfScheduler.layoutPdfChunk({
              results, pdfType: type, carry: carryIn, docPageCount,
            });
            idsBefore.forEach((ids, k) => {
              const order = ids && detailOrderAfter(ids, results[k].pageObj);
              if (order) staged.setDetailOrder(first + k, 'pdf', order);
            });
            return laidOut;
          });
        } else {
          const pages = [];
          for (let n = first; n < last; n++) {
            pages.push({
              record: staged.heldRecord(n, 'pdf'), flags: parsed[n].flags, signals: parsed[n].signals, dataTablePage: parsed[n].dataTablePage, provisionalTables: parsed[n].provisionalTables,
            });
          }
          out = await pdfScheduler.layoutPdfChunkRecords({
            pages, pdfType: type, carry: carryIn, docPageCount,
          });
          if (!out || typeof out !== 'object') return null;
          out.pages.forEach((page, k) => {
            staged.replaceRecord(first + k, 'pdf', page.record, { words: page.words, nativeWords: page.nativeWords, textSource: 'pdf' });
            if (page.order) staged.setDetailOrder(first + k, 'pdf', page.order);
            parsed[first + k].dataTablePage = page.dataTablePage;
          });
        }
        carry = out.carry;
        options.onProgress?.();
        tableLinkSuggestions.push(...out.tableLinkSuggestions);
        for (const patch of out.notePatches) {
          const word = ocr.getPageWord(/** @type {OcrPage} */ (staged.getPage(patch.n, 'pdf')), patch.wordId);
          if (word) word.footnoteParId = patch.parId;
        }
      }

      // Awaited before any write, so the writes below run without yielding and a viewer never sees the text half-written.
      const fontPromiseArr = [loadBuiltInFontsRaw()];
      if (parsed.some((r) => r.langSet && r.langSet.has('chi_sim'))) {
        fontPromiseArr.push(loadChiSimFont());
      }
      await Promise.all(fontPromiseArr);
    }

    doc.inputData.pageStats = parsed.map((r) => r.pageStats || null);

    doc.inputData.requiresOCR = computeRequiresOCR(doc.inputData.pageStats);

    doc.inputData.pdfType = type;

    // Restored .scribe annotations may embed page-edit remaps and user deletions a fresh lift cannot reflect, so re-merging would duplicate kept entries and resurrect deleted ones.
    if (!doc.annotations.restored) {
      const seenFieldRefs = new Set();
      for (let i = 0; i < pageCount; i++) {
        const lifted = (parsed[i].annotations || []).filter((a) => {
          if (a.type !== 'field' || a.srcRef == null) return true;
          if (seenFieldRefs.has(a.srcRef)) return false;
          seenFieldRefs.add(a.srcRef);
          return true;
        });
        doc.stampSources.pages[i] = lifted.filter((a) => a.type === 'stamp').map((a) => ({ srcRef: a.srcRef, bbox: { ...a.bbox } }));
        const existing = doc.annotations.pages[i];
        if (existing && existing.length) {
          doc.annotations.pages[i] = [...lifted, ...existing];
          doc.docHistory.prependAnnotRows(doc.annotations, i, lifted);
        } else {
          doc.annotations.pages[i] = lifted;
        }
      }
    }

    const res = { type };

    if (!keepText) return res;

    // `doc.nativeText.pages` proxies the `pdf` layer in `doc.pageStore` when present, so snapshot any restored entries before `takeLayer` installs the parsed layer.
    /** @type {Array<?Record<string, NativeTextWord>>} */
    const restoredNativeText = [];
    for (let i = 0; i < pageCount; i++) {
      const restored = doc.nativeText.pages[i];
      restoredNativeText.push(restored && Object.keys(restored).length > 0 ? restored : null);
    }

    doc.tableLinkSuggestions = tableLinkSuggestions;
    doc.pageStore.takeLayer(staged, 'pdf');
    for (let i = 0; i < pageCount; i++) {
      if (restoredNativeText[i]) doc.nativeText.pages[i] = { ...doc.nativeText.pages[i], ...restoredNativeText[i] };
    }

    const tablePages = parsed.map((r) => r.dataTablePage);
    addCircularRefsDataTables(tablePages);
    for (let i = 0; i < tablePages.length; i++) {
      if (Object.keys(doc.layoutDataTables.pages[i]?.tables || {}).length === 0) doc.layoutDataTables.pages[i] = tablePages[i];
    }

    const stats = doc.inputData.pageStats || [];
    const parsedLayerTrusted = type === 'image'
      && stats.some((st) => st && (st.printableVis || 0) > 0)
      && stats.every((st) => !st || ((st.invisibleTextChars || 0) === 0 && (st.control || 0) === 0 && !hasBrokenFontRun(st)));
    const isMainData = !supplemental
      && ((type === 'text' && usePDFText.native.main)
        || (type === 'ocr' && usePDFText.ocr.main)
        || (parsedLayerTrusted && usePDFText.native.main));

    for (let n = 0; n < pageCount; n++) {
      if (isMainData && doc.pageMetrics[n]) doc.pageMetrics[n].angle = parsed[n].angle;
      doc.inputData.xmlMode[n] = true;
    }

    if (isMainData) doc.pageStore.active = 'pdf';

    return res;
  } finally {
    // Remove any untransferred pages from the global LRU eviction set and word budget.
    staged.clear();
  }
}
