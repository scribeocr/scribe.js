import scribe from '../../scribe.js';
/* eslint-disable import/no-cycle */
import { ScribeViewer } from '../viewer.js';
import { initBitmapWorker } from './bitmapWorkerMain.js';
import { range } from '../../js/utils/miscUtils.js';
import { SKIPPED, DEBUG_RENDER_SCHED } from '../../tess/TessScheduler.js';

/** @typedef {import('../../js/objects/imageObjects.js').ImageWrapper} ImageWrapper */

// iPadOS 13+ reports the Mac platform string, so it is told apart from a real Mac by its touch points.
export const IOS_WEBKIT = typeof navigator !== 'undefined'
  && (/iP(hone|ad|od)/.test(navigator.platform || '')
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1));

/**
 * @typedef {Object} ImageProperties
 * @property {boolean} [rotated]
 * @property {boolean} [upscaled]
 * @property {('color'|'gray'|'binary')} [colorMode]
 * @property {number} [rotation]
 * @property {number} [srcW] - Width of the source raster the canvas was drawn from.
 * @property {number} [srcH] - Height of the source raster the canvas was drawn from.
 * @property {number} [canvasW] - Backing-store width the canvas was built with (see `_pageCanvasBox`).
 * @property {number} [canvasH] - Backing-store height the canvas was built with.
 * @property {number} [cssW] - CSS width the canvas was styled with.
 * @property {number} [cssH] - CSS height the canvas was styled with.
 * @property {number} n
 */

/**
 * @typedef {Object} ImagePropertiesRequest
 * @property {?boolean} [rotated]
 * @property {?boolean} [upscaled]
 * @property {?('color'|'gray'|'binary')} [colorMode]
 */

export class BitmapScheduler {
  constructor(scheduler, workers) {
    this.scheduler = scheduler;
    /** @type {Array<Awaited<ReturnType<typeof initBitmapWorker>>>} */
    this.workers = workers;
    /**
     * @param {Parameters<typeof import('./bitmapWorker.js').getImageBitmap>} args
     * @returns {Promise<ReturnType<typeof import('./bitmapWorker.js').getImageBitmap>>}
     */
    this.pageText = (args) => (this.scheduler.addJob('pageText', args));
  }
}

/** @type {?Promise<BitmapScheduler>} */
let _bitmapScheduler = null;

const _initBitmapScheduler = async (numWorkers = 3) => {
  const { TessScheduler } = await import('../../tess/TessScheduler.js');
  const scheduler = new TessScheduler();
  const workersPromiseArr = range(1, numWorkers).map(async () => {
    const w = await initBitmapWorker();
    w.id = `png-${Math.random().toString(16).slice(3, 8)}`;
    scheduler.addWorker(w);
    return w;
  });

  const workers = await Promise.all(workersPromiseArr);

  return new BitmapScheduler(scheduler, workers);
};

/** @typedef {HTMLDivElement & {_canvas?: ?HTMLCanvasElement}} PageContainer */

/**
 * Per-viewer image cache. Owns its own page-canvas array and per-page bitmap promises.
 * Only the bitmap-worker scheduler is shared globally, because workers are expensive.
 */
export class ViewerImageCache {
  /**
   * Rows beyond the screen rendered on each side while the reader is active in the document; the warm tier renders one.
   * Two on iOS, whose renders are serialized.
   */
  static activeRenderRows = IOS_WEBKIT ? 2 : 3;

  /**
   * A second jump within this many ms of the first is a burst: it renders the rows on screen alone, and the rows around them once the jumps pause for this long.
   * Below the time a flip settles on a scanned book, above a deliberate second click.
   */
  static burstGapMs = 300;

  /**
   * Number of pages ahead and behind the current page to keep the full-resolution decoded bitmap for.
   * Also the floor within which a display canvas is never evicted.
   */
  static cacheDeletePages = IOS_WEBKIT ? 4 : 5;

  /**
   * Total-bytes cap on retained display canvases, kept far beyond the bitmap window so a revisit reuses the drawn pixels instead of re-decoding (see `_cleanBitmapCache2`).
   * A byte cap self-adapts to zoom where a page count would not: canvas size scales with on-screen area x dpr^2, so this ceiling holds many pages zoomed out and few zoomed in.
   * The one knob for the memory/coverage trade-off.
   */
  static canvasCacheBytes = (IOS_WEBKIT ? 128 : 256) * 1024 * 1024;

  /**
   * Rows ahead whose previews are pre-warmed on each fast-scroll page change.
   * Bounded on purpose: a whole-document background pass competed with the scroll and never let the pipeline settle.
   */
  static previewAhead = 20;

  /** Rows behind the current one kept previewed, so a brief reverse or a rebuilt container is covered. */
  static previewBehind = 4;

  /**
   * @param {import('../viewer.js').ScribeViewer} [viewer]
   */
  constructor(viewer) {
    /** @type {?import('../viewer.js').ScribeViewer} */
    this.viewer = viewer || null;
    /**
     * Per-instance override of the retained-canvas byte cap; `null` uses the class default.
     * An auxiliary viewer (e.g. a preview pane) sets this so it never competes with the main viewer for memory.
     * @type {?number}
     */
    this.canvasCacheBytes = null;
    /** @type {Array<?Promise<HTMLCanvasElement|symbol>>} */
    this.pageCanvases = [];
    /** @type {Array<?ImageProperties>} */
    this.pageCanvasProps = [];
    /** @type {Array<?Promise<boolean>>} */
    this._nativeBitmapPromises = [];
    /** @type {Array<?Promise<boolean>>} */
    this._binaryBitmapPromises = [];
    /**
     * Per-page render sequence. Bumped on each (re-)render and on delete.
     * The resolving render only applies its result if its captured value still matches,
     * so a stale render completing out of order (LIFO can run a newer request first) never overwrites a newer one.
     * @type {Array<number>}
     */
    this._renderSeq = [];
    /**
     * Per-page count of in-flight `getPageCanvas` draws.
     * Back-to-back refreshes overlap two draws on one page, so this is a count, not a set.
     * @type {Map<number, number>}
     */
    this._drawing = new Map();
    /**
     * Per-page identity of the compression promise installed into `native[n]`, so each page is compressed once on eviction rather than re-wrapped on every cleanup sweep.
     * A re-render replaces the slot and re-enables it.
     * @type {Array<?Promise<any>>}
     */
    this._compressPromises = [];
    /**
     * Byte size (`width * height * 4`) of each retained display canvas, keyed by page number, summed to enforce `canvasCacheBytes`.
     * @type {Map<number, number>}
     */
    this._canvasBytes = new Map();
    /**
     * Retained-canvas access order, least-recently-viewed first, so eviction over the byte cap drops the oldest.
     * @type {Set<number>}
     */
    this._canvasLru = new Set();
    /**
     * Pages the viewer has requested a bitmap for and not yet evicted; `_cleanBitmapCache` sweeps only these.
     * @type {Set<number>}
     */
    this._bitmapPages = new Set();
    /**
     * Viewer-owned source rasters for the PDF display path, rendered at on-screen resolution rather than full resolution.
     * Kept out of `doc.images.native[]` so `getNative` consumers (OCR, export, coordinates) still get a full-resolution render.
     * @type {Array<?Promise<ImageWrapper|typeof SKIPPED>>}
     */
    this._srcRasters = [];
    /**
     * Requested integer pixel width of each `_srcRasters` entry; the render lands on exactly this width.
     * 0 or undefined means no raster.
     * @type {Array<number>}
     */
    this._srcWidths = [];
    /** Re-decode dedupe for compressed `_srcRasters` wrappers (mirrors `_nativeBitmapPromises`). @type {Array<?Promise<boolean>>} */
    this._srcBitmapPromises = [];
    /** Per-page identity of the compression promise installed into `_srcRasters` (mirrors `_compressPromises`). @type {Array<?Promise<any>>} */
    this._srcCompressPromises = [];
    /**
     * One-shot full-resolution background upgrade per expensive page.
     * A settled promise stays in the slot as an already-attempted marker until `invalidatePage` re-arms the upgrade.
     * @type {Array<?Promise<void>>}
     */
    this._capUpgrades = [];
    /**
     * Per-page content generation, bumped by `invalidatePage`.
     * An async render captures it at start and discards its result on mismatch, so pixels rendered before a content change never land.
     * @type {Array<number>}
     */
    this._contentSeq = [];
    /**
     * Serializes iOS page renders across `renderAheadBehindBrowser` calls.
     * Always kept resolving, never rejected.
     * @type {Promise<void>}
     */
    this._iosRenderChain = Promise.resolve();
    /**
     * Focus page of the newest iOS render request, anchoring the chain's stale-page check.
     * `state.cp.n` cannot anchor it: `displayPage` updates that only after issuing the request, so a far jump would drop its own pages and leave the view blank.
     * @type {number}
     */
    this._iosRenderFocus = 0;
    /**
     * How far beyond the screen the viewer renders: one row on each side while the document is `'warm'`, `activeRenderRows` once the host sees the reader navigating it (`'active'`).
     * The host sets it; a viewer without one keeps the full window.
     * @type {'warm'|'active'}
     */
    this.tier = 'active';
    /** When the last jump of two rows or more was requested, for the burst check. @type {number} */
    this._lastJumpAt = -Infinity;
    /** Pending render of the full window after a burst, once the jumps have paused. @type {?ReturnType<typeof setTimeout>} */
    this._burstTimer = null;
    /**
     * Pages whose source raster is the one the document keeps stored for them.
     * @type {Set<number>}
     */
    this._fromStored = new Set();
    /**
     * For each page, a promise that settles once the page's latest draw has put its canvas up or been dropped.
     * A draw that showed a stored raster settles only once the render that follows it has too.
     * @type {Array<Promise<void>|undefined>}
     */
    this._drawSettled = [];
  }

  _viewer() {
    return this.viewer || ScribeViewer.getDefault();
  }

  /**
   * Get the global bitmap scheduler, initializing it on first call.
   * @param {number} [numWorkers=3]
   */
  // eslint-disable-next-line class-methods-use-this
  async getBitmapScheduler(numWorkers = 3) {
    if (_bitmapScheduler) return _bitmapScheduler;
    _bitmapScheduler = _initBitmapScheduler(numWorkers);
    return _bitmapScheduler;
  }

  async imageStrToBitmap(imageStr) {
    const bitmapScheduler = await this.getBitmapScheduler();
    return bitmapScheduler.scheduler.addJob('getImageBitmap', [imageStr]);
  }

  /**
   * Compute the display rotation (deskew correction + user rotation) for page `n`, given whether the source raster is already rotated.
   * @param {number} n
   * @param {boolean} [rotated]
   */
  _displayRotation(n, rotated) {
    const viewer = this._viewer();
    let rotation = 0;
    if (scribe.ScribeDoc.defaults.autoRotate && !rotated) {
      rotation = (viewer.doc.pageMetrics[n].angle || 0) * -1;
    } else if (!scribe.ScribeDoc.defaults.autoRotate && rotated) {
      rotation = (viewer.doc.pageMetrics[n].angle || 0);
    }
    rotation += viewer.doc.pageMetrics[n].rotation || 0;
    return rotation;
  }

  /**
   * Backing-store and CSS box for a page canvas drawn from a `srcW`x`srcH` source raster at the current zoom.
   * @param {number} n - Page number
   * @param {number} srcW - Source raster width
   * @param {number} srcH - Source raster height
   * @param {number} rotation - Display rotation the blit applies (degrees)
   * @returns {{canvasW: number, canvasH: number, cssW: number, cssH: number, blitScale: number}}
   */
  _pageCanvasBox(n, srcW, srcH, rotation) {
    const viewer = this._viewer();
    const pageDims = viewer.doc.pageMetrics[n].dims;
    // User rotation (multiple of 90) swaps the displayed page dimensions for 90/270.
    const swap = (viewer.doc.pageMetrics[n].rotation || 0) % 180 === 90;
    const dispW = swap ? pageDims.height : pageDims.width;
    const dispH = swap ? pageDims.width : pageDims.height;
    const displayScale = Math.max(0.01, (viewer.zoomLevel || 1) * (window.devicePixelRatio || 1));
    if (rotation % 90 === 0 && srcW === Math.max(1, Math.round(pageDims.width * displayScale))) {
      // Take the raster's own integers verbatim: re-rounding any of them rescales it by a fraction of a pixel, which blurs every pixel.
      const canvasW = swap ? srcH : srcW;
      const canvasH = swap ? srcW : srcH;
      return {
        canvasW, canvasH, cssW: canvasW / displayScale, cssH: canvasH / displayScale, blitScale: 1,
      };
    }
    const srcDensity = srcW / pageDims.width;
    const rasterScale = Math.min(srcDensity, displayScale);
    // A fractional device-pixel edge makes the compositor resample the whole bitmap.
    const cssW = Math.max(1, Math.round(dispW * displayScale)) / displayScale;
    const cssH = Math.max(1, Math.round(dispH * displayScale)) / displayScale;
    if (rotation % 90 === 0 && rasterScale === srcDensity) {
      // The general branch below re-derives the source height from the page dims, which can land a pixel off the source's own rounding, and the centered draw then smears the page by half a pixel.
      return {
        canvasW: swap ? srcH : srcW, canvasH: swap ? srcW : srcH, cssW, cssH, blitScale: 1,
      };
    }
    return {
      canvasW: Math.max(1, Math.round(dispW * rasterScale)),
      canvasH: Math.max(1, Math.round(dispH * rasterScale)),
      cssW,
      cssH,
      blitScale: rasterScale / srcDensity,
    };
  }

  /**
   * Whether page display uses the viewer-owned display-resolution raster path.
   * Binary rasters are derived from the full-resolution native image, and image input has no PDF to re-render, so neither uses this path.
   */
  _usesViewerRaster() {
    const viewer = this._viewer();
    return !!viewer.doc.images.inputModes?.pdf && viewer.state.colorMode !== 'binary';
  }

  /**
   * Source-raster width the current zoom calls for: the page's on-screen device-pixel width, capped at its full-resolution width.
   * @param {number} n - Page number
   * @returns {number}
   */
  _wantSrcWidth(n) {
    const viewer = this._viewer();
    const dims = viewer.doc.pageMetrics[n].dims;
    const dpr = window.devicePixelRatio || 1;
    const displayScale = Math.max(0.01, (viewer.zoomLevel || 1) * dpr);
    return Math.max(1, Math.min(Math.round(dims.width * displayScale), this._maxSrcWidth(n)));
  }

  /**
   * Hard ceiling on a page's viewer raster width.
   * iOS caps at ~1.5 viewport-widths of device pixels: full-resolution rasters are ~32 MB each on a phone, and a zoom cycle rebuilding several at once gets the tab killed.
   * @param {number} n - Page number
   * @returns {number}
   */
  _maxSrcWidth(n) {
    const viewer = this._viewer();
    const dims = viewer.doc.pageMetrics[n].dims;
    if (!IOS_WEBKIT) return dims.width;
    const dpr = window.devicePixelRatio || 1;
    const vw = viewer.scrollContainer ? viewer.scrollContainer.clientWidth : (window.innerWidth || 800);
    return Math.min(dims.width, Math.max(1024, Math.round(vw * dpr * 1.5)));
  }

  /**
   * Get page `n`'s viewer source raster, rendering from the PDF when there is none at the width the current zoom calls for.
   * A page measured expensive to render keeps its existing raster, so the result can be coarser or finer than the screen density.
   * @param {number} n - Page number
   * @param {'display'|'prefetch'} [lane='display'] - display for a page on screen, prefetch for one in the window beyond it.
   * @returns {Promise<{image: ImageBitmap, wrapper: ImageWrapper} | typeof SKIPPED>}
   */
  async _getViewerSrc(n, lane = 'display') {
    const viewer = this._viewer();
    const { doc } = viewer;
    const images = doc.images;
    const wantW = this._wantSrcWidth(n);
    const haveW = this._srcWidths[n] ?? 0;
    let slot = this._srcRasters[n];
    const sufficient = !!slot && haveW === wantW;
    if (slot && !sufficient && images.isRenderExpensive(n)) {
      // Re-rendering an expensive page would hitch the zoom, so reuse the off-width raster.
      if (haveW < wantW) this._ensureCapUpgrade(n);
    } else if (!slot || !sufficient) {
      const render = () => images.renderViewerRaster(n, wantW, lane).then((w) => {
        if (w && w !== SKIPPED && w.imageBitmap) doc.rasterRendered?.(n, w.imageBitmap);
        return w;
      });
      // An empty slot does not mean the page is unchanged, because an edit clears the slot too.
      // The change count is the document's, not this viewer's `_contentSeq`, so every viewer refuses the stored raster of an edited page.
      const storedRaster = !slot && images.renderInvalidations(n) === 0 ? doc.storedRaster : null;
      /** @type {Promise<ImageWrapper|typeof SKIPPED>} */
      let renderP;
      if (storedRaster) {
        // A thumbnail asked for meanwhile is cut from the stored raster instead of rendering the page.
        const storedLanded = images.expectViewerRaster(n);
        renderP = Promise.resolve(storedRaster(n)).catch(() => null).then((bitmap) => {
          if (!bitmap) {
            // Ask for the render before ending the wait, so a waiting thumbnail is cut from it instead of rendering the page again.
            const rendering = render();
            storedLanded();
            return rendering;
          }
          storedLanded(bitmap);
          if (this._srcRasters[n] === renderP) {
            this._srcWidths[n] = bitmap.width;
            this._fromStored.add(n);
          }
          return /** @type {ImageWrapper} */ (/** @type {unknown} */ ({
            imageBitmap: bitmap, src: null, rotated: false, upscaled: false, colorMode: 'color', n,
          }));
        });
      } else {
        renderP = render();
      }
      // Waiting for GC to free the superseded raster lets rapid zoom cycles stack ~34 MB bitmaps faster than they collect.
      // iOS kills the tab on the uncollected total.
      const oldSlot = this._srcRasters[n];
      slot = renderP;
      this._srcRasters[n] = renderP;
      this._srcWidths[n] = wantW;
      this._srcBitmapPromises[n] = null;
      if (oldSlot) {
        Promise.resolve(oldSlot).then((old) => {
          if (!old || old === SKIPPED || !old.imageBitmap) return;
          if (this._drawing.has(n)) return;
          old.imageBitmap.close();
          old.imageBitmap = null;
        }).catch(() => {});
      }
      renderP.then((w) => {
        // Dropped from the viewer lane: clear the slot so a later request re-renders.
        if (w === SKIPPED && this._srcRasters[n] === renderP) {
          this._srcRasters[n] = null;
          this._srcWidths[n] = 0;
        }
      }).catch(() => {});
    } else if (DEBUG_RENDER_SCHED) {
      console.log(`[render-sched] cache hit page ${n} (viewer raster reused at ${haveW}px)`);
    }
    const wrapper = await slot;
    if (!wrapper || wrapper === SKIPPED) return SKIPPED;
    if (!wrapper.imageBitmap) {
      // Evicted-and-compressed raster: re-decode its PNG (deduped across concurrent draws).
      if (this._srcBitmapPromises[n]) await this._srcBitmapPromises[n];
      if (!wrapper.imageBitmap && wrapper.src != null) {
        const bitmapPromise = this.imageStrToBitmap(wrapper.src);
        this._srcBitmapPromises[n] = bitmapPromise.then(() => true, () => true);
        wrapper.imageBitmap = await bitmapPromise;
      }
    }
    if (!wrapper.imageBitmap) return SKIPPED;
    return { image: wrapper.imageBitmap, wrapper };
  }

  /**
   * Schedule page `n`'s one-time full-resolution background render.
   * @param {number} n - Page number
   */
  _ensureCapUpgrade(n) {
    // A failed upgrade leaves its promise in place: a render this slow must not be retried on every further zoom.
    if (this._capUpgrades[n]) return;
    // The iOS raster ceiling applies to this background upgrade too, or it would reintroduce the full-size rasters the ceiling exists to avoid.
    const fullW = this._maxSrcWidth(n);
    if ((this._srcWidths[n] ?? 0) >= fullW) return;
    const images = this._viewer().doc.images;
    const contentSeq = this._contentSeq[n] || 0;
    this._capUpgrades[n] = (async () => {
      const w = await images.renderViewerRaster(n, fullW, 'background');
      // A failure placeholder has no bitmap, and must not replace a working raster.
      if (!w || w === SKIPPED || !(/** @type {ImageWrapper} */ (w)).imageBitmap) return;
      // Rechecked after the await: the document may have been replaced, or the raster already re-rendered at full resolution.
      if (this._viewer().doc.images !== images) return;
      if ((this._contentSeq[n] || 0) !== contentSeq) return;
      if ((this._srcWidths[n] ?? 0) >= fullW) return;
      this._srcRasters[n] = Promise.resolve(w);
      this._srcWidths[n] = fullW;
      this._srcBitmapPromises[n] = null;
      // At deep zoom only the current page may hold a raster-cap-sized canvas, so a late-landing upgrade must not redraw a neighbor.
      // The upgraded raster stays cached for when the page is visited.
      if (this._iosDeepZoom() && n !== this._viewer().state.cp.n) return;
      if (this.pageCanvases[n]) this.addPageCanvas(n);
    })().catch(() => {});
  }

  /**
   * Render page `n`'s raster into a `<canvas>` sized to the displayed device pixels, CSS-fit to the page's content box, with rotation baked in.
   * Returns `SKIPPED` when the bitmap render was dropped to keep the lane bounded.
   * @param {number} n - Page number
   * @param {'display'|'prefetch'} [lane='display'] - display for a page on screen, prefetch for one in the window beyond it.
   * @returns {Promise<{canvas: HTMLCanvasElement, props: ImageProperties} | typeof SKIPPED>}
   */
  async getPageCanvas(n, lane = 'display') {
    const viewer = this._viewer();

    const binary = viewer.state.colorMode === 'binary';

    /** @type {ImageWrapper} */
    let backgroundImage;
    /** @type {ImageBitmap} */
    let image;
    if (this._usesViewerRaster()) {
      const src = await this._getViewerSrc(n, lane);
      if (src === SKIPPED) return SKIPPED;
      backgroundImage = src.wrapper;
      image = src.image;
    } else {
      // Sampled before `getNative`/`getBinary` below, which populate the slot on a fresh render.
      const wasCached = (binary ? viewer.doc.images.binary : viewer.doc.images.native)[n] !== undefined;

      const bg = binary ? await viewer.doc.images.getBinary(n, undefined, true) : await viewer.doc.images.getNative(n, undefined, true);
      if (bg === SKIPPED) return SKIPPED;
      if (DEBUG_RENDER_SCHED && wasCached) {
        // This cache-hit trace pairs with the scheduler's render-dispatch trace: serving a page from cache dispatches no renderPdfPage.
        console.log(`[render-sched] cache hit page ${n} (${bg?.imageBitmap != null ? 'decoded bitmap reused' : 'decoded from cached PNG'})`);
      }
      const bmp = binary ? await this.getBinaryBitmap(n) : await this.getNativeBitmap(n);
      if (bmp === SKIPPED) return SKIPPED;
      backgroundImage = /** @type {ImageWrapper} */ (bg);
      image = bmp;
    }

    const rotation = this._displayRotation(n, backgroundImage.rotated);
    // The source may be a viewer raster, a native image, or a 2x binary upscale, so the box is derived from the bitmap's own dimensions.
    const box = this._pageCanvasBox(n, image.width, image.height, rotation);

    const canvas = /** @type {HTMLCanvasElement} */ (document.createElement('canvas'));
    canvas.className = 'scribe-layer-image';
    canvas.width = box.canvasW;
    canvas.height = box.canvasH;
    // iOS WebKit sizes a canvas's compositing surface from its layout box x device scale, ignoring the zoom layer's down-scale.
    // A page-sized layout box inside a zoomed-out layer then costs hundreds of MB per page and gets the tab killed.
    // Power-of-two math cancels exactly, but the compositor still resamples by a subpixel (fine at phone density), so every non-iOS platform keeps the plain untransformed box.
    let shrink = 1;
    if (IOS_WEBKIT) {
      const dpr = window.devicePixelRatio || 1;
      while (box.cssW / shrink > box.canvasW / dpr + 0.5) shrink *= 2;
    }
    Object.assign(canvas.style, {
      position: 'absolute',
      left: '0',
      top: '0',
      width: `${box.cssW / shrink}px`,
      height: `${box.cssH / shrink}px`,
      pointerEvents: 'none',
    }, shrink === 1 ? {} : { transformOrigin: '0 0', transform: `scale(${shrink})` });
    // iOS WebKit backs an accelerated 2D canvas with an IOSurface that is reclaimed asynchronously.
    // Page turnover allocates faster than that reclaim runs, so churn accumulates toward the 2GB process kill.
    // willReadFrequently forces a malloc backing, which frees synchronously and ends the race.
    const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d', IOS_WEBKIT ? { willReadFrequently: true } : undefined));
    ctx.imageSmoothingQuality = 'high';
    ctx.save();
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.rotate(rotation * (Math.PI / 180));
    ctx.scale(box.blitScale, box.blitScale);
    ctx.drawImage(image, -image.width / 2, -image.height / 2);
    ctx.restore();

    const props = {
      rotated: backgroundImage.rotated,
      upscaled: backgroundImage.upscaled,
      colorMode: /** @type {'color'|'gray'|'binary'} */ (backgroundImage.colorMode),
      rotation,
      srcW: image.width,
      srcH: image.height,
      canvasW: box.canvasW,
      canvasH: box.canvasH,
      cssW: box.cssW,
      cssH: box.cssH,
      n,
    };

    return { canvas, props };
  }

  /**
   * @param {number} n - Page number
   * @param {ImagePropertiesRequest} [props]
   */
  async getNativeBitmap(n, props) {
    const viewer = this._viewer();
    const nativeN = await viewer.doc.images.getNative(n, props, true);
    if (nativeN === SKIPPED) return SKIPPED;
    if (this._nativeBitmapPromises[n]) await this._nativeBitmapPromises[n];
    if (!nativeN.imageBitmap) {
      const bitmapPromise = this.imageStrToBitmap(nativeN.src);

      this._nativeBitmapPromises[n] = bitmapPromise.then(() => (true));
      nativeN.imageBitmap = await bitmapPromise;
    }
    return nativeN.imageBitmap;
  }

  /**
   * @param {number} n - Page number
   * @param {ImagePropertiesRequest} [props]
   */
  async getBinaryBitmap(n, props) {
    const viewer = this._viewer();
    const binaryN = await viewer.doc.images.getBinary(n, props, true);
    if (binaryN === SKIPPED) return SKIPPED;
    if (this._binaryBitmapPromises[n]) await this._binaryBitmapPromises[n];
    if (!binaryN.imageBitmap) {
      const bitmapPromise = this.imageStrToBitmap(binaryN.src);

      this._binaryBitmapPromises[n] = bitmapPromise.then(() => (true));
      binaryN.imageBitmap = await bitmapPromise;
    }
    return binaryN.imageBitmap;
  }

  /**
   * @param {number} n - Page number
   * @param {'display'|'prefetch'} [lane='display'] - display for a page on screen, prefetch for one in the window beyond it.
   */
  async addPageCanvas(n, lane = 'display') {
    const viewer = this._viewer();
    // Both paths below leave the viewer holding a bitmap, so mark the page for the eviction sweep before branching.
    this._bitmapPages.add(n);
    if (this.pageCanvases[n]) {
      let rerender = false;
      const props = this.pageCanvasProps[n];
      if (props) {
        if (props.colorMode !== viewer.state.colorMode) {
          rerender = true;
        } else {
          // The rotation is baked into the raster, so a changed display rotation needs a fresh draw.
          const rotation = this._displayRotation(n, props.rotated);
          if (Math.abs((props.rotation ?? 0) - rotation) > 0.01) rerender = true;
          if (this._usesViewerRaster()) {
            // A reused canvas never reaches `_getViewerSrc`, so an off-width source must be caught here too.
            const wantW = this._wantSrcWidth(n);
            const haveW = this._srcWidths[n] ?? 0;
            if (haveW !== wantW) {
              if (!viewer.doc.images.isRenderExpensive(n)) rerender = true;
              else if (haveW < wantW) this._ensureCapUpgrade(n);
            }
            // This is the only check that redraws once a background upgrade lands, because the expensive-page branch above never sets `rerender`.
            if (haveW && props.srcW !== haveW) rerender = true;
          }
          if (!rerender) {
            if (!props.srcW || !props.srcH) {
              rerender = true;
            } else {
              // Reusing a canvas whose box no longer matches the current zoom lets the compositor scale the bitmap, softening it.
              // The box in `props` came from this same function, so an unchanged zoom compares bit-identical and needs no float tolerance.
              const boxNow = this._pageCanvasBox(n, props.srcW, props.srcH, rotation);
              if (boxNow.canvasW !== props.canvasW || boxNow.canvasH !== props.canvasH
                || boxNow.cssW !== props.cssW || boxNow.cssH !== props.cssH) rerender = true;
            }
          }
        }
      }
      if (!rerender) {
        if (DEBUG_RENDER_SCHED) console.log(`[render-sched] cache hit page ${n} (canvas reused; no render)`);
        return;
      }
    }

    if (viewer.getPageStop(n) === null) return;

    // Each render is stamped. Only the latest render for this page is applied.
    // A slower earlier render completing out of order (LIFO can run a newer request first) cannot overwrite a newer one.
    // The superseding call (or a delete) removes the discarded canvas.
    const seq = (this._renderSeq[n] || 0) + 1;
    this._renderSeq[n] = seq;

    // Mark the page as drawing for the whole render so eviction never transfers a bitmap this draw is mid-read of.
    this._drawing.set(n, (this._drawing.get(n) || 0) + 1);
    this.pageCanvasProps[n] = null;
    /** @type {?ImageProperties} */
    let drawnProps = null;
    const canvasPromise = this.getPageCanvas(n, lane).then((res) => {
      if (res === SKIPPED) return SKIPPED;
      drawnProps = res.props;
      return res.canvas;
    });
    this.pageCanvases[n] = canvasPromise;
    const drawDone = () => {
      const count = (this._drawing.get(n) || 0) - 1;
      if (count > 0) this._drawing.set(n, count);
      else this._drawing.delete(n);
    };
    canvasPromise.then(drawDone, drawDone);

    /** @type {Promise<void>} */
    const settled = canvasPromise.then((canvas) => {
      if (canvas === SKIPPED) {
        // Render dropped to keep the lane bounded; leave the placeholder, allow a later re-render.
        if (this.pageCanvases[n] === canvasPromise) this.pageCanvases[n] = null;
        return;
      }
      if (this._renderSeq[n] !== seq) {
        // Superseded render: the canvas was never attached, so free its backing store now.
        /** @type {HTMLCanvasElement} */ (canvas).width = 0;
        /** @type {HTMLCanvasElement} */ (canvas).height = 0;
        return;
      }
      // Set only after the supersede check, not where drawnProps is captured.
      // A superseded render's properties would describe a canvas that was never mounted.
      this.pageCanvasProps[n] = drawnProps;
      const pc = viewer._ensurePageContainer(n);
      if (!pc) return;
      const prev = /** @type {any} */ (pc)._canvas;
      if (prev && prev !== canvas && prev.parentNode) prev.remove();
      if (prev && prev !== canvas) {
        prev.width = 0;
        prev.height = 0;
      }
      /** @type {any} */ (pc)._canvas = canvas;
      /** @type {HTMLCanvasElement} */ (canvas).style.display = viewer.state.displayMode === 'ebook' ? 'none' : '';
      // Insert behind the text/overlay groups (which carry z-index >= 1).
      pc.insertBefore(/** @type {HTMLCanvasElement} */ (canvas), pc.firstChild);
      // Track this canvas's memory and mark it most-recently-viewed for the byte-capped retention (_cleanBitmapCache2).
      // A re-render for the same page overwrites the byte entry, so a resized canvas is never double-counted.
      const c = /** @type {HTMLCanvasElement} */ (canvas);
      this._canvasBytes.set(n, c.width * c.height * 4);
      this._canvasLru.delete(n);
      this._canvasLru.add(n);
      viewer._releaseRasterWaiters(n);
      if (this._fromStored.delete(n) && (this._srcWidths[n] ?? 0) !== this._wantSrcWidth(n)) this.addPageCanvas(n, lane);
    }).catch(() => {
      // pageCanvasProps[n] stayed null, so the reuse check would read the leftover rejected promise as a cache hit and never re-render the page.
      if (this.pageCanvases[n] === canvasPromise) this.pageCanvases[n] = null;
    }).then(() => {
      // When the step above re-renders past a stored raster, this draw settles only once that render does.
      const later = this._drawSettled[n];
      return later === settled ? undefined : later;
    });
    this._drawSettled[n] = settled;
  }

  /**
   * Forget page `n`'s cached display raster after a content change.
   * The next `addPageCanvas` renders the page again.
   * The canvas on screen stays mounted until that render replaces it.
   * Only this viewer's copies are cleared.
   * @param {number} n - Page number
   */
  invalidatePage(n) {
    this._contentSeq[n] = (this._contentSeq[n] || 0) + 1;
    // Without this re-arm, an edited expensive page could never regain full resolution.
    this._capUpgrades[n] = null;
    const oldSlot = this._srcRasters[n];
    this._srcRasters[n] = null;
    this._srcWidths[n] = 0;
    this._srcBitmapPromises[n] = null;
    if (oldSlot) {
      Promise.resolve(oldSlot).then((old) => {
        if (!old || old === SKIPPED || !old.imageBitmap) return;
        // An in-flight draw may still be blitting this bitmap; closing it mid-drawImage throws.
        if (this._drawing.has(n)) return;
        old.imageBitmap.close();
        old.imageBitmap = null;
      }).catch(() => {});
    }
    if (!this.pageCanvases[n]) return;
    // Supersede any in-flight render, whose pixels predate the change.
    this._renderSeq[n] = (this._renderSeq[n] || 0) + 1;
    this.pageCanvases[n] = null;
  }

  /**
   * Take page `n`'s canvas off the page and forget it.
   * @param {number} n - Page number
   */
  deletePageCanvas(n) {
    this._canvasBytes.delete(n);
    this._canvasLru.delete(n);
    if (this.pageCanvases[n]) {
      // Supersede any in-flight render so it cannot mount its canvas after the deletion.
      this._renderSeq[n] = (this._renderSeq[n] || 0) + 1;
      this.pageCanvases[n] = null;
    }
    const viewer = this._viewer();
    const pc = /** @type {?PageContainer} */ (viewer.pageContainerArr[n]);
    // After an invalidation or a dropped render, `pageCanvases[n]` is null while a canvas is still mounted.
    const mounted = pc?._canvas;
    if (pc && mounted) {
      mounted.remove();
      // Zeroing the dimensions releases the backing store now.
      // A detached canvas otherwise holds its pixels until GC, which iOS's process kill does not wait for.
      mounted.width = 0;
      mounted.height = 0;
      pc._canvas = null;
    }
    // No pixels are left for a waiting caller's overlay to cover.
    viewer._releaseRasterWaiters(n);
  }

  clear() {
    if (this._burstTimer) {
      clearTimeout(this._burstTimer);
      this._burstTimer = null;
    }
    for (let i = 0; i < this.pageCanvases.length; i++) {
      this.deletePageCanvas(i);
    }
    this.pageCanvases.length = 0;
    this.pageCanvasProps.length = 0;
    this._nativeBitmapPromises.length = 0;
    this._binaryBitmapPromises.length = 0;
    // `_renderSeq` is kept: counting from zero again would let a render still in flight for the outgoing document match a new render's number and attach.
    this._drawing.clear();
    this._compressPromises.length = 0;
    this._canvasBytes.clear();
    this._canvasLru.clear();
    this._bitmapPages.clear();
    this._srcRasters.length = 0;
    this._srcWidths.length = 0;
    this._srcBitmapPromises.length = 0;
    this._srcCompressPromises.length = 0;
    this._capUpgrades.length = 0;
    this._fromStored.clear();
    this._drawSettled.length = 0;
    this._iosRenderChain = Promise.resolve();
  }

  /**
   * Draw page `n`'s low-res preview as its container background, so a page with no full raster shows shapes instead of blank.
   * @param {number} n
   */
  async showPreview(n) {
    const viewer = this._viewer();
    // Ebook mode shows no page raster, so no preview either.
    if (viewer.state.displayMode === 'ebook') return;
    if (n < 0 || n >= viewer.doc.images.pageCount) return;
    // The page's shared thumbnail URL, one decode also used by the page strip, page grid, and pull-up morph.
    const url = await viewer.doc.images.thumbnailUrl(n);
    if (!url) return;
    const pc = viewer._ensurePageContainer(n);
    const style = /** @type {?HTMLElement} */ (pc)?.style;
    if (!style || style.backgroundImage.indexOf(url) !== -1) return; // already applied (skip redundant write)
    // Safe to stretch to fill the page box: the preview shares the page aspect, so no distortion.
    style.backgroundImage = `url("${url}")`;
    style.backgroundSize = '100% 100%';
    style.backgroundRepeat = 'no-repeat';
  }

  /**
   * Show previews for the current row and a look-ahead in the scroll direction, rendering any not yet cached.
   * The window is measured in rows, so two-page view keeps the same look-ahead distance rather than half of it.
   * @param {number} curr
   * @param {number} [dir=1] - Scroll direction (+1 down, -1 up).
   */
  ensurePreviewWindow(curr, dir = 1) {
    const viewer = this._viewer();
    const ahead = ViewerImageCache.previewAhead;
    const behind = ViewerImageCache.previewBehind;
    const r = viewer.rowOfPage(curr);
    if (r === null) {
      const lo = dir >= 0 ? curr - behind : curr - ahead;
      const hi = dir >= 0 ? curr + ahead : curr + behind;
      for (let i = lo; i <= hi; i++) {
        if (i >= 0) this.showPreview(i);
      }
      return;
    }
    const loR = r - (dir >= 0 ? behind : ahead);
    const hiR = r + (dir >= 0 ? ahead : behind);
    for (let ri = Math.max(0, loR); ri <= hiR; ri++) {
      for (const n of viewer.rowPages(ri)) this.showPreview(n);
    }
  }

  /**
   * The pages to render for a view on `curr`: the rows on screen, `curr` first, and `radius` rows beyond the screen on each side, nearest first and the side the reader is moving toward first.
   * Pages outside the loaded range are left out.
   * @param {number} curr
   * @param {number} radius - Rows beyond the screen on each side.
   * @param {?number} viewTop - Content-space top of the viewport once the view lands; the current scroll position when null.
   * @param {number} dir - Direction of travel, +1 forward.
   * @returns {{onScreen: Array<number>, beyond: Array<number>}}
   */
  _windowPages(curr, radius, viewTop, dir) {
    const viewer = this._viewer();
    const count = viewer.doc.images.loadCount;
    const onScreen = [curr];
    const beyond = [];
    const push = (list, n) => {
      if (n >= 0 && n < count && !onScreen.includes(n) && !beyond.includes(n)) list.push(n);
    };
    const r = viewer.rowOfPage(curr);
    const rows = viewer.visibleRows(viewTop);
    if (r === null || rows === null) {
      // Without a layout only `curr` is known to be on screen.
      for (let i = 1; i <= radius + 1; i++) {
        push(beyond, curr + i * dir);
        push(beyond, curr - i * dir);
      }
      return { onScreen, beyond };
    }
    // The target row is on screen once the view lands, whatever viewport the rows were read from.
    const first = Math.min(rows[0], r);
    const last = Math.max(rows[1], r);
    for (let ri = first; ri <= last; ri++) for (const n of viewer.rowPages(ri)) push(onScreen, n);
    for (let i = 1; i <= radius; i++) {
      for (const n of viewer.rowPages(dir >= 0 ? last + i : first - i)) push(beyond, n);
      for (const n of viewer.rowPages(dir >= 0 ? first - i : last + i)) push(beyond, n);
    }
    return { onScreen, beyond };
  }

  /**
   * Render the current page and the window around it, and free the bitmaps of distant pages.
   * The window is the rows on screen plus the tier's rows beyond them (`tier`), the rows on screen alone for the second jump of a burst, or `curr` alone in a glide tail.
   * @param {number} curr
   * @param {boolean} [currOnly=false] - Render only `curr`, in the tail of a fast-scroll glide, so a window of full-page renders does not clump into the decelerating frames.
   *   Cache sweeps run regardless.
   * @param {?number} [viewTop=null] - Content-space top of the viewport once this view lands, for a jump whose scroll follows the request; the current scroll position when null.
   */
  async renderAheadBehindBrowser(curr, currOnly = false, viewTop = null) {
    const viewer = this._viewer();
    if (this._burstTimer) {
      clearTimeout(this._burstTimer);
      this._burstTimer = null;
    }
    // `state.cp.n` is still the page being left: `displayPage` updates it after issuing the request.
    const prevRow = viewer.rowOfPage(viewer.state.cp.n);
    const row = viewer.rowOfPage(curr);
    const dir = row !== null && prevRow !== null && row < prevRow ? -1 : 1;
    /** @type {Array<number>} The pages on screen, `curr` first. */
    let onScreen;
    /** @type {Array<number>} The pages of the rows beyond the screen, nearest first. */
    let beyond = [];
    if (currOnly) {
      onScreen = [curr];
    } else {
      const jump = row !== null && prevRow !== null && Math.abs(row - prevRow) >= 2;
      const now = performance.now();
      const burst = jump && now - this._lastJumpAt < ViewerImageCache.burstGapMs;
      if (jump) this._lastJumpAt = now;
      if (burst) {
        // A reader who jumps again this soon is not reading yet; the rows around the target come once the jumps pause.
        ({ onScreen } = this._windowPages(curr, 0, viewTop, dir));
        const doc = viewer.doc;
        this._burstTimer = setTimeout(() => {
          this._burstTimer = null;
          const v = this._viewer();
          if (v.doc === doc && v.state.cp.n === curr) this.renderAheadBehindBrowser(curr);
        }, ViewerImageCache.burstGapMs);
      } else {
        const radius = this.tier !== 'active' ? 1
          : (IOS_WEBKIT || viewer.doc.images.isRenderExpensive(curr) ? 2 : ViewerImageCache.activeRenderRows);
        ({ onScreen, beyond } = this._windowPages(curr, radius, viewTop, dir));
      }
    }

    // A glide tail keeps its row, whose other page may still be rendering from the last full window.
    const keep = currOnly ? new Set([curr, ...(row === null ? [] : viewer.rowPages(row))]) : new Set([...onScreen, ...beyond]);
    viewer.doc.images.setViewerFocus?.(curr, keep, this);

    this.sweepCaches(curr);

    // While OCR uploaded with a PDF is still converting, its dimensions are not yet available and nothing re-renders the neighbors once they are.
    // Raw OCR without converted OCR marks the next page as still converting.
    // A page with no text has neither.
    if (curr === 0 && viewer.doc.ocr?.active?.[curr] && !viewer.doc.ocr?.active?.[curr + 1] && viewer.doc.ocrRaw?.active?.[curr + 1]
      && viewer.doc.pageMetrics.length > curr + 1) {
      await this.addPageCanvas(curr);
      return;
    }

    // Send the current page first.
    // Although jobs may be reordered in the scheduler, sending them in correct order of priority still avoids issues.
    if (IOS_WEBKIT) {
      // One page start-to-finish at a time, chained across calls too: parallel or interleaved renders hold several ~100 MB page transients at once, and iOS kills the tab on the total.
      // Past fit-width the ahead-render is dropped: neighbor canvases are raster-cap-sized there, and the eviction-protected window would pin an over-budget set nothing can reclaim.
      // Previews cover the neighbors until they are scrolled to.
      const deepZoom = this._iosDeepZoom();
      const chain = deepZoom ? [curr] : [...onScreen, ...beyond];
      if (deepZoom) this.ensurePreviewWindow(curr);
      this._iosRenderFocus = curr;
      // A page's render is asked for only when its turn comes, so a thumbnail asked for before then is told the render is coming and waits for it.
      const lanes = chain.map((n) => (onScreen.includes(n) ? 'display' : 'prefetch'));
      const turns = chain.map((n, i) => viewer.doc.images.expectViewerRaster(n, lanes[i]));
      this._iosRenderChain = this._iosRenderChain.then(async () => {
        for (let i = 0; i < chain.length; i++) {
          const n = chain[i];
          // A page enqueued for an earlier focus the view has since moved away from would render only to be evicted by the next sweep.
          if (Math.abs(n - this._iosRenderFocus) > ViewerImageCache.cacheDeletePages) continue;
          await this.addPageCanvas(n, lanes[i]);
          // The page's render has been asked for by now, when it needed one, and the thumbnail's wait passes to it.
          turns[i]();
          // Hold the chain until this page's canvas is up, including the render that follows a stored raster, so no two pages render at once.
          await this._drawSettled[n];
        }
      }).catch(() => { /* a dead chain link must not block every later render */ }).finally(() => {
        // A page the chain skipped, or never reached, has no render coming.
        for (const turn of turns) turn();
      });
      await this._iosRenderChain;
      return;
    }
    // The rows beyond the screen go in the prefetch lane, so a rail row on screen never waits behind a page the reader has not reached.
    await Promise.all([
      ...onScreen.map((n) => this.addPageCanvas(n, 'display')),
      ...beyond.map((n) => this.addPageCanvas(n, 'prefetch')),
    ]);
  }

  /**
   * Compress `arr[n]`'s bitmap to a PNG `src` and free the bitmap, so a revisit re-decodes the PNG instead of rendering the page again.
   * Only a `src==null` wrapper holding a bitmap is touched.
   * @param {Array<ImageWrapper|Promise<ImageWrapper|typeof SKIPPED>|null|undefined>} arr - Store array holding the slot (`doc.images.native` or `_srcRasters`).
   * @param {number} n
   * @param {Array<?Promise<any>>} promises - Compression promises installed into `arr`, so each slot is compressed once rather than re-wrapped on every cleanup sweep.
   */
  _compressSlot(arr, n, promises) {
    const entry = arr[n];
    if (!entry) return;
    // Already compressed (or compressing) this exact slot.
    // A re-render installs a new promise and re-enables this.
    if (promises[n] === entry) return;
    // A draw holds a live reference to this bitmap, so leave it for a later eviction pass.
    if (this._drawing.has(n)) return;
    const compressP = Promise.resolve(entry).then(async (w) => {
      if (!w || w === SKIPPED || w.src != null || !w.imageBitmap) return w;
      const bitmap = w.imageBitmap;
      w.imageBitmap = null;
      const bitmapScheduler = await this.getBitmapScheduler();
      const dataUrl = await bitmapScheduler.scheduler.addJob('compressBitmap', bitmap);
      // Only write back if this slot is still ours (a re-render may have replaced it).
      if (arr[n] === compressP) w.src = dataUrl;
      return w;
    }).catch(() => {
      // Compression failed after the bitmap was already transferred away.
      // Drop the slot so a revisit re-renders.
      if (arr[n] === compressP) arr[n] = undefined;
      return SKIPPED;
    });
    // Until this settles the wrapper has lost its bitmap and not yet gained a `src`, so hand consumers the promise instead.
    // The catch widens the sentinel to `symbol`, but it is only ever `SKIPPED`, so narrow back for the store.
    arr[n] = /** @type {Promise<ImageWrapper|typeof SKIPPED>} */ (compressP);
    promises[n] = compressP;
  }

  /**
   * Compress page `n`'s viewer bitmap in `native[n]` (binary-mode and image-input display paths).
   * @param {number} n
   */
  _compressNative(n) {
    // Broadly-typed view of the store array: it also holds SKIPPED-promises and `undefined` that the narrow field type omits.
    this._compressSlot(/** @type {Array<ImageWrapper|Promise<ImageWrapper|typeof SKIPPED>|undefined>} */ (this._viewer().doc.images.native), n, this._compressPromises);
  }

  /**
   * Free the decoded bitmap of page `n`'s viewer source raster.
   * @param {number} n
   */
  _releaseViewerSrcBitmap(n) {
    const entry = this._srcRasters[n];
    if (!entry) return;
    Promise.resolve(entry).then((w) => {
      // A `src`-less wrapper's bitmap is the raster's only copy, so `_compressSlot` compresses it into a `src` before dropping it.
      if (!w || w === SKIPPED || w.src == null) return;
      if (this._drawing.has(n)) return;
      if (w.imageBitmap) {
        w.imageBitmap.close();
        w.imageBitmap = null;
      }
    }).catch(() => {});
  }

  /**
   * Whether the viewer sits past fit-width zoom on iOS, where every canvas is raster-cap-sized and the resident set must stay minimal.
   * @returns {boolean}
   */
  _iosDeepZoom() {
    if (!IOS_WEBKIT) return false;
    const viewer = this._viewer();
    const sc = viewer.scrollContainer;
    const fitZoom = sc && viewer._contentWidth ? sc.clientWidth / viewer._contentWidth : 0;
    return fitZoom > 0 && viewer.zoomLevel > fitZoom * 1.2;
  }

  /**
   * Evict decoded bitmaps and over-budget canvases for pages far from `curr`.
   * Rides every ahead-render, and the iOS deferred-raster glide path calls it directly because that path skips the ahead-render and pre-glide high-res canvases would survive the whole fling.
   * @param {number} curr
   */
  sweepCaches(curr) {
    this._cleanBitmapCache(curr);
    this._cleanBitmapCache2(curr);
  }

  /** @param {number} curr */
  _cleanBitmapCache(curr) {
    const images = this._viewer().doc.images;
    // Non-tracked pages would no-op here, so sweep only `_bitmapPages`.
    // Deleting from a Set mid-iteration is safe.
    for (const i of this._bitmapPages) {
      if (Math.abs(curr - i) > ViewerImageCache.cacheDeletePages) {
        // Compress the viewer bitmaps to a re-decodable PNG `src`, then free the page's decoded bitmaps to bound viewer memory.
        this._compressNative(i);
        this._compressSlot(this._srcRasters, i, this._srcCompressPromises);
        images.releaseBitmapCache(i);
        this._releaseViewerSrcBitmap(i);
        this._bitmapPages.delete(i);
      }
    }
  }

  /**
   * Bound retained display canvases by a total-bytes cap, evicting least-recently-viewed first.
   * @param {number} curr
   */
  _cleanBitmapCache2(curr) {
    const viewer = this._viewer();
    const pageCount = viewer.doc.images.pageCount;

    // The on-screen + prefetch window is most-recently-viewed and is never evicted.
    const lo = Math.max(0, curr - ViewerImageCache.cacheDeletePages);
    const hi = Math.min(pageCount - 1, curr + ViewerImageCache.cacheDeletePages);
    for (let i = lo; i <= hi; i++) {
      if (this.pageCanvases[i]) {
        this._canvasLru.delete(i);
        this._canvasLru.add(i);
      }
    }

    const cap = this.canvasCacheBytes ?? ViewerImageCache.canvasCacheBytes;
    let total = 0;
    for (const bytes of this._canvasBytes.values()) total += bytes;
    if (total <= cap) return;

    // Evict least-recently-viewed canvases (skipping the protected window) until back under the cap.
    const toEvict = [];
    for (const n of this._canvasLru) {
      if (total <= cap) break;
      if (Math.abs(curr - n) <= ViewerImageCache.cacheDeletePages) continue;
      toEvict.push(n);
      total -= (this._canvasBytes.get(n) || 0);
    }
    for (const n of toEvict) this.deletePageCanvas(n);
  }
}
