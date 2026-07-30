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

  /** @type {?import('./parsePdfDoc.js').LinkDestInfo} */
  #linkDestInfo = null;

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
    // Shared across parsePage calls so the lazily-built named-destination map is walked at most once per document.
    this.#linkDestInfo = { objNumToIndex: new Map(this.#pages.map((p, i) => [p.objNum, i])), pages: this.#pages, nameDests: null };
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
    return parseSinglePage(this.#pages[pageIndex], this.#objCache, pageIndex, dpi, undefined, this.#linkDestInfo ?? undefined);
  }

  /**
   * Render a single page to an image data URL, a JPEG blob, or a transferable ImageBitmap.
   * @param {{ pageIndex: number, colorMode: string, dpi?: number, targetWidth?: number,
   * outputFormat?: 'png'|'jpeg'|'bitmap', quality?: number,
   * textEdits?: ?{records: Array<TextEdit>, dims: {width: number, height: number}} }} args - `targetWidth` renders the page exactly that many pixels wide, taking precedence over `dpi`.
   * @returns {Promise<{ dataUrl?: string, blob?: Blob, bitmap?: ImageBitmap, colorMode: string, ok: boolean, failReason?: string, failDetail?: string,
   *   perf?: { prepMs: number, drawMs: number, decodeMs: number, flushMs: number } }>}
   */
  async renderPage({
    pageIndex, colorMode, dpi, targetWidth, outputFormat = 'png', quality = 0.6, textEdits = null,
  }) {
    if (!this.#objCache || !this.#pages) throw new Error('PDF not loaded');
    // Lazy import so the renderer stays out of main-thread bundles that never render in-process.
    const { renderPdfPageAsImage } = await import('./renderPdfPage.js');
    if (typeof process !== 'undefined') await ca.getCanvasNode();
    const page = this.#pages[pageIndex];
    const box = page.cropBox || page.mediaBox;
    if (targetWidth) {
      // Deriving dpi from the same box/rotate floats renderPdfPageAsImage sizes its canvas from is what makes its ceil land on exactly `targetWidth`.
      const widthPts = Math.abs(box[2] - box[0]);
      const heightPts = Math.abs(box[3] - box[1]);
      const visualWidthPts = page.rotate === 90 || page.rotate === 270 ? heightPts : widthPts;
      dpi = (72 * targetWidth) / visualWidthPts;
    }
    return renderPdfPageAsImage(page.objText, this.#objCache, box, pageIndex, colorMode, page.rotate, dpi, outputFormat, quality, textEdits);
  }

  /**
   * The font program the renderer draws the given embedded font with, plus the cascade inputs native-text editing needs.
   * @param {{ fontObjNum: number, pageIndex?: number }} args - `pageIndex` is a page the font is used on, letting this instance resolve a font from a page it never parsed.
   * @returns {Promise<?{ kind: 'original'|'rebuilt'|'none', bytes?: ArrayBuffer, allGlyphsEmpty?: boolean,
   *   baseName: string, familyName: string, bold: boolean, italic: boolean, serifFlag: boolean|null,
   *   italicAngleDeg: ?number, capHeightPdf: ?number, xHeightPdf: ?number, stemV: ?number }>}
   *   `kind: 'none'` means the font has no usable embedded program, so editing must fall back the same way the renderer did.
   *   Null means the `fontObjNum` is unknown.
   */
  async getFontBytes({ fontObjNum, pageIndex }) {
    if (!this.#objCache) throw new Error('PDF not loaded');
    let fontObj = this.#objCache.fontCache.get(fontObjNum);
    if (!fontObj && pageIndex !== undefined && this.#pages?.[pageIndex]) {
      this.parsePage({ pageIndex, dpi: 300 });
      fontObj = this.#objCache.fontCache.get(fontObjNum);
    }
    if (!fontObj) return null;
    if (!this.#objCache.fontBytesCache.has(fontObjNum) && !this.#objCache.fontConversionCache.has(fontObjNum)) {
      const { registerFontForEditing } = await import('./renderPdfPage.js');
      if (typeof process !== 'undefined') await ca.getCanvasNode();
      await registerFontForEditing(fontObj, this.#objCache);
    }
    const meta = {
      baseName: fontObj.baseName,
      familyName: fontObj.familyName,
      bold: !!fontObj.bold,
      italic: !!fontObj.italic,
      serifFlag: fontObj.serifFlag ?? null,
      italicAngleDeg: fontObj.italicAngleDeg ?? null,
      capHeightPdf: fontObj.capHeightPdf ?? null,
      xHeightPdf: fontObj.xHeightPdf ?? null,
      stemV: fontObj.stemV ?? null,
    };
    const entry = this.#objCache.fontBytesCache.get(fontObjNum);
    if (!entry) return { kind: 'none', ...meta };
    const allGlyphsEmpty = !!(fontObj.allGlyphsEmpty
      || this.#objCache.fontConversionCache.get(fontObjNum)?.allGlyphsEmpty);
    // Copied so the postMessage transfer can never detach the cached buffer.
    return {
      kind: entry.kind, bytes: entry.bytes.slice(0), allGlyphsEmpty, ...meta,
    };
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
    this.#linkDestInfo = null;
  }
}
