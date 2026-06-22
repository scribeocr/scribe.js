import { scribeDocDefaults } from '../containers/scribeDocDefaults.js';

/** Min page-area fraction for an image to count as non-trivial. Used only to recognize a blank page. */
const IMAGE_AREA_MIN = 0.02;
/** Min count of filled glyph-height vector paths for a page to plausibly hold path-rendered text. */
export const PATH_TEXT_MIN = 8;
/** Min count of line-shaped image strips for a page to plausibly hold image-borne text. */
export const IMAGE_TEXT_MIN = 8;
/** Min run of consecutive glyphs from a broken-ToUnicode font to count as a broken-font run. */
export const BROKEN_RUN_MIN = 3;
/** Min broken-ToUnicode run for a page to count as substantially unreadable, far higher than the mere-presence `BROKEN_RUN_MIN`. */
export const BROKEN_TEXT_MIN = 100;
/** Min page-area fraction for a single image to plausibly hold baked-in text (figure, table, photo). */
export const TEXT_CANDIDATE_IMAGE_MIN = 0.1;
/**
 * Min page-area fraction for a page to count as a full-page image (a scan).
 * The high threshold excludes born-digital pages that merely embed a large image (e.g. an author portrait).
 */
export const FULL_PAGE_IMAGE_MIN = 0.95;
/** Min invisible printable chars for a full-page image to count as carrying an existing OCR layer. */
export const INVIS_OCR_MIN = 100;
/** Min readable visible chars for a page to count as having real text. */
export const READABLE_TEXT_MIN = 100;
/** Min body-band readable chars (outside a header/footer band) for a page to have real body text of its own. */
export const BODY_TEXT_MIN = 100;

/**
 * Raw per-page measurements produced by the parser. No thresholds applied.
 * @typedef {object} PageStats
 * @property {number} largestImageFrac Largest single image placement as a fraction of page area.
 * @property {number} invisibleTextChars Count of invisible printable chars (an OCR text layer).
 * @property {number} visibleChars Count of all visible glyphs (readable + PUA/broken + control).
 * @property {number} visibleReadableChars Count of visible glyphs excluding control/PUA/broken-font.
 * @property {number} bodyReadableChars Count of `visibleReadableChars` in the page body (10-90% of height), excluding a header/footer band.
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
/** The page carries real readable body text, not just a header/footer. @param {PageStats} s */
export const hasRealText = (s) => s.bodyReadableChars >= BODY_TEXT_MIN;
/** The page is itself unreadable: a full-page scan or substantially broken text, with no body text of its own. @param {PageStats} s */
export const isScanOrUnreadable = (s) => !hasRealText(s)
  && (isFullPageImage(s) || s.longestBrokenRun >= BROKEN_TEXT_MIN);

/**
 * Decide which pages to OCR.
 * @param {Array<PageStats|null>} pageStats Per-page raw measurements.
 * @param {'text'|'ocr'|'image'|null} [pdfType] Per-document verdict from `determinePdfType`: text-native, image with an OCR layer, or image.
 *   A null/unknown verdict OCRs the whole document.
 * @param {'all'|'none'|'auto'|'autoShallow'|'autoDeep'} [ocrPages] Scope.
 *   `autoShallow` runs OCR on pages containing document scans or full-page screenshots, plus pages where the font encoding is broken.
 *   `autoDeep` (alias `auto`) is a superset of `autoShallow`, also running `ocr` when the page contains images or paths that *might* represent text.
 *   Consider an academic article created in Word, where the body text can be copy/pasted, but data tables are represented by inline .png images.
 *   `auto` (`autoDeep`) will run OCR on pages containing the data tables; `autoShallow` will not.
 * @param {typeof scribeDocDefaults.usePDFText} [usePDFText] Governs an existing OCR layer: when `ocr.main` is true the layer is
 *   trusted as the primary text and its pages are not re-OCR'd; otherwise they are (and `recognize` decides separately, from `ocr.supp`, whether to merge it back in).
 * @returns {boolean[]} One flag per page: whether to OCR it.
 */
export function selectOcrPages(pageStats, pdfType = 'image', ocrPages = 'autoShallow', usePDFText = scribeDocDefaults.usePDFText) {
  const len = pageStats.length;
  if (ocrPages === 'all') return new Array(len).fill(true);
  if (ocrPages === 'none') return new Array(len).fill(false);
  // `auto` is an alias for the deep variant.
  const deep = ocrPages === 'autoDeep' || ocrPages === 'auto';

  let ocrWholeDoc;
  if (pdfType === 'text') ocrWholeDoc = false;
  else if (pdfType === 'ocr') ocrWholeDoc = !usePDFText.ocr.main;
  else ocrWholeDoc = true;

  return pageStats.map((s) => {
    if (ocrWholeDoc) return true;
    if (!s) return false;
    if (deep) {
      if (hasBrokenFontRun(s)) return true;
      if (isScanPage(s)) return hasExistingOcrLayer(s) ? !usePDFText.ocr.main : true;
      return mayHaveBakedText(s);
    }
    if (!isScanOrUnreadable(s)) return false;
    return hasExistingOcrLayer(s) ? !usePDFText.ocr.main : true;
  });
}

/**
 * Whether any page has content that needs OCR (a recommendation flag that does not change selection).
 * @param {Array<PageStats|null>} pageStats Per-page raw measurements.
 * @returns {boolean}
 */
export function computeRequiresOCR(pageStats) {
  return pageStats.some((s) => !!s && (mayHaveBakedText(s) || hasBrokenFontRun(s) || isScanPage(s)));
}
