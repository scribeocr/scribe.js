import {
  PageMetrics,
} from '../objects/pageMetricsObjects.js';

import { gs } from '../generalWorkerMain.js';
import { imageUtils, ImageWrapper } from '../objects/imageObjects.js';
import { range } from '../utils/miscUtils.js';
import { opt } from './app.js';

import { initPdfScheduler } from '../pdfWorkerMain.js';
import { extractType0Fonts } from '../pdf/fonts/parsePdfFonts.js';
import { syncToWorkers } from '../fontContainerMain.js';

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

/**
 * Per-document image cache and PDF worker pool. Holds the document's rendered images, the loaded
 * PDF bytes, and a dedicated `PdfScheduler`.
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

  /** @type {?ArrayBuffer} */
  pdfData = null;

  /**
   * The owning document's page metrics. Held by reference (the document mutates this array in place
   * and never reassigns it) so this cache reads its own document's metrics, not the active document's.
   * @type {Array<PageMetrics>}
   */
  #pageMetrics;

  /**
   * The owning document's fonts, used only by the optional embedded-PDF-font extraction path
   * (`opt.extractPDFFonts`). Held by reference so extracted fonts land on this document's `DocFonts`.
   * @type {?import('./fontContainer.js').DocFonts}
   */
  #fonts;

  /**
   * @param {Array<PageMetrics>} [pageMetrics] - The owning document's page-metrics array.
   * @param {?import('./fontContainer.js').DocFonts} [fonts] - The owning document's fonts.
   */
  constructor(pageMetrics = [], fonts = null) {
    this.#pageMetrics = pageMetrics;
    this.#fonts = fonts;
  }

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
      const color = props?.colorMode === 'color' || !props?.colorMode && opt.colorMode === 'color';
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

  /** @type {?import('../pdfWorkerMain.js').PdfScheduler} */
  pdfScheduler = null;

  /** @type {?Promise<import('../pdfWorkerMain.js').PdfScheduler>} */
  #pdfSchedulerReady = null;

  /**
   * Get or lazily initialize the dedicated PDF worker pool.
   * @returns {Promise<import('../pdfWorkerMain.js').PdfScheduler>}
   */
  getPdfScheduler = async () => {
    if (this.pdfScheduler) return this.pdfScheduler;
    if (!this.#pdfSchedulerReady) {
      this.#pdfSchedulerReady = initPdfScheduler().then((s) => {
        this.pdfScheduler = s;
        return s;
      });
    }
    return this.#pdfSchedulerReady;
  };

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
   * @param {number} n - Page number
   * @param {boolean} [color=false]
   */
  #renderImage = async (n, color = false) => {
    if (this.inputModes.image) {
      return this.nativeSrc[n];
    } if (this.inputModes.pdf) {
      const colorMode = color ? 'color' : 'gray';
      const pdfScheduler = await this.getPdfScheduler();
      const targetWidth = this.#pageMetrics[n].dims.width;
      const dpi = 300 * (targetWidth / this.pdfDims300[n].width);
      const result = await pdfScheduler.renderPdfPage({ pageIndex: n, colorMode, dpi }, true);
      return new ImageWrapper(n, result.dataUrl, result.colorMode);
    }
    throw new Error('Attempted to render image without image input provided.');
  };

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

    const resPromise = (async () => {
      // Wait for non-rotated version before replacing with promise
      await gs.initTesseract({ anyOk: true });
      return gs.recognize({
        image: inputImage.src,
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
   * @param {boolean} [priorityJob=false] - Whether to make this a priority job, cutting ahead of non-priority jobs.
   *    This is used to keep the UI responsive when many jobs are queued.
   */
  getImages = (n, props, nativeOnly = true, priorityJob = false) => {
    if (!this.inputModes.image && !this.inputModes.pdf) {
      return { native: undefined, binary: undefined };
    }

    const significantRotation = Math.abs(this.#pageMetrics[n].angle || 0) > 0.05;

    const newNative = !this.native[n] || !imageUtils.compatible(this.nativeProps[n], props, significantRotation);
    const newBinary = !nativeOnly && (!this.binary[n] || !imageUtils.compatible(this.binaryProps[n], props, significantRotation));

    if (newNative || newBinary) {
      const renderRaw = !this.native[n] || imageUtils.requiresUndo(this.nativeProps[n], props);
      const propsRaw = {
        colorMode: opt.colorMode, rotated: false, upscaled: false, n,
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
          const color = props?.colorMode === 'color' || !props?.colorMode && opt.colorMode === 'color';
          img1 = await this.#renderImage(n, color, priorityJob);
        } else {
          img1 = await inputNative;
        }
        if (renderTransform) {
          return this.transformImage(img1, n, props, true);
        }
        return { native: img1, binary: null };
      })();

      if (newNative) this.native[n] = res.then((r) => r.native);
      if (newBinary) this.binary[n] = res.then((r) => r.binary);
    }

    return { native: this.native[n], binary: this.binary[n] };
  };

  /**
   * @param {number} n
   * @param {ImagePropertiesRequest} [props]
   * @param {boolean} [priorityJob=false] - Whether to make this a priority job, cutting ahead of non-priority jobs.
   *    This is used to keep the UI responsive when many jobs are queued.
   */
  getNative = async (n, props, priorityJob) => this.getImages(n, props, true, priorityJob || false).native;

  /**
   * @param {number} n
   * @param {ImagePropertiesRequest} [props]
   * @param {boolean} [priorityJob=false] - Whether to make this a priority job, cutting ahead of non-priority jobs.
   *    This is used to keep the UI responsive when many jobs are queued.
   */
  getBinary = async (n, props, priorityJob) => this.getImages(n, props, false, priorityJob || false).binary;

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
        opt.progressHandler({ n, type: 'render', info: { } });
      })));
    } else {
      await Promise.all(pagesArr.map((n) => this.getNative(n, props).then(() => {
        opt.progressHandler({ n, type: 'render', info: { } });
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
    if (this.pdfScheduler) {
      await this.pdfScheduler.terminate();
      this.pdfScheduler = null;
      this.#pdfSchedulerReady = null;
    }
  };

  /**
   *
   * @param {ArrayBuffer | Uint8Array | Blob} fileData
   */
  openMainPDF = async (fileData) => {
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
    if (opt.usePdfSharedBuffer && canUseSharedArrayBuffer()) {
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
    const { pageCount, pages } = await pdfScheduler.loadPdfInAllWorkers(pdfBytes);

    this.pageCount = pageCount;

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

    // WIP: Extract fonts embedded in PDFs.
    // This feature is disabled by default as the results are often bad.
    // In addition to only working for certain font formats, fonts embedded in PDFs are often subsetted and/or corrupted.
    // Therefore, before this is enabled by default, more sophisticated rules regarding when fonts should be used are needed.
    if (opt.extractPDFFonts && this.#fonts) {
      const docFonts = this.#fonts;
      extractType0Fonts(pdfBytes).then(async (fonts) => {
        for (const objNum of Object.keys(fonts)) {
          const fontFile = fonts[Number(objNum)].fontFile;
          docFonts.addFontFromFile(fontFile.buffer.slice(fontFile.byteOffset, fontFile.byteOffset + fontFile.byteLength));
        }
        await syncToWorkers(docFonts);
      });
    }
  };
}
