import { InputData, opt } from './app.js';
import { DocFonts } from './fontContainer.js';
import { ImageStore } from './imageContainer.js';
import { scribeDocDefaults } from './scribeDocDefaults.js';
import { clearObjectProperties } from '../utils/miscUtils.js';
import { addHighlights as addHighlightsImpl, addFreeText as addFreeTextImpl, clearHighlights as clearHighlightsImpl } from '../addHighlights.js';
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
