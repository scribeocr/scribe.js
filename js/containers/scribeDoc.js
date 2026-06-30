import { InputData, opt } from './app.js';
import { DocFonts } from './fontContainer.js';
import { ImageStore } from './imageContainer.js';
import { scribeDocDefaults } from './scribeDocDefaults.js';
import { clearObjectProperties } from '../utils/miscUtils.js';
import {
  addHighlights as addHighlightsImpl, addFreeText as addFreeTextImpl, clearHighlights as clearHighlightsImpl,
  addShapes as addShapesImpl, clearShapes as clearShapesImpl,
} from '../addHighlights.js';
import { renderPageStatic as renderPageStaticImpl } from '../debug.js';
import { exportData as exportDataImpl, download as downloadImpl } from '../export/export.js';
import { dropFromWorkers, enableOpt as enableFontOptImpl } from '../fontContainerMain.js';
import {
  recognize as recognizeImpl,
  compareOCR as compareOCRImpl,
  recognizePageImp as recognizePageImpImpl,
  evalOCRPage as evalOCRPageImpl,
  insertParsedPage as insertParsedPageImpl,
} from '../recognizeConvert.js';
import { importFiles as importFilesImpl, importFilesSupp as importFilesSuppImpl } from '../import/import.js';
import { runOptimization as runOptimizationImpl } from '../fontEval.js';
import { clonePageFull } from '../objects/ocrObjects.js';

/**
 * The distinct OCR/raw-OCR layer arrays.
 * Deduped by identity because callers alias layers (e.g. the viewer sets `doc.ocr.active = doc.ocr.pdf`), so a shared array is spliced only once.
 * @param {Object<string, Array<any>>} layers
 * @returns {Array<Array<any>>}
 */
function uniqueLayers(layers) {
  return [...new Set(Object.values(layers).filter(Array.isArray))];
}

/**
 * Every dense per-page array that must stay index-aligned with `pageMetrics`.
 * Delete/move apply the same splice to each. (Derived image caches are handled separately by `clearImageCaches`.)
 * @param {ScribeDoc} doc
 * @returns {Array<Array<any>>}
 */
function densePageArrays(doc) {
  const arrs = [...uniqueLayers(doc.ocr), ...uniqueLayers(doc.ocrRaw)];
  arrs.push(doc.pageMetrics, doc.layoutRegions.pages, doc.layoutDataTables.pages, doc.annotations.pages);
  if (Array.isArray(doc.vis)) arrs.push(doc.vis);
  if (Array.isArray(doc.convertPageWarn)) arrs.push(doc.convertPageWarn);
  // Source image (image-input docs) and per-page 300-DPI dims are full-length; rendered caches are not (see clearImageCaches).
  arrs.push(doc.images.nativeSrc, doc.images.pdfDims300);
  if (Array.isArray(doc.inputData.xmlMode)) arrs.push(doc.inputData.xmlMode);
  if (Array.isArray(doc.inputData.pageStats)) arrs.push(doc.inputData.pageStats);
  if (Array.isArray(doc.inputData.ocrApplied)) arrs.push(doc.inputData.ocrApplied);
  // Dedupe so any aliased array (e.g. ocr.active === ocr.pdf) is spliced exactly once.
  return [...new Set(arrs)];
}

/**
 * Drop the derived image caches so they re-render against the edited order (via `sourcePageN`).
 * @param {ScribeDoc} doc
 */
function clearImageCaches(doc) {
  const { images } = doc;
  images.native.length = 0;
  images.binary.length = 0;
  images.nativeProps.length = 0;
  images.binaryProps.length = 0;
  images.thumbnails.length = 0;
}

/**
 * Renumber the `.n` field on every per-page object whose identity carries its index.
 * @param {ScribeDoc} doc
 */
function renumberPages(doc) {
  for (const layer of uniqueLayers(doc.ocr)) {
    for (let i = 0; i < layer.length; i++) if (layer[i]) layer[i].n = i;
  }
  const tag = (arr) => { for (let i = 0; i < arr.length; i++) if (arr[i]) arr[i].n = i; };
  tag(doc.layoutRegions.pages);
  tag(doc.layoutDataTables.pages);
  tag(doc.images.nativeProps);
  tag(doc.images.binaryProps);
}

/**
 * Give every page a concrete `sourcePageN`, so a later reorder/delete can carry the real source index
 * (the default `null` means "identity = my current index", valid only before any edit).
 * @param {ScribeDoc} doc
 */
function materializeSourcePages(doc) {
  for (let i = 0; i < doc.pageMetrics.length; i++) {
    const pm = doc.pageMetrics[i];
    if (pm && pm.sourcePageN == null) pm.sourcePageN = i;
  }
}

/**
 * Build an independent snapshot of every per-page array entry at index `i`, for later insertion via `insertPages`.
 * Call `materializeSourcePages(doc)` first so the cloned `pageMetrics.sourcePageN` is concrete.
 * @param {ScribeDoc} doc
 * @param {number} i - Source page index.
 * @returns {object} An independent clone bundle for page `i`.
 */
function clonePageBundle(doc, i) {
  // One clone per unique OCR array so aliased layers (e.g. `ocr.active === ocr.pdf`) share a single cloned page.
  const ocrCache = new Map();
  const ocr = {};
  for (const [engine, arr] of Object.entries(doc.ocr)) {
    if (!Array.isArray(arr) || i >= arr.length || !arr[i]) { ocr[engine] = null; continue; }
    if (!ocrCache.has(arr)) ocrCache.set(arr, clonePageFull(arr[i]));
    ocr[engine] = ocrCache.get(arr);
  }
  const ocrRaw = {};
  for (const [engine, arr] of Object.entries(doc.ocrRaw)) {
    ocrRaw[engine] = Array.isArray(arr) && i < arr.length ? arr[i] : '';
  }
  const cloneAt = (arr) => (Array.isArray(arr) ? structuredClone(arr[i]) : undefined);
  const refAt = (arr) => (Array.isArray(arr) ? arr[i] : undefined);
  return {
    ocr,
    ocrRaw,
    pageMetrics: structuredClone(doc.pageMetrics[i]),
    layoutRegions: cloneAt(doc.layoutRegions.pages),
    layoutDataTables: cloneAt(doc.layoutDataTables.pages),
    annotations: cloneAt(doc.annotations.pages),
    vis: cloneAt(doc.vis),
    convertPageWarn: cloneAt(doc.convertPageWarn),
    pageStats: cloneAt(doc.inputData.pageStats),
    xmlMode: refAt(doc.inputData.xmlMode),
    ocrApplied: refAt(doc.inputData.ocrApplied),
    nativeSrc: refAt(doc.images.nativeSrc),
    pdfDims300: refAt(doc.images.pdfDims300),
  };
}

let docIdCounter = 0;

/**
 * A single document being processed, holding its imported pages, OCR text, layout, and fonts.
 */
export class ScribeDoc {
  static defaults = scribeDocDefaults;

  constructor() {
    /** Process-unique id, used to namespace this document's fonts in shared registries. */
    this.id = ++docIdCounter;

    /** Input modes and basic file metadata for this document. */
    this.inputData = new InputData();

    /** @type {Object<string, Array<import('../objects/ocrObjects.js').OcrPage>>} */
    this.ocr = { active: [] };

    /** @type {Object<string, Array<string>>} */
    this.ocrRaw = { active: [] };

    /** @type {Array<PageMetrics>} */
    this.pageMetrics = [];

    /** @type {Array<Awaited<ReturnType<typeof import('../../scrollview-web/scrollview/ScrollView.js').ScrollView.prototype.getAll>>>} */
    this.vis = [];

    /** @type {Array<Object<string, string>>} */
    this.convertPageWarn = [];

    /** @type {{ debugImg: {[key: string]: Array<Array<CompDebugBrowser|CompDebugNode>> | undefined} }} */
    this.debug = { debugImg: {} };

    /** @type {{ pages: Array<LayoutPage> }} */
    this.layoutRegions = { pages: [] };

    /** @type {{ pages: Array<LayoutDataTablePage> }} */
    this.layoutDataTables = { pages: [] };

    /** @type {{ pages: Array<Array<Annotation>> }} */
    this.annotations = { pages: [] };

    this.fonts = new DocFonts();
    this.fonts.id = this.id;

    this.images = new ImageStore(this);

    /**
     * Per-document handlers consulted by emit sites during `recognize()` etc.
     * These should be set if documents require separate per-document reporting,
     * such as a client/server setup with multiple users.
     * Uses without the need for document-level reporting should use
     * `opt.progressHandler`/`opt.warningHandler`/`opt.errorHandler`,
     * which are used for all documents by default.
     * @type {(msg: any) => void}
     */
    this.progressHandler = (msg) => opt.progressHandler?.(msg);

    /** @type {(w: { message: string, page?: number }) => void} */
    this.warningHandler = ({ message }) => opt.warningHandler?.(message);

    /** @type {(e: { message: string, page?: number }) => void} */
    this.errorHandler = ({ message }) => opt.errorHandler?.(message);
  }

  /**
   * @param {LayoutRegion} region - Region to delete.
   * @param {number} n - Page number.
   */
  deleteLayoutRegion(region, n) {
    for (const [key, value] of Object.entries(this.layoutRegions.pages[n].boxes)) {
      if (value.id === region.id) {
        delete this.layoutRegions.pages[n].boxes[key];
        break;
      }
    }
  }

  /**
   * @param {LayoutDataTable} table - Table to delete.
   * @param {number} n - Page number.
   */
  deleteLayoutDataTable(table, n) {
    const idx = this.layoutDataTables.pages[n].tables.findIndex((t) => t.id === table.id);
    if (idx >= 0) {
      this.layoutDataTables.pages[n].tables.splice(idx, 1);
    }
  }

  /**
   * Delete page `i` from this document's live page model.
   * @param {number} i - 0-based page index.
   */
  deletePage(i) {
    if (i < 0 || i >= this.pageMetrics.length) return;
    materializeSourcePages(this);
    for (const arr of densePageArrays(this)) if (i < arr.length) arr.splice(i, 1);
    clearImageCaches(this);
    renumberPages(this);
    this.inputData.pageCount = this.pageMetrics.length;
    this.images.pageCount = this.pageMetrics.length;
  }

  /**
   * Move page `from` to index `to` (its final position in the new order) in this document's live page model.
   * @param {number} from
   * @param {number} to
   */
  movePage(from, to) {
    const len = this.pageMetrics.length;
    if (from < 0 || from >= len || to < 0 || to >= len || from === to) return;
    materializeSourcePages(this);
    for (const arr of densePageArrays(this)) {
      if (from >= arr.length) continue;
      const [item] = arr.splice(from, 1);
      arr.splice(to, 0, item);
    }
    clearImageCaches(this);
    renumberPages(this);
  }

  /**
   * Delete several pages at once from this document's live page model.
   * @param {Array<number>} indices - 0-based page indices to remove.
   */
  deletePages(indices) {
    // Splice high-to-low so each removal leaves the lower indices valid.
    const sorted = [...new Set(indices)].filter((i) => i >= 0 && i < this.pageMetrics.length).sort((a, b) => b - a);
    if (sorted.length === 0) return;
    materializeSourcePages(this);
    for (const arr of densePageArrays(this)) {
      for (const i of sorted) if (i < arr.length) arr.splice(i, 1);
    }
    clearImageCaches(this);
    renumberPages(this);
    this.inputData.pageCount = this.pageMetrics.length;
    this.images.pageCount = this.pageMetrics.length;
  }

  /**
   * Move several pages to a single contiguous block in this document's live page model, keeping their relative order.
   * The pages are pulled out, then re-inserted starting at `to` (an index into the array after removal).
   * @param {Array<number>} indices - 0-based page indices to move.
   * @param {number} to - Block start position in the post-removal order.
   */
  movePages(indices, to) {
    const sorted = [...new Set(indices)].filter((i) => i >= 0 && i < this.pageMetrics.length).sort((a, b) => a - b);
    if (sorted.length === 0) return;
    materializeSourcePages(this);
    for (const arr of densePageArrays(this)) {
      const pulled = [];
      for (let k = sorted.length - 1; k >= 0; k--) {
        if (sorted[k] < arr.length) pulled.unshift(arr.splice(sorted[k], 1)[0]);
      }
      arr.splice(Math.max(0, Math.min(to, arr.length)), 0, ...pulled);
    }
    clearImageCaches(this);
    renumberPages(this);
  }

  /**
   * Snapshot pages `indices` into independent clone bundles for a later `insertPages` (the clipboard payload of a page copy/cut).
   * Pure: the document is not mutated apart from materializing `sourcePageN`.
   * Returned bundles are fully detached, so the source pages may be edited or deleted before the bundles are pasted.
   * @param {Array<number>} indices - 0-based page indices to clone, in any order.
   * @returns {Array<object>} One clone bundle per valid index, in ascending page order.
   */
  copyPages(indices) {
    const sorted = [...new Set(indices)].filter((i) => i >= 0 && i < this.pageMetrics.length).sort((a, b) => a - b);
    if (sorted.length === 0) return [];
    materializeSourcePages(this);
    return sorted.map((i) => clonePageBundle(this, i));
  }

  /**
   * Insert clone bundles (from `copyPages`) as a contiguous block starting at index `to`, in this document's live page model.
   * Each full-length per-page array is spliced in lockstep.
   * Arrays that are not full-length for this document (e.g. `images.nativeSrc` for a PDF, whose rasters come from the worker via `sourcePageN`) are left untouched,
   * mirroring how delete/move guard on per-array length.
   * @param {Array<object>} bundles - Clone bundles from `copyPages`.
   * @param {number} to - Insertion index (0..pageMetrics.length).
   */
  insertPages(bundles, to) {
    if (!Array.isArray(bundles) || bundles.length === 0) return;
    const prevLen = this.pageMetrics.length;
    const at = Math.max(0, Math.min(to, prevLen));
    materializeSourcePages(this);
    // Splice only arrays that span every existing page; a sparse/empty array would misalign if inserted into.
    const spliceFull = (arr, values) => {
      if (Array.isArray(arr) && arr.length === prevLen) arr.splice(at, 0, ...values);
    };

    const ocrSeen = new Set();
    for (const [engine, arr] of Object.entries(this.ocr)) {
      if (!Array.isArray(arr) || ocrSeen.has(arr)) continue;
      ocrSeen.add(arr);
      spliceFull(arr, bundles.map((b) => b.ocr[engine] ?? null));
    }
    const rawSeen = new Set();
    for (const [engine, arr] of Object.entries(this.ocrRaw)) {
      if (!Array.isArray(arr) || rawSeen.has(arr)) continue;
      rawSeen.add(arr);
      spliceFull(arr, bundles.map((b) => b.ocrRaw[engine] ?? ''));
    }
    spliceFull(this.pageMetrics, bundles.map((b) => b.pageMetrics));
    spliceFull(this.layoutRegions.pages, bundles.map((b) => b.layoutRegions));
    spliceFull(this.layoutDataTables.pages, bundles.map((b) => b.layoutDataTables));
    spliceFull(this.annotations.pages, bundles.map((b) => b.annotations));
    spliceFull(this.vis, bundles.map((b) => b.vis));
    spliceFull(this.convertPageWarn, bundles.map((b) => b.convertPageWarn));
    spliceFull(this.images.nativeSrc, bundles.map((b) => b.nativeSrc));
    spliceFull(this.images.pdfDims300, bundles.map((b) => b.pdfDims300));
    spliceFull(this.inputData.xmlMode, bundles.map((b) => b.xmlMode));
    spliceFull(this.inputData.pageStats, bundles.map((b) => b.pageStats));
    spliceFull(this.inputData.ocrApplied, bundles.map((b) => b.ocrApplied));

    clearImageCaches(this);
    renumberPages(this);
    this.inputData.pageCount = this.pageMetrics.length;
    this.images.pageCount = this.pageMetrics.length;
  }

  /**
   * Duplicate pages `indices`, inserting the copies as a contiguous block starting at `to`.
   * @param {Array<number>} indices - 0-based page indices to duplicate.
   * @param {number} to - Insertion index (0..pageMetrics.length).
   */
  duplicatePages(indices, to) {
    this.insertPages(this.copyPages(indices), to);
  }

  /**
   * Reset all of this document's data.
   * The document's own PDF pool is cleared but not terminated (see `terminate`).
   */
  clear() {
    this.inputData.clear();
    clearObjectProperties(this.ocr);
    this.ocr.active = [];
    clearObjectProperties(this.ocrRaw);
    this.ocrRaw.active = [];
    this.annotations.pages.length = 0;
    this.layoutRegions.pages.length = 0;
    this.layoutDataTables.pages.length = 0;
    this.pageMetrics.length = 0;
    this.convertPageWarn.length = 0;
    this.images.clear();
    this.fonts.clear();
  }

  /**
   * Release this document's resources: terminate its PDF worker pool, clear its image cache, and
   * drop this document's optimized fonts from the main thread and the shared general-pool workers.
   * Does not touch the shared general/OCR pool or the process-wide built-in fonts.
   */
  async terminate() {
    await this.images.terminate();
    this.fonts.clear();
    await dropFromWorkers(this.fonts);
  }

  /**
   * Preload the PDF code and workers.
   * This is done automatically by `importFiles`, but pre-loading resources reduces the delay between upload and rendering the first page.
   */
  async preloadPdfWorkers() {
    await this.images.getPdfScheduler();
  }

  /**
   * Serialize the layout data tables as JSON, stripping circular references.
   */
  serializeLayoutDataTables() {
    const pages = structuredClone(this.layoutDataTables.pages);
    pages.forEach((page) => {
      page.tables.forEach((table) => {
        // @ts-ignore
        delete table.page;
        table.boxes.forEach((box) => {
          // @ts-ignore
          delete box.table;
        });
      });
    });
    return JSON.stringify(pages);
  }

  /**
   * Add highlight annotations using page:line references or page-level quote matching.
   * @param {Parameters<typeof addHighlightsImpl>[1]} highlights
   * @returns {ReturnType<typeof addHighlightsImpl>}
   */
  addHighlights(highlights) {
    return addHighlightsImpl(this, highlights);
  }

  /**
   * Add FreeText (text label) annotations at fixed page positions.
   * @param {Parameters<typeof addFreeTextImpl>[1]} annotations
   * @returns {ReturnType<typeof addFreeTextImpl>}
   */
  addFreeText(annotations) {
    return addFreeTextImpl(this, annotations);
  }

  /**
   * Remove all highlights previously added by `addHighlights`.
   */
  clearHighlights() {
    clearHighlightsImpl(this);
  }

  /**
   * Add vector shape annotations at fixed page positions.
   * @param {Parameters<typeof addShapesImpl>[1]} shapes
   * @returns {ReturnType<typeof addShapesImpl>}
   */
  addShapes(shapes) {
    return addShapesImpl(this, shapes);
  }

  /**
   * Remove all shape annotations previously added by `addShapes`.
   */
  clearShapes() {
    clearShapesImpl(this);
  }

  /**
   * Render a page to a canvas, including the OCR text drawn over the page image.
   * @param {Parameters<typeof renderPageStaticImpl>[1]} page
   * @param {Parameters<typeof renderPageStaticImpl>[2]} [options]
   * @returns {ReturnType<typeof renderPageStaticImpl>}
   */
  renderPageStatic(page, options) {
    return renderPageStaticImpl(this, page, options);
  }

  /**
   * Export this document's OCR data to the specified format.
   * @param {Parameters<typeof exportDataImpl>[1]} [format]
   * @param {Parameters<typeof exportDataImpl>[2]} [options]
   * @returns {ReturnType<typeof exportDataImpl>}
   */
  exportData(format, options) {
    return exportDataImpl(this, format, options);
  }

  /**
   * Run `exportData` and save the result as a download (browser) or local file (Node.js).
   * @param {Parameters<typeof downloadImpl>[1]} format
   * @param {Parameters<typeof downloadImpl>[2]} fileName
   * @param {Parameters<typeof downloadImpl>[3]} [options]
   * @returns {ReturnType<typeof downloadImpl>}
   */
  download(format, fileName, options) {
    return downloadImpl(this, format, fileName, options);
  }

  /**
   * Recognize this document's pages with the OCR engine.
   * @param {Parameters<typeof recognizeImpl>[1]} [options]
   * @returns {ReturnType<typeof recognizeImpl>}
   */
  recognize(options) {
    return recognizeImpl(this, options);
  }

  /**
   * Install a parsed `OcrPage` into this doc.
   * @param {Parameters<typeof insertParsedPageImpl>[1]} n
   * @param {Parameters<typeof insertParsedPageImpl>[2]} page
   * @param {Parameters<typeof insertParsedPageImpl>[3]} options
   */
  insertParsedPage(n, page, options) {
    return insertParsedPageImpl(this, n, page, options);
  }

  /**
   * Compare two sets of OCR data.
   * @param {Parameters<typeof compareOCRImpl>[1]} ocrA
   * @param {Parameters<typeof compareOCRImpl>[2]} ocrB
   * @param {Parameters<typeof compareOCRImpl>[3]} [options]
   * @param {Parameters<typeof compareOCRImpl>[4]} [progressCallback]
   * @returns {ReturnType<typeof compareOCRImpl>}
   */
  compareOCR(ocrA, ocrB, options, progressCallback = null) {
    return compareOCRImpl(this, ocrA, ocrB, options, progressCallback);
  }

  /**
   * Recognize a single page (or sub-region) with the OCR engine.
   * @param {Parameters<typeof recognizePageImpImpl>[1]} n
   * @param {Parameters<typeof recognizePageImpImpl>[2]} legacy
   * @param {Parameters<typeof recognizePageImpImpl>[3]} lstm
   * @param {Parameters<typeof recognizePageImpImpl>[4]} areaMode
   * @param {Parameters<typeof recognizePageImpImpl>[5]} [tessOptions]
   * @param {Parameters<typeof recognizePageImpImpl>[6]} [debugVis]
   * @param {Parameters<typeof recognizePageImpImpl>[7]} [langs]
   * @param {Parameters<typeof recognizePageImpImpl>[8]} [vanillaMode]
   * @returns {ReturnType<typeof recognizePageImpImpl>}
   */
  recognizePageImp(n, legacy, lstm, areaMode, tessOptions = {}, debugVis = false, langs = null, vanillaMode = false) {
    return recognizePageImpImpl(this, n, legacy, lstm, areaMode, tessOptions, debugVis, langs, vanillaMode);
  }

  /**
   * Evaluate the OCR accuracy of a single page or line.
   * @param {Parameters<typeof evalOCRPageImpl>[1]} params
   * @returns {ReturnType<typeof evalOCRPageImpl>}
   */
  evalOCRPage(params) {
    return evalOCRPageImpl(this, params);
  }

  /**
   * Import files for processing into this document.
   * @param {Parameters<typeof importFilesImpl>[1]} files
   * @param {Parameters<typeof importFilesImpl>[2]} [options]
   * @returns {ReturnType<typeof importFilesImpl>}
   */
  importFiles(files, options) {
    return importFilesImpl(this, files, options);
  }

  /**
   * Import supplemental OCR files into this document (e.g. an alternate OCR version or ground truth).
   * @param {Parameters<typeof importFilesSuppImpl>[1]} files
   * @param {Parameters<typeof importFilesSuppImpl>[2]} ocrName
   * @returns {ReturnType<typeof importFilesSuppImpl>}
   */
  importFilesSupp(files, ocrName) {
    return importFilesSuppImpl(this, files, ocrName);
  }

  /**
   * Run font optimization and validation for this document.
   * @param {Parameters<typeof runOptimizationImpl>[1]} ocrArr
   * @returns {ReturnType<typeof runOptimizationImpl>}
   */
  runOptimization(ocrArr) {
    return runOptimizationImpl(this, ocrArr);
  }

  /**
   * Enable or disable use of optimized fonts for this document, syncing the change to worker threads.
   * Optimized fonts must already exist (via `runOptimization`) for this to have an effect.
   * @param {Parameters<typeof enableFontOptImpl>[1]} enable
   * @param {Parameters<typeof enableFontOptImpl>[2]} [force]
   * @returns {ReturnType<typeof enableFontOptImpl>}
   */
  enableFontOpt(enable, force) {
    return enableFontOptImpl(this.fonts, enable, force);
  }
}
