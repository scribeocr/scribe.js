import scribe from '../../scribe.js';
/* eslint-disable import/no-cycle */
import { ScribeViewer } from '../viewer.js';
import { initBitmapWorker } from './bitmapWorkerMain.js';
import { range } from '../../js/utils/miscUtils.js';
import { SKIPPED, DEBUG_RENDER_SCHED } from '../../tess/TessScheduler.js';

/** @typedef {import('../../js/objects/imageObjects.js').ImageWrapper} ImageWrapper */

/**
 * @typedef {Object} ImageProperties
 * @property {boolean} [rotated]
 * @property {boolean} [upscaled]
 * @property {('color'|'gray'|'binary')} [colorMode]
 * @property {number} [rotation]
 * @property {number} [rasterScale] - On-screen device-pixel density the backing store was rastered at (see `_targetRasterScale`).
 * @property {number} [srcScale] - Density of the source raster the canvas was drawn from, in device px per page-dims px.
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

/**
 * Per-viewer image cache. Owns its own page-canvas array and per-page bitmap promises.
 * Only the bitmap-worker scheduler is shared globally, because workers are expensive.
 */
export class ViewerImageCache {
  /** Number of pages ahead and behind the current page to pre-render. */
  static cacheRenderPages = 3;

  /**
   * Number of pages ahead and behind the current page to keep the full-resolution decoded bitmap for.
   * Also the floor within which a display canvas is never evicted.
   */
  static cacheDeletePages = 5;

  /**
   * Total-bytes cap on retained display canvases, kept far beyond the bitmap window so a revisit reuses the drawn pixels instead of re-decoding (see `_cleanBitmapCache2`).
   * A byte cap self-adapts to zoom where a page count would not: canvas size scales with on-screen area x dpr^2, so this ceiling holds many pages zoomed out and few zoomed in.
   * The one knob for the memory/coverage trade-off.
   */
  static canvasCacheBytes = 256 * 1024 * 1024;

  /** Preview width in px; low enough to show shapes and colors, not readable text. */
  static previewWidth = 300;

  /**
   * Pages ahead whose previews are pre-warmed on each fast-scroll page change.
   * Bounded on purpose: a whole-document background pass competed with the scroll and never let the pipeline settle.
   */
  static previewAhead = 20;

  /** Pages behind the current page kept previewed, so a brief reverse or a rebuilt container is covered. */
  static previewBehind = 4;

  /**
   * @param {import('../viewer.js').ScribeViewer} [viewer]
   */
  constructor(viewer) {
    /** @type {?import('../viewer.js').ScribeViewer} */
    this.viewer = viewer || null;
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
     * Pages with an in-flight `getPageCanvas` draw (holding a live reference to the bitmap).
     * Eviction never compresses a page in this set, so a transfer can't neuter a bitmap a draw is mid-read of.
     * @type {Set<number>}
     */
    this._drawing = new Set();
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
     * Per-page object URL of the low-res preview drawn as the page container's background, so a page with no full raster shows shapes instead of blank.
     * Revoked in `clear()`.
     * @type {Map<number, string>}
     */
    this._previewUrls = new Map();
    /**
     * Viewer-owned source rasters for the PDF display path, rendered at on-screen resolution rather than full resolution.
     * Kept out of `doc.images.native[]` so `getNative` consumers (OCR, export, coordinates) still get a full-resolution render.
     * @type {Array<?Promise<ImageWrapper|typeof SKIPPED>>}
     */
    this._srcRasters = [];
    /**
     * Density of each `_srcRasters` entry, as a fraction of the full-resolution render `getNative` returns.
     * 0 or undefined means no raster.
     * @type {Array<number>}
     */
    this._srcScales = [];
    /** Re-decode dedupe for compressed `_srcRasters` wrappers (mirrors `_nativeBitmapPromises`). @type {Array<?Promise<boolean>>} */
    this._srcBitmapPromises = [];
    /** Per-page identity of the compression promise installed into `_srcRasters` (mirrors `_compressPromises`). @type {Array<?Promise<any>>} */
    this._srcCompressPromises = [];
    /**
     * One-shot full-resolution background upgrade per expensive page (see `_ensureCapUpgrade`).
     * Held (not cleared) after completion or failure so an expensive page is upgraded at most once.
     * @type {Array<?Promise<void>>}
     */
    this._capUpgrades = [];
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
   * Backing-store density for a page canvas, capped at the source raster's density because rastering past the source's 1:1 adds no detail.
   * @param {number} srcDensity - Source raster density in device px per page-dims px.
   * @returns {number}
   */
  _targetRasterScale(srcDensity) {
    const dpr = window.devicePixelRatio || 1;
    return Math.min(srcDensity, Math.max(0.01, (this._viewer().zoomLevel || 1) * dpr));
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
   * Source-raster density the current zoom calls for, capped at 1 because a render cannot add detail beyond full resolution.
   * @returns {number}
   */
  _wantDensity() {
    const dpr = window.devicePixelRatio || 1;
    return Math.min(1, Math.max(0.01, (this._viewer().zoomLevel || 1) * dpr));
  }

  /**
   * Get page `n`'s viewer source raster, rendering from the PDF when there is none or the existing one is too coarse for the current zoom.
   * A page measured expensive to render keeps its coarse raster, so the result can be below the density the zoom calls for.
   * @param {number} n - Page number
   * @returns {Promise<{image: ImageBitmap, wrapper: ImageWrapper} | typeof SKIPPED>}
   */
  async _getViewerSrc(n) {
    const viewer = this._viewer();
    const images = viewer.doc.images;
    const wantDensity = this._wantDensity();
    const haveScale = this._srcScales[n] ?? 0;
    let slot = this._srcRasters[n];
    // 2% slack so device-pixel-ratio rounding never triggers a same-density re-render.
    const sufficient = !!slot && wantDensity <= haveScale * 1.02;
    if (slot && !sufficient && images.isRenderExpensive(n)) {
      // Re-rendering an expensive page would hitch the zoom, so reuse the coarse raster (the CSS transform upscales it, soft) and sharpen it in the background.
      this._ensureCapUpgrade(n);
    } else if (!slot || !sufficient) {
      const renderP = images.renderViewerRaster(n, wantDensity, true);
      slot = renderP;
      this._srcRasters[n] = renderP;
      this._srcScales[n] = wantDensity;
      this._srcBitmapPromises[n] = null;
      renderP.then((w) => {
        // Dropped from the viewer lane: clear the slot so a later request re-renders.
        if (w === SKIPPED && this._srcRasters[n] === renderP) {
          this._srcRasters[n] = null;
          this._srcScales[n] = 0;
        }
      }).catch(() => {});
    } else if (DEBUG_RENDER_SCHED) {
      console.log(`[render-sched] cache hit page ${n} (viewer raster reused at ${haveScale.toFixed(2)}x)`);
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
    if ((this._srcScales[n] ?? 0) >= 1) return;
    const images = this._viewer().doc.images;
    this._capUpgrades[n] = (async () => {
      const w = await images.renderViewerRaster(n, 1, false);
      // A failure placeholder has no bitmap, and must not replace a working raster.
      if (!w || w === SKIPPED || !(/** @type {ImageWrapper} */ (w)).imageBitmap) return;
      // Rechecked after the await: the document may have been replaced, or the raster already re-rendered at full resolution.
      if (this._viewer().doc.images !== images) return;
      if ((this._srcScales[n] ?? 0) >= 1) return;
      this._srcRasters[n] = Promise.resolve(w);
      this._srcScales[n] = 1;
      this._srcBitmapPromises[n] = null;
      if (this.pageCanvases[n]) this.addPageCanvas(n);
    })().catch(() => {});
  }

  /**
   * Render page `n`'s raster into a `<canvas>` sized to the displayed device pixels, CSS-fit to the page's content box, with rotation baked in.
   * Returns `SKIPPED` when the bitmap render was dropped to keep the lane bounded.
   * @param {number} n - Page number
   * @returns {Promise<{canvas: HTMLCanvasElement, props: ImageProperties} | typeof SKIPPED>}
   */
  async getPageCanvas(n) {
    const viewer = this._viewer();
    const pageDims = viewer.doc.pageMetrics[n].dims;

    const binary = viewer.state.colorMode === 'binary';

    /** @type {ImageWrapper} */
    let backgroundImage;
    /** @type {ImageBitmap} */
    let image;
    if (this._usesViewerRaster()) {
      const src = await this._getViewerSrc(n);
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

    // User rotation (multiple of 90) is an extra display transform on top of the deskew angle;
    // for 90/270 it swaps the displayed page dimensions.
    const userRotation = viewer.doc.pageMetrics[n].rotation || 0;
    const dispW = userRotation % 180 === 90 ? pageDims.height : pageDims.width;
    const dispH = userRotation % 180 === 90 ? pageDims.width : pageDims.height;

    // The source may be a viewer raster, a native image, or a 2x binary upscale, so read the density off the bitmap rather than assuming it.
    const srcDensity = image.width / pageDims.width;

    // Round the CSS box to whole device pixels so the raster lands on the device-pixel grid.
    // A fractional edge lets the GPU compositor bilinear-blur the whole bitmap.
    const displayScale = (viewer.zoomLevel || 1) * (window.devicePixelRatio || 1);
    const rasterScale = this._targetRasterScale(srcDensity);
    const cssW = Math.max(1, Math.round(dispW * displayScale)) / displayScale;
    const cssH = Math.max(1, Math.round(dispH * displayScale)) / displayScale;

    const canvas = /** @type {HTMLCanvasElement} */ (document.createElement('canvas'));
    canvas.className = 'scribe-layer-image';
    canvas.width = Math.max(1, Math.round(dispW * rasterScale));
    canvas.height = Math.max(1, Math.round(dispH * rasterScale));
    Object.assign(canvas.style, {
      position: 'absolute', left: '0', top: '0', width: `${cssW}px`, height: `${cssH}px`, pointerEvents: 'none',
    });
    const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d'));
    ctx.imageSmoothingQuality = 'high';
    ctx.save();
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.rotate(rotation * (Math.PI / 180));
    // Scale the source raster (`srcDensity`x display) to the backing store (`rasterScale`x display).
    ctx.scale(rasterScale / srcDensity, rasterScale / srcDensity);
    ctx.drawImage(image, -image.width / 2, -image.height / 2);
    ctx.restore();

    const props = {
      rotated: backgroundImage.rotated,
      upscaled: backgroundImage.upscaled,
      colorMode: /** @type {'color'|'gray'|'binary'} */ (backgroundImage.colorMode),
      rotation,
      rasterScale,
      srcScale: srcDensity,
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

  /** @param {number} n - Page number */
  async addPageCanvas(n) {
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
          // Read the density from the current source slot rather than the canvas's own, so a landed background upgrade raises the target and forces a re-raster.
          const srcNow = this._usesViewerRaster()
            ? (this._srcScales[n] || props.srcScale || 1)
            : (props.srcScale ?? (props.upscaled ? 2 : 1));
          const targetScale = this._targetRasterScale(srcNow);
          if (props.rasterScale && Math.abs(targetScale / props.rasterScale - 1) > 0.01) rerender = true;
          // Reusing the canvas returns before `_getViewerSrc` runs, so a too-coarse source has to be caught here as well.
          if (!rerender && this._usesViewerRaster() && this._wantDensity() > srcNow * 1.02) {
            if (viewer.doc.images.isRenderExpensive(n)) this._ensureCapUpgrade(n);
            else rerender = true;
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
    this._drawing.add(n);
    this.pageCanvasProps[n] = null;
    const canvasPromise = this.getPageCanvas(n).then((res) => {
      if (res === SKIPPED) return SKIPPED;
      this.pageCanvasProps[n] = res.props;
      return res.canvas;
    });
    this.pageCanvases[n] = canvasPromise;
    canvasPromise.then(() => this._drawing.delete(n), () => this._drawing.delete(n));

    canvasPromise.then((canvas) => {
      if (canvas === SKIPPED) {
        // Render dropped to keep the lane bounded; leave the placeholder, allow a later re-render.
        if (this.pageCanvases[n] === canvasPromise) this.pageCanvases[n] = null;
        return;
      }
      if (this._renderSeq[n] !== seq) return;
      const pc = viewer._ensurePageContainer(n);
      if (!pc) return;
      const prev = /** @type {any} */ (pc)._canvas;
      if (prev && prev !== canvas && prev.parentNode) prev.remove();
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
    }).catch(() => {});
  }

  /** @param {number} n - Page number */
  deletePageCanvas(n) {
    this._canvasBytes.delete(n);
    this._canvasLru.delete(n);
    if (!this.pageCanvases[n]) return;
    // Supersede any in-flight render so its result is discarded rather than added after deletion.
    this._renderSeq[n] = (this._renderSeq[n] || 0) + 1;
    const canvasPromise = this.pageCanvases[n];
    this.pageCanvases[n] = null;
    const pc = this._viewer().pageContainerArr[n];
    canvasPromise.then((canvas) => {
      if (canvas && canvas !== SKIPPED) {
        /** @type {HTMLCanvasElement} */ (canvas).remove();
        if (pc && /** @type {any} */ (pc)._canvas === canvas) /** @type {any} */ (pc)._canvas = null;
      }
    }).catch(() => {});
  }

  clear() {
    for (let i = 0; i < this.pageCanvases.length; i++) {
      this.deletePageCanvas(i);
    }
    this.pageCanvases.length = 0;
    this.pageCanvasProps.length = 0;
    this._nativeBitmapPromises.length = 0;
    this._binaryBitmapPromises.length = 0;
    this._renderSeq.length = 0;
    this._drawing.clear();
    this._compressPromises.length = 0;
    this._canvasBytes.clear();
    this._canvasLru.clear();
    this._bitmapPages.clear();
    this._srcRasters.length = 0;
    this._srcScales.length = 0;
    this._srcBitmapPromises.length = 0;
    this._srcCompressPromises.length = 0;
    this._capUpgrades.length = 0;
    for (const url of this._previewUrls.values()) URL.revokeObjectURL(url);
    this._previewUrls.clear();
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
    let url = this._previewUrls.get(n);
    if (!url) {
      const blob = await viewer.doc.images.renderThumbnail(n, ViewerImageCache.previewWidth, 0.6);
      if (!blob) return;
      url = this._previewUrls.get(n) || URL.createObjectURL(blob); // a concurrent call may have won while awaiting
      this._previewUrls.set(n, url);
    }
    const pc = viewer._ensurePageContainer(n);
    const style = /** @type {?HTMLElement} */ (pc)?.style;
    if (!style || style.backgroundImage.indexOf(url) !== -1) return; // already applied (skip redundant write)
    // Safe to stretch to fill the page box: the preview shares the page aspect, so no distortion.
    style.backgroundImage = `url("${url}")`;
    style.backgroundSize = '100% 100%';
    style.backgroundRepeat = 'no-repeat';
  }

  /**
   * Show previews for the current page and a look-ahead in the scroll direction, rendering any not yet cached.
   * @param {number} curr
   * @param {number} [dir=1] - Scroll direction (+1 down, -1 up).
   */
  ensurePreviewWindow(curr, dir = 1) {
    const ahead = ViewerImageCache.previewAhead;
    const behind = ViewerImageCache.previewBehind;
    const lo = dir >= 0 ? curr - behind : curr - ahead;
    const hi = dir >= 0 ? curr + ahead : curr + behind;
    for (let i = lo; i <= hi; i++) {
      if (i >= 0) this.showPreview(i);
    }
  }

  /**
   * Render the current page and a few pages ahead and behind.
   * Bitmaps for distant pages are freed.
   * @param {number} curr
   * @param {number} [radius=ViewerImageCache.cacheRenderPages] - Pages to render on each side of `curr`.
   *   Pass 0 (render only `curr`) in the tail of a fast-scroll glide, so a window of full-page renders does not clump into the decelerating frames.
   *   Cache sweeps run regardless.
   */
  async renderAheadBehindBrowser(curr, radius = ViewerImageCache.cacheRenderPages) {
    const viewer = this._viewer();

    // Staged renders dispatch closest-to-focus first, so setting the focus makes the current page win a backlogged queue whatever its enqueue order.
    viewer.doc.images.pdfScheduler?.setViewerFocus(curr);

    this._cleanBitmapCache(curr);
    this._cleanBitmapCache2(curr);

    // Skip ahead-render when a PDF is being uploaded alongside OCR data and OCR dimensions are not yet available.
    // No re-render mechanism currently exists for that case.
    if (curr === 0 && viewer.doc.ocr?.active?.[curr] && !viewer.doc.ocr?.active?.[curr + 1] && viewer.doc.pageMetrics.length > curr + 1) {
      await this.addPageCanvas(curr);
      return;
    }

    // Send the current page first.
    // Although jobs may be reordered in the scheduler, sending them in correct order of priority still avoids issues.
    const resArr = [this.addPageCanvas(curr)];
    for (let i = 1; i <= radius; i++) {
      if (curr + i < viewer.doc.images.loadCount) {
        resArr.push(this.addPageCanvas(curr + i));
      }
      if (curr - i >= 0) {
        resArr.push(this.addPageCanvas(curr - i));
      }
    }

    await Promise.all(resArr);
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
      if (w.imageBitmap) w.imageBitmap = null;
    }).catch(() => {});
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

    let total = 0;
    for (const bytes of this._canvasBytes.values()) total += bytes;
    if (total <= ViewerImageCache.canvasCacheBytes) return;

    // Evict least-recently-viewed canvases (skipping the protected window) until back under the cap.
    const toEvict = [];
    for (const n of this._canvasLru) {
      if (total <= ViewerImageCache.canvasCacheBytes) break;
      if (Math.abs(curr - n) <= ViewerImageCache.cacheDeletePages) continue;
      toEvict.push(n);
      total -= (this._canvasBytes.get(n) || 0);
    }
    for (const n of toEvict) this.deletePageCanvas(n);
  }
}
