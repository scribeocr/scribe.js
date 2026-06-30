import scribe from '../../scribe.js';
/* eslint-disable import/no-cycle */
import { ScribeViewer } from '../viewer.js';
import { initBitmapWorker } from './bitmapWorkerMain.js';
import { range } from '../../js/utils/miscUtils.js';
import { SKIPPED } from '../../tess/TessScheduler.js';

/**
 * @typedef {Object} ImageProperties
 * @property {boolean} [rotated]
 * @property {boolean} [upscaled]
 * @property {('color'|'gray'|'binary')} [colorMode]
 * @property {number} [rotation]
 * @property {number} [rasterScale] - On-screen device-pixel density the backing store was rastered at (see `_targetRasterScale`).
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

  /** Number of pages ahead and behind the current page to retain in memory before deleting. */
  static cacheDeletePages = 5;

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
   * On-screen device-pixel density to rasterize a page canvas at: the zoom level times the display's `devicePixelRatio`,
   * clamped to the source raster's oversample factor (`over`) since there is no detail to draw beyond 1:1.
   * @param {number} over - Source raster oversample factor (2 for upscaled/binary, else 1).
   * @returns {number}
   */
  _targetRasterScale(over) {
    const dpr = window.devicePixelRatio || 1;
    return Math.min(over, Math.max(0.01, (this._viewer().zoomLevel || 1) * dpr));
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

    const backgroundImage = viewer.state.colorMode === 'binary' ? await viewer.doc.images.getBinary(n, undefined, true) : await viewer.doc.images.getNative(n, undefined, true);
    if (backgroundImage === SKIPPED) return SKIPPED;
    const image = viewer.state.colorMode === 'binary' ? await this.getBinaryBitmap(n) : await this.getNativeBitmap(n);
    if (image === SKIPPED) return SKIPPED;

    const rotation = this._displayRotation(n, backgroundImage.rotated);

    // User rotation (multiple of 90) is an extra display transform on top of the deskew angle;
    // for 90/270 it swaps the displayed page dimensions.
    const userRotation = viewer.doc.pageMetrics[n].rotation || 0;
    const dispW = userRotation % 180 === 90 ? pageDims.height : pageDims.width;
    const dispH = userRotation % 180 === 90 ? pageDims.width : pageDims.height;

    // Native oversample factor of the source raster: a "binary"/upscaled raster is rendered at 2x the display size.
    const over = backgroundImage.upscaled ? 2 : 1;
    // Size the backing store to the on-screen pixel density, not the page's content size, so the shrink-to-fit
    // is a high-quality `drawImage` here instead of a bilinear compositor downscale of the zoom layer.
    const rasterScale = this._targetRasterScale(over);

    const canvas = /** @type {HTMLCanvasElement} */ (document.createElement('canvas'));
    canvas.className = 'scribe-layer-image';
    canvas.width = Math.max(1, Math.round(dispW * rasterScale));
    canvas.height = Math.max(1, Math.round(dispH * rasterScale));
    Object.assign(canvas.style, {
      position: 'absolute', left: '0', top: '0', width: `${dispW}px`, height: `${dispH}px`, pointerEvents: 'none',
    });
    const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d'));
    ctx.imageSmoothingQuality = 'high';
    ctx.save();
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.rotate(rotation * (Math.PI / 180));
    // The source raster is `dispW * over` px wide; scale it to fill the `dispW * rasterScale` px backing store.
    ctx.scale(rasterScale / over, rasterScale / over);
    ctx.drawImage(image, -image.width / 2, -image.height / 2);
    ctx.restore();

    const props = {
      rotated: backgroundImage.rotated,
      upscaled: backgroundImage.upscaled,
      colorMode: /** @type {'color'|'gray'|'binary'} */ (backgroundImage.colorMode),
      rotation,
      rasterScale,
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
          // The backing store is sized to the on-screen pixel density, so re-raster when that density moves more than 1%
          // (a redraw at the same zoom reuses the existing canvas).
          const targetScale = this._targetRasterScale(props.upscaled ? 2 : 1);
          if (props.rasterScale && Math.abs(targetScale / props.rasterScale - 1) > 0.01) rerender = true;
        }
      }
      if (!rerender) return;
    }

    if (viewer.getPageStop(n) === null) return;

    if (this.pageCanvases[n]) {
      this.pageCanvases[n].then((canvas) => {
        if (canvas && canvas !== SKIPPED && /** @type {HTMLCanvasElement} */ (canvas).parentNode) /** @type {HTMLCanvasElement} */ (canvas).remove();
      }).catch(() => {});
    }

    // Each render is stamped. Only the latest render for this page is applied.
    // A slower earlier render completing out of order (LIFO can run a newer request first) cannot overwrite a newer one.
    // The superseding call (or a delete) removes the discarded canvas.
    const seq = (this._renderSeq[n] || 0) + 1;
    this._renderSeq[n] = seq;

    this.pageCanvasProps[n] = null;
    const canvasPromise = this.getPageCanvas(n).then((res) => {
      if (res === SKIPPED) return SKIPPED;
      this.pageCanvasProps[n] = res.props;
      return res.canvas;
    });
    this.pageCanvases[n] = canvasPromise;

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
    }).catch(() => {});
  }

  /** @param {number} n - Page number */
  deletePageCanvas(n) {
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
  }

  /**
   * Render the current page and a few pages ahead and behind. Bitmaps for distant pages are freed.
   * @param {number} curr
   */
  async renderAheadBehindBrowser(curr) {
    const viewer = this._viewer();

    this._cleanBitmapCache(curr);
    this._cleanBitmapCache2(curr);

    // Skip ahead-render when a PDF is being uploaded alongside OCR data and OCR dimensions are not yet available.
    // No re-render mechanism currently exists for that case.
    if (curr === 0 && viewer.doc.ocr?.active?.[curr] && !viewer.doc.ocr?.active?.[curr + 1] && viewer.doc.pageMetrics.length > curr + 1) {
      await this.addPageCanvas(curr);
      return;
    }

    const resArr = [];
    // Enqueue outermost pages first and the current page last, so that under the scheduler's LIFO
    // viewer lane the current page renders first, then its neighbors outward.
    for (let i = ViewerImageCache.cacheRenderPages; i >= 1; i--) {
      if (curr + i < viewer.doc.images.loadCount) {
        resArr.push(this.addPageCanvas(curr + i));
      }
      if (curr - i >= 0) {
        resArr.push(this.addPageCanvas(curr - i));
      }
    }
    resArr.push(this.addPageCanvas(curr));

    await Promise.all(resArr);
  }

  /** @param {number} curr */
  _cleanBitmapCache(curr) {
    const viewer = this._viewer();
    for (let i = 0; i < viewer.doc.images.pageCount; i++) {
      if (Math.abs(curr - i) > ViewerImageCache.cacheDeletePages) {
        if (viewer.doc.images.native[i]) {
          Promise.resolve(viewer.doc.images.native[i]).then((img) => {
            // A dropped render resolves to the SKIPPED symbol (no bitmap to free). Skip it.
            if (img && img !== SKIPPED) img.imageBitmap = null;
          }).catch(() => {});
        }
        if (viewer.doc.images.binary[i]) {
          Promise.resolve(viewer.doc.images.binary[i]).then((img) => {
            if (img && img !== SKIPPED) img.imageBitmap = null;
          }).catch(() => {});
        }
      }
    }
  }

  /** @param {number} curr */
  _cleanBitmapCache2(curr) {
    const viewer = this._viewer();
    for (let i = 0; i < viewer.doc.images.pageCount; i++) {
      if (Math.abs(curr - i) > ViewerImageCache.cacheDeletePages) {
        this.deletePageCanvas(i);
      }
    }
  }
}
