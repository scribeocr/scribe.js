export class opt {
  static ligatures = false;

  static kerning = true;

  static extractText = false;

  static enableUpscale = false;

  static ignorePunct = false;

  static ignoreCap = false;

  static ignoreExtra = false;

  static confThreshHigh = 85;

  static confThreshMed = 75;

  static addOverlay = true;

  static standardizePageSize = false;

  static humanReadablePDF = false;

  static intermediatePDF = false;

  static reflow = true;

  static lineNumbers = false;

  static removeMargins = false;

  static includeImages = false;

  static pageBreaks = true;

  /** @type {('invis'|'ebook'|'eval'|'proof'|'annot')} */
  static displayMode = 'proof';

  /** @type {('color'|'gray'|'binary')} */
  static colorMode = 'color';

  static overlayOpacity = 80;

  static autoRotate = true;

  static enableLayout = false;

  static xlsxFilenameColumn = true;

  static xlsxPageNumberColumn = true;

  static saveDebugImages = false;

  /**
   * Whether to keep the raw OCR data (e.g. AWS Textract JSON) in the internal data structure.
   * This can significantly increase memory usage, so should only be used for debugging purposes.
   * If `true`, raw OCR data can be exported with `scribe.exportData('raw')`.
   */
  static keepRawData = false;

  static compressScribe = true;

  /**
   * Include extra text data in .scribe/.scribe.json exports.
   * Enabling this option adds `text` fields at the line/paragraph/page level.
   * This should be disabled if using .scribe files for saving/restoring full OCR data,
   * as it increases file size and duplicates data already present in the OCR structure.
   * This can be convenient when using .scribe/.scribe.json files for programs
   * end users write themselves.
   */
  static includeExtraTextScribe = false;

  static warningHandler = (x) => console.warn(x);

  static errorHandler = (x) => console.error(x);

  /** @param {ProgressMessage} x */
  // eslint-disable-next-line no-unused-vars
  static progressHandler = (x) => {};

  /** Generate debug visualizations when running OCR. */
  static debugVis = false;

  /** Print recognition runtime for each page to console. */
  static printRecognitionTime = false;

  /** @type {'width' | 'sentence'} */
  static docxLineSplitMode = 'width';

  static extractPDFFonts = false;

  /**
   * How to use PDF text data extracted from input PDFs (if any).
   * The `native` option controls how native text data is used (i.e. visible text rendered by the PDF viewer),
   * while the `ocr` option controls how OCR text data is used (i.e. invisible text printed over an image).
   * If `main` is true, then the data will be used as the primary data source.
   * If `supp` is true, then the data will be used as a supplemental data source (may be used to correct errors in the primary data source).
   */
  static usePDFText = {
    native: {
      supp: true,
      main: true,
    },
    ocr: {
      supp: true,
      main: false,
    },
  };

  /**
   * Always convert and retain existing PDF text data.
   * By default (`false`), if the existing PDF text data will not be used (per the `usePDFText` settings),
   * it is discarded and never converted into the internal OCR format.
   * This performance/memory optimization can be disabled by setting this option to `true`,
   * resulting in the PDF text being converted and retained even if (for example) it is corrupted.
   */
  static keepPDFTextAlways = false;

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
   * mirror — useful in sandboxed/offline environments. The path is used as-is
   * with the language code appended, e.g. `${langPath}/eng.traineddata.gz`.
   * @type {?string}
   */
  static langPath = null;

  /**
   * Share the loaded PDF across PDF workers via `SharedArrayBuffer` instead of giving each worker its own clone.
   * Only supported within specific environments (e.g. Chrome with COOP/COEP headers, Node with worker threads and shared memory enabled).
   */
  static usePdfSharedBuffer = false;

  /**
   * Skip font loading and font optimization during `importFiles`.
   * Intended for callers that only need raw OCR text/confidence and never render or export glyphs (e.g. the `conf` CLI command).
   */
  static skipFontOpt = false;
}

export class inputData {
  /** `true` if OCR data exists (whether from upload or built-in engine) */
  static xmlMode = [];

  /** `true` if user uploaded pdf */
  static pdfMode = false;

  /** @type {?('text'|'ocr'|'image')} */
  static pdfType = null;

  /** `true` if user uploaded image files (.png, .jpeg) */
  static imageMode = false;

  /** `true` if user re-uploaded HOCR data created by Scribe OCR */
  static resumeMode = false;

  /** `true` if ground truth data is uploaded */
  static evalMode = false;

  static inputFileNames = [];

  static defaultDownloadFileName = '';

  static pageCount = 0;

  static clear = () => {
    inputData.xmlMode.length = 0;
    inputData.pdfMode = false;
    inputData.imageMode = false;
    inputData.resumeMode = false;
    inputData.evalMode = false;
    inputData.inputFileNames = [];
    inputData.defaultDownloadFileName = '';
    inputData.pageCount = 0;
  };
}
