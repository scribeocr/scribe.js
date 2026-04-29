import {
  PageMetrics,
} from '../objects/pageMetricsObjects.js';

import { updateFontContWorkerMain } from '../fontContainerMain.js';
import { pageMetricsAll } from './dataContainer.js';
import {
  FontCont,
} from './fontContainer.js';

import { gs } from '../generalWorkerMain.js';
import { imageUtils, ImageWrapper } from '../objects/imageObjects.js';
import { range } from '../utils/miscUtils.js';
import { opt } from './app.js';

import { initPdfScheduler } from '../pdfWorkerMain.js';
import { extractType0Fonts } from '../pdf/fonts/parsePdfFonts.js';

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

export class ImageCache {
  /** @type {Array<ImageWrapper|Promise<ImageWrapper>>} */
  static nativeSrc = [];

  /** @type {Array<ImageWrapper|Promise<ImageWrapper>>} */
  static native = [];

  /** @type {Array<ImageWrapper|Promise<ImageWrapper>>} */
  static binary = [];

  // These arrays store the properties of the images.
  // While they are redundant with the properties stored in the ImageWrapper objects,
  // they still need to exist to determine whether the image needs to be re-rendered.
  // The imagewrappers are stored as promises, and needing to await them would break things without further changes.
  // See: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Operators/await#control_flow_effects_of_await
  /** @type {Array<ImageProperties>} */
  static nativeProps = [];

  /** @type {Array<ImageProperties>} */
  static binaryProps = [];

  /** @type {?ArrayBuffer} */
  static pdfData = null;

  /**
   * @param {ImagePropertiesRequest} props
   * @param {ImageWrapper} inputImage
   * @param {number} n - Page number
   * @param {boolean} [binary=false]
   * @returns {ImageProperties}
   */
  static fillPropsDefault = (props, inputImage, n, binary = false) => {
    /** @type {"binary" | "color" | "gray"} */
    let colorMode = 'binary';
    if (!binary) {
      const color = props?.colorMode === 'color' || !props?.colorMode && opt.colorMode === 'color';
      colorMode = color ? 'color' : 'gray';
    }

    let pageAngle = pageMetricsAll[n].angle || 0;
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
  static pdfScheduler = null;

  /** @type {?Promise<import('../pdfWorkerMain.js').PdfScheduler>} */
  static #pdfSchedulerReady = null;

  /**
   * Get or lazily initialize the dedicated PDF worker pool.
   * @returns {Promise<import('../pdfWorkerMain.js').PdfScheduler>}
   */
  static getPdfScheduler = async () => {
    if (ImageCache.pdfScheduler) return ImageCache.pdfScheduler;
    if (!ImageCache.#pdfSchedulerReady) {
      ImageCache.#pdfSchedulerReady = initPdfScheduler().then((s) => {
        ImageCache.pdfScheduler = s;
        return s;
      });
    }
    return ImageCache.#pdfSchedulerReady;
  };

  static loadCount = 0;

  static pageCount = 0;

  /**
   * The dimensions that each page would be, if it was rendered at 300 DPI.
   * @type {Array<dims>}
   */
  static pdfDims300 = [];

  static inputModes = {
    pdf: false,
    image: false,
  };

  static colorModeDefault = 'gray';

  /**
   * @param {number} n - Page number
   * @param {boolean} [color=false]
   */
  static #renderImage = async (n, color = false) => {
    if (ImageCache.inputModes.image) {
      return ImageCache.nativeSrc[n];
    } if (ImageCache.inputModes.pdf) {
      const colorMode = color ? 'color' : 'gray';
      const pdfScheduler = await ImageCache.getPdfScheduler();
      const targetWidth = pageMetricsAll[n].dims.width;
      const dpi = 300 * (targetWidth / ImageCache.pdfDims300[n].width);
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
  static transformImage = async (inputImage, n, props, saveNativeImage = true) => {
    let pageAngle = pageMetricsAll[n].angle || 0;
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
  static getImages = (n, props, nativeOnly = true, priorityJob = false) => {
    if (!ImageCache.inputModes.image && !ImageCache.inputModes.pdf) {
      return { native: undefined, binary: undefined };
    }

    const significantRotation = Math.abs(pageMetricsAll[n].angle || 0) > 0.05;

    const newNative = !ImageCache.native[n] || !imageUtils.compatible(ImageCache.nativeProps[n], props, significantRotation);
    const newBinary = !nativeOnly && (!ImageCache.binary[n] || !imageUtils.compatible(ImageCache.binaryProps[n], props, significantRotation));

    if (newNative || newBinary) {
      const renderRaw = !ImageCache.native[n] || imageUtils.requiresUndo(ImageCache.nativeProps[n], props);
      const propsRaw = {
        colorMode: opt.colorMode, rotated: false, upscaled: false, n,
      };
      const renderTransform = newBinary || !imageUtils.compatible(propsRaw, props, significantRotation);

      const propsNew = renderRaw ? propsRaw : JSON.parse(JSON.stringify(ImageCache.nativeProps[n]));
      propsNew.colorMode = props?.colorMode || propsNew.colorMode;
      propsNew.rotated = props?.rotated ?? propsNew.rotated;
      propsNew.upscaled = props?.upscaled ?? propsNew.upscaled;
      const propsNewBinary = JSON.parse(JSON.stringify(propsNew));
      propsNewBinary.colorMode = 'binary';

      const inputNative = ImageCache.native[n];
      if (newNative) ImageCache.nativeProps[n] = propsNew;
      if (newBinary) ImageCache.binaryProps[n] = propsNewBinary;
      const res = (async () => {
        /** @type {?ImageWrapper} */
        let img1;
        if (renderRaw) {
          const color = props?.colorMode === 'color' || !props?.colorMode && opt.colorMode === 'color';
          img1 = await ImageCache.#renderImage(n, color, priorityJob);
        } else {
          img1 = await inputNative;
        }
        if (renderTransform) {
          return ImageCache.transformImage(img1, n, props, true);
        }
        return { native: img1, binary: null };
      })();

      if (newNative) ImageCache.native[n] = res.then((r) => r.native);
      if (newBinary) ImageCache.binary[n] = res.then((r) => r.binary);
    }

    return { native: ImageCache.native[n], binary: ImageCache.binary[n] };
  };

  /**
   * @param {number} n
   * @param {ImagePropertiesRequest} [props]
   * @param {boolean} [priorityJob=false] - Whether to make this a priority job, cutting ahead of non-priority jobs.
   *    This is used to keep the UI responsive when many jobs are queued.
   */
  static getNative = async (n, props, priorityJob) => ImageCache.getImages(n, props, true, priorityJob || false).native;

  /**
   * @param {number} n
   * @param {ImagePropertiesRequest} [props]
   * @param {boolean} [priorityJob=false] - Whether to make this a priority job, cutting ahead of non-priority jobs.
   *    This is used to keep the UI responsive when many jobs are queued.
   */
  static getBinary = async (n, props, priorityJob) => ImageCache.getImages(n, props, false, priorityJob || false).binary;

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
  static preRenderRange = async ({
    binary, pageArr = null, min = 0, max = 0, props,
  }) => {
    const pagesArr = pageArr || range(min, max);
    if (binary) {
      await Promise.all(pagesArr.map((n) => ImageCache.getBinary(n, props).then(() => {
        opt.progressHandler({ n, type: 'render', info: { } });
      })));
    } else {
      await Promise.all(pagesArr.map((n) => ImageCache.getNative(n, props).then(() => {
        opt.progressHandler({ n, type: 'render', info: { } });
      })));
    }
  };

  static clear = () => {
    ImageCache.nativeSrc = [];
    ImageCache.native = [];
    ImageCache.binary = [];
    ImageCache.inputModes.image = false;
    ImageCache.inputModes.pdf = false;
    ImageCache.pageCount = 0;
    ImageCache.pdfDims300.length = 0;
    ImageCache.loadCount = 0;
    ImageCache.nativeProps.length = 0;
    ImageCache.binaryProps.length = 0;
  };

  static terminate = async () => {
    ImageCache.clear();
    if (ImageCache.pdfScheduler) {
      await ImageCache.pdfScheduler.terminate();
      ImageCache.pdfScheduler = null;
      ImageCache.#pdfSchedulerReady = null;
    }
  };

  /**
   *
   * @param {ArrayBuffer | Uint8Array | Blob} fileData
   */
  static openMainPDF = async (fileData) => {
    /** @type {ArrayBuffer} */
    let arrayBuffer;
    if (fileData instanceof ArrayBuffer) {
      arrayBuffer = fileData;
    } else if (typeof fileData.arrayBuffer === 'function') {
      arrayBuffer = await fileData.arrayBuffer();
    } else {
      arrayBuffer = fileData.buffer.slice(fileData.byteOffset, fileData.byteOffset + fileData.byteLength);
    }
    ImageCache.pdfData = arrayBuffer;

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
    const pdfScheduler = await ImageCache.getPdfScheduler();
    const { pageCount, pages } = await pdfScheduler.loadPdfInAllWorkers(pdfBytes);

    ImageCache.pageCount = pageCount;

    ImageCache.pdfDims300.length = 0;
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
      ImageCache.pdfDims300.push({ width, height });
    }

    ImageCache.inputModes.pdf = true;

    // Set page metrics based on PDF dimensions.
    // This is always run, even though it is overwritten almost immediately by OCR data when it is uploaded.
    // This is done to ensure that the page metrics are always set (which is necessary to prevent a crash),
    // even if (due to some edge case) metrics cannot be parsed from the OCR data for all pages.
    // For example, this was encountered using Archive.org data where the page counts of the PDFs and OCR data did not match perfectly.

    // For reasons that are unclear, a small number of pages have been rendered into massive files
    // so a hard-cap on resolution must be imposed.
    const pageDPI = ImageCache.pdfDims300.map((x) => 300 * Math.min(x.width, 3500) / x.width);

    ImageCache.pdfDims300.forEach((x, i) => {
      const pageDims = { width: Math.round(x.width * pageDPI[i] / 300), height: Math.round(x.height * pageDPI[i] / 300) };
      pageMetricsAll[i] = new PageMetrics(pageDims);
    });

    // WIP: Extract fonts embedded in PDFs.
    // This feature is disabled by default as the results are often bad.
    // In addition to only working for certain font formats, fonts embedded in PDFs are often subsetted and/or corrupted.
    // Therefore, before this is enabled by default, more sophisticated rules regarding when fonts should be used are needed.
    if (opt.extractPDFFonts) {
      extractType0Fonts(pdfBytes).then(async (fonts) => {
        for (const objNum of Object.keys(fonts)) {
          const fontFile = fonts[Number(objNum)].fontFile;
          FontCont.addFontFromFile(fontFile.buffer.slice(fontFile.byteOffset, fontFile.byteOffset + fontFile.byteLength));
        }
        await updateFontContWorkerMain();
      });
    }
  };
}
