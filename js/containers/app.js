/**
 * Process-wide settings.
 * Per-document settings live on `ScribeDoc.defaults` and instance fields, not here.
 * Anything that controls how a specific document or workflow runs belongs there.
 */
export class opt {
  /**
   * Number of workers to use. Must be set prior to initialization.
   * If set to `null` (default), the number of workers will be set up to 6 (browser) or 8 (node),
   * if the system has enough resources.
   * @type {?number}
   */
  static workerN = null;

  /**
   * Custom URL or path to load Tesseract `.traineddata` files from.
   * If `null` (default), files are fetched from the jsdelivr CDN.
   * Set this to a directory containing `<lang>.traineddata.gz` to use a local
   * mirror, useful in sandboxed/offline environments. The path is used as-is
   * with the language code appended, e.g. `${langPath}/eng.traineddata.gz`.
   * @type {?string}
   */
  static langPath = null;

  /**
   * Share the loaded PDF across PDF workers via `SharedArrayBuffer` instead of giving each worker its own clone.
   * Only supported within specific environments (e.g. Chrome with COOP/COEP headers, Node with worker threads and shared memory enabled).
   */
  static usePdfSharedBuffer = false;

  static warningHandler = (x) => console.warn(x);

  static errorHandler = (x) => console.error(x);

  /** @param {ProgressMessage} x */
  // eslint-disable-next-line no-unused-vars
  static progressHandler = (x) => {};
}

/**
 * Per-document input metadata: which input modes are active and basic file info.
 * Each `ScribeDoc` owns one.
 */
export class InputData {
  /** `true` if OCR data exists (whether from upload or built-in engine) */
  xmlMode = [];

  /** `true` if user uploaded pdf */
  pdfMode = false;

  /** @type {?('text'|'ocr'|'image')} */
  pdfType = null;

  /** `true` if user uploaded image files (.png, .jpeg) */
  imageMode = false;

  /** `true` if user re-uploaded HOCR data created by Scribe OCR */
  resumeMode = false;

  /** `true` if ground truth data is uploaded */
  evalMode = false;

  inputFileNames = [];

  defaultDownloadFileName = '';

  pageCount = 0;

  clear() {
    this.xmlMode.length = 0;
    this.pdfMode = false;
    this.imageMode = false;
    this.resumeMode = false;
    this.evalMode = false;
    this.inputFileNames = [];
    this.defaultDownloadFileName = '';
    this.pageCount = 0;
  }
}
