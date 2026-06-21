/** Min page-area fraction for an image to count as non-trivial. Used only to recognize a blank page. */
const IMAGE_AREA_MIN = 0.02;
/** Min count of filled glyph-height vector paths for a page to plausibly hold path-rendered text. */
export const PATH_TEXT_MIN = 8;
/** Min count of line-shaped image strips for a page to plausibly hold image-borne text. */
export const IMAGE_TEXT_MIN = 8;
/** Min run of consecutive glyphs from a broken-ToUnicode font to count as a broken-font run. */
export const BROKEN_RUN_MIN = 3;
/** Min page-area fraction for a single image to plausibly hold baked-in text (figure, table, photo). */
export const TEXT_CANDIDATE_IMAGE_MIN = 0.1;
/**
 * Min page-area fraction for a page to count as a full-page image (a scan).
 * The high threshold excludes born-digital pages that merely embed a large image (e.g. an author portrait).
 */
export const FULL_PAGE_IMAGE_MIN = 0.95;
/** Min invisible printable chars for a full-page image to count as carrying an existing OCR layer. */
export const INVIS_OCR_MIN = 100;
/** Min readable visible chars for a page to count as having real text. Stamp-immune: a Bates stamp is well under 100. */
export const READABLE_TEXT_MIN = 100;

/**
 * Raw per-page measurements produced by the parser. No thresholds applied.
 * @typedef {object} PageStats
 * @property {number} largestImageFrac Largest single image placement as a fraction of page area.
 * @property {number} invisibleTextChars Count of invisible printable chars (an OCR text layer).
 * @property {number} visibleChars Count of all visible glyphs (readable + PUA/broken + control).
 * @property {number} visibleReadableChars Count of visible glyphs excluding control/PUA/broken-font.
 * @property {number} printableVis Count of visible printable chars, including broken-font glyphs that map to printable codepoints (feeds `determinePdfType`).
 * @property {number} control Count of control chars, visible and invisible (feeds `determinePdfType`).
 * @property {number} controlVis Count of visible control chars (feeds `determinePdfType`).
 * @property {number} pathTextCandidates Count of glyph-like vector paths.
 * @property {number} imageTextCandidates Count of line-shaped image strips.
 * @property {number} longestBrokenRun Longest run of consecutive broken-ToUnicode-font glyphs.
 * @property {number[]} pageSize Page dimensions in points.
 */

/** A single image covers nearly the whole page (a scan). @param {PageStats} s */
export const isFullPageImage = (s) => s.largestImageFrac >= FULL_PAGE_IMAGE_MIN;
/** The page renders enough readable text to count as a real text page. @param {PageStats} s */
export const hasReadableText = (s) => s.visibleReadableChars >= READABLE_TEXT_MIN;
/** The page is a full-page raster scan with no readable text of its own. @param {PageStats} s */
export const isScanPage = (s) => isFullPageImage(s) && !hasReadableText(s);
/** A full-page-image page that already carries an invisible OCR text layer. @param {PageStats} s */
export const hasExistingOcrLayer = (s) => isFullPageImage(s) && s.invisibleTextChars >= INVIS_OCR_MIN;
/** The page has a run of glyphs from a broken-ToUnicode font (its text extracts as garbage). @param {PageStats} s */
export const hasBrokenFontRun = (s) => s.longestBrokenRun >= BROKEN_RUN_MIN;
/** The page plausibly holds baked-in text: a sizeable image, path run, or image strip. @param {PageStats} s */
export const mayHaveBakedText = (s) => s.largestImageFrac >= TEXT_CANDIDATE_IMAGE_MIN
  || s.pathTextCandidates >= PATH_TEXT_MIN
  || s.imageTextCandidates >= IMAGE_TEXT_MIN;
/** The page has no glyphs and no non-trivial image (a blank page). @param {PageStats} s */
export const isEmpty = (s) => s.visibleChars === 0 && s.invisibleTextChars === 0
  && s.largestImageFrac < IMAGE_AREA_MIN;

/**
 * Decide which pages to OCR.
 * @param {Array<PageStats|null>} pageStats Per-page raw measurements.
 * @param {'all'|'none'|'fast'|'deep'} [ocrMode] Scope. `fast` decides per document from `pdfType`: it
 *   OCRs an image-based document in full and leaves a text-native one alone. `deep` is a strict superset
 *   of `fast` that also OCRs the individual pages of an otherwise-skipped document that may hold baked-in text.
 * @param {'rerun'|'reuse'} [existingOcrPolicy] For a document/page that already carries an OCR layer:
 *   `rerun` re-OCRs it, `reuse` keeps it.
 * @param {'text'|'ocr'|'image'|null} [pdfType] Per-document verdict from `determinePdfType`: text-native,
 *   image with an OCR layer, or image. A null/unknown verdict OCRs the whole document.
 * @returns {boolean[]} One flag per page: whether to OCR it.
 */
export function selectOcrPages(pageStats, ocrMode = 'fast', existingOcrPolicy = 'rerun', pdfType = 'image') {
  const len = pageStats.length;
  if (ocrMode === 'all') return new Array(len).fill(true);
  if (ocrMode === 'none') return new Array(len).fill(false);

  // `fast` decides for the whole document from its parse-time verdict: skip a text-native document,
  // OCR an image one, and re-OCR an image+OCR-layer document only when `existingOcrPolicy` is `rerun`.
  let ocrWholeDoc;
  if (pdfType === 'text') ocrWholeDoc = false;
  else if (pdfType === 'ocr') ocrWholeDoc = existingOcrPolicy === 'rerun';
  else ocrWholeDoc = true;

  return pageStats.map((s) => {
    if (ocrWholeDoc) return true;
    // `deep` superset: for a document `fast` leaves alone, still OCR the pages that may hold baked-in text,
    // plus any embedded scan or broken-font page.
    if (ocrMode !== 'deep' || !s) return false;
    if (hasBrokenFontRun(s)) return true;
    if (isScanPage(s)) return hasExistingOcrLayer(s) ? existingOcrPolicy === 'rerun' : true;
    return mayHaveBakedText(s);
  });
}

/**
 * Whether any page has content that needs OCR (a recommendation flag; does not change selection).
 * @param {Array<PageStats|null>} pageStats
 * @returns {boolean}
 */
export function computeRequiresOCR(pageStats) {
  return pageStats.some((s) => !!s && (mayHaveBakedText(s) || hasBrokenFontRun(s) || isScanPage(s)));
}
