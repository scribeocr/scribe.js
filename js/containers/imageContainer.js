import {
  PageMetrics,
} from '../objects/pageMetricsObjects.js';

import { initMuPDFWorker } from '../../mupdf/mupdf-async.js';

import { updateFontContWorkerMain } from '../fontContainerMain.js';
import { pageMetricsAll } from './dataContainer.js';
import {
  FontCont,
  FontContainerFont,
  loadOpentype,
} from './fontContainer.js';

import { gs } from '../generalWorkerMain.js';
import { imageUtils, ImageWrapper } from '../objects/imageObjects.js';
import { range } from '../utils/miscUtils.js';
import { opt } from './app.js';

let skipTextMode = false;

export class MuPDFScheduler {
  constructor(scheduler, workers) {
    this.scheduler = scheduler;
    /** @type {Array<Awaited<ReturnType<typeof initMuPDFWorker>>>} */
    this.workers = workers;
    /**
     * @param {Parameters<typeof import('../../mupdf/mupdf-worker.js').mupdf.pageText>[1]} args
     * @returns {Promise<ReturnType<typeof import('../../mupdf/mupdf-worker.js').mupdf.pageText>>}
     */
    this.pageText = (args) => (this.scheduler.addJob('pageText', args));
    /**
     * @param {Parameters<typeof import('../../mupdf/mupdf-worker.js').mupdf.extractAllFonts>[1]} args
     * @returns {Promise<ReturnType<typeof import('../../mupdf/mupdf-worker.js').mupdf.extractAllFonts>>}
     */
    this.extractAllFonts = (args) => (this.scheduler.addJob('extractAllFonts', args));
    /**
     * @param {Parameters<typeof import('../../mupdf/mupdf-worker.js').mupdf.drawPageAsPNG>[1]} args
     * @returns {Promise<ReturnType<typeof import('../../mupdf/mupdf-worker.js').mupdf.drawPageAsPNG>>}
     */
    this.drawPageAsPNG = (args) => (this.scheduler.addJob('drawPageAsPNG', args));
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

// TODO: Either separate out the imagebitmap again or edit so it does not get sent between threads.
// Alternatively, if it is sent between threads, use it reather than making a new one.
// Actually, definitely do that last option.

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

  /** @type {?Promise<MuPDFScheduler>} */
  static muPDFScheduler = null;

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
   * Initializes the MuPDF scheduler.
   * This is separate from the function that loads the file (`#loadFileMuPDFScheduler`),
   * as the scheduler starts loading ahead of the file being available for performance reasons.
   * @param {number} [numWorkers]
   */
  static #initMuPDFScheduler = async (numWorkers) => {
    // If `numbWorkers` is not specified, use up to 3 workers based on hardware concurrency
    // and the global `opt.workerN` setting.
    if (!numWorkers) {
      if (typeof process === 'undefined') {
        numWorkers = Math.min(Math.round((globalThis.navigator.hardwareConcurrency || 8) / 2), 3);
      } else {
        const cpuN = Math.floor((await import('node:os')).cpus().length / 2);
        numWorkers = Math.max(Math.min(cpuN - 1, 3), 1);
      }
      if (opt.workerN && opt.workerN < numWorkers) {
        numWorkers = opt.workerN;
      }
    }

    const Tesseract = typeof process === 'undefined' ? (await import('../../tess/tesseract.esm.min.js')).default : await import('@scribe.js/tesseract.js');
    const scheduler = await Tesseract.createScheduler();
    const workersPromiseArr = range(1, numWorkers).map(async () => {
      const w = await initMuPDFWorker();
      w.id = `png-${Math.random().toString(16).slice(3, 8)}`;
      scheduler.addWorker(w);
      return w;
    });

    const workers = await Promise.all(workersPromiseArr);

    return new MuPDFScheduler(scheduler, workers);
  };

  /**
   *
   * @param {ArrayBuffer} fileData
   * @returns
   */
  static #loadFileMuPDFScheduler = async (fileData) => {
    const scheduler = await ImageCache.getMuPDFScheduler();

    const workersPromiseArr = range(0, scheduler.workers.length - 1).map(async (x) => {
      const w = scheduler.workers[x];

      if (w.pdfDoc) await w.freeDocument(w.pdfDoc);

      // The ArrayBuffer is transferred to the worker, so a new one must be created for each worker.
      // const fileData = await file.arrayBuffer();
      const fileDataCopy = fileData.slice(0);
      const pdfDoc = await w.openDocument(fileDataCopy, 'document.pdf');
      w.pdfDoc = pdfDoc;
    });

    await Promise.all(workersPromiseArr);
  };

  static #renderImage = async (n, color = false) => {
    if (ImageCache.inputModes.image) {
      return ImageCache.nativeSrc[n];
    } if (ImageCache.inputModes.pdf) {
      const pageMetrics = pageMetricsAll[n];
      const targetWidth = pageMetrics.dims.width;
      const dpi = 300 * (targetWidth / ImageCache.pdfDims300[n].width);
      const muPDFScheduler = await ImageCache.getMuPDFScheduler();
      return muPDFScheduler.drawPageAsPNG({
        page: n + 1, dpi, color, skipText: skipTextMode,
      }).then((res) => new ImageWrapper(n, res, color ? 'color' : 'gray'));
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
   */
  static getImages = (n, props, nativeOnly = true) => {
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
          img1 = await ImageCache.#renderImage(n, color);
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
   */
  static getNative = async (n, props) => ImageCache.getImages(n, props, true).native;

  /**
   * @param {number} n
   * @param {ImagePropertiesRequest} [props]
   */
  static getBinary = async (n, props) => ImageCache.getImages(n, props, false).binary;

  /**
   * Pre-render a range of pages.
   * This is generally not required, as individual image are rendered as needed.
   * The primary use case is reducing latency in the UI by rendering images in advance.
   *
   * @param {number} min - Min page to render.
   * @param {number} max - Max page to render.
   * @param {boolean} binary - Whether to render binary images.
   * @param {ImagePropertiesRequest} [props]
   */
  static preRenderRange = async (min, max, binary, props) => {
    const pagesArr = range(min, max);
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
    if (ImageCache.muPDFScheduler) {
      const muPDFScheduler = await ImageCache.muPDFScheduler;
      await muPDFScheduler.scheduler.terminate();
      ImageCache.muPDFScheduler = null;
    }
  };

  /**
   * Gets the MuPDF scheduler if it exists, otherwise creates a new one.
   * @param {number} [numWorkers] - Number of workers to create.
   */
  static getMuPDFScheduler = async (numWorkers) => {
    if (ImageCache.muPDFScheduler) return ImageCache.muPDFScheduler;
    ImageCache.muPDFScheduler = ImageCache.#initMuPDFScheduler(numWorkers);
    return ImageCache.muPDFScheduler;
  };

  /**
   *
   * @param {ArrayBuffer} fileData
   * @param {Boolean} [skipText=false] - Whether to skip native text when rendering PDF to image.
   */
  static openMainPDF = async (fileData, skipText = false) => {
    const muPDFScheduler = await ImageCache.getMuPDFScheduler();

    await ImageCache.#loadFileMuPDFScheduler(fileData);

    ImageCache.pageCount = await muPDFScheduler.workers[0].countPages();

    const pageDims1 = await muPDFScheduler.workers[0].pageSizes([300]);

    ImageCache.pdfDims300.length = 0;
    pageDims1.forEach((x) => {
      ImageCache.pdfDims300.push({ width: x[0], height: x[1] });
    });

    ImageCache.inputModes.pdf = true;
    skipTextMode = skipText;

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
      muPDFScheduler.extractAllFonts().then(async (x) => {
        for (let i = 0; i < x.length; i++) {
          const src = x[i].buffer;
          FontCont.addFontFromFile(src);
        }
        await updateFontContWorkerMain();
      });
    }
  };
}
