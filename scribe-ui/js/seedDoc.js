// A provisional document the viewer can display before the real document exists.
import { SKIPPED } from '../../tess/TessScheduler.js';
import { DocFonts } from '../../js/containers/fontContainer.js';
import {
  OcrPage, OcrPar, OcrLine, OcrWord,
} from '../../js/objects/ocrObjects.js';
import {
  addInk as addInkImpl, addStamp as addStampImpl, addFillText as addFillTextImpl, syncFillText as syncFillTextImpl,
} from '../../js/fillSign.js';

const MAX_RESIDENT_PAGES = 64;
const MAX_EXACT_RASTERS = 4;

/**
 * @typedef {Object} ProvisionalSeed
 * @property {number} pageCount
 * @property {Array<{width: number, height: number, rotation?: number}>} pageDims - One entry per page, in the point units the page's OCR bboxes use.
 * @property {number} [initialPage=0]
 * @property {{from: number, to: number}} window - Pages whose annotations and words are fetched at open, inclusive on both ends.
 *   Every other page gets them as the view reaches it.
 * @property {(n: number, targetWidth: number) => Promise<?Blob|ImageBitmap|string>} raster
 *   A string return is a URL the browser can fetch.
 *   A null resolution leaves the page a pending placeholder.
 * @property {(n: number, width: number) => Promise<?ImageBitmap>} [render] - The page rendered at exactly `width` pixels wide.
 *   A page's first paint comes from `raster`, and the render at the view's own width replaces it when it lands.
 * @property {(n: number) => Promise<?Object>} [ocr] - A page's words with their geometry, at minimum `{dims, lines: [{words: [{text, bbox}]}]}`.
 *   Providing it makes that page's text selectable, copyable, and findable.
 *   A line of rotated text must also carry its `orientation` (0-3) and give its word bboxes in that orientation's frame.
 * @property {(n: number) => Promise<?Array<Object>>} [annots] - The page's existing annotations.
 *   A page that resolves, even to `[]`, replaces the real document's page at the swap, so removals count.
 *   Pages that do not resolve append their session additions instead.
 * @property {(n: number) => Promise<?string>} [thumb]
 * @property {(query: string) => Promise<Array<{pageN: number, wordIds: Array<string>}>>} [find] - The document's matches of a query, in page order.
 *   Its word ids must be those `ocr` gives, since the viewer marks the words by id.
 * @property {Array<Object>} [outline]
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
    this.outline = seed.outline ?? [];
    this.nativeText = { pages: [] };
    this.contentEdits = { pages: [] };
    this.fillShapes = { pages: [] };
    this.layoutRegions = { pages: [] };
    this.layoutDataTables = { pages: [] };
    this.redactions = { terms: [], matchCase: false, scannedAt: null };
    this.tableExport = { excluded: {}, names: {} };
    this.assistantChats = { chats: [] };
    this.type3GlyphMappings = new Map();
    this.attachments = { collection: null, files: [] };
    this.fonts = new DocFonts();
    /** @type {?(msg: Object) => void} */
    this.progressHandler = null;
    this.history = {
      undoStack: [], redoStack: [], canUndo: false, canRedo: false, undo() {}, redo() {}, record: (fn) => fn(),
    };
    this.docHistory = {
      undoStack: [],
      redoStack: [],
      canUndo: false,
      canRedo: false,
      undo() { return null; },
      redo() { return null; },
      record() {},
      snapshotAnnots() { return null; },
      recordAnnots() {},
      // Unlike the no-op stubs around them, these two must run `fn`.
      // A no-op would silently drop the mutation the caller wrapped.
      group(label, fn) { return fn(); },
      recordAnnotFields(rows, fields, pages, label, fn) { return fn(); },
      clear() {},
    };

    // While `_textReadySettle` is truthy the viewer treats the document as still loading, so search waits on `textReady` and Recognize stays hidden.
    // A seed with a word source settles it once its window is primed.
    // One without stays loading until hydration replaces it.
    /** @type {?() => void} */
    this._textReadySettle = null;
    /** @type {Promise<void>} */
    this.textReady = new Promise((resolve) => { this._textReadySettle = resolve; });

    this._cancelled = false;
    /** @type {?() => Promise<Object>} Starts hydration and resolves with the real document. */
    this._requestHydration = null;
    /** @type {?(n: number) => void} */
    this._onPageText = null;
    /** @type {?(n: number) => void} */
    this._onPageRaster = null;
    /** @type {Map<number, {width: number, bitmap: ImageBitmap}>} */
    this._exact = new Map();
    /** @type {Map<number, number>} */
    this._exactOrdered = new Map();
    /** @type {Map<number, Promise<?Blob>>} */
    this._blobs = new Map();
    /** @type {Map<number, Promise<void>>} */
    this._pages = new Map();
    /** @type {Array<number>} */
    this._resident = [];
    /** @type {Map<number, Promise<?string>>} */
    this._thumbs = new Map();
    /** @type {Array<string>} Object URLs this doc created. */
    this._urls = [];
    /** @type {?(query: string) => Promise<Array<{pageN: number, wordIds: Array<string>}>>} */
    this.findMatches = seed.find ? (query) => /** @type {NonNullable<typeof seed.find>} */ (seed.find)(query) : null;

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
    /**
     * Order page `n` rendered at `width` through the seed's renderer and tell the viewer when it lands.
     * @param {number} n
     * @param {number} width
     */
    const orderExact = (n, width) => {
      if (!seed.render || this._exactOrdered.get(n) === width) return;
      this._exactOrdered.set(n, width);
      Promise.resolve(seed.render(n, width)).then((bitmap) => {
        if (this._exactOrdered.get(n) === width) this._exactOrdered.delete(n);
        if (!bitmap) return;
        if (this._cancelled) {
          bitmap.close();
          return;
        }
        this._exact.get(n)?.bitmap.close();
        this._exact.set(n, { width, bitmap });
        while (this._exact.size > MAX_EXACT_RASTERS) {
          let far = -1;
          for (const k of this._exact.keys()) if (far < 0 || Math.abs(k - n) > Math.abs(far - n)) far = k;
          /** @type {{width: number, bitmap: ImageBitmap}} */ (this._exact.get(far)).bitmap.close();
          this._exact.delete(far);
        }
        this._onPageRaster?.(n);
      }).catch(() => {
        if (this._exactOrdered.get(n) === width) this._exactOrdered.delete(n);
      });
    };
    // A page's words come with its pixels, so the text layer is there when the viewer builds the page after the raster lands.
    const rasterWrapper = async (n, targetWidth) => {
      if (this._cancelled || n < 0 || n >= seed.pageCount) return SKIPPED;
      const exact = this._exact.get(n);
      /** @type {?ImageBitmap} */
      let bitmap = null;
      if (exact) {
        await this.pageText(n);
        bitmap = await createImageBitmap(exact.bitmap).catch(() => null);
      } else {
        const [blob] = await Promise.all([rasterBlob(n, targetWidth), this.pageText(n)]);
        if (!blob || this._cancelled) return SKIPPED;
        // Decoded here rather than handed off as `src`, because the cache's re-decode path base64-decodes the string and hosts hand us Blobs or fetchable URLs.
        bitmap = await createImageBitmap(blob).catch(() => null);
      }
      if (!bitmap || this._cancelled) return SKIPPED;
      if (targetWidth !== bitmap.width) orderExact(n, targetWidth);
      return {
        imageBitmap: bitmap, src: null, rotated: false, upscaled: targetWidth > bitmap.width, colorMode: 'color',
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
      // Without a renderer the cache reuses the fixed-width raster across zoom changes instead of re-requesting a width this doc cannot give.
      // With one, every request is served at once from what is in hand, so the cache may ask at each zoom.
      isRenderExpensive: () => !seed.render,
      releaseBitmapCache: () => {},
      invalidatePageRender: () => {},
      renderViewerRaster: (n, targetWidth) => rasterWrapper(n, targetWidth),
      getNative: (n) => rasterWrapper(n, 0),
      getBinary: (n) => rasterWrapper(n, 0),
      renderThumbnail: async () => null,
      thumbnailUrl: (n) => {
        if (this._cancelled || !seed.thumb) return Promise.resolve(null);
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
   * Fetch the window's annotations and words.
   * @returns {Promise<void>}
   */
  async prime() {
    const jobs = [];
    const seedAnnots = this.seed.annots;
    for (let n = this.seed.window.from; n <= this.seed.window.to; n++) {
      if (this.seed.ocr) jobs.push(this.pageText(n));
      else if (seedAnnots) {
        jobs.push(Promise.resolve(seedAnnots(n)).then((annots) => {
          if (this._cancelled || !Array.isArray(annots)) return;
          this.annotations.pages[n] = annots;
          this._annotBaseline.add(n);
        }).catch(() => { /* Without a baseline the page appends at the swap instead. */ }));
      }
    }
    await Promise.all(jobs);
    if (this.seed.ocr && this._textReadySettle && !this._cancelled) {
      this._textReadySettle();
      this._textReadySettle = null;
    }
  }

  /**
   * Have page `n`'s words in `ocr.active`.
   * Resolves when they are there or when the page has none.
   * Pages far from `n` give up their words past the resident cap.
   * @param {number} n
   * @returns {Promise<void>}
   */
  pageText(n) {
    const seedOcr = this.seed.ocr;
    if (!seedOcr) return Promise.resolve();
    let p = this._pages.get(n);
    if (p) return p;
    const seedAnnots = this.seed.annots;
    const annotsP = seedAnnots && !this._annotBaseline.has(n) ? Promise.resolve(seedAnnots(n)).catch(() => null) : Promise.resolve(null);
    p = Promise.all([seedOcr(n), annotsP]).then(([pageLike, annots]) => {
      if (this._cancelled) return;
      if (Array.isArray(annots) && !this._annotBaseline.has(n)) {
        this.annotations.pages[n] = annots;
        this._annotBaseline.add(n);
      }
      if (!pageLike || !Array.isArray(pageLike.lines)) {
        if (Array.isArray(annots)) this._onPageText?.(n);
        return;
      }
      const dims = pageLike.dims || this.pageMetrics[n].dims;
      const page = new OcrPage(n, { width: dims.width, height: dims.height });
      page.angle = pageLike.angle || 0;
      if (pageLike.textSource) page.textSource = pageLike.textSource;
      /** @type {Array<OcrPar>} */
      const pars = (pageLike.pars || []).map((parLike) => {
        const par = new OcrPar(page, parLike.bbox);
        if (parLike.type) par.type = parLike.type;
        par.headingLevel = parLike.headingLevel ?? null;
        par.parNum = parLike.parNum ?? null;
        par.marker = parLike.marker ?? null;
        return par;
      });
      page.pars = pars;
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
        line.orientation = lineLike.orientation || 0;
        line.lineNum = lineLike.lineNum ?? null;
        line.pageNum = lineLike.pageNum ?? null;
        const par = typeof lineLike.par === 'number' ? pars[lineLike.par] : null;
        if (par) {
          line.par = par;
          par.lines.push(line);
        }
        for (const w of words) {
          const word = new OcrWord(line, w.id || `seed-${n}-${page.lines.length}-${line.words.length}`, w.text, w.bbox);
          if (w.style) Object.assign(word.style, w.style);
          if (w.lang) word.lang = w.lang;
          word.conf = w.conf ?? 100;
          if (w.visualCoords === false) word.visualCoords = false;
          if (w.footnoteParId) word.footnoteParId = w.footnoteParId;
          if (Array.isArray(w.chars)) word.chars = w.chars;
          line.words.push(word);
        }
        page.lines.push(line);
      }
      this.ocr.active[n] = page;
      this.inputData.xmlMode[n] = true;
      this._resident.push(n);
      while (this._resident.length > MAX_RESIDENT_PAGES) {
        let far = -1;
        let farBy = -1;
        for (let i = 0; i < this._resident.length; i++) {
          const d = Math.abs(this._resident[i] - n);
          if (d > farBy) {
            far = i;
            farBy = d;
          }
        }
        const [gone] = this._resident.splice(far, 1);
        delete this.ocr.active[gone];
        this._pages.delete(gone);
        this._blobs.delete(gone);
      }
      this._onPageText?.(n);
    }).catch(() => { /* Without geometry the page still renders, just without selectable text. */ });
    this._pages.set(n, p);
    return p;
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
    this._pages.clear();
    this._resident.length = 0;
    for (const { bitmap } of this._exact.values()) bitmap.close();
    this._exact.clear();
    this._exactOrdered.clear();
    this._thumbs.clear();
  }
}

// An edit on a provisional document triggers the load it needs, so these return a promise where the real document's verbs are synchronous.
for (const name of [
  'addHighlights', 'addFreeText', 'addShapes', 'addTextAnnots', 'addRedactions', 'removeRedactions',
  'clearHighlights', 'clearShapes', 'clearTextAnnots', 'addLinks', 'removeLinks',
  'addBookmark', 'renameBookmark', 'setBookmarkDest', 'moveBookmark', 'removeBookmarks', 'replaceOutline',
  'deletePage', 'deletePages', 'movePage', 'movePages', 'copyPages', 'duplicatePages', 'insertPages', 'rotatePages',
  'deleteTextLines', 'replaceTextLine', 'deleteGraphics', 'deleteImages', 'setFormValue', 'recognize',
]) {
  /** @type {any} */ (SeedDoc.prototype)[name] = async function hydrateThenRun(...args) {
    if (!this._requestHydration) throw new Error('This document is still loading.');
    const real = await this._requestHydration();
    return real[name](...args);
  };
}
