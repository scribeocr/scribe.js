import { scribeDocDefaults } from '../containers/scribeDocDefaults.js';
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
import ocr, { OcrPage, removeCircularRefsOcr, clonePageFull } from '../objects/ocrObjects.js';
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
 * @property {boolean} [convertDupSourceTextToPaths] - When overlaying onto a PDF input,
 *    convert the input PDF's vector text to glyph outlines before adding the invisible OCR text layer.
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
 * @property {string} [ocrName] - Export this named OCR layer (a key of `doc.ocr`) instead of the active one.
 * @property {'width' | 'sentence'} [docxLineSplitMode]
 * @property {boolean} [sanitize] - Strip identifying metadata (Info/XMP/PieceInfo/embedded files/image
 *    EXIF/actions/prior revisions/signatures) from the exported PDF, keeping the visible pages unchanged.
 *    Only applies to the PDF-overlay export path (PDF input with addOverlay).
 * @property {object} [scrubOpts] - Overrides the Balanced scrub defaults when `sanitize` is set
 *    (`stripStructTree`, `stripPageLabels`, `stripViewerPrefs`, `dropOCProperties`).
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
      const clone = clonePageFull(page);
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
          if (routeCategories && !convertDupSourceTextToPaths && pageStats && pageStats.length > 0
            && (overlayOcrArr.length === 0 || overlayOcrArr.length === pageStats.length)) {
            // `flagged` marks each page that is a flattening candidate: it holds content the native text layer cannot surface
            // (`mayHaveBakedText`, `hasBrokenFontRun`, or `isScanPage`) and was OCR'd (`ocrApplied[i]`).
            // Gating on `ocrApplied` leaves a skipped or never-OCR'd page unflattened so its native text stays extractable.
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
              return new OcrPage(i, p?.dims || overlayPageMetricsArr[i].dims);
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
            convertTextToPaths: convertDupSourceTextToPaths,
            convertFullPages,
            convertBrokenType3ToPaths: convertBrokenType3,
            docFonts: doc.fonts,
            warningHandler,
            outline: outlineForOutput,
            scrub,
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
    const data = {
      ocr: removeCircularRefsOcr(ocrDownload, { includeText: includeExtraTextScribe, includeCharBoxes: includeCharBoxesScribe }),
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
    };
    const contentStr = JSON.stringify(data);
    if (compressScribe) {
      const cs = new CompressionStream('gzip');
      const compressedStream = new Blob([new TextEncoder().encode(contentStr)]).stream().pipeThrough(cs);
      content = await new Response(compressedStream).arrayBuffer();
    } else {
      content = contentStr;
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
