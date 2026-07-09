import { ca } from '../canvasAdapter.js';
import { unregisterFontFacesMatching } from '../containers/fontContainer.js';
import { ObjectCache } from './objectCache.js';
import { parseOutline } from './parseOutline.js';
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
      // Document outline (bookmarks), page-index-normalized; serializable across the worker boundary.
      outline: parseOutline(this.#objCache, this.#pages),
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
   * Render a single page to an image data URL, a JPEG blob, or a transferable ImageBitmap.
   * @param {{ pageIndex: number, colorMode: string, dpi?: number, outputFormat?: 'png'|'jpeg'|'bitmap', quality?: number }} args
   * @returns {Promise<{ dataUrl?: string, blob?: Blob, bitmap?: ImageBitmap, colorMode: string, ok: boolean, failReason?: string, failDetail?: string,
   *   perf?: { prepMs: number, drawMs: number, decodeMs: number, flushMs: number } }>}
   */
  async renderPage({
    pageIndex, colorMode, dpi, outputFormat = 'png', quality = 0.6,
  }) {
    if (!this.#objCache || !this.#pages) throw new Error('PDF not loaded');
    // Lazy import so the renderer stays out of main-thread bundles that never render in-process.
    const { renderPdfPageAsImage } = await import('./renderPdfPage.js');
    if (typeof process !== 'undefined') await ca.getCanvasNode();
    const page = this.#pages[pageIndex];
    return renderPdfPageAsImage(page.objText, this.#objCache, page.cropBox || page.mediaBox, pageIndex, colorMode, page.rotate, dpi, outputFormat, quality);
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
    // Free decoded-image bitmaps retained for the document's lifetime.
    const imgCache = this.#objCache.decodedImageCache;
    if (imgCache) {
      for (const entry of imgCache.values()) ca.closeDrawable(entry.bitmap);
      imgCache.clear();
      this.#objCache.decodedImageCacheBytes = 0;
    }
    this.#objCache = null;
    this.#pages = null;
  }
}
