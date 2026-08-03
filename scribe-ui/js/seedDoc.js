// A provisional document the viewer can display before the real document exists.
import { SKIPPED } from '../../tess/TessScheduler.js';
import { DocFonts } from '../../js/containers/fontContainer.js';
import { OcrPage, OcrLine, OcrWord } from '../../js/objects/ocrObjects.js';
import {
  addInk as addInkImpl, addStamp as addStampImpl, addFillText as addFillTextImpl, syncFillText as syncFillTextImpl,
} from '../../js/fillSign.js';

/**
 * @typedef {Object} ProvisionalSeed
 * @property {number} pageCount
 * @property {Array<{width: number, height: number, rotation?: number}>} pageDims - One entry per page, in the point units the page's OCR bboxes use.
 * @property {number} [initialPage=0]
 * @property {{from: number, to: number}} window - Pages with assets, inclusive on both ends.
 * @property {(n: number, targetWidth: number) => Promise<?Blob|ImageBitmap|string>} raster - Pre-rendered page image.
 *   A string return is a URL the browser can fetch.
 *   A null resolution leaves the page a pending placeholder until hydration.
 * @property {(n: number) => Promise<?Object>} [ocr] - Word geometry for a page, at minimum `{dims, lines: [{words: [{text, bbox}]}]}`.
 *   Providing it makes that page's text selectable, copyable, and findable.
 * @property {(n: number) => Promise<?Array<Object>>} [annots] - The page's existing annotations.
 *   A page that resolves, even to `[]`, replaces the real document's page at the swap, so removals count.
 *   Pages that do not resolve append their session additions instead.
 * @property {(n: number) => Promise<?string>} [thumb]
 * @property {() => Promise<Array<File>|Object>} load - Hydration source, either files for `scribe.openDocument` or an already-imported ScribeDoc.
 * @property {'eager'|'on-demand'} [hydration='eager']
 * @property {string} [name] - Display name for the tab and the download basename.
 */

let seedDocIdNext = -1;

export class SeedDoc {
  /** @param {ProvisionalSeed} seed */
  constructor(seed) {
    if (!seed || !Number.isInteger(seed.pageCount) || seed.pageCount < 1) throw new Error('openProvisional: pageCount must be a positive integer.');
    if (!Array.isArray(seed.pageDims) || seed.pageDims.length !== seed.pageCount) throw new Error('openProvisional: pageDims must have one entry per page.');
    if (!seed.window || seed.window.from < 0 || seed.window.to >= seed.pageCount || seed.window.from > seed.window.to) {
      throw new Error('openProvisional: window must be an inclusive in-range page span.');
    }
    if (typeof seed.raster !== 'function' || typeof seed.load !== 'function') throw new Error('openProvisional: raster and load are required functions.');

    // Real ScribeDoc ids count upward, so negative ids can never collide.
    this.id = seedDocIdNext--;
    this.seed = seed;
    this.pageMetrics = seed.pageDims.map((d) => ({
      dims: { width: d.width, height: d.height }, angle: 0, rotation: d.rotation || 0, sourcePageN: null, sourceId: null,
    }));
    this.inputData = {
      pageCount: seed.pageCount,
      xmlMode: [],
      pdfMode: true,
      imageMode: false,
      evalMode: false,
      pdfType: 'text',
      pageStats: null,
      requiresOCR: false,
      defaultDownloadFileName: seed.name || 'document.pdf',
    };
    // Sparse, but `.length` must equal pageCount for the viewer's neighbor-page look-aheads.
    this.ocr = { active: new Array(seed.pageCount) };
    this.annotations = { pages: Array.from({ length: seed.pageCount }, () => []) };
    /** @type {Set<number>} Pages whose baseline annotations came from `seed.annots`. */
    this._annotBaseline = new Set();
    this.outline = [];
    this.fonts = new DocFonts();
    /** @type {?(msg: Object) => void} */
    this.progressHandler = null;
    this.history = {
      undoStack: [], redoStack: [], canUndo: false, canRedo: false, undo() {}, redo() {}, record: (fn) => fn(),
    };

    // While `_textReadySettle` is truthy the viewer treats the document as still loading, so search waits on `textReady` and Recognize stays hidden.
    /** @type {?() => void} */
    this._textReadySettle = null;
    /** @type {Promise<void>} */
    this.textReady = new Promise((resolve) => { this._textReadySettle = resolve; });

    this._cancelled = false;
    /** @type {?() => Promise<Object>} Starts hydration and resolves with the real document. */
    this._requestHydration = null;
    /** @type {Map<number, Promise<?Blob>>} */
    this._blobs = new Map();
    /** @type {Map<number, Promise<?string>>} */
    this._thumbs = new Map();
    /** @type {Array<string>} Object URLs this doc created. */
    this._urls = [];

    const inWindow = (n) => n >= seed.window.from && n <= seed.window.to && !this._cancelled;
    // The image cache closes the bitmaps it is served, so the blob is what gets cached here and every request decodes a fresh bitmap from it.
    const rasterBlob = (n, targetWidth) => {
      let p = this._blobs.get(n);
      if (p) return p;
      p = Promise.resolve(seed.raster(n, targetWidth)).then(async (r) => {
        if (this._cancelled || !r) return null;
        if (r instanceof Blob) return r;
        if (typeof ImageBitmap !== 'undefined' && r instanceof ImageBitmap) {
          const canvas = new OffscreenCanvas(r.width, r.height);
          /** @type {OffscreenCanvasRenderingContext2D} */ (canvas.getContext('2d')).drawImage(r, 0, 0);
          r.close();
          return canvas.convertToBlob({ type: 'image/png' });
        }
        return (await fetch(/** @type {string} */ (r))).blob();
      }).catch(() => null);
      this._blobs.set(n, p);
      return p;
    };
    const rasterWrapper = async (n, targetWidth) => {
      if (!inWindow(n)) return SKIPPED;
      const blob = await rasterBlob(n, targetWidth);
      if (!blob || this._cancelled) return SKIPPED;
      // Decoded here rather than handed off as `src`, because the cache's re-decode path base64-decodes the string and hosts hand us Blobs or fetchable URLs.
      const bitmap = await createImageBitmap(blob).catch(() => null);
      if (!bitmap || this._cancelled) return SKIPPED;
      return {
        imageBitmap: bitmap, src: null, rotated: false, upscaled: false, colorMode: 'color',
      };
    };

    /** The ImageStore surface the viewer consumes. */
    this.images = {
      inputModes: { pdf: true, image: false },
      native: [],
      binary: [],
      pageCount: seed.pageCount,
      loadCount: seed.pageCount,
      // Empty because a seed has no worker pools, but the tab resource policy still iterates it.
      sources: new Map(),
      // Always expensive, so the cache reuses the fixed-width seed raster across zoom changes instead of re-requesting a width this doc cannot render.
      isRenderExpensive: () => true,
      releaseBitmapCache: () => {},
      renderViewerRaster: (n, targetWidth) => rasterWrapper(n, targetWidth),
      getNative: (n) => rasterWrapper(n, 0),
      getBinary: (n) => rasterWrapper(n, 0),
      renderThumbnail: async () => null,
      thumbnailUrl: (n) => {
        if (!inWindow(n) || !seed.thumb) return Promise.resolve(null);
        let p = this._thumbs.get(n);
        if (p) return p;
        p = Promise.resolve(seed.thumb(n)).then((t) => {
          if (this._cancelled || !t) return null;
          if (t instanceof Blob) {
            const url = URL.createObjectURL(t);
            this._urls.push(url);
            return url;
          }
          return t;
        }).catch(() => null);
        this._thumbs.set(n, p);
        return p;
      },
      clear: () => {},
      terminate: async () => {},
    };
  }

  /**
   * Fetch the window's word geometry and annotations.
   * @returns {Promise<void>}
   */
  async prime() {
    const jobs = [];
    if (this.seed.annots) {
      for (let n = this.seed.window.from; n <= this.seed.window.to; n++) {
        jobs.push(Promise.resolve(/** @type {NonNullable<typeof this.seed.annots>} */ (this.seed.annots)(n)).then((annots) => {
          if (this._cancelled || !Array.isArray(annots)) return;
          this.annotations.pages[n] = annots;
          this._annotBaseline.add(n);
        }).catch(() => { /* Without a baseline the page appends at the swap instead. */ }));
      }
    }
    if (!this.seed.ocr) {
      await Promise.all(jobs);
      return;
    }
    for (let n = this.seed.window.from; n <= this.seed.window.to; n++) {
      jobs.push(Promise.resolve(this.seed.ocr(n)).then((pageLike) => {
        if (this._cancelled || !pageLike || !Array.isArray(pageLike.lines)) return;
        const dims = pageLike.dims || this.pageMetrics[n].dims;
        const page = new OcrPage(n, { width: dims.width, height: dims.height });
        page.angle = pageLike.angle || 0;
        for (const lineLike of pageLike.lines) {
          const words = Array.isArray(lineLike.words) ? lineLike.words.filter((w) => w && w.text && w.bbox) : [];
          if (!words.length) continue;
          const lineBbox = lineLike.bbox || {
            left: Math.min(...words.map((w) => w.bbox.left)),
            top: Math.min(...words.map((w) => w.bbox.top)),
            right: Math.max(...words.map((w) => w.bbox.right)),
            bottom: Math.max(...words.map((w) => w.bbox.bottom)),
          };
          const line = new OcrLine(page, lineBbox, lineLike.baseline || [0, 0], lineLike.ascHeight ?? null, lineLike.xHeight ?? null);
          for (const w of words) {
            const word = new OcrWord(line, w.id || `seed-${n}-${page.lines.length}-${line.words.length}`, w.text, w.bbox);
            if (w.style) Object.assign(word.style, w.style);
            if (w.lang) word.lang = w.lang;
            word.conf = w.conf ?? 100;
            if (w.visualCoords === false) word.visualCoords = false;
            if (Array.isArray(w.chars)) word.chars = w.chars;
            line.words.push(word);
          }
          page.lines.push(line);
        }
        this.ocr.active[n] = page;
        this.inputData.xmlMode[n] = true;
      }).catch(() => { /* Without geometry the page still renders, just without selectable text. */ }));
    }
    await Promise.all(jobs);
  }

  async exportData(...args) {
    if (!this._requestHydration) throw new Error('This document is still loading.');
    const real = await this._requestHydration();
    return real.exportData(...args);
  }

  async download(...args) {
    if (!this._requestHydration) throw new Error('This document is still loading.');
    const real = await this._requestHydration();
    return real.download(...args);
  }

  // These verbs only write `annotations.pages`, which merges into the real document at the swap, so they run locally instead of hydrating.

  /** @param {number} n @param {Parameters<typeof addInkImpl>[2]} item */
  addInk(n, item) {
    return addInkImpl(/** @type {any} */ (this), n, item);
  }

  /** @param {number} n @param {Parameters<typeof addStampImpl>[2]} item */
  addStamp(n, item) {
    return addStampImpl(/** @type {any} */ (this), n, item);
  }

  /** @param {number} n @param {Parameters<typeof addFillTextImpl>[2]} item */
  addFillText(n, item) {
    return addFillTextImpl(/** @type {any} */ (this), n, item);
  }

  /** @param {number} n @param {Parameters<typeof syncFillTextImpl>[2]} row @param {Parameters<typeof syncFillTextImpl>[3]} [prevBbox] */
  syncFillText(n, row, prevBbox) {
    return syncFillTextImpl(/** @type {any} */ (this), n, row, prevBbox);
  }

  // Synchronous, unlike the hydrating verbs, because the viewer branches on the returned boolean.
  // eslint-disable-next-line class-methods-use-this
  undo() {
    return false;
  }

  // eslint-disable-next-line class-methods-use-this
  redo() {
    return false;
  }

  async close() {
    this._cancelled = true;
    this._onClose?.();
    if (this._textReadySettle) {
      this._textReadySettle();
      this._textReadySettle = null;
    }
    for (const url of this._urls) URL.revokeObjectURL(url);
    this._urls.length = 0;
    this._blobs.clear();
    this._thumbs.clear();
  }
}

// An edit on a provisional document triggers the load it needs, so these return a promise where the real document's verbs are synchronous.
for (const name of [
  'addHighlights', 'addFreeText', 'addShapes', 'addTextAnnots', 'addRedactions', 'removeRedactions',
  'clearHighlights', 'clearShapes', 'clearTextAnnots', 'addLinks', 'removeLinks',
  'addBookmark', 'renameBookmark', 'setBookmarkDest', 'moveBookmark', 'removeBookmarks', 'replaceOutline',
  'deletePage', 'deletePages', 'movePage', 'movePages', 'copyPages', 'insertPages', 'rotatePages',
  'deleteTextLines', 'replaceTextLine', 'setFormValue', 'recognize',
]) {
  /** @type {any} */ (SeedDoc.prototype)[name] = async function hydrateThenRun(...args) {
    if (!this._requestHydration) throw new Error('This document is still loading.');
    const real = await this._requestHydration();
    return real[name](...args);
  };
}
