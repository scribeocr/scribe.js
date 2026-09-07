import { ca } from '../canvasAdapter.js';
import { unregisterFontFacesMatching } from '../containers/fontContainer.js';
import { ObjectCache } from './objectCache.js';
import { buildType3OpentypeFont } from './fonts/parsePdfFonts.js';
import { parseAttachments } from './parseAttachments.js';
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
      // Embedded files and the portfolio collection, a name-tree walk with no stream decoded.
      attachments: parseAttachments(this.#objCache),
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
   * Render a single page to an image data URL, a JPEG/WebP blob, or a transferable ImageBitmap.
   * @param {{ pageIndex: number, colorMode: string, dpi?: number, targetWidth?: number,
   * outputFormat?: 'png'|'jpeg'|'webp'|'bitmap', quality?: number,
   * edits?: ?{records: Array<ContentEdit>, dims: {width: number, height: number}} }} args - `targetWidth` renders the page exactly that many pixels wide, taking precedence over `dpi`.
   * @returns {Promise<{ dataUrl?: string, blob?: Blob, bitmap?: ImageBitmap, colorMode: string, ok: boolean, failReason?: string, failDetail?: string,
   *   perf?: { prepMs: number, drawMs: number, decodeMs: number, flushMs: number } }>}
   */
  async renderPage({
    pageIndex, colorMode, dpi, targetWidth, outputFormat = 'png', quality = 0.6, edits = null,
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
    return renderPdfPageAsImage(page.objText, this.#objCache, box, pageIndex, colorMode, page.rotate, dpi, outputFormat, quality, edits);
  }

  /**
   * The font program the renderer draws the given embedded font with, plus the cascade inputs native-text editing needs.
   * @param {{ fontObjNum: number, pageIndex?: number }} args - `pageIndex` is a page the font is used on, letting this instance resolve a font from a page it never parsed.
   * @returns {Promise<?{ kind: 'original'|'rebuilt'|'type3'|'none', bytes?: ArrayBuffer, allGlyphsEmpty?: boolean,
   *   glyphs?: Array<{ name: string, codes: number[], text: ?string, pathHash: ?string, hasOutline: boolean }>,
   *   baseName: string, familyName: string, bold: boolean, italic: boolean, serifFlag: boolean|null,
   *   italicAngleDeg: ?number, capHeightPdf: ?number, xHeightPdf: ?number, stemV: ?number }>}
   *   `kind: 'none'` means the font has no usable embedded program, so editing must fall back the same way the renderer did.
   *   `kind: 'type3'` is a program built from a Type 3 font's CharProcs, which the Inspect panel draws with but edited text does not.
   *   `glyphs` names each CharProc with the codes that reach it and the text they extract as.
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
    // The program's glyphs answer to the text the parser gave each code, so the words it extracted draw in the font's own glyphs.
    // That text is often a private-use placeholder rather than a real character.
    if (fontObj.type3 && !this.#objCache.fontBytesCache.has(fontObjNum)) {
      const t3 = fontObj.type3;
      const overrides = new Map();
      const table = [];
      const taken = new Set();
      for (const name of Object.keys(t3.charProcObjNums)) {
        const info = t3.glyphs[name];
        const hasOutline = !!(info && info.commands && info.commands.some((c) => c.type === 'L' || c.type === 'C'));
        const codes = Object.entries(t3.encoding).filter(([, n]) => n === name).map(([c]) => Number(c)).sort((a, b) => a - b);
        const unicodes = [];
        for (const code of codes) {
          const text = fontObj.toUnicode.get(code);
          if (!text || [...text].length !== 1) continue;
          const cp = /** @type {number} */ (text.codePointAt(0));
          if (taken.has(cp)) continue;
          taken.add(cp);
          unicodes.push(cp);
        }
        // A placeholder d1 carries no usable advance, so the glyph's own ink sets the width instead.
        const advanceWidth = info && info.placeholderD1 && info.bbox && info.bbox.x1 > 0 ? info.bbox.x1 + Math.max(0, info.bbox.x0) : (info ? info.advanceWidth : 0);
        overrides.set(name, { unicodes, advanceWidth });
        table.push({
          name, codes, text: codes.length ? (fontObj.toUnicode.get(codes[0]) ?? null) : null, pathHash: (info && info.pathHash) || null, hasOutline,
        });
      }
      const objText = this.#objCache.getObjectText(fontObjNum);
      const built = objText && table.some((g) => g.hasOutline) ? buildType3OpentypeFont(objText, this.#objCache, overrides) : null;
      if (built) {
        const file = built.fontFile;
        this.#objCache.fontBytesCache.set(fontObjNum, { bytes: file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength), kind: 'type3', glyphs: table });
      }
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
      kind: entry.kind, bytes: entry.bytes.slice(0), allGlyphsEmpty, ...meta, ...(entry.glyphs ? { glyphs: entry.glyphs } : {}),
    };
  }

  /**
   * The decoded bytes of an embedded file stream (a portfolio member or a plain attachment), by the object number `doc.attachments.files[].objNum` carries.
   * @param {{ objNum: number }} args
   * @returns {?{ bytes: ArrayBuffer }} A fresh buffer, so the postMessage transfer can never detach cached data.
   *   Null when the object is not a readable stream.
   */
  getEmbeddedFileBytes({ objNum }) {
    if (!this.#objCache) throw new Error('PDF not loaded');
    const bytes = this.#objCache.getStreamBytes(objNum);
    if (!bytes) return null;
    return { bytes: bytes.slice().buffer };
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
