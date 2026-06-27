import scribe from '../../scribe.js';
/* eslint-disable import/no-cycle */
import { ScribeViewer } from '../viewer.js';
import Konva from './konva/index.js';
import { initBitmapWorker } from './bitmapWorkerMain.js';
import { range } from '../../js/utils/miscUtils.js';
import { SKIPPED } from '../../tess/TessScheduler.js';

/**
 * @typedef {Object} ImageProperties
 * @property {boolean} [rotated]
 * @property {boolean} [upscaled]
 * @property {('color'|'gray'|'binary')} [colorMode]
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
 * Per-viewer image cache. Owns its own konvaImages array; the bitmap-worker scheduler is shared
 * globally (workers are expensive) but per-page bitmap promises are per-viewer.
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
    /** @type {Array<?Promise<InstanceType<typeof Konva.Image>>>} */
    this.konvaImages = [];
    /** @type {Array<?ImageProperties>} */
    this.konvaImagesProps = [];
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

  /** @param {number} n */
  async getKonvaImage(n) {
    const viewer = this._viewer();
    const pageDims = viewer.doc.pageMetrics[n].dims;

    const backgroundImage = viewer.state.colorMode === 'binary' ? await viewer.doc.images.getBinary(n, undefined, true) : await viewer.doc.images.getNative(n, undefined, true);
    if (backgroundImage === SKIPPED) return SKIPPED;
    const image = viewer.state.colorMode === 'binary' ? await this.getBinaryBitmap(n) : await this.getNativeBitmap(n);
    if (image === SKIPPED) return SKIPPED;

    let rotation = 0;
    if (scribe.ScribeDoc.defaults.autoRotate && !backgroundImage.rotated) {
      rotation = (viewer.doc.pageMetrics[n].angle || 0) * -1;
    } else if (!scribe.ScribeDoc.defaults.autoRotate && backgroundImage.rotated) {
      rotation = (viewer.doc.pageMetrics[n].angle || 0);
    }

    // User rotation (multiple of 90) is an extra display transform on top of the deskew angle;
    // for 90/270 it swaps the displayed page dimensions.
    const userRotation = viewer.doc.pageMetrics[n].rotation || 0;
    rotation += userRotation;
    const dispW = userRotation % 180 === 90 ? pageDims.height : pageDims.width;
    const dispH = userRotation % 180 === 90 ? pageDims.width : pageDims.height;

    const pageOffsetY = viewer.getPageStop(n) ?? 30;

    const y = pageOffsetY + dispH * 0.5;

    const scaleX = backgroundImage.upscaled ? 0.5 : 1;
    const scaleY = backgroundImage.upscaled ? 0.5 : 1;

    const konvaImage = new Konva.Image({
      image,
      rotation,
      scaleX,
      scaleY,
      x: dispW * 0.5,
      y,
      offsetX: image.width * 0.5,
      offsetY: image.height * 0.5,
      strokeWidth: 4,
      stroke: 'black',
    });

    const props = {
      rotated: backgroundImage.rotated,
      upscaled: backgroundImage.upscaled,
      colorMode: /** @type {'color'|'gray'|'binary'} */ (backgroundImage.colorMode),
      n,
    };

    return { konvaImage, props };
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
  async addKonvaImage(n) {
    const viewer = this._viewer();
    if (this.konvaImages[n]) {
      let rerender = false;
      if (this.konvaImagesProps[n]) {
        if (this.konvaImagesProps[n].colorMode !== viewer.state.colorMode) {
          rerender = true;
        } else {
          const konvaImage = await this.konvaImages[n];
          if (konvaImage && konvaImage !== SKIPPED) {
            let rotation = 0;
            if (scribe.ScribeDoc.defaults.autoRotate && !this.konvaImagesProps[n].rotated) {
              rotation = (viewer.doc.pageMetrics[n].angle || 0) * -1;
            } else if (!scribe.ScribeDoc.defaults.autoRotate && this.konvaImagesProps[n].rotated) {
              rotation = (viewer.doc.pageMetrics[n].angle || 0);
            }
            rotation += viewer.doc.pageMetrics[n].rotation || 0;

            if (Math.abs(konvaImage.rotation() - rotation) > 0.01) {
              konvaImage.rotation(rotation);
              if (Math.abs(viewer.state.cp.n - n) < 2) viewer.layerBackground.batchDraw();
            }
          }
        }
      }
      if (!rerender) return;
    }

    if (viewer.getPageStop(n) === null) return;

    if (this.konvaImages[n]) {
      this.konvaImages[n].then((konvaImage) => {
        if (konvaImage && konvaImage !== SKIPPED) konvaImage.destroy();
      }).catch(() => {});
    }

    // Each render is stamped. Only the latest render for this page is applied.
    // A slower earlier render completing out of order (LIFO can run a newer request first) cannot overwrite a newer one.
    // The superseding call (or a delete) destroys the discarded image.
    const seq = (this._renderSeq[n] || 0) + 1;
    this._renderSeq[n] = seq;

    this.konvaImagesProps[n] = null;
    const konvaImagePromise = this.getKonvaImage(n).then((res) => {
      if (res === SKIPPED) return SKIPPED;
      this.konvaImagesProps[n] = res.props;
      return res.konvaImage;
    });
    this.konvaImages[n] = konvaImagePromise;

    konvaImagePromise.then((konvaImage) => {
      if (konvaImage === SKIPPED) {
        // Render dropped to keep the lane bounded; leave the placeholder, allow a later re-render.
        if (this.konvaImages[n] === konvaImagePromise) this.konvaImages[n] = null;
        return;
      }
      if (this._renderSeq[n] !== seq) return;
      viewer.layerBackground.add(konvaImage);
      if (viewer.placeholderRectArr[n]) viewer.placeholderRectArr[n].hide();
      if (Math.abs(viewer.state.cp.n - n) < 2) viewer.layerBackground.batchDraw();
    }).catch(() => {});
  }

  /** @param {number} n - Page number */
  deleteKonvaImage(n) {
    if (!this.konvaImages[n]) return;
    // Supersede any in-flight render so its result is discarded rather than added after deletion.
    this._renderSeq[n] = (this._renderSeq[n] || 0) + 1;
    const konvaImagePromise = this.konvaImages[n];
    this.konvaImages[n] = null;
    konvaImagePromise.then((konvaImage) => {
      if (konvaImage && konvaImage !== SKIPPED) konvaImage.destroy();
    }).catch(() => {});
  }

  clear() {
    for (let i = 0; i < this.konvaImages.length; i++) {
      this.deleteKonvaImage(i);
    }
    this.konvaImages.length = 0;
    this.konvaImagesProps.length = 0;
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
      await this.addKonvaImage(curr);
      return;
    }

    const resArr = [];
    // Enqueue outermost pages first and the current page last, so that under the scheduler's LIFO
    // viewer lane the current page renders first, then its neighbors outward.
    for (let i = ViewerImageCache.cacheRenderPages; i >= 1; i--) {
      if (curr + i < viewer.doc.images.loadCount) {
        resArr.push(this.addKonvaImage(curr + i));
      }
      if (curr - i >= 0) {
        resArr.push(this.addKonvaImage(curr - i));
      }
    }
    resArr.push(this.addKonvaImage(curr));

    await Promise.all(resArr);
  }

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

  _cleanBitmapCache2(curr) {
    const viewer = this._viewer();
    for (let i = 0; i < viewer.doc.images.pageCount; i++) {
      if (Math.abs(curr - i) > ViewerImageCache.cacheDeletePages) {
        if (viewer.placeholderRectArr[i]) viewer.placeholderRectArr[i].show();
        this.deleteKonvaImage(i);
      }
    }
  }
}
