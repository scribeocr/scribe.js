import { InputData, opt } from './app.js';
import { DocFonts } from './fontContainer.js';
import { ImageStore } from './imageContainer.js';
import { scribeDocDefaults } from './scribeDocDefaults.js';
import { clearObjectProperties, getRandomAlphanum } from '../utils/miscUtils.js';
import {
  addHighlights as addHighlightsImpl, addFreeText as addFreeTextImpl, clearHighlights as clearHighlightsImpl,
  addShapes as addShapesImpl, clearShapes as clearShapesImpl, addTextAnnots as addTextAnnotsImpl, clearTextAnnots as clearTextAnnotsImpl,
  addRedactions as addRedactionsImpl, removeRedactions as removeRedactionsImpl,
} from '../addHighlights.js';
import { renderPageStatic as renderPageStaticImpl } from '../debug.js';
import { exportData as exportDataImpl, download as downloadImpl } from '../export/export.js';
import { subsetPdf, stripMetadataPdf } from '../export/pdf/subsetPdf.js';
import { defaultScrubOpts } from '../pdf/metadata/scrubMetadata.js';
import { getMetadataImpl } from '../pdf/metadata/metadataInspect.js';
import { dropFromWorkers, enableOpt as enableFontOptImpl } from '../fontContainerMain.js';
import {
  recognize as recognizeImpl,
  compareOCR as compareOCRImpl,
  recognizePageImp as recognizePageImpImpl,
  evalOCRPage as evalOCRPageImpl,
  insertParsedPage as insertParsedPageImpl,
} from '../recognizeConvert.js';
import { importFiles as importFilesImpl, importFilesSupp as importFilesSuppImpl } from '../import/import.js';
import {
  remapOutline, cloneOutline, makeOutlineNode, findOutlineEntry, isOutlineDescendant,
} from '../objects/outlineObjects.js';
import { runOptimization as runOptimizationImpl } from '../fontEval.js';
import { clonePageFull, reIdPage } from '../objects/ocrObjects.js';

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
 * Every dense per-page array that must stay index-aligned with `pageMetrics` under page delete/move.
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
 * Drop the full-resolution render caches so they re-render against the edited page order.
 * Thumbnails are deliberately not among these; page ops reorder that cache in place via `remapThumbnails` instead of re-rendering it.
 * @param {ScribeDoc} doc
 */
function clearImageCaches(doc) {
  const { images } = doc;
  images.native.length = 0;
  images.binary.length = 0;
  images.nativeProps.length = 0;
  images.binaryProps.length = 0;
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
 * Give every page a concrete `sourceId`, so a cross-document copy carries the real origin
 * (the default `null` means "this document's primary source", valid only within the source document).
 * Image-only documents have no PDF source, so nothing is materialized.
 * @param {ScribeDoc} doc
 */
function materializeSourceIds(doc) {
  const primaryId = doc.images.primarySourceId;
  if (primaryId == null) return;
  for (let i = 0; i < doc.pageMetrics.length; i++) {
    const pm = doc.pageMetrics[i];
    if (pm && pm.sourceId == null) pm.sourceId = primaryId;
  }
}

/**
 * Build an independent snapshot of every per-page array entry at index `i`, for later insertion via `insertPages`.
 * Call `materializeSourcePages(doc)` and `materializeSourceIds(doc)` first so the cloned `pageMetrics.sourcePageN`/`sourceId` are concrete.
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
  // Give each cloned page fresh word ids so the paste is a distinct instance, not an id-for-id twin of its source.
  // Otherwise highlight and selection, which are keyed on word id across the render window, would act on the copy and its source together.
  for (const p of new Set(Object.values(ocr))) if (p) reIdPage(p);
  const ocrRaw = {};
  for (const [engine, arr] of Object.entries(doc.ocrRaw)) {
    ocrRaw[engine] = Array.isArray(arr) && i < arr.length ? arr[i] : '';
  }
  const cloneAt = (arr) => (Array.isArray(arr) ? structuredClone(arr[i]) : undefined);
  const refAt = (arr) => (Array.isArray(arr) ? arr[i] : undefined);
  // Re-group the cloned highlight annotations so the copy's highlights form their own group.
  // Otherwise deleting the source's highlight (matched by group id) would also clear the copy's, and vice-versa.
  const annotations = cloneAt(doc.annotations.pages);
  if (Array.isArray(annotations)) {
    const groupIdMap = new Map();
    for (const annot of annotations) {
      if (!annot || annot.groupId == null) continue;
      if (!groupIdMap.has(annot.groupId)) groupIdMap.set(annot.groupId, getRandomAlphanum(10));
      annot.groupId = groupIdMap.get(annot.groupId);
    }
  }
  return {
    ocr,
    ocrRaw,
    pageMetrics: structuredClone(doc.pageMetrics[i]),
    layoutRegions: cloneAt(doc.layoutRegions.pages),
    layoutDataTables: cloneAt(doc.layoutDataTables.pages),
    annotations,
    vis: cloneAt(doc.vis),
    convertPageWarn: cloneAt(doc.convertPageWarn),
    pageStats: cloneAt(doc.inputData.pageStats),
    xmlMode: refAt(doc.inputData.xmlMode),
    ocrApplied: refAt(doc.inputData.ocrApplied),
    nativeSrc: refAt(doc.images.nativeSrc),
    pdfDims300: refAt(doc.images.pdfDims300),
    // The origin's render pool (shared by reference), so a page pasted into another document rasters from its true source.
    // `null` for image-source pages, whose raster rides in `nativeSrc`.
    renderSource: doc.images.sources.get(doc.pageMetrics[i].sourceId) ?? null,
  };
}

/**
 * Replace `doc.outline`'s contents in place, keeping the array reference stable
 * so UI bindings and history snapshots hold a live handle across page/outline edits.
 * @param {ScribeDoc} doc
 * @param {Array<import('../objects/outlineObjects.js').OutlineNode>} nodes
 */
function setDocOutline(doc, nodes) {
  doc.outline.length = 0;
  for (const n of nodes) doc.outline.push(n);
}

/**
 * Remap the document outline after a page-order edit.
 * Bookmarks whose page was removed are dropped, and their surviving descendants promoted.
 * @param {ScribeDoc} doc
 * @param {Array<?number>} tags - `tags[newPos]` is the pre-edit index of the page now at `newPos`, or null for a freshly inserted page.
 */
function remapOutlineByTags(doc, tags) {
  if (!doc.outline.length) return;
  const newByOld = new Map();
  tags.forEach((old, newPos) => { if (old != null && !newByOld.has(old)) newByOld.set(old, newPos); });
  setDocOutline(doc, remapOutline(doc.outline, (old) => (newByOld.has(old) ? newByOld.get(old) : null)));
}

/**
 * Reorder the retained thumbnail cache to match a page-order edit instead of dropping it:
 * a reorder leaves each thumbnail's pixels unchanged, so re-rendering would be waste.
 * @param {ScribeDoc} doc
 * @param {Array<?number>} tags - tags[newPos] is the pre-edit index of the page now at newPos, or null for a freshly inserted page.
 */
function remapThumbnails(doc, tags) {
  const { thumbnails } = doc.images;
  const remapped = tags.map((old) => (old == null ? undefined : thumbnails[old]));
  thumbnails.length = 0;
  for (const t of remapped) thumbnails.push(t);
}

/**
 * Re-align the document's FOREIGN render sources (the pools of pages copied in from other documents) with a restored page state,
 * so undo/redo of a cross-document paste tracks its source rather than leaking it.
 * A source the target references but the doc dropped is re-registered (redo of the paste).
 * A source the doc holds but the target does not is released (undo of the paste), terminating that source's worker pool once no live document still holds it.
 * The document's own primary source is never touched, since it is not part of any page op.
 * @param {ScribeDoc} doc
 * @param {?Map<number, import('./imageContainer.js').RenderSource>} target - Foreign sources captured with the snapshot.
 */
function reconcileForeignSources(doc, target) {
  if (!target) return;
  const { images } = doc;
  for (const [id, src] of target) {
    if (!images.sources.has(id)) { images.sources.set(id, src); src.refCount += 1; }
  }
  for (const [id, src] of [...images.sources]) {
    if (id === images.primarySourceId || target.has(id)) continue;
    images.sources.delete(id);
    src.refCount -= 1;
    if (src.refCount <= 0) src.terminate();
  }
}

/**
 * A before/after snapshot of every per-page array plus the outline, for undo/redo of a page operation.
 * @param {ScribeDoc} doc
 */
function capturePageState(doc) {
  const primaryId = doc.images.primarySourceId;
  return {
    arrays: densePageArrays(doc).map((arr) => [arr, arr === doc.pageMetrics ? arr.map((pm) => structuredClone(pm)) : [...arr]]),
    pageCount: doc.pageMetrics.length,
    outline: cloneOutline(doc.outline),
    // Foreign (cross-document) render sources this state references, captured so undo/redo can re-register or release them.
    // The primary source is excluded because page ops never add or remove it.
    foreignSources: new Map([...doc.images.sources].filter(([id]) => id !== primaryId)),
    // The retained thumbnail cache, so undo/redo restore its slot alignment too (no preview re-render on either).
    thumbnails: [...doc.images.thumbnails],
  };
}

/**
 * Restore a `capturePageState` snapshot, mutating each array in place so references held elsewhere stay valid.
 * @param {ScribeDoc} doc
 * @param {ReturnType<typeof capturePageState>} snap
 */
function restorePageState(doc, snap) {
  for (const [arr, values] of snap.arrays) {
    arr.length = 0;
    for (const v of values) arr.push(v);
  }
  setDocOutline(doc, cloneOutline(snap.outline));
  renumberPages(doc);
  clearImageCaches(doc);
  // Restore the retained thumbnail cache in lockstep with the page order (clearImageCaches no longer drops it).
  const { thumbnails } = doc.images;
  thumbnails.length = 0;
  for (const t of snap.thumbnails) thumbnails.push(t);
  doc.inputData.pageCount = snap.pageCount;
  doc.images.pageCount = snap.pageCount;
  reconcileForeignSources(doc, snap.foreignSources);
}

/**
 * Bounded undo/redo history for a document's PAGE operations (delete/move/reorder/insert/paste/duplicate/rotate).
 * Each recorded op captures a full before/after page-state snapshot that `undo`/`redo` restore.
 * Non-page edits (word text, style, annotations) are out of scope, since the snapshot does not capture the state they mutate.
 */
class PageHistory {
  static LIMIT = 100;

  /** @param {ScribeDoc} doc */
  constructor(doc) {
    this.doc = doc;
    /** @type {Array<{ before: object, after: object }>} */
    this.undoStack = [];
    /** @type {Array<{ before: object, after: object }>} */
    this.redoStack = [];
    // While a mutation is running (or an undo/redo is restoring), nested page ops are folded into the outer step.
    this.suspended = false;
  }

  get canUndo() { return this.undoStack.length > 0; }

  get canRedo() { return this.redoStack.length > 0; }

  /**
   * Run a page mutation `fn` and record it as one undoable step (snapshotting before and after).
   * Re-entrant: a page op invoked from within another recorded op is folded into the outer step rather than recorded separately,
   * so a composite edit (e.g. a cut = insert + delete) becomes a single undo.
   * @param {() => void} fn
   */
  record(fn) {
    if (this.suspended) { fn(); return; }
    const before = capturePageState(this.doc);
    this.suspended = true;
    try { fn(); } finally { this.suspended = false; }
    const after = capturePageState(this.doc);
    this.undoStack.push({ before, after });
    if (this.undoStack.length > PageHistory.LIMIT) this.undoStack.shift();
    this.redoStack.length = 0;
  }

  /** Undo the last recorded page operation. @returns {boolean} whether anything was undone. */
  undo() {
    const step = this.undoStack.pop();
    if (!step) return false;
    restorePageState(this.doc, step.before);
    this.redoStack.push(step);
    return true;
  }

  /** Redo the last undone page operation. @returns {boolean} whether anything was redone. */
  redo() {
    const step = this.redoStack.pop();
    if (!step) return false;
    restorePageState(this.doc, step.after);
    this.undoStack.push(step);
    return true;
  }

  clear() {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
  }
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

    /**
     * Document outline (bookmarks) as an editable tree; destinations are zero-based page indices.
     * Empty when the document has no bookmarks. Populated from the PDF on open (`ImageStore.openMainPDF`).
     * @type {Array<import('../objects/outlineObjects.js').OutlineNode>}
     */
    this.outline = [];

    /**
     * Resolves once this document's text extraction has completed.
     * Already resolved except during a `deferText` import, where extraction continues in the background after `importFiles` returns.
     * Resolves rather than rejects on `terminate()`, so waiters cannot hang on a dead worker pool.
     * @type {Promise<?Awaited<ReturnType<typeof import('../extractPDFText.js').extractInternalPDFText>>>}
     */
    this.textReady = Promise.resolve(null);

    /**
     * Settles a pending deferred `textReady`.
     * Non-null exactly while a deferred extraction is in flight, so it doubles as the "text not ready yet" test.
     * @type {?() => void}
     */
    this._textReadySettle = null;

    this.fonts = new DocFonts();
    this.fonts.id = this.id;

    this.images = new ImageStore(this);

    /** Bounded undo/redo history for this document's page operations. */
    this.history = new PageHistory(this);

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
   * Delete a layout region from the page it belongs to.
   * @param {LayoutRegion} region - Region to delete.
   */
  deleteLayoutRegion(region) {
    const n = region.page.n;
    for (const [key, value] of Object.entries(this.layoutRegions.pages[n].boxes)) {
      if (value.id === region.id) {
        delete this.layoutRegions.pages[n].boxes[key];
        break;
      }
    }
  }

  /**
   * Delete a layout data table from the page it belongs to.
   * @param {LayoutDataTable} table - Table to delete.
   */
  deleteLayoutDataTable(table) {
    const n = table.page.n;
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
    // Deferred text extraction (`importFiles` deferText) writes per-page results by import-time index,
    // so editing the page model while it is in flight corrupts the document.
    if (this._textReadySettle) { console.warn('Page edit ignored: text import is still in progress.'); return; }
    if (i < 0 || i >= this.pageMetrics.length) return;
    this.history.record(() => {
      materializeSourcePages(this);
      const tags = this.pageMetrics.map((_, k) => k);
      for (const arr of [...densePageArrays(this), tags]) if (i < arr.length) arr.splice(i, 1);
      remapOutlineByTags(this, tags);
      remapThumbnails(this, tags);
      clearImageCaches(this);
      renumberPages(this);
      this.inputData.pageCount = this.pageMetrics.length;
      this.images.pageCount = this.pageMetrics.length;
    });
  }

  /**
   * Move page `from` to index `to` (its final position in the new order) in this document's live page model.
   * @param {number} from
   * @param {number} to
   */
  movePage(from, to) {
    // See `deletePage`: no page-model restructuring while a deferred extraction is in flight.
    if (this._textReadySettle) { console.warn('Page edit ignored: text import is still in progress.'); return; }
    const len = this.pageMetrics.length;
    if (from < 0 || from >= len || to < 0 || to >= len || from === to) return;
    this.history.record(() => {
      materializeSourcePages(this);
      const tags = this.pageMetrics.map((_, k) => k);
      for (const arr of [...densePageArrays(this), tags]) {
        if (from >= arr.length) continue;
        const [item] = arr.splice(from, 1);
        arr.splice(to, 0, item);
      }
      remapOutlineByTags(this, tags);
      remapThumbnails(this, tags);
      clearImageCaches(this);
      renumberPages(this);
    });
  }

  /**
   * Delete several pages at once from this document's live page model.
   * @param {Array<number>} indices - 0-based page indices to remove.
   */
  deletePages(indices) {
    // See `deletePage`: no page-model restructuring while a deferred extraction is in flight.
    if (this._textReadySettle) { console.warn('Page edit ignored: text import is still in progress.'); return; }
    // Splice high-to-low so each removal leaves the lower indices valid.
    const sorted = [...new Set(indices)].filter((i) => i >= 0 && i < this.pageMetrics.length).sort((a, b) => b - a);
    if (sorted.length === 0) return;
    this.history.record(() => {
      materializeSourcePages(this);
      const tags = this.pageMetrics.map((_, k) => k);
      for (const arr of [...densePageArrays(this), tags]) {
        for (const i of sorted) if (i < arr.length) arr.splice(i, 1);
      }
      remapOutlineByTags(this, tags);
      remapThumbnails(this, tags);
      clearImageCaches(this);
      renumberPages(this);
      this.inputData.pageCount = this.pageMetrics.length;
      this.images.pageCount = this.pageMetrics.length;
    });
  }

  /**
   * Move several pages to a single contiguous block in this document's live page model, keeping their relative order.
   * The pages are pulled out, then re-inserted starting at `to` (an index into the array after removal).
   * @param {Array<number>} indices - 0-based page indices to move.
   * @param {number} to - Block start position in the post-removal order.
   */
  movePages(indices, to) {
    // See `deletePage`: no page-model restructuring while a deferred extraction is in flight.
    if (this._textReadySettle) { console.warn('Page edit ignored: text import is still in progress.'); return; }
    const sorted = [...new Set(indices)].filter((i) => i >= 0 && i < this.pageMetrics.length).sort((a, b) => a - b);
    if (sorted.length === 0) return;
    this.history.record(() => {
      materializeSourcePages(this);
      const tags = this.pageMetrics.map((_, k) => k);
      for (const arr of [...densePageArrays(this), tags]) {
        const pulled = [];
        for (let k = sorted.length - 1; k >= 0; k--) {
          if (sorted[k] < arr.length) pulled.unshift(arr.splice(sorted[k], 1)[0]);
        }
        arr.splice(Math.max(0, Math.min(to, arr.length)), 0, ...pulled);
      }
      remapOutlineByTags(this, tags);
      remapThumbnails(this, tags);
      clearImageCaches(this);
      renumberPages(this);
    });
  }

  /**
   * Snapshot pages `indices` into independent clone bundles for a later `insertPages` (the clipboard payload of a page copy/cut).
   * Pure: the document is not mutated apart from materializing `sourcePageN`/`sourceId`.
   * Returned bundles are fully detached, so the source pages may be edited or deleted before the bundles are pasted.
   * @param {Array<number>} indices - 0-based page indices to clone, in any order.
   * @returns {Array<object>} One clone bundle per valid index, in ascending page order.
   */
  copyPages(indices) {
    // Copying while a deferred extraction is in flight would snapshot pages without their text,
    // silently degrading a later paste. Refused (empty clipboard), consistent with `deletePage`.
    if (this._textReadySettle) { console.warn('Page copy ignored: text import is still in progress.'); return []; }
    const sorted = [...new Set(indices)].filter((i) => i >= 0 && i < this.pageMetrics.length).sort((a, b) => a - b);
    if (sorted.length === 0) return [];
    materializeSourcePages(this);
    materializeSourceIds(this);
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
    // See `deletePage`: no page-model restructuring while a deferred extraction is in flight.
    if (this._textReadySettle) { console.warn('Page edit ignored: text import is still in progress.'); return; }
    if (!Array.isArray(bundles) || bundles.length === 0) return;
    this.history.record(() => {
      const prevLen = this.pageMetrics.length;
      const at = Math.max(0, Math.min(to, prevLen));
      materializeSourcePages(this);
      // Page-identity tags: existing pages carry their old index.
      const tags = this.pageMetrics.map((_, k) => k);
      // Splice only arrays that span every existing page. A sparse/empty array would misalign if inserted into.
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
      spliceFull(tags, bundles.map(() => null));
      remapOutlineByTags(this, tags);
      remapThumbnails(this, tags);

      // Register a copied page's foreign render source so it keeps rendering and subsetting from its origin.
      for (const b of bundles) {
        const src = b.renderSource;
        if (src && !this.images.sources.has(src.id)) {
          this.images.sources.set(src.id, src);
          src.refCount += 1;
        }
      }

      clearImageCaches(this);
      renumberPages(this);
      this.inputData.pageCount = this.pageMetrics.length;
      this.images.pageCount = this.pageMetrics.length;
    });
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
   * Rotate pages `indices` by `deltaDeg` (a multiple of 90), composed onto each page's existing rotation.
   * Recorded as one undoable step. Rebuilding the display is the caller's responsibility.
   * @param {Array<number>} indices - 0-based page indices.
   * @param {number} deltaDeg - Clockwise degrees to add (e.g. 90, -90, 180).
   * @returns {boolean} Whether any page was rotated (so a caller can skip a redundant rebuild).
   */
  rotatePages(indices, deltaDeg) {
    const targets = [...new Set(indices)].filter((n) => this.pageMetrics[n]);
    if (targets.length === 0) return false;
    this.history.record(() => {
      for (const n of targets) {
        const pm = this.pageMetrics[n];
        pm.rotation = ((((pm.rotation || 0) + deltaDeg) % 360) + 360) % 360;
      }
    });
    return true;
  }

  /**
   * Add a bookmark to the document outline, recorded as one undoable step.
   * @param {{ title?: string, pageIndex?: ?number, parentId?: ?number, atIndex?: ?number }} [spec]
   *   `pageIndex` null makes a title-only (structural) node; `parentId` null adds at the top level;
   *   `atIndex` null appends.
   * @returns {number} The new node's id.
   */
  addBookmark({
    title = '', pageIndex = null, parentId = null, atIndex = null,
  } = {}) {
    const node = makeOutlineNode({ title, dest: pageIndex == null ? null : { pageIndex, view: ['Fit'] } });
    this.history.record(() => {
      const siblings = parentId == null ? this.outline : (findOutlineEntry(this.outline, parentId)?.node.children ?? this.outline);
      const at = atIndex == null ? siblings.length : Math.max(0, Math.min(atIndex, siblings.length));
      siblings.splice(at, 0, node);
    });
    return node.id;
  }

  /**
   * Rename a bookmark. Recorded as one undoable step. No-op if `id` is unknown.
   * @param {number} id
   * @param {string} title
   */
  renameBookmark(id, title) {
    if (!findOutlineEntry(this.outline, id)) return;
    this.history.record(() => { findOutlineEntry(this.outline, id).node.title = title; });
  }

  /**
   * Point a bookmark at a different page (or make it title-only with `null`). Recorded. No-op if `id` is unknown.
   * @param {number} id
   * @param {?number} pageIndex
   */
  setBookmarkDest(id, pageIndex) {
    if (!findOutlineEntry(this.outline, id)) return;
    this.history.record(() => {
      findOutlineEntry(this.outline, id).node.dest = pageIndex == null ? null : { pageIndex, view: ['Fit'] };
    });
  }

  /**
   * Reparent/reorder a bookmark: detach it and insert under `parentId` (null = top level) at `atIndex` (null = append).
   * Recorded as one undoable step.
   * No-op if `id` is unknown or the move would nest the node inside its own subtree.
   * @param {number} id
   * @param {?number} parentId
   * @param {?number} atIndex
   */
  moveBookmark(id, parentId = null, atIndex = null) {
    const entry = findOutlineEntry(this.outline, id);
    if (!entry) return;
    if (parentId != null && isOutlineDescendant(entry.node, parentId)) return;
    this.history.record(() => {
      const e = findOutlineEntry(this.outline, id);
      e.siblings.splice(e.index, 1);
      const siblings = parentId == null ? this.outline : (findOutlineEntry(this.outline, parentId)?.node.children ?? this.outline);
      const at = atIndex == null ? siblings.length : Math.max(0, Math.min(atIndex, siblings.length));
      siblings.splice(at, 0, e.node);
    });
  }

  /**
   * Remove bookmarks by id (each with its whole subtree). Recorded as one undoable step.
   * @param {Array<number>} ids
   */
  removeBookmarks(ids) {
    if (!ids.some((id) => findOutlineEntry(this.outline, id))) return;
    this.history.record(() => {
      for (const id of ids) {
        const e = findOutlineEntry(this.outline, id);
        if (e) e.siblings.splice(e.index, 1);
      }
    });
  }

  /**
   * Undo the last page/outline operation (delete/move/reorder/insert/paste/duplicate/rotate/bookmark edit).
   * @returns {boolean} Whether anything was undone (so a caller can skip a redundant rebuild).
   */
  undo() { return this.history.undo(); }

  /**
   * Redo the last undone page operation.
   * @returns {boolean} Whether anything was redone.
   */
  redo() { return this.history.redo(); }

  /** Whether there is a page operation available to undo. */
  get canUndo() { return this.history.canUndo; }

  /** Whether there is an undone page operation available to redo. */
  get canRedo() { return this.history.canRedo; }

  /**
   * Reset all of this document's data.
   * The document's own PDF pool is cleared but not terminated (see `terminate`).
   */
  clear() {
    // Settle any pending deferred extraction so its waiters resolve rather than hang.
    this._textReadySettle?.();
    this._textReadySettle = null;
    this.textReady = Promise.resolve(null);
    this.inputData.clear();
    clearObjectProperties(this.ocr);
    this.ocr.active = [];
    clearObjectProperties(this.ocrRaw);
    this.ocrRaw.active = [];
    this.annotations.pages.length = 0;
    this.layoutRegions.pages.length = 0;
    this.layoutDataTables.pages.length = 0;
    this.pageMetrics.length = 0;
    this.outline.length = 0;
    this.convertPageWarn.length = 0;
    this.images.clear();
    this.fonts.clear();
    this.history.clear();
  }

  /**
   * Release this document's resources: terminate its PDF worker pool, clear its image cache, and
   * drop this document's optimized fonts from the main thread and the shared general-pool workers.
   * Does not touch the shared general/OCR pool or the process-wide built-in fonts.
   */
  async terminate() {
    // In-flight extraction jobs die with the worker pool below and never settle `textReady`, so settle it now to let waiters proceed rather than hang.
    this._textReadySettle?.();
    this._textReadySettle = null;
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
   * Add freestanding /Text annotations at fixed page positions.
   * @param {Parameters<typeof addTextAnnotsImpl>[1]} textAnnots
   * @returns {ReturnType<typeof addTextAnnotsImpl>}
   */
  addTextAnnots(textAnnots) {
    return addTextAnnotsImpl(this, textAnnots);
  }

  /**
   * Remove all freestanding /Text annotations previously added by `addTextAnnots`.
   */
  clearTextAnnots() {
    clearTextAnnotsImpl(this);
  }

  /**
   * Add redaction marks.
   * Marks stay reviewable/deletable (and persist in `.scribe` saves); every other export applies them by permanently removing the marked content.
   * @param {Parameters<typeof addRedactionsImpl>[1]} redactions
   * @returns {ReturnType<typeof addRedactionsImpl>}
   */
  addRedactions(redactions) {
    return addRedactionsImpl(this, redactions);
  }

  /**
   * Remove redaction marks (all of them, or one page's, or one group's).
   * @param {Parameters<typeof removeRedactionsImpl>[1]} [filter]
   */
  removeRedactions(filter) {
    removeRedactionsImpl(this, filter);
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

  /**
   * List the identifying-metadata categories present in this document's PDF source(s).
   * Returns null for an image-only document (no PDF source).
   * @returns {ReturnType<typeof getMetadataImpl>}
   */
  getMetadata() {
    return getMetadataImpl(this);
  }

  /**
   * Produce a privacy-cleaned copy of this document's PDF with identifying metadata removed.
   * The visible pages stay byte-faithful to the source, honoring page reorder/delete.
   * Removed: `/Info`, XMP, `/PieceInfo`, embedded files, image EXIF/GPS, actions/JavaScript, prior revisions, signatures, and filename-leaking layer names.
   * Accessibility tags, page labels, language, and viewer preferences are kept by default.
   * Emits `warningHandler` if a digital signature had to be dropped.
   * @param {object} [options] - Overrides the Balanced scrub defaults (`stripStructTree`, `stripPageLabels`, `stripViewerPrefs`, `dropOCProperties`); see `defaultScrubOpts`.
   * @returns {Promise<Uint8Array>}
   */
  async stripMetadata(options = {}) {
    const { images } = this;
    if (!images || !images.pdfData) {
      throw new Error('stripMetadata requires a document with a PDF source (image-only imports carry no PDF metadata).');
    }
    const warningHandler = (/** @type {string} */ message) => this.warningHandler({ message });

    const primaryId = images.primarySourceId;
    const pageCount = this.inputData?.pageCount ?? 0;
    const sourceArr = [];
    let multiSource = false;
    let edited = false;
    for (let p = 0; p < pageCount; p++) {
      const pm = this.pageMetrics?.[p];
      const src = pm?.sourcePageN ?? p;
      if (src !== p) edited = true;
      if ((pm?.sourceId ?? primaryId) !== primaryId) multiSource = true;
      sourceArr.push(src);
    }
    if (multiSource) {
      throw new Error('stripMetadata does not yet support documents assembled from multiple PDF sources '
        + '(cross-document page copy); export the document to a single PDF first, then strip its metadata.');
    }

    // stripMetadataPdf enumerates every source page, so an unedited document cleans in full even when its in-memory page metrics are incomplete.
    if (!edited) return stripMetadataPdf(images.pdfData, options, warningHandler);

    // Page reorder/delete: subset the source to the current display order, scrubbing as it rebuilds.
    const scrub = { opts: { ...defaultScrubOpts(), ...options } };
    const out = await subsetPdf(images.pdfData, sourceArr, { scrub, warningHandler });
    return out instanceof Uint8Array ? out : new Uint8Array(out);
  }
}
