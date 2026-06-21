import { ca } from '../canvasAdapter.js';
import { unregisterFontFacesMatching } from '../containers/fontContainer.js';
import { ObjectCache } from './objectCache.js';
import { parseSinglePage } from './parsePdfDoc.js';
import { findXrefOffset, getPageObjects, parseXref } from './parsePdfUtils.js';

/**
 * One loaded PDF and the page operations over it (parse, render).
 * Shared by the worker shell (js/worker/pdfWorker.js) and the in-process
 * scheduler (PdfSchedulerInProcess in js/pdfWorkerMain.js); each owns one instance.
 */
export class PdfCore {
  /** @type {?ObjectCache} */
  #objCache = null;

  /** @type {?ReturnType<typeof getPageObjects>} */
  #pages = null;

  /**
   * Load PDF bytes and parse the document structure.
   * @param {Uint8Array | ArrayBuffer} pdfBytes
   */
  async load(pdfBytes) {
    await this.unload();
    const arr = pdfBytes instanceof Uint8Array ? pdfBytes : new Uint8Array(pdfBytes);
    const xrefOffset = findXrefOffset(arr);
    const xrefEntries = parseXref(arr, xrefOffset);
    this.#objCache = new ObjectCache(arr, xrefEntries);
    this.#pages = getPageObjects(this.#objCache);
    return {
      pageCount: this.#pages.length,
      pages: this.#pages.map((p) => ({ mediaBox: p.cropBox || p.mediaBox, rotate: p.rotate })),
    };
  }

  /**
   * Parse a single page for text extraction + type-detection scoring.
   * @param {{ pageIndex: number, dpi: number }} args
   */
  parsePage({ pageIndex, dpi }) {
    if (!this.#objCache || !this.#pages) throw new Error('PDF not loaded');
    return parseSinglePage(this.#pages[pageIndex], this.#objCache, pageIndex, dpi);
  }

  /**
   * Render a single page to a PNG data URL.
   * @param {{ pageIndex: number, colorMode: string, dpi?: number }} args
   */
  async renderPage({ pageIndex, colorMode, dpi }) {
    if (!this.#objCache || !this.#pages) throw new Error('PDF not loaded');
    // Lazy import so the renderer stays out of main-thread bundles that never render in-process.
    const { renderPdfPageAsImage } = await import('./renderPdfPage.js');
    if (typeof process !== 'undefined') await ca.getCanvasNode();
    const page = this.#pages[pageIndex];
    return renderPdfPageAsImage(page.objText, this.#objCache, page.cropBox || page.mediaBox, pageIndex, colorMode, page.rotate, dpi);
  }

  /**
   * Release `_pdf_d${docId}_*` fonts (Node + browser registries) and clear the parsed document state.
   */
  async unload() {
    if (!this.#objCache) return;
    const { docId } = this.#objCache;
    const prefix = `_pdf_d${docId}_`;
    ca.unregisterFontsMatching((name) => name.startsWith(prefix));
    unregisterFontFacesMatching((family) => family.startsWith(prefix));
    this.#objCache = null;
    this.#pages = null;
  }
}
