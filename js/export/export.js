import { scribeDocDefaults } from '../containers/scribeDocDefaults.js';
import { collectFillTextRefs, isFillTextLine } from '../fillSign.js';
import { reorderOcrPage } from '../modifyOCR.js';
import { saveAs } from '../utils/miscUtils.js';
import { writePdf } from './pdf/writePdf.js';
import { overlayPdfText } from './pdf/writePdfOverlay.js';
import { subsetPdf } from './pdf/subsetPdf.js';
import { mergePdfs } from './pdf/mergePdfs.js';
import { defaultScrubOpts } from '../pdf/metadata/scrubMetadata.js';
import { remapOutline, pageArrIndexMap } from '../objects/outlineObjects.js';
import { writeHocr } from './writeHocr.js';
import { writeText } from './writeText.js';
import { writeHtml } from './writeHtml.js';
import { writeAlto } from './writeAlto.js';
import { writeMarkdown } from './writeMarkdown.js';
import ocr, { OcrPage, clonePage } from '../objects/ocrObjects.js';
import { removeCircularRefsDataTables } from '../objects/layoutObjects.js';
import { mayHaveBakedText, hasBrokenFontRun, isScanPage } from '../pdf/ocrPageSelection.js';
import { bboxToPageSpace } from '../addHighlights.js';
import { ImageWrapper, imageUtils } from '../objects/imageObjects.js';
import { ca } from '../canvasAdapter.js';
import { _buildPngDataUrl } from '../pdf/renderPdfPage.js';

/** @typedef {import('../containers/scribeDoc.js').ScribeDoc} ScribeDoc */

/**
 * @typedef {Object} ExportOptions
 * @property {number} [minPage=0] - First page to export.
 * @property {number} [maxPage=-1] - Last page to export (inclusive). -1 exports through the last page.
 * @property {?Array<number>} [pageArr=null] - Array of 0-based page indices to include.
 *    Overrides minPage/maxPage when provided.
 * @property {('invis'|'ebook'|'eval'|'proof'|'annot')} [displayMode]
 * @property {('color'|'gray'|'binary')} [colorMode]
 * @property {number} [overlayOpacity]
 * @property {boolean} [addOverlay]
 * @property {boolean} [autoRotate]
 * @property {number} [confThreshHigh]
 * @property {number} [confThreshMed]
 * @property {boolean} [standardizePageSize]
 * @property {boolean} [humanReadablePDF]
 * @property {boolean} [reflow]
 * @property {boolean} [lineNumbers]
 * @property {boolean} [removeMargins]
 * @property {boolean} [includeImages]
 * @property {boolean} [convertDupSourceTextToPaths] - When overlaying onto a PDF input, convert the input PDF's vector text to glyph outlines before adding the invisible OCR text layer.
 *    Ignored unless the export uses the overlay path (PDF input, addOverlay, displayMode !== 'ebook').
 * @property {boolean} [routePageCategories] - Apply the per-page flatten/passthrough routing regardless of display mode.
 *    Defaults to true for 'invis' and false otherwise.
 *    Review tooling sets it with displayMode 'proof' to render the searchable flow's routing with a visible confidence-coloured overlay.
 * @property {boolean} [embedFonts]
 * @property {boolean} [enableLayout]
 * @property {boolean} [xlsxFilenameColumn]
 * @property {boolean} [xlsxPageNumberColumn]
 * @property {boolean} [compressScribe]
 * @property {boolean} [includeExtraTextScribe]
 * @property {boolean} [includeCharBoxesScribe] - Include per-character bounding boxes (`word.chars`) in `.scribe` exports; default true.
 *    When false they are dropped (word text is unaffected) and readers of char geometry fall back to word-level boxes.
 * @property {boolean} [scribeSession] - Include the application `session` block (text-edit records, native-text metadata) in `.scribe` exports.
 *    Default false, since the standard interchange format carries no app-only data.
 * @property {number} [scribeSegmentThreshold] - Character count above which a compressed `.scribe` uses the segmented layout
 *    (header line plus one JSON record per page) instead of a single JSON document; default 400,000,000.
 *    The default keeps every single-JSON file under the JavaScript string limit that a reader must fit it into.
 * @property {string} [ocrName] - Export this named OCR layer (a key of `doc.ocr`) instead of the active one.
 * @property {'width' | 'sentence'} [docxLineSplitMode]
 * @property {boolean} [sanitize] - Strip identifying metadata from the exported PDF, keeping the visible pages unchanged.
 *    Covers Info/XMP/PieceInfo, embedded files, image EXIF, actions, prior revisions, and signatures.
 *    Only applies to the PDF-overlay export path (PDF input with addOverlay).
 * @property {object} [scrubOpts] - Overrides the Balanced scrub defaults when `sanitize` is set (`stripStructTree`, `stripPageLabels`, `stripViewerPrefs`, `dropOCProperties`).
 * @property {boolean} [flattenFormFields] - Bake each form field's current appearance (including values set via `setFormValue`) into the page content
 *    and remove the interactive fields, so the export is no longer fillable.
 *    Only applies to the PDF-overlay export path (PDF input with addOverlay); other PDF paths already write no interactive fields.
 * @property {?Object<string, ?string>} [docInfo] - Document information entries (`Title`, `Author`, `Creator`, ...) written into the exported PDF.
 *    Entries the input already carries are preserved; these override same-named ones, and a null value removes a key.
 *    Ignored when `sanitize` is set, which removes document metadata outright.
 */

/**
 * Paint redaction rects (page coords, top-left origin) as opaque black onto a page raster, returning a fresh wrapper.
 * Used by the raster-backed exports (fresh-build PDF, HTML), whose page images contain the content itself, so a box drawn in a later layer would not remove it.
 * @param {ImageWrapper} image
 * @param {Array<bbox>} rects
 * @param {dims} pageDims - Page dimensions in the same frame as `rects`.
 * @param {number} pageAngle - The page's deskew angle in degrees (`pageMetrics.angle`).
 * @returns {Promise<ImageWrapper>}
 */
async function paintRedactionsOntoImage(image, rects, pageDims, pageAngle) {
  const drawable = image.imageBitmap || await ca.getImageBitmap(image.ensureSrc());
  const { width, height } = imageUtils.getDims(image);
  const canvas = await ca.createCanvas(width, height);
  const ctx = /** @type {OffscreenCanvasRenderingContext2D} */ (canvas.getContext('2d'));
  ctx.drawImage(drawable, 0, 0);
  ctx.fillStyle = '#000000';

  // Mirror the renderer's no-rotation threshold (imageContainer.js `fillPropsDefault`).
  let angle = image.rotated ? (pageAngle || 0) : 0;
  if (Math.abs(angle) < 0.05) angle = 0;
  const rad = -angle * (Math.PI / 180);
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const sx = width / pageDims.width;
  const sy = height / pageDims.height;
  // On a deskewed raster (image.rotated), map each rect's corners through the same rotate-about-image-center transform the renderer applied (rotateBbox in ocrObjects.js).
  for (const r of rects) {
    const corners = [
      [r.left * sx, r.top * sy], [r.right * sx, r.top * sy],
      [r.left * sx, r.bottom * sy], [r.right * sx, r.bottom * sy],
    ];
    let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
    for (const [x, y] of corners) {
      const xr = angle === 0 ? x : cos * (x - width / 2) - sin * (y - height / 2) + width / 2;
      const yr = angle === 0 ? y : sin * (x - width / 2) + cos * (y - height / 2) + height / 2;
      x0 = Math.min(x0, xr); y0 = Math.min(y0, yr); x1 = Math.max(x1, xr); y1 = Math.max(y1, yr);
    }
    // 1px pad so anti-aliased glyph edges at the rect boundary cannot survive.
    ctx.fillRect(Math.floor(x0) - 1, Math.floor(y0) - 1, Math.ceil(x1 - x0) + 2, Math.ceil(y1 - y0) + 2);
  }

  const imageData = ctx.getImageData(0, 0, width, height);
  const dataUrl = await _buildPngDataUrl(imageData, image.colorMode === 'color' ? 'color' : 'gray');
  return new ImageWrapper(image.n, dataUrl, image.colorMode, image.rotated, image.upscaled);
}

// Transport granularity only: this batch size does not affect the output bytes.
const SCRIBE_ENCODE_BATCH = 4 * 1024 * 1024;

/**
 * Convert one page into the plain object `.scribe` serializes.
 * Nested values (bboxes, chars, styles) are shared with the live page, so mutating anything below the top level of the result corrupts the open document.
 * @param {OcrPage} page
 * @param {{includeText: boolean, includeCharBoxes: boolean}} serializeOpts
 */
function pageForScribe(page, { includeText, includeCharBoxes }) {
  /** @type {Record<string, unknown>} */
  const pageCopy = { ...page };
  pageCopy.pars = page.pars.map((par) => {
    const { page: key, lines: key2, ...rest } = par;
    /** @type {Record<string, unknown>} */
    const p = rest;
    if (par.debug && !par.debug.raw && !par.debug.sourceType && !par.debug.sourceStyle) delete p.debug;
    if (includeText) p.text = ocr.getParText(par);
    p.lineIds = par.lines.map((line) => line.id);
    return p;
  });
  pageCopy.lines = page.lines.map((line) => {
    const { page: key, par: key2, ...rest } = line;
    /** @type {Record<string, unknown>} */
    const l = rest;
    l.words = line.words.map((word) => {
      const { line: key3, ...wordRest } = word;
      /** @type {Record<string, unknown>} */
      const w = wordRest;
      if (!includeCharBoxes) delete w.chars;
      if (word.debug && !word.debug.raw) delete w.debug;
      return w;
    });
    if (line.debug && !line.debug.raw) delete l.debug;
    if (includeText) l.text = ocr.getLineText(line);
    if (line.par) l.parId = line.par.id;
    return l;
  });
  if (includeText) pageCopy.text = ocr.getPageText(page);
  return pageCopy;
}

/**
 * Yield the `.scribe` single-JSON layout as string chunks.
 * Pages are serialized one at a time, so no string is ever document-sized.
 * Concatenated output is byte-identical to `JSON.stringify({ ocr, ...envelope })`.
 * @param {Array<OcrPage>} ocrPages
 * @param {{includeText: boolean, includeCharBoxes: boolean}} serializeOpts
 * @param {Record<string, any>} envelope - Every top-level `.scribe` field except `ocr`.
 */
function* scribeJsonChunks(ocrPages, serializeOpts, envelope) {
  yield '{"ocr":[';
  for (let i = 0; i < ocrPages.length; i++) {
    if (i > 0) yield ',';
    yield ocrPages[i] ? JSON.stringify(pageForScribe(ocrPages[i], serializeOpts)) : 'null';
  }
  yield ']';
  const rest = JSON.stringify(envelope);
  yield rest === '{}' ? '}' : `,${rest.slice(1)}`;
}

/**
 * Yield the `.scribe` segmented layout as string chunks.
 * Line 1 is a header of the doc-level fields, followed by one newline-separated JSON record per page.
 * Every line parses on its own, so a reader never needs the whole document as one string.
 * @param {Array<OcrPage>} ocrPages
 * @param {{includeText: boolean, includeCharBoxes: boolean}} serializeOpts
 * @param {Record<string, any>} envelope
 */
function* scribeSegmentChunks(ocrPages, serializeOpts, envelope) {
  const header = {
    scribeSegments: 1,
    pageCount: ocrPages.length,
    fontState: envelope.fontState,
    layoutRegions: envelope.layoutRegions,
    layoutDataTables: envelope.layoutDataTables,
    annotations: envelope.annotations,
    pageRotations: envelope.pageRotations,
    pageSourceIndices: envelope.pageSourceIndices,
    outline: envelope.outline,
    inputData: envelope.inputData,
    session: envelope.session ? { v: envelope.session.v, fillText: envelope.session.fillText } : undefined,
  };
  yield JSON.stringify(header);
  const textEdits = envelope.session?.textEdits || [];
  const nativeText = envelope.session?.nativeText || [];
  for (let i = 0; i < ocrPages.length; i++) {
    const page = ocrPages[i] ? pageForScribe(ocrPages[i], serializeOpts) : null;
    /** @type {Record<string, any>} */
    const rec = { i, ocr: page };
    if (envelope.session) {
      rec.textEdits = textEdits[i] ?? null;
      rec.nativeText = nativeText[i] ?? null;
    }
    yield '\n';
    yield JSON.stringify(rec);
  }
}

/**
 * Stream string chunks through a gzip CompressionStream.
 * With `charLimit` set, aborts the stream and returns null once the chunks exceed it.
 * @param {Iterable<string>} chunks
 * @param {number} [charLimit]
 * @returns {Promise<?ArrayBuffer>}
 */
async function compressStringChunks(chunks, charLimit) {
  const cs = new CompressionStream('gzip');
  const outPromise = new Response(cs.readable).arrayBuffer();
  const writer = cs.writable.getWriter();
  const encoder = new TextEncoder();
  let pending = '';
  let total = 0;
  for (const chunk of chunks) {
    total += chunk.length;
    if (charLimit && total > charLimit) {
      writer.abort().catch(() => {});
      outPromise.catch(() => {});
      return null;
    }
    pending += chunk;
    if (pending.length >= SCRIBE_ENCODE_BATCH) {
      await writer.write(encoder.encode(pending));
      pending = '';
    }
  }
  if (pending) await writer.write(encoder.encode(pending));
  await writer.close();
  return outPromise;
}

/**
 * Export this document's OCR data to the specified format.
 *
 * Every setting resolves as `options.X ?? scribeDocDefaults.X`.
 *
 * @param {ScribeDoc} doc
 * @param {'pdf'|'hocr'|'alto'|'docx'|'html'|'xlsx'|'txt'|'text'|'md'|'scribe'} [format='txt']
 * @param {ExportOptions} [options]
 * @returns {Promise<string|ArrayBuffer>}
 */
export async function exportData(doc, format = 'txt', options = {}) {
  if (format === 'text') format = 'txt';

  // A deferred import's extraction may still be in flight; every format below reads its outputs
  // (ocr layers, data tables, annotations). Resolved at no cost for non-deferred documents.
  await doc.textReady;

  const minPage = options.minPage ?? 0;
  let maxPage = options.maxPage ?? -1;
  let pageArr = options.pageArr ?? null;

  // Every setting resolves as `options.X ?? scribeDocDefaults.X`. There is no per-doc
  // instance state for settings.
  const displayMode = options.displayMode ?? scribeDocDefaults.displayMode;
  const colorMode = options.colorMode ?? scribeDocDefaults.colorMode;
  const overlayOpacity = options.overlayOpacity ?? scribeDocDefaults.overlayOpacity;
  const addOverlay = options.addOverlay ?? scribeDocDefaults.addOverlay;
  const autoRotate = options.autoRotate ?? scribeDocDefaults.autoRotate;
  const confThreshHigh = options.confThreshHigh ?? scribeDocDefaults.confThreshHigh;
  const confThreshMed = options.confThreshMed ?? scribeDocDefaults.confThreshMed;
  const standardizePageSize = options.standardizePageSize ?? scribeDocDefaults.standardizePageSize;
  const humanReadablePDF = options.humanReadablePDF ?? scribeDocDefaults.humanReadablePDF;
  const reflow = options.reflow ?? scribeDocDefaults.reflow;
  const lineNumbers = options.lineNumbers ?? scribeDocDefaults.lineNumbers;
  const removeMargins = options.removeMargins ?? scribeDocDefaults.removeMargins;
  const includeImagesOpt = options.includeImages ?? scribeDocDefaults.includeImages;
  const convertDupSourceTextToPaths = options.convertDupSourceTextToPaths ?? scribeDocDefaults.convertDupSourceTextToPaths;
  const embedFonts = options.embedFonts ?? scribeDocDefaults.embedFonts;
  const enableLayout = options.enableLayout ?? scribeDocDefaults.enableLayout;
  const compressScribe = options.compressScribe ?? scribeDocDefaults.compressScribe;
  const includeExtraTextScribe = options.includeExtraTextScribe ?? scribeDocDefaults.includeExtraTextScribe;
  const includeCharBoxesScribe = options.includeCharBoxesScribe ?? scribeDocDefaults.includeCharBoxesScribe;
  const scribeSession = options.scribeSession ?? scribeDocDefaults.scribeSession;
  const scribeSegmentThreshold = options.scribeSegmentThreshold ?? scribeDocDefaults.scribeSegmentThreshold;

  if (!pageArr) {
    if (maxPage === -1) maxPage = doc.inputData.pageCount - 1;
    pageArr = [];
    for (let i = minPage; i <= maxPage; i++) pageArr.push(i);
  }

  /** @type {Array<OcrPage>} */
  let ocrDownload = [];

  // Export a specific named OCR layer when requested (e.g. a single engine's output), else the active one.
  if (options.ocrName && !doc.ocr[options.ocrName]) {
    throw new Error(`No OCR layer named "${options.ocrName}" on this document.`);
  }
  const ocrSource = options.ocrName ? doc.ocr[options.ocrName] : doc.ocr.active;

  if (format !== 'hocr' && enableLayout) {
    // Reorder HOCR elements according to layout boxes
    for (let i = 0; i < ocrSource.length; i++) {
      ocrDownload.push(reorderOcrPage(ocrSource[i], doc.layoutRegions.pages[i]));
    }
  } else {
    ocrDownload = ocrSource;
  }

  // Every export except `.scribe` (which persists the marks unapplied) is built from redaction-filtered pages.
  // Each marked page is cloned so the live document stays unmutated (marks stay editable), and words whose page-space bbox overlaps a mark are dropped.
  // This filters every text output, including the PDF invisible OCR layer.
  // The same rects drive the removal from PDF page streams and page rasters further down.
  /** @type {Map<number, Array<bbox>>} */
  const redactRectsByPage = new Map();
  if (format !== 'scribe') {
    for (let i = 0; i < doc.annotations.pages.length; i++) {
      const rects = (doc.annotations.pages[i] || []).filter((a) => a.type === 'redact').map((a) => a.bbox);
      if (rects.length > 0) redactRectsByPage.set(i, rects);
    }
  }
  if (redactRectsByPage.size > 0) {
    if (ocrDownload === ocrSource) ocrDownload = [...ocrSource];
    for (const [i, rects] of redactRectsByPage) {
      const page = ocrDownload[i];
      if (!page) continue;
      const clone = clonePage(page);
      const dropIds = [];
      for (const line of clone.lines) {
        for (const word of line.words) {
          const b = bboxToPageSpace(word.bbox, line.orientation, clone.dims);
          // All-or-nothing per word: any strict overlap drops the whole word (over-redaction beats a leak).
          if (rects.some((r) => b.left < r.right && b.right > r.left && b.top < r.bottom && b.bottom > r.top)) {
            dropIds.push(word.id);
          }
        }
      }
      if (dropIds.length > 0) ocr.deletePageWords(clone, dropIds);
      ocrDownload[i] = clone;
    }
  }

  // Annotations overlapping a mark are dropped too: a highlight or note over redacted text leaks its location, and often its content via the comment.
  // Redact marks themselves stay in the array; the PDF writers consume them for content removal and never emit them as annotations.
  let annotationsPagesExport = doc.annotations.pages;
  if (redactRectsByPage.size > 0) {
    annotationsPagesExport = doc.annotations.pages.map((pageAnnots, i) => {
      const rects = redactRectsByPage.get(i);
      if (!rects || !pageAnnots || pageAnnots.length === 0) return pageAnnots || [];
      return pageAnnots.filter((a) => {
        if (a.type === 'redact') return true;
        let b = null;
        if (a.type === 'line') {
          b = {
            left: Math.min(a.points[0], a.points[2]), top: Math.min(a.points[1], a.points[3]),
            right: Math.max(a.points[0], a.points[2]), bottom: Math.max(a.points[1], a.points[3]),
          };
        } else if (a.type === 'polygon' || a.type === 'polyline') {
          const xs = a.vertices.filter((_, k) => k % 2 === 0);
          const ys = a.vertices.filter((_, k) => k % 2 === 1);
          b = {
            left: Math.min(...xs), top: Math.min(...ys), right: Math.max(...xs), bottom: Math.max(...ys),
          };
        } else if (a.bbox) {
          b = a.bbox;
        }
        if (!b) return true;
        return !rects.some((r) => b.left < r.right && b.right > r.left && b.top < r.bottom && b.bottom > r.top);
      });
    });
  }

  /** @type {string|ArrayBuffer} */
  let content;

  if (format === 'pdf') {
    if (convertDupSourceTextToPaths && !(displayMode !== 'ebook' && doc.inputData.pdfMode && addOverlay)) {
      console.warn('convertDupSourceTextToPaths is only applied when overlaying OCR text onto a PDF input '
        + "(requires a PDF input, addOverlay enabled, and displayMode other than 'ebook'); ignoring.");
    }

    // Surfaces per-annotation skips (a bad annotation no longer aborts the whole export).
    const warningHandler = (message) => doc.warningHandler({ message });

    // A non-null scrub forces the overlay writer onto its rebuild path.
    const scrub = options.sanitize ? { opts: { ...defaultScrubOpts(), ...(options.scrubOpts || {}) } } : null;

    const docInfo = options.docInfo ?? null;
    if (docInfo && scrub) {
      console.warn('docInfo is not applied when sanitize is set, which removes document metadata; ignoring.');
    }

    const dimsLimit = { width: -1, height: -1 };
    if (standardizePageSize) {
      for (const i of pageArr) {
        dimsLimit.height = Math.max(dimsLimit.height, doc.pageMetrics[i].dims.height);
        dimsLimit.width = Math.max(dimsLimit.width, doc.pageMetrics[i].dims.width);
      }
    }

    // For proof or ocr mode the text layer needs to be combined with a background layer
    if (displayMode !== 'ebook') {
      const insertInputPDF = doc.inputData.pdfMode && addOverlay;

      const rotateBackground = !insertInputPDF && autoRotate;

      const rotateText = !rotateBackground;

      if (insertInputPDF) {
        try {
          let basePdfData = doc.images.pdfData;
          let overlayOcrArr = ocrDownload;
          let overlayPageMetricsArr = doc.pageMetrics;
          let overlayAnnotationsPages = annotationsPagesExport;
          let overlayTextEditsPages = doc.textEdits.pages;
          let pageStats = doc.inputData.pageStats;
          let ocrAppliedArr = doc.inputData.ocrApplied;
          // Page edits (delete/reorder) make each slot's source page (`sourcePageN`) diverge from its display position,
          // so subset the input PDF to the source order while the overlay arrays stay in display order.
          // An identity composition (no reordering, full page set) skips the subset.
          const sourceArr = pageArr.map((p) => doc.pageMetrics[p]?.sourcePageN ?? p);
          // A page copied from another document carries a foreign `sourceId`, so multiSource flags an export that spans more than one source PDF.
          const sourceIdArr = pageArr.map((p) => doc.pageMetrics[p]?.sourceId ?? doc.images.primarySourceId);
          const multiSource = sourceIdArr.some((id) => id !== doc.images.primarySourceId);
          const composed = multiSource || sourceArr.some((s, k) => s !== pageArr[k]) || pageArr.length < doc.inputData.pageCount;
          // [] (not null) makes the writers strip a source's existing /Outlines, but null would preserve them.
          const outlineForOutput = remapOutline(doc.outline || [], pageArrIndexMap(pageArr));
          if (composed) {
            const fullStats = pageStats;
            const fullOcrApplied = ocrAppliedArr;
            if (multiSource) {
              // mergePdfs duplicates shared fonts/images per source and keeps only the first source's OCG layers.
              const runs = [];
              for (let k = 0; k < pageArr.length; k++) {
                const last = runs[runs.length - 1];
                if (last && last.sourceId === sourceIdArr[k]) last.pages.push(sourceArr[k]);
                else runs.push({ sourceId: sourceIdArr[k], pages: [sourceArr[k]] });
              }
              const runBuffers = [];
              for (const run of runs) {
                const bytes = doc.images.sources.get(run.sourceId)?.pdfData;
                if (!bytes) throw new Error(`Cannot export: missing PDF bytes for render source ${run.sourceId}.`);
                runBuffers.push(await subsetPdf(bytes, run.pages));
              }
              basePdfData = runBuffers.length === 1 ? runBuffers[0] : await mergePdfs(runBuffers, { outline: outlineForOutput });
            } else {
              basePdfData = await subsetPdf(basePdfData, sourceArr, { outline: outlineForOutput });
            }
            overlayOcrArr = pageArr.map((i) => ocrDownload[i]);
            overlayPageMetricsArr = pageArr.map((i) => doc.pageMetrics[i]);
            overlayAnnotationsPages = pageArr.map((i) => annotationsPagesExport[i] || []);
            overlayTextEditsPages = pageArr.map((i) => doc.textEdits.pages[i] || []);
            pageStats = fullStats ? pageArr.map((i) => fullStats[i]) : null;
            ocrAppliedArr = fullOcrApplied ? pageArr.map((i) => fullOcrApplied[i]) : null;
          }

          // Snapshot the real OCR before the routing below empties overlayOcrArr for clean text-native pages,
          // since highlight consolidation still needs the real word/line geometry to coalesce per-word highlights into per-line quads.
          const annotationOcrArr = overlayOcrArr;

          // convertFullPages and convertBrokenType3 control per-page flatten vs. passthrough.
          // They default to the legacy path: a full overlay on every page plus broken-Type3 conversion.
          // The block below overrides that by routing on import-time page categories,
          // engaged for the searchable ('invis') flow by default and for a visible mode only when routePageCategories is set.
          // With routing off or categories absent (old .scribe.json sessions), the legacy defaults stand.
          /** @type {?number[]} */
          let convertFullPages = null;
          // Broken-Type3-to-paths conversion rewrites page content and strips a scanned page's invisible OCR text.
          // The annot overlay writes no replacement text layer, so leaving conversion on would silently delete searchable text.
          let convertBrokenType3 = displayMode !== 'annot';
          // convertDupSourceTextToPaths converts ALL text to paths by explicit request,
          // so it skips the category routing below entirely.
          const routeCategories = options.routePageCategories ?? (displayMode === 'invis');
          // Routing empties a clean page's overlay on the assumption that its text is already on the page, which holds only for text from the PDF's own parse.
          // A `.scribe` restore also stores its layer under this name but runs no parse, so `ocr.pdf` is what tells the two apart.
          const suppliedOcrLayer = !!doc.ocr.pdf && ocrSource === doc.ocr['User Upload'];
          if (routeCategories && !convertDupSourceTextToPaths && !suppliedOcrLayer && pageStats && pageStats.length > 0
            && (overlayOcrArr.length === 0 || overlayOcrArr.length === pageStats.length)) {
            // `flagged` marks each page that is a flattening candidate: it holds content the native text layer cannot surface
            // (`mayHaveBakedText`, `hasBrokenFontRun`, or `isScanPage`) and was OCR'd (`ocrApplied[i]`).
            // Gating on `ocrApplied` leaves every page whose text is native unflattened, so that text stays extractable.
            // With no `ocrApplied` array, nothing is flattened.
            const flagged = pageStats.map((s, i) => !!(s && (mayHaveBakedText(s) || hasBrokenFontRun(s) || isScanPage(s)))
              && !!(ocrAppliedArr && ocrAppliedArr[i]));
            // Flatten exists ONLY to support an invisible text layer:
            // a flagged page is flattened exactly when it has overlay text to add (from any source), and that text is kept.
            // A flagged page with no text, and any clean page, gets an empty overlay and is left unflattened,
            // so its native text stays the only text layer.
            const ocrIn = overlayOcrArr;
            convertFullPages = [];
            overlayOcrArr = pageStats.map((c, i) => {
              const p = ocrIn[i];
              const hasWords = !!(p && p.lines && p.lines.length > 0);
              if (flagged[i] && hasWords) {
                convertFullPages.push(i);
                return p;
              }
              // The overlay draws typed fill text from lifted fill-text lines, so dropping them would silently lose it from the export.
              const np = new OcrPage(i, p?.dims || overlayPageMetricsArr[i].dims);
              if (hasWords) {
                const keep = p.lines.filter(isFillTextLine);
                if (keep.length > 0) np.lines = keep;
              }
              return np;
            });
            convertBrokenType3 = false;
          }

          content = await overlayPdfText({
            basePdfData,
            ocrArr: overlayOcrArr,
            annotationOcrArr,
            pageMetricsArr: overlayPageMetricsArr,
            textMode: displayMode,
            rotateText,
            rotateBackground,
            confThreshHigh,
            confThreshMed,
            proofOpacity: overlayOpacity / 100,
            humanReadable: humanReadablePDF,
            annotationsPages: overlayAnnotationsPages,
            textEditsPages: overlayTextEditsPages,
            // Overlay arrays are display-ordered on the composed path, so map back to doc pages for font resolution.
            getEditFont: (i, fontObjNum) => doc.images.getEditFont(composed ? pageArr[i] : i, fontObjNum),
            convertTextToPaths: convertDupSourceTextToPaths,
            convertFullPages,
            convertBrokenType3ToPaths: convertBrokenType3,
            docFonts: doc.fonts,
            warningHandler,
            outline: outlineForOutput,
            scrub,
            docInfo,
            flattenFormFields: options.flattenFormFields ?? false,
          });
        } catch (error) {
          // Never fall back to rasterizing PDF input: it bakes vector/text pages into images and destroys searchable text.
          // Rendering image *inputs* to raster + an invisible-text layer below is a separate, legitimate path.
          throw new Error(`Failed to overlay text onto the input PDF: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
        }
      }

      // Build a fresh PDF from rendered images: reached for image inputs, or a PDF exported with the overlay disabled.
      if (!insertInputPDF) {
        const props = { rotated: rotateBackground, upscaled: false, colorMode };
        const binary = colorMode === 'binary';

        // An image could be rendered if either (1) binary is selected or (2) the input data is a PDF.
        // Otherwise, the images uploaded by the user are used.
        const renderImage = binary || doc.inputData.pdfMode;
        const includeImages = doc.inputData.pdfMode || doc.inputData.imageMode;

        // Pre-render to benefit from parallel processing, since the loop below is synchronous.
        if (renderImage && includeImages) await doc.images.preRenderRange({ pageArr, binary, props });

        /** @type {ImageWrapper[]} */
        const images = [];
        if (includeImages) {
          for (const i of pageArr) {
            let image;
            if (binary) {
              image = await doc.images.getBinary(i, props);
            } else if (doc.inputData.pdfMode) {
              image = await doc.images.getNative(i, props);
            } else {
              image = await doc.images.nativeSrc[i];
            }
            // The raster itself contains the redacted content, so the pixels are painted over.
            if (redactRectsByPage.has(i)) {
              image = await paintRedactionsOntoImage(image, redactRectsByPage.get(i), doc.pageMetrics[i].dims, doc.pageMetrics[i].angle || 0);
            }
            images.push(image);
            doc.progressHandler({ n: i, type: 'export', info: {} });
          }
        }

        content = await writePdf({
          ocrArr: ocrDownload,
          pageMetricsArr: doc.pageMetrics,
          pageArr,
          textMode: displayMode,
          rotateText,
          rotateBackground,
          dimsLimit: { width: -1, height: -1 },
          confThreshHigh,
          confThreshMed,
          proofOpacity: overlayOpacity / 100,
          images,
          includeImages,
          annotationsPages: annotationsPagesExport,
          humanReadable: humanReadablePDF,
          docFonts: doc.fonts,
          doc,
          warningHandler,
          docInfo,
        });
      }
    } else {
      content = await writePdf({
        ocrArr: ocrDownload,
        pageMetricsArr: doc.pageMetrics,
        pageArr,
        textMode: displayMode,
        rotateText: false,
        rotateBackground: true,
        dimsLimit,
        confThreshHigh,
        confThreshMed,
        proofOpacity: overlayOpacity / 100,
        annotationsPages: annotationsPagesExport,
        humanReadable: humanReadablePDF,
        docFonts: doc.fonts,
        doc,
        warningHandler,
        docInfo,
      });
    }
  } else if (format === 'hocr') {
    content = writeHocr({
      ocrData: ocrDownload,
      pageArr,
      docFonts: doc.fonts,
      layoutRegions: doc.layoutRegions,
      pageMetrics: doc.pageMetrics,
      dataTablesSerialized: doc.serializeLayoutDataTables(),
      doc,
    });
  } else if (format === 'alto') {
    content = writeAlto({
      ocrData: ocrDownload, pageArr, pageMetrics: doc.pageMetrics, doc,
    });
  } else if (format === 'html') {
    const images = /** @type {Array<ImageWrapper>} */ ([]);
    if (includeImagesOpt) {
      const props = { rotated: autoRotate, upscaled: false, colorMode };
      const binary = colorMode === 'binary';

      // An image could be rendered if either (1) binary is selected or (2) the input data is a PDF.
      // Otherwise, the images uploaded by the user are used.
      const renderImage = binary || doc.inputData.pdfMode;

      // Pre-render to benefit from parallel processing, since the loop below is synchronous.
      if (renderImage) await doc.images.preRenderRange({ pageArr, binary, props });

      for (const i of pageArr) {
        /** @type {ImageWrapper} */
        let image;
        if (binary) {
          image = await doc.images.getBinary(i, props);
        } else if (doc.inputData.pdfMode) {
          image = await doc.images.getNative(i, props);
        } else {
          image = await doc.images.nativeSrc[i];
        }
        // The raster itself contains the redacted content, so the pixels are painted over.
        if (redactRectsByPage.has(i)) {
          image = await paintRedactionsOntoImage(image, redactRectsByPage.get(i), doc.pageMetrics[i].dims, doc.pageMetrics[i].angle || 0);
        }
        images.push(image);
      }
    }

    content = writeHtml({
      ocrPages: ocrDownload,
      images,
      pageArr,
      reflowText: reflow,
      removeMargins,
      docFonts: doc.fonts,
      pageMetrics: doc.pageMetrics,
      displayMode,
      confThreshHigh,
      confThreshMed,
      overlayOpacity,
      embedFonts,
      doc,
    });
  } else if (format === 'txt') {
    content = writeText({
      ocrCurrent: ocrDownload,
      pageArr,
      reflowText: reflow,
      lineNumbers,
      pageMetrics: doc.pageMetrics,
      doc,
    });
  } else if (format === 'md') {
    content = writeMarkdown({
      ocrCurrent: ocrDownload,
      layoutPageArr: doc.layoutDataTables.pages,
      pageArr,
      reflowText: reflow,
      pageMetrics: doc.pageMetrics,
      doc,
    });
  // Defining `DISABLE_DOCX_XLSX` disables docx/xlsx exports when using build tools.
  // @ts-ignore
  } else if (typeof DISABLE_DOCX_XLSX === 'undefined' && format === 'docx') {
    // Less common export formats are loaded dynamically to reduce initial load time.
    const writeDocx = (await import('./writeDocx.js')).writeDocx;
    content = await writeDocx({
      hocrCurrent: ocrDownload, pageArr, pageMetrics: doc.pageMetrics, reflowText: reflow, doc,
    });
  // @ts-ignore
  } else if (typeof DISABLE_DOCX_XLSX === 'undefined' && format === 'xlsx') {
    // Less common export formats are loaded dynamically to reduce initial load time.
    const writeXlsx = (await import('./writeTabular.js')).writeXlsx;
    content = await writeXlsx({
      ocrPageArr: ocrDownload,
      layoutPageArr: doc.layoutDataTables.pages,
      inputData: doc.inputData,
      pageArr,
      xlsxFilenameColumn: options.xlsxFilenameColumn ?? scribeDocDefaults.xlsxFilenameColumn,
      xlsxPageNumberColumn: options.xlsxPageNumberColumn ?? scribeDocDefaults.xlsxPageNumberColumn,
      doc,
    });
  } else if (format === 'scribe') {
    /** @type {Record<string, any>} */
    const envelope = {
      fontState: doc.fonts.state,
      layoutRegions: doc.layoutRegions.pages,
      layoutDataTables: removeCircularRefsDataTables(doc.layoutDataTables.pages),
      annotations: doc.annotations.pages,
      pageRotations: (doc.pageMetrics || []).map((pm) => pm?.rotation || 0),
      pageSourceIndices: (doc.pageMetrics || []).map((pm) => pm?.sourcePageN ?? null),
      outline: doc.outline,
      inputData: {
        pdfType: doc.inputData.pdfType,
        pageStats: doc.inputData.pageStats,
        requiresOCR: doc.inputData.requiresOCR,
        ocrApplied: doc.inputData.ocrApplied,
      },
      /** @type {ScribeSessionData|undefined} */
      session: undefined,
    };
    // App-only state ships in one opt-in block, so standard-format consumers never receive it and the app save path cannot scatter it.
    if (scribeSession) {
      envelope.session = {
        v: 1, textEdits: doc.textEdits.pages, nativeText: doc.nativeText.pages, fillText: collectFillTextRefs(doc),
      };
    }
    const serializeOpts = { includeText: includeExtraTextScribe, includeCharBoxes: includeCharBoxesScribe };
    if (compressScribe) {
      content = await compressStringChunks(scribeJsonChunks(ocrDownload, serializeOpts, envelope), scribeSegmentThreshold)
        ?? await compressStringChunks(scribeSegmentChunks(ocrDownload, serializeOpts, envelope));
    } else {
      // A document whose JSON cannot exist as one string (V8 caps strings at 2^29 - 24) has no uncompressed form.
      const parts = [];
      let total = 0;
      for (const chunk of scribeJsonChunks(ocrDownload, serializeOpts, envelope)) {
        total += chunk.length;
        if (total > 536_870_888) {
          throw new Error('This document\'s JSON exceeds the JavaScript string limit, so it cannot be exported as uncompressed .scribe.json; export compressed .scribe instead.');
        }
        parts.push(chunk);
      }
      content = parts.join('');
    }
  }

  return content;
}

/**
 * Run `exportData` for this document and save the result as a download (browser) or local file (Node.js).
 * @param {ScribeDoc} doc
 * @param {'pdf'|'hocr'|'alto'|'docx'|'xlsx'|'txt'|'text'|'md'|'html'|'scribe'} format
 * @param {string} fileName
 * @param {ExportOptions} [options]
 */
export async function download(doc, format, fileName, options = {}) {
  if (format === 'text') format = 'txt';
  const compressScribe = options.compressScribe ?? scribeDocDefaults.compressScribe;
  let ext;
  if (format === 'alto') {
    ext = 'xml';
  } else if (format === 'scribe' && !compressScribe) {
    ext = 'scribe.json';
  } else {
    ext = format;
  }
  // Replace an existing extension, or append one when the name has none.
  // Otherwise the file saves extensionless and won't open.
  fileName = /\.\w{1,6}$/.test(fileName) ? fileName.replace(/\.\w{1,6}$/, `.${ext}`) : `${fileName}.${ext}`;
  const content = await exportData(doc, format, options);
  await saveAs(content, fileName);
}
