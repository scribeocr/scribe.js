import {
  PageMetrics,
} from '../objects/pageMetricsObjects.js';
import { reassignOutlineIds } from '../objects/outlineObjects.js';

import { gs } from '../generalWorkerMain.js';
import { imageUtils, ImageWrapper } from '../objects/imageObjects.js';
import { range } from '../utils/miscUtils.js';
import { opt } from './app.js';

import { initPdfScheduler } from '../pdfWorkerMain.js';
import { scribeDocDefaults } from './scribeDocDefaults.js';
import { SKIPPED } from '../../tess/TessScheduler.js';
import { ca } from '../canvasAdapter.js';

/** @typedef {import('./scribeDoc.js').ScribeDoc} ScribeDoc */

// Background renders can fail when they reuse a viewer render that is then dropped (skipped).
// The background render retries when this happens.
// This cap is an arbitrarily high number, and hitting indicates a logic error.
const MAX_SKIPPED_RETRY = 32;

/** @type {?boolean} */
let _sabCapability = null;
/**
 * Check whether `SharedArrayBuffer` can actually be allocated and shared
 * across workers in the current runtime. In Node (worker_threads) this is
 * unconditional; in browsers it requires COOP/COEP / `crossOriginIsolated`.
 * Probe result is memoized — capabilities don't change at runtime.
 */
function canUseSharedArrayBuffer() {
  if (_sabCapability !== null) return _sabCapability;
  try {
    if (typeof SharedArrayBuffer === 'undefined') return (_sabCapability = false);
    if (typeof process !== 'undefined') {
      // eslint-disable-next-line no-new
      new SharedArrayBuffer(1);
      return (_sabCapability = true);
    }
    if (globalThis.crossOriginIsolated !== true) return (_sabCapability = false);
    // eslint-disable-next-line no-new
    new SharedArrayBuffer(1);
    return (_sabCapability = true);
  } catch {
    return (_sabCapability = false);
  }
}

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

let renderSourceIdCounter = 0;

/**
 * One render origin: a PDF's worker pool and its bytes.
 * Its `id` space is separate from `ScribeDoc.id`.
 * Sources are shared by reference and refcounted,
 * so a page copied between documents keeps rendering from its origin without reloading bytes or spawning workers.
 */
export class RenderSource {
  /** @type {number} Process-unique source id. */
  id;

  /** @type {'pdf'} Kind of origin. Image-input pages are self-contained (their blob rides in `nativeSrc`) and never use a source. */
  kind = 'pdf';

  /** @type {?ArrayBuffer} Original PDF bytes; used to (re)load the pool and, on export, to subset this source's pages. */
  pdfData = null;

  /** @type {?(import('../pdfWorkerMain.js').PdfScheduler | import('../pdfWorkerMain.js').PdfSchedulerInProcess)} */
  scheduler = null;

  /** @type {?Promise<import('../pdfWorkerMain.js').PdfScheduler | import('../pdfWorkerMain.js').PdfSchedulerInProcess>} */
  #schedulerReady = null;

  /** @type {number} Live documents referencing this source; the pool is terminated only when this returns to 0. */
  refCount = 0;

  /**
   * The source document's optimized substitute fonts, carried for overlay fidelity of pages copied out of it.
   * Placeholder in v1 (the basic editor is invisible-text-only), populated when font fidelity lands.
   * @type {?Object}
   */
  optFonts = null;

  /** @type {?Object} The source document's user-uploaded fonts, carried the same way. Placeholder in v1. */
  uploadedFonts = null;

  /** @param {number} id */
  constructor(id) { this.id = id; }

  /**
   * Get or lazily initialize this source's dedicated PDF worker pool (or the in-process equivalent when `opt.inProcess` is set).
   * @returns {Promise<import('../pdfWorkerMain.js').PdfScheduler | import('../pdfWorkerMain.js').PdfSchedulerInProcess>}
   */
  getScheduler = async () => {
    if (this.scheduler) return this.scheduler;
    if (!this.#schedulerReady) {
      this.#schedulerReady = initPdfScheduler().then((s) => {
        this.scheduler = s;
        return s;
      });
    }
    return this.#schedulerReady;
  };

  terminate = async () => {
    if (this.scheduler) {
      await this.scheduler.terminate();
      this.scheduler = null;
      this.#schedulerReady = null;
    }
  };
}

/**
 * Per-document image cache and registry of `RenderSource`s.
 * Each page resolves its raster through `pageMetrics[n].sourceId`, so a page copied from another document renders from its origin.
 */
export class ImageStore {
  /** @type {Array<ImageWrapper|Promise<ImageWrapper>>} */
  nativeSrc = [];

  /** @type {Array<ImageWrapper|Promise<ImageWrapper>>} */
  native = [];

  /** @type {Array<ImageWrapper|Promise<ImageWrapper>>} */
  binary = [];

  // These arrays store the properties of the images.
  // While they are redundant with the properties stored in the ImageWrapper objects,
  // they still need to exist to determine whether the image needs to be re-rendered.
  // The imagewrappers are stored as promises, and needing to await them would break things without further changes.
  // See: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Operators/await#control_flow_effects_of_await
  /** @type {Array<ImageProperties>} */
  nativeProps = [];

  /** @type {Array<ImageProperties>} */
  binaryProps = [];

  /**
   * Small low-resolution JPEG page previews (one Blob promise per page), rendered on demand by `renderThumbnail`.
   * Fresh per document (a new doc gets a new `ImageStore`), so it never needs manual clearing.
   * @type {Array<Promise<?Blob> | undefined>}
   */
  thumbnails = [];

  /**
   * This document's render sources, keyed by source id: its own primary source plus any copied in from other documents.
   * Image-input pages are self-contained (their raster is in `nativeSrc`) and are not in this map.
   * @type {Map<number, RenderSource>}
   */
  sources = new Map();

  /** @type {?number} Id of this document's own source in `sources` (the one `openMainPDF` loads into). */
  primarySourceId = null;

  /**
   * The owning document.
   * @type {ScribeDoc}
   */
  #doc;

  /**
   * @param {ScribeDoc} doc - The owning document.
   */
  constructor(doc) {
    this.#doc = doc;
  }

  /** Owning document's page metrics array (held by reference, mutated in place by the doc). */
  get #pageMetrics() { return this.#doc.pageMetrics; }

  /**
   * @param {ImagePropertiesRequest} props
   * @param {ImageWrapper} inputImage
   * @param {number} n - Page number
   * @param {boolean} [binary=false]
   * @returns {ImageProperties}
   */
  fillPropsDefault = (props, inputImage, n, binary = false) => {
    /** @type {"binary" | "color" | "gray"} */
    let colorMode = 'binary';
    if (!binary) {
      const color = props?.colorMode === 'color' || !props?.colorMode && scribeDocDefaults.colorMode === 'color';
      colorMode = color ? 'color' : 'gray';
    }

    let pageAngle = this.#pageMetrics[n].angle || 0;
    if (Math.abs(pageAngle) < 0.05) pageAngle = 0;

    // If no preference is specified for rotation, default to true.
    const rotate = props?.rotated !== false && inputImage.rotated === false;
    const angleArg = rotate ? pageAngle * (Math.PI / 180) * -1 : 0;

    // If no preference is specified for upscaling, default to false.
    const upscaleArg = props?.upscaled || false;

    const isRotated = Boolean(angleArg) || inputImage.rotated;
    const isUpscaled = upscaleArg || inputImage.upscaled;

    return {
      rotated: isRotated, upscaled: isUpscaled, colorMode, n,
    };
  };

  /** This document's own (primary) render source, or `null` before one is created. @returns {?RenderSource} */
  get #primarySource() {
    return this.primarySourceId != null ? this.sources.get(this.primarySourceId) ?? null : null;
  }

  /** Get (creating if needed) this document's own render source. @returns {RenderSource} */
  #ensurePrimarySource = () => {
    let src = this.#primarySource;
    if (!src) {
      src = new RenderSource(++renderSourceIdCounter);
      src.refCount = 1;
      this.sources.set(src.id, src);
      this.primarySourceId = src.id;
    }
    return src;
  };

  /**
   * Resolve the render source for a page.
   * `sourceId` is `null` for this document's own pages (the primary source) and a concrete id for pages copied in from another document.
   * @param {import('../objects/pageMetricsObjects.js').PageMetrics} [pm]
   * @returns {RenderSource}
   */
  resolveSource = (pm) => {
    const id = pm?.sourceId ?? this.primarySourceId;
    return (id != null && this.sources.get(id)) || this.#ensurePrimarySource();
  };

  /**
   * Loaded PDF bytes for this document's own source.
   * @type {?ArrayBuffer}
   */
  get pdfData() { return this.#primarySource?.pdfData ?? null; }

  set pdfData(v) { this.#ensurePrimarySource().pdfData = v; }

  /**
   * The primary source's worker pool once initialized (else `null`). Accessor over the primary `RenderSource`.
   * @type {?(import('../pdfWorkerMain.js').PdfScheduler | import('../pdfWorkerMain.js').PdfSchedulerInProcess)}
   */
  get pdfScheduler() { return this.#primarySource?.scheduler ?? null; }

  /**
   * Get or lazily initialize this document's own PDF worker pool (or the in-process equivalent when `opt.inProcess` is set).
   * Delegates to the primary `RenderSource`.
   * @returns {Promise<import('../pdfWorkerMain.js').PdfScheduler | import('../pdfWorkerMain.js').PdfSchedulerInProcess>}
   */
  getPdfScheduler = async () => this.#ensurePrimarySource().getScheduler();

  loadCount = 0;

  pageCount = 0;

  /**
   * The dimensions that each page would be, if it was rendered at 300 DPI.
   * @type {Array<dims>}
   */
  pdfDims300 = [];

  inputModes = {
    pdf: false,
    image: false,
  };

  colorModeDefault = 'gray';

  /**
   * Render page `n` from its source and return it as an `ImageWrapper`.
   * @param {number} n - Page number
   * @param {boolean} [color=false]
   * @param {boolean} [forViewer=false]
   * @param {boolean} [wantBitmap=false] - Take the render as a transferable ImageBitmap (viewer display path) rather than a PNG data URL.
   *   Ignored outside a browser.
   * @returns {Promise<ImageWrapper | typeof SKIPPED>}
   */
  #renderImage = async (n, color = false, forViewer = false, wantBitmap = false) => {
    if (this.inputModes.image) {
      return this.nativeSrc[n];
    } if (this.inputModes.pdf) {
      const colorMode = color ? 'color' : 'gray';
      const pm = this.#pageMetrics[n];
      // Display slot `n` may hold a page copied from another document. Render it from its own source, not this doc's.
      const pdfScheduler = await this.resolveSource(pm).getScheduler();
      const targetWidth = pm.dims.width;
      const dpi = 300 * (targetWidth / this.pdfDims300[n].width);
      // Display slot `n` may have been reordered. Raster its source page, not its position.
      const sourcePageN = pm.sourcePageN ?? n;
      // The viewer's display path takes the rendered pixels as a transferable ImageBitmap, skipping the PNG encode/decode round-trip.
      // Bitmap output needs OffscreenCanvas, so it is browser-only and Node always renders to PNG.
      const outputFormat = wantBitmap && typeof OffscreenCanvas !== 'undefined' ? 'bitmap' : 'png';
      const result = await pdfScheduler.renderPdfPage({
        pageIndex: sourcePageN, colorMode, dpi, outputFormat,
      }, forViewer);
      // The render was dropped from the queue (e.g. evicted to keep the viewer lane bounded).
      if (result === SKIPPED) return SKIPPED;
      // A failure/blank render always returns a `dataUrl`, even when a bitmap was requested.
      if (result.bitmap) return ImageWrapper.fromBitmap(n, result.bitmap, result.colorMode);
      return new ImageWrapper(n, result.dataUrl, result.colorMode);
    }
    throw new Error('Attempted to render image without image input provided.');
  };

  /**
   * Free the decoded bitmap(s) for page `n` to bound viewer memory (called for pages outside the viewer's retention window).
   * @param {number} n - Page number
   */
  releaseBitmapCache = (n) => {
    this.#releaseBitmap(this.native, this.nativeProps, n);
    this.#releaseBitmap(this.binary, this.binaryProps, n);
  };

  /**
   * Release the decoded bitmap for page `n` from one image store, dropping the whole entry for a bitmap-only wrapper or freeing just the bitmap for a string-backed one.
   * @param {Array<?Promise<ImageWrapper|typeof SKIPPED>|?ImageWrapper>} store
   * @param {Array<?ImageProperties>} propsStore
   * @param {number} n - Page number
   */
  // eslint-disable-next-line class-methods-use-this
  #releaseBitmap(store, propsStore, n) {
    const entry = store[n];
    if (!entry) return;
    Promise.resolve(entry).then((img) => {
      if (!img || img === SKIPPED) return;
      if (img.src == null) {
        // With no `src`, nulling this wrapper's bitmap would strand an in-flight consumer still holding it, so drop the store entry instead and let a revisit re-render.
        if (store[n] === entry) {
          store[n] = undefined;
          propsStore[n] = undefined;
        }
      } else if (img.imageBitmap) {
        // String-backed wrapper: free only the decoded bitmap so the page can re-decode from `src` on revisit.
        img.imageBitmap = null;
      }
    }).catch(() => {});
  }

  /**
   * @param {ImageWrapper} inputImage
   * @param {number} n - Page number
   * @param {ImagePropertiesRequest} [props] - Image properties needed.
   *  Image properties should only be defined if needed, as they can require the image to be re-rendered.
   * @param {boolean} [saveNativeImage=true] - Whether the native image should be saved.
   */
  transformImage = async (inputImage, n, props, saveNativeImage = true) => {
    let pageAngle = this.#pageMetrics[n].angle || 0;
    if (Math.abs(pageAngle) < 0.05) pageAngle = 0;

    // If no preference is specified for rotation, default to true.
    const rotate = props?.rotated !== false && inputImage.rotated === false;
    const angleArg = rotate ? pageAngle * (Math.PI / 180) * -1 : 0;

    // If no preference is specified for upscaling, default to false.
    const upscaleArg = props?.upscaled || false;

    await gs.getGeneralScheduler();

    // Materialize `src` in case the input is a viewer-rendered bitmap-backed wrapper (no-op otherwise).
    const inputSrc = inputImage.ensureSrc();

    const resPromise = (async () => {
      // Wait for non-rotated version before replacing with promise
      await gs.initTesseract({ anyOk: true });
      return gs.recognize({
        image: inputSrc,
        options: { rotateRadians: angleArg, upscale: upscaleArg },
        output: {
          imageBinary: true, imageColor: saveNativeImage, debug: true, text: false, hocr: false, tsv: false, blocks: false,
        },
      });
    })();

    const isRotated = Boolean(angleArg) || inputImage.rotated;

    /** @type {?Promise<ImageWrapper>} */
    let native = null;
    if (saveNativeImage) {
      native = resPromise.then(async (res) => new ImageWrapper(n, /** @type {string} */(/** @type {unknown} */(res.imageColor)), inputImage.colorMode, isRotated, upscaleArg));
    }

    const binary = resPromise.then(async (res) => new ImageWrapper(n, /** @type {string} */(/** @type {unknown} */(res.imageBinary)), 'binary', isRotated, upscaleArg));

    return { native, binary };
  };

  /**
   * @param {number} n - Page number
   * @param {ImagePropertiesRequest} [props] - Image properties needed.
   *  Image properties should only be defined if needed, as they can require the image to be re-rendered.
   * @param {boolean} [nativeOnly=true]
   * @param {boolean} [forViewer=false] - Whether this render serves the on-screen viewer.
   *    Viewer renders are served ahead of background work, newest-first, and may be dropped (resolving to SKIPPED) when superseded.
   */
  getImages = (n, props, nativeOnly = true, forViewer = false) => {
    if (!this.inputModes.image && !this.inputModes.pdf) {
      return { native: undefined, binary: undefined };
    }

    const significantRotation = Math.abs(this.#pageMetrics[n].angle || 0) > 0.05;

    const newNative = !this.native[n] || !imageUtils.compatible(this.nativeProps[n], props, significantRotation);
    const newBinary = !nativeOnly && (!this.binary[n] || !imageUtils.compatible(this.binaryProps[n], props, significantRotation));

    if (newNative || newBinary) {
      const renderRaw = !this.native[n] || imageUtils.requiresUndo(this.nativeProps[n], props);
      const propsRaw = {
        colorMode: scribeDocDefaults.colorMode, rotated: false, upscaled: false, n,
      };
      const renderTransform = newBinary || !imageUtils.compatible(propsRaw, props, significantRotation);

      const propsNew = renderRaw ? propsRaw : JSON.parse(JSON.stringify(this.nativeProps[n]));
      propsNew.colorMode = props?.colorMode || propsNew.colorMode;
      propsNew.rotated = props?.rotated ?? propsNew.rotated;
      propsNew.upscaled = props?.upscaled ?? propsNew.upscaled;
      const propsNewBinary = JSON.parse(JSON.stringify(propsNew));
      propsNewBinary.colorMode = 'binary';

      const inputNative = this.native[n];
      if (newNative) this.nativeProps[n] = propsNew;
      if (newBinary) this.binaryProps[n] = propsNewBinary;
      const res = (async () => {
        /** @type {?ImageWrapper} */
        let img1;
        if (renderRaw) {
          const color = props?.colorMode === 'color' || !props?.colorMode && scribeDocDefaults.colorMode === 'color';
          // Take the fast ImageBitmap path only when this render feeds the viewer directly with no follow-on transform.
          img1 = await this.#renderImage(n, color, forViewer, forViewer && !renderTransform);
        } else {
          img1 = await inputNative;
        }
        // Render dropped from the queue: propagate the sentinel so callers leave a placeholder.
        // The cache slot is cleared below so a later request for this page re-renders.
        if (img1 === SKIPPED) return { native: SKIPPED, binary: SKIPPED };
        if (renderTransform) {
          return this.transformImage(img1, n, props, true);
        }
        return { native: img1, binary: null };
      })();

      if (newNative) {
        const nativeP = res.then((r) => r.native);
        this.native[n] = nativeP;
        nativeP.then((img) => {
          if (img === SKIPPED && this.native[n] === nativeP) {
            this.native[n] = undefined;
            this.nativeProps[n] = undefined;
          }
        }).catch(() => {});
      }
      if (newBinary) {
        const binaryP = res.then((r) => r.binary);
        this.binary[n] = binaryP;
        binaryP.then((img) => {
          if (img === SKIPPED && this.binary[n] === binaryP) {
            this.binary[n] = undefined;
            this.binaryProps[n] = undefined;
          }
        }).catch(() => {});
      }
    }

    return { native: this.native[n], binary: this.binary[n] };
  };

  /**
   * @param {number} n
   * @param {ImagePropertiesRequest} [props]
   * @param {boolean} [forViewer=false] - Whether this render serves the on-screen viewer.
   *    Viewer renders are served ahead of background work, newest-first, and may be dropped (resolving to SKIPPED) when superseded.
   */
  getNative = async (n, props, forViewer) => {
    // Viewer callers want SKIPPED so they can leave a placeholder; pass it through.
    if (forViewer) return this.getImages(n, props, true, true).native;
    // Background (non-viewer) callers (OCR, export, coordinates, ...) cannot handle SKIPPED.
    // A reused, then dropped, viewer render clears its own cache slot before we observe SKIPPED,
    // so re-requesting renders fresh on the undroppable FIFO.
    for (let i = 0; i < MAX_SKIPPED_RETRY; i++) {
      const native = await this.getImages(n, props, true, false).native;
      if (native !== SKIPPED) return native;
    }
    throw new Error(`getNative: render for page ${n} repeatedly dropped (SKIPPED).`);
  };

  /**
   * Render (or return from cache) a small low-resolution JPEG preview of page `n`.
   *
   * For PDF input the page is drawn directly at thumbnail resolution and JPEG-encoded in one pass by the renderer,
   * so it never populates the full-resolution `native[]` cache and the few-KB Blob stays cheap to keep resident across a large document.
   * The render uses the background lane (`forViewer = false`) so it can never delay an on-screen viewer render.
   * For image input the full-resolution page image is already in memory, so it is drawn onto a small canvas and JPEG-encoded the same way.
   * @param {number} n - Page index.
   * @param {number} [widthPx=150] - Target preview width in CSS px.
   * @param {number} [quality=0.6] - JPEG quality (0-1).
   * @returns {Promise<?Blob>} A JPEG Blob, or `null` if the page cannot be rendered.
   */
  renderThumbnail = (n, widthPx = 150, quality = 0.6) => {
    if (this.thumbnails[n]) return this.thumbnails[n];
    if (!this.inputModes.image && !this.inputModes.pdf) return Promise.resolve(null);

    const p = (async () => {
      if (this.inputModes.pdf) {
        const dims300 = this.pdfDims300[n];
        if (!dims300) return null;
        const pm = this.#pageMetrics[n];
        // Display slot `n` may hold a page copied from another document, so render it from its own source, not this doc's.
        const pdfScheduler = await this.resolveSource(pm).getScheduler();
        const dpi = 300 * (widthPx / dims300.width);
        // Display slot `n` may have been reordered, so raster its source page, not its position.
        const sourcePageN = pm?.sourcePageN ?? n;
        const result = await pdfScheduler.renderPdfPage({
          pageIndex: sourcePageN, colorMode: 'color', dpi, outputFormat: 'jpeg', quality,
        }, false);
        return result && result !== SKIPPED ? result.blob ?? null : null;
      }
      const native = await this.getNative(n);
      if (!native) return null;
      const bitmap = await ca.getImageBitmap(native.src);
      const canvas = ca.makeCanvas(widthPx, Math.max(1, Math.round(widthPx * (bitmap.height / bitmap.width))));
      const ctx = canvas.getContext('2d');
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      ca.closeDrawable(bitmap);
      // `type` for browsers, `mime` for the Node canvas fork: both are needed to get a JPEG (not PNG) Blob.
      const blob = await canvas.convertToBlob({ type: 'image/jpeg', mime: 'image/jpeg', quality });
      ca.closeDrawable(canvas);
      return blob;
    })();

    this.thumbnails[n] = p;
    // Clear the cache slot if the render failed, so a later call can retry.
    p.then((r) => { if (r === null && this.thumbnails[n] === p) this.thumbnails[n] = undefined; })
      .catch(() => { if (this.thumbnails[n] === p) this.thumbnails[n] = undefined; });
    return p;
  };

  /**
   * @param {number} n
   * @param {ImagePropertiesRequest} [props]
   * @param {boolean} [forViewer=false] - Whether this render serves the on-screen viewer.
   *    Viewer renders are served ahead of background work, newest-first, and may be dropped (resolving to SKIPPED) when superseded.
   */
  getBinary = async (n, props, forViewer) => {
    if (forViewer) return this.getImages(n, props, false, true).binary;
    for (let i = 0; i < MAX_SKIPPED_RETRY; i++) {
      const binary = await this.getImages(n, props, false, false).binary;
      if (binary !== SKIPPED) return binary;
    }
    throw new Error(`getBinary: render for page ${n} repeatedly dropped (SKIPPED).`);
  };

  /**
   * Pre-render pages.
   * This is generally not required, as individual images are rendered as needed.
   * The primary use case is reducing latency in the UI by rendering images in advance.
   *
   * @param {Object} params
   * @param {boolean} params.binary - Whether to render binary images.
   * @param {?Array<number>} [params.pageArr=null] - Array of 0-based page indices to render. Overrides min/max when provided.
   * @param {number} [params.min=0] - Min page to render (used when pageArr is not provided).
   * @param {number} [params.max=0] - Max page to render (used when pageArr is not provided).
   * @param {ImagePropertiesRequest} [params.props]
   */
  preRenderRange = async ({
    binary, pageArr = null, min = 0, max = 0, props,
  }) => {
    const pagesArr = pageArr || range(min, max);
    if (binary) {
      await Promise.all(pagesArr.map((n) => this.getBinary(n, props).then(() => {
        this.#doc.progressHandler({ n, type: 'render', info: { } });
      })));
    } else {
      await Promise.all(pagesArr.map((n) => this.getNative(n, props).then(() => {
        this.#doc.progressHandler({ n, type: 'render', info: { } });
      })));
    }
  };

  clear = () => {
    this.nativeSrc = [];
    this.native = [];
    this.binary = [];
    this.inputModes.image = false;
    this.inputModes.pdf = false;
    this.pageCount = 0;
    this.pdfDims300.length = 0;
    this.loadCount = 0;
    this.nativeProps.length = 0;
    this.binaryProps.length = 0;
  };

  terminate = async () => {
    this.clear();
    // Release this document's refcount on each source, terminating only sources no other document still holds.
    const orphaned = [];
    for (const src of this.sources.values()) {
      src.refCount -= 1;
      if (src.refCount <= 0) orphaned.push(src);
    }
    this.sources.clear();
    this.primarySourceId = null;
    await Promise.all(orphaned.map((s) => s.terminate()));
  };

  /**
   * @param {ArrayBuffer | Uint8Array | Blob} fileData
   * @param {Object} [options]
   * @param {boolean} [options.usePdfSharedBuffer] - Share the loaded PDF across PDF workers via
   *    SharedArrayBuffer instead of cloning per worker. Defaults to `opt.usePdfSharedBuffer`.
   */
  openMainPDF = async (fileData, options = {}) => {
    const usePdfSharedBuffer = options.usePdfSharedBuffer ?? opt.usePdfSharedBuffer;

    /** @type {ArrayBuffer} */
    let arrayBuffer;
    if (fileData instanceof ArrayBuffer) {
      arrayBuffer = fileData;
    } else if (typeof fileData.arrayBuffer === 'function') {
      arrayBuffer = await fileData.arrayBuffer();
    } else {
      arrayBuffer = fileData.buffer.slice(fileData.byteOffset, fileData.byteOffset + fileData.byteLength);
    }
    this.pdfData = arrayBuffer;

    /** @type {Uint8Array} */
    let pdfBytes;
    if (usePdfSharedBuffer && canUseSharedArrayBuffer()) {
      // Allocate a SharedArrayBuffer once; all workers will receive a view
      // over this same buffer via postMessage (SAB is shared, not cloned).
      const sab = new SharedArrayBuffer(arrayBuffer.byteLength);
      pdfBytes = new Uint8Array(sab);
      pdfBytes.set(new Uint8Array(arrayBuffer));
    } else {
      pdfBytes = new Uint8Array(arrayBuffer);
    }

    // Initialize dedicated PDF workers and load the PDF into all of them.
    // Each worker creates its own ObjectCache and page tree.
    const pdfScheduler = await this.getPdfScheduler();
    const { pageCount, pages, outline } = await pdfScheduler.loadPdfInAllWorkers(pdfBytes);

    this.pageCount = pageCount;
    // The outline was parsed in the worker, so renumber its ids from the main-thread counter to keep subsequent edits from colliding.
    this.#doc.outline = reassignOutlineIds(outline || []);

    this.pdfDims300.length = 0;
    for (const page of pages) {
      const widthPts = Math.abs(page.mediaBox[2] - page.mediaBox[0]);
      const heightPts = Math.abs(page.mediaBox[3] - page.mediaBox[1]);
      // /Rotate swaps the visual page dimensions for 90°/270°.
      // The renderer and parser (parsePdfDoc.js) both operate in the
      // post-rotation coordinate space, so pdfDims300 must match.
      const rotated = page.rotate === 90 || page.rotate === 270;
      const visualWidthPts = rotated ? heightPts : widthPts;
      const visualHeightPts = rotated ? widthPts : heightPts;
      const width = Math.round(visualWidthPts * 300 / 72);
      const height = Math.round(visualHeightPts * 300 / 72);
      this.pdfDims300.push({ width, height });
    }

    this.inputModes.pdf = true;

    // Set page metrics based on PDF dimensions.
    // This is always run, even though it is overwritten almost immediately by OCR data when it is uploaded.
    // This is done to ensure that the page metrics are always set (which is necessary to prevent a crash),
    // even if (due to some edge case) metrics cannot be parsed from the OCR data for all pages.
    // For example, this was encountered using Archive.org data where the page counts of the PDFs and OCR data did not match perfectly.

    // For reasons that are unclear, a small number of pages have been rendered into massive files
    // so a hard-cap on resolution must be imposed.
    const pageDPI = this.pdfDims300.map((x) => 300 * Math.min(x.width, 3500) / x.width);

    this.pdfDims300.forEach((x, i) => {
      const pageDims = { width: Math.round(x.width * pageDPI[i] / 300), height: Math.round(x.height * pageDPI[i] / 300) };
      this.#pageMetrics[i] = new PageMetrics(pageDims);
    });
  };
}
