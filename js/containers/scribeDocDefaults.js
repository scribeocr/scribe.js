export const scribeDocDefaults = {

  /** @type {('color'|'gray'|'binary')} */
  colorMode: 'color',

  autoRotate: true,

  confThreshHigh: 85,

  confThreshMed: 75,

  ligatures: false,

  kerning: true,

  enableUpscale: false,

  ignorePunct: false,

  ignoreCap: false,

  saveDebugImages: false,

  /**
   * Keep the raw OCR data (e.g. AWS Textract JSON) in the document's internal data.
   * Increases memory usage; only enable for debugging.
   */
  keepRawData: false,

  /** Generate debug visualizations when running OCR. */
  debugVis: false,

  /**
   * Print recognition runtime for each page to console.
   * Set to `true` to print every page.
   * Set to a number of seconds to print only pages whose recognition time exceeds that threshold.
   * @type {boolean | number}
   */
  printRecognitionTime: false,

  /** @type {'width' | 'sentence'} */
  docxLineSplitMode: 'width',

  /**
   * How to use PDF text data extracted from input PDFs (if any).
   * `native` controls visible text rendered by the PDF viewer; `ocr` controls invisible
   * text printed over an image. `main: true` uses the data as the primary source.
   * `supp: true` uses it as a supplemental source.
   */
  usePDFText: {
    native: { supp: true, main: true },
    ocr: { supp: true, main: false },
  },

  /**
   * Always convert and retain existing PDF text data, even when `usePDFText` would
   * otherwise discard it. Disables a perf/memory optimization.
   * Enable when input PDFs have corrupted text you still want to retain.
   */
  keepPDFTextAlways: false,

  /**
   * Skip font loading and optimization during `importFiles`.
   * For callers that only need raw OCR text/confidence and never render or export glyphs.
   */
  skipFontOpt: false,

  /**
   * Which pages to run OCR on, from the import-time per-page content analysis.
   * `'all'` (default) OCRs every page. `'none'` skips OCR entirely.
   * `'autoShallow'` leaves text-native pages alone and OCRs only image-based content
   * (scanned sections, broken-encoding pages, and existing-OCR pages unless `usePDFText.ocr.main` trusts the existing layer).
   * `'autoDeep'` (alias `'auto'`) additionally OCRs any page that may hold baked-in text (a sizeable image, image-borne text, or path-rendered text).
   * A per-call `recognize`/`extractText` override may also pass a boolean array to select pages explicitly.
   * Image inputs always OCR every page.
   * @type {('all'|'auto'|'autoShallow'|'autoDeep'|'none')}
   */
  ocrPages: 'all',

  /** @type {('invis'|'ebook'|'eval'|'proof'|'annot')} */
  displayMode: 'invis',

  overlayOpacity: 80,

  addOverlay: true,

  standardizePageSize: false,

  humanReadablePDF: false,

  reflow: true,

  lineNumbers: false,

  removeMargins: false,

  includeImages: false,

  /**
   * When adding an invisible text overlay to a page with existing text contents,
   * convert the existing text contents to paths to prevent a duplicative text layer.
   */
  convertDupSourceTextToPaths: false,

  /**
   * Embed fonts inline (base64 `data:` URIs) in HTML exports instead of referencing the jsDelivr CDN.
   */
  embedFonts: false,

  enableLayout: false,

  xlsxFilenameColumn: true,

  xlsxPageNumberColumn: true,

  compressScribe: true,

  /**
   * Include extra text data in `.scribe`/`.scribe.json` exports.
   * Adds `text` fields at the line/paragraph/page level.
   */
  includeExtraTextScribe: false,

  /**
   * Include per-character bounding boxes (`word.chars`) in `.scribe` exports..
   */
  includeCharBoxesScribe: true,
};
