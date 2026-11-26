import { scribeDocDefaults } from '../containers/scribeDocDefaults.js';
import { collectFillTextRefs, isFillTextLine } from '../fillSign.js';
import { reorderOcrPage } from '../modifyOCR.js';
import { concatBytes, saveAs } from '../utils/miscUtils.js';
import { compressChunks } from '../utils/byteStream.js';
import { opt } from '../containers/app.js';
import { heldJson } from '../containers/pageStore.js';
import { writePdf } from './pdf/writePdf.js';
import { textAnnotIconBox } from './pdf/writePdfAnnots.js';
import { overlayPdfText } from './pdf/writePdfOverlay.js';
import { subsetPdf } from './pdf/subsetPdf.js';
import { mergePdfs } from './pdf/mergePdfs.js';
import { replaceType3FontsWithCorrected } from './pdf/replaceType3Fonts.js';
import { defaultScrubOpts } from '../pdf/metadata/scrubMetadata.js';
import { remapOutline, pageArrIndexMap } from '../objects/outlineObjects.js';
import { writeHocrChunks } from './writeHocr.js';
import { writeTextChunks } from './writeText.js';
import { writeHtmlChunks } from './writeHtml.js';
import { writeAltoChunks } from './writeAlto.js';
import { writeMarkdownChunks } from './writeMarkdown.js';
import ocr, { OcrPage, clonePage } from '../objects/ocrObjects.js';
import { removeCircularRefsDataTables, removeCircularRefsRegions } from '../objects/layoutObjects.js';
import { mayHaveBakedText, hasBrokenFontRun, isScanPage } from '../pdf/ocrPageSelection.js';
import { bboxToPageSpace } from '../addHighlights.js';
import { ImageWrapper, imageUtils } from '../objects/imageObjects.js';
import { ca } from '../canvasAdapter.js';
import { _buildPngDataUrl } from '../pdf/renderPdfPage.js';

/** @typedef {import('../containers/scribeDoc.js').ScribeDoc} ScribeDoc */

/**
 * Options for `exportData` and `download`.
 * @typedef {Object} ExportOptions
 * @property {number} [minPage=0] - First 0-based page index to export.
 * @property {number} [maxPage=-1] - Last 0-based page index to export (inclusive), or `-1` for the last page.
 * @property {?Array<number>} [pageArr=null] - Array of 0-based page indices to include.
 *   Overrides `minPage` and `maxPage` when provided.
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
 * @property {boolean} [convertDupSourceTextToPaths] - When overlaying onto a PDF input, convert the input PDF's vector text to glyph outlines before adding the OCR text layer.
 *   Ignored unless the export uses the overlay path (PDF input, `addOverlay`, `displayMode !== 'ebook'`).
 * @property {boolean} [routePageCategories] - Whether PDF overlay exports flatten source text and add OCR only on recognized pages with unextractable text, leaving other pages untouched.
 *   Defaults to `true` when `displayMode` is `'invis'` and `false` otherwise.
 * @property {boolean} [embedFonts]
 * @property {boolean} [enableLayout]
 * @property {boolean} [xlsxFilenameColumn]
 * @property {boolean} [xlsxPageNumberColumn]
 * @property {boolean} [compressScribe]
 * @property {boolean} [includeExtraTextScribe]
 * @property {boolean} [includeCharBoxesScribe=true] - Include per-character bounding boxes (`word.chars`) in `.scribe` exports.
 * @property {boolean} [scribeSession=false] - Include the application `session` block (text-edit records, native-text metadata) in `.scribe` exports.
 * @property {boolean} [includeOcrScribe=true] - Include per-page OCR data in the `ocr` block of `.scribe` exports.
 * @property {boolean} [scribeSegments=false] - Switch compressed `.scribe` exports above `scribeSegmentThreshold` from a single JSON document to a segmented format.
 *   Single-JSON exports exceeding JavaScript's string-length limit cannot be read back in JavaScript, including by the scribe.js library.
 * @property {number} [scribeSegmentThreshold=400000000] - Character count above which a compressed `.scribe` export with `scribeSegments` set switches to the segmented format.
 *   `0` selects the segmented format at any size.
 * @property {string} [layer] - Export this named text layer from `doc.layers` instead of the active one.
 * @property {string} [ocrName] - Alias of `layer`.
 * @property {'width' | 'sentence'} [docxLineSplitMode]
 * @property {boolean} [htmlFitWindow=false] - Scale HTML export pages down to the window width.
 *   Ignored when `reflow` is set.
 * @property {boolean} [dropPageHeadersFooters=false] - Omit page headers, footers, page numbers, and margin line numbers from reflowed text, Markdown, Word, and HTML exports.
 * @property {boolean} [sanitize=false] - Strip identifying metadata from the exported PDF, keeping the visible pages unchanged.
 *   Covers Info/XMP/PieceInfo, embedded files, image EXIF, actions, prior revisions, and signatures.
 *   Only applies to the PDF-overlay export path (PDF input, `addOverlay`, `displayMode !== 'ebook'`).
 * @property {object} [scrubOpts] - Additional PDF structures to strip when `sanitize` is set (`stripStructTree`, `stripPageLabels`, `stripViewerPrefs`, `dropOCProperties`, all `false` by default).
 * @property {boolean} [flattenFormFields=false] - Bake each form field's current appearance into the page content and remove the interactive fields.
 *   Only applies to the PDF-overlay export path (PDF input, `addOverlay`, `displayMode !== 'ebook'`).
 * @property {?Object<string, ?string>} [docInfo=null] - Document information entries (such as `Title`, `Author`, `Creator`) written into the exported PDF.
 *   Preserves other existing entries on the input PDF, overrides matching keys, and removes any key set to `null`.
 *   Ignored on PDF overlay exports when `sanitize` is set.
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
 * Resolve an image region's pixels into an embeddable image.
 * With no `source` set, the pixels are cropped out of the page raster at the region's coordinates and encoded as JPEG.
 * @param {LayoutImageRegion} region
 * @param {ImageWrapper} image - Full-page raster of the region's page.
 * @param {dims} pageDims - Page dimensions in the same frame as the region coordinates.
 * @returns {Promise<ImageWrapper>}
 */
export async function resolveRegionImage(region, image, pageDims) {
  if (region.source) throw new Error(`Unsupported image region source: ${region.source.kind}`);
  const drawable = image.imageBitmap || await ca.getImageBitmap(image.ensureSrc());
  const { width } = imageUtils.getDims(image);
  // The render preserves aspect ratio, so one axis's ratio maps region coordinates to raster pixels.
  const scale = width / pageDims.width;
  const srcX = region.coords.left * scale;
  const srcY = region.coords.top * scale;
  const srcW = (region.coords.right - region.coords.left) * scale;
  const srcH = (region.coords.bottom - region.coords.top) * scale;
  const outW = Math.max(1, Math.round(srcW));
  const outH = Math.max(1, Math.round(srcH));
  const canvas = await ca.createCanvas(outW, outH);
  const ctx = /** @type {OffscreenCanvasRenderingContext2D} */ (canvas.getContext('2d'));
  ctx.drawImage(drawable, srcX, srcY, srcW, srcH, 0, 0, outW, outH);
  // `type` for browsers, `mime` for the Node canvas fork: both are needed to get a JPEG (not PNG) Blob.
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', mime: 'image/jpeg', quality: 0.85 });
  ca.closeDrawable(canvas);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let j = 0; j < bytes.length; j += 32768) binary += String.fromCharCode(...bytes.subarray(j, j + 32768));
  return new ImageWrapper(region.page.n, `data:image/jpeg;base64,${btoa(binary)}`, image.colorMode, image.rotated, image.upscaled);
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
  for (const [key, value] of Object.entries(envelope)) {
    if (key !== 'session' || !value) {
      const json = JSON.stringify(value);
      if (json !== undefined) yield `,${JSON.stringify(key)}:${json}`;
      continue;
    }
    let sep = ',"session":{';
    for (const [sessionKey, sessionValue] of Object.entries(value)) {
      if (sessionKey === 'nativeText' || sessionKey === 'fillShapes') {
        yield `${sep}${JSON.stringify(sessionKey)}:[`;
        for (let i = 0; i < sessionValue.length; i++) yield `${i > 0 ? ',' : ''}${JSON.stringify(sessionValue[i]) ?? 'null'}`;
        yield ']';
      } else {
        const json = JSON.stringify(sessionValue);
        if (json === undefined) continue;
        yield `${sep}${JSON.stringify(sessionKey)}:${json}`;
      }
      sep = ',';
    }
    yield sep === ',' ? '}' : `${sep}}`;
  }
  yield '}';
}

/**
 * Build the document-level header object for a segmented `.scribe` file.
 * @param {Record<string, any>} envelope
 * @param {number} pageCount
 */
export function scribeSegmentHeader(envelope, pageCount) {
  return {
    scribeSegments: 1,
    pageCount,
    fontState: envelope.fontState,
    layoutRegions: envelope.layoutRegions,
    layoutDataTables: envelope.layoutDataTables,
    annotations: envelope.annotations,
    pageRotations: envelope.pageRotations,
    outline: envelope.outline,
    inputData: envelope.inputData,
    session: envelope.session
      ? {
        v: envelope.session.v,
        pageSourceIndices: envelope.session.pageSourceIndices,
        contentEdits: envelope.session.contentEdits,
        fillText: envelope.session.fillText,
        stampSources: envelope.session.stampSources,
        assistantChats: envelope.session.assistantChats,
        redactions: envelope.session.redactions,
        type3GlyphMappings: envelope.session.type3GlyphMappings,
        tableExport: envelope.session.tableExport,
        editedAt: envelope.session.editedAt,
        recognizedAt: envelope.session.recognizedAt,
        hocrSourceHead: envelope.session.hocrSource?.head,
      }
      : undefined,
  };
}

/**
 * Yield the `.scribe` segmented form as string chunks.
 * @param {Array<OcrPage>} ocrPages
 * @param {{includeText: boolean, includeCharBoxes: boolean}} serializeOpts
 * @param {ReturnType<typeof scribeEnvelope>} envelope
 */
function* scribeSegmentChunks(ocrPages, serializeOpts, envelope) {
  yield JSON.stringify(scribeSegmentHeader(envelope, ocrPages.length));
  const nativeText = envelope.session?.nativeText || [];
  const fillShapes = envelope.session?.fillShapes || [];
  const truth = envelope.session?.truth || [];
  const hocrSourcePages = envelope.session?.hocrSource?.pages || [];
  for (let i = 0; i < ocrPages.length; i++) {
    const page = ocrPages[i] ? pageForScribe(ocrPages[i], serializeOpts) : null;
    /** @type {Record<string, unknown>} */
    const rec = { i, ocr: page };
    if (envelope.session) {
      rec.nativeText = nativeText[i] ?? null;
      rec.fillShapes = fillShapes[i] ?? null;
      if (envelope.session.truth) rec.truth = truth[i] ?? null;
      rec.hocrSource = hocrSourcePages[i] ?? null;
    }
    yield '\n';
    yield JSON.stringify(rec);
  }
}

/**
 * Stream string chunks through gzip, yielding the compressed bytes as they come out.
 * @param {Iterable<string>} chunks
 * @returns {AsyncGenerator<Uint8Array>}
 */
function gzipChunks(chunks) {
  const encoder = new TextEncoder();
  return compressChunks((function* encodedBatches() {
    let pending = '';
    for (const chunk of chunks) {
      pending += chunk;
      if (pending.length >= SCRIBE_ENCODE_BATCH) {
        yield encoder.encode(pending);
        pending = '';
      }
    }
    if (pending) yield encoder.encode(pending);
  }()), 'gzip');
}

/**
 * Return a read-only array proxy that computes elements on demand.
 * @template T
 * @param {number} length
 * @param {(n: number) => boolean} has - True if index `n` is populated, or false for a sparse hole.
 * @param {(n: number) => T} read
 * @returns {Array<T>}
 */
function lazyArray(length, has, read) {
  let lastN = -1;
  /** @type {T|undefined} */
  let last;
  return new Proxy(/** @type {Array<T>} */ ([]), {
    get(target, prop, receiver) {
      if (prop === 'length') return length;
      if (typeof prop === 'string' && /^\d+$/.test(prop)) {
        const n = Number(prop);
        if (n >= length || !has(n)) return undefined;
        if (n !== lastN) {
          last = read(n);
          lastN = n;
        }
        return last;
      }
      return Reflect.get(target, prop, receiver);
    },
    has(target, prop) {
      if (typeof prop === 'string' && /^\d+$/.test(prop)) return Number(prop) < length && has(Number(prop));
      return Reflect.has(target, prop);
    },
  });
}

/**
 * Build every top-level field of a `.scribe` file except `ocr`.
 * @param {ScribeDoc} doc
 * @param {boolean} session - Include the app-only `session` block.
 * @param {?string} layerName - Text layer whose hOCR source records are included in `session`.
 */
export function scribeEnvelope(doc, session, layerName) {
  /** @param {Array<import('../objects/outlineObjects.js').OutlineNode>} nodes @returns {Array<Object>} */
  const outlineWithoutIds = (nodes) => nodes.map((n) => ({
    title: n.title, dest: n.dest, action: n.action, open: n.open, children: outlineWithoutIds(n.children),
  }));
  const envelope = {
    fontState: doc.fonts.state,
    layoutRegions: removeCircularRefsRegions(doc.layoutRegions.pages),
    layoutDataTables: removeCircularRefsDataTables(doc.layoutDataTables.pages),
    annotations: doc.annotations.pages,
    pageRotations: (doc.pageMetrics || []).map((pm) => pm?.rotation || 0),
    outline: outlineWithoutIds(doc.outline || []),
    inputData: {
      pdfType: doc.inputData.pdfType,
      pageStats: doc.inputData.pageStats,
      requiresOCR: doc.inputData.requiresOCR,
      ocrApplied: doc.inputData.ocrApplied,
    },
    /** @type {ScribeSessionData|undefined} */
    session: undefined,
  };
  if (session) {
    const hocrHead = layerName ? doc.hocrSource.head[layerName] ?? null : null;
    const hocrPages = lazyArray(doc.hocrSource.pages.length, (n) => !!(layerName && doc.hocrSource.pages[n]?.[layerName]),
      (n) => heldJson(doc.hocrSource.pages[n][/** @type {string} */ (layerName)]));
    envelope.session = {
      v: 1,
      contentEdits: doc.contentEdits.pages,
      // Indexing `doc.nativeText.pages[n]` marks a `'pdf'`-layer page modified and drops its cached records.
      nativeText: lazyArray(doc.nativeText.pages.length, (n) => n in doc.nativeText.pages, (n) => {
        const extras = doc.pageStore.extras(n, false);
        return extras ? extras.nativeText ?? {} : doc.nativeText.pages[n];
      }),
      hocrSource: hocrHead || (layerName && doc.hocrSource.pages.some((recs) => recs?.[layerName])) ? { head: hocrHead, pages: hocrPages } : undefined,
      fillText: collectFillTextRefs(doc),
      pageSourceIndices: (doc.pageMetrics || []).map((pm) => pm?.sourcePageN ?? null),
    };
    if (doc.sessionMarks.editedAt != null) envelope.session.editedAt = doc.sessionMarks.editedAt;
    if (doc.sessionMarks.recognizedAt != null) envelope.session.recognizedAt = doc.sessionMarks.recognizedAt;
    if (doc.truth.pages.some((p) => p)) envelope.session.truth = doc.truth.pages.map((p) => p ?? null);
    const r1 = (/** @type {number} */ v) => Math.round(v * 10) / 10;
    const box = (/** @type {{left: number, top: number, right: number, bottom: number}} */ b) => [r1(b.left), r1(b.top), r1(b.right), r1(b.bottom)];
    envelope.session.fillShapes = lazyArray(doc.fillShapes.pages.length, (n) => n in doc.fillShapes.pages, (n) => {
      const extras = doc.pageStore.extras(n, false);
      const shapes = extras ? extras.fillShapes : doc.fillShapes.pages[n];
      if (!shapes) return null;
      /** @type {EncodedFillShapes} */
      const enc = {};
      if (shapes.images?.length) enc.i = shapes.images.map((e) => [...box(e), e.sites.map((st) => [...box(st), st.objNum ?? -1])]);
      if (shapes.paths?.length) enc.p = shapes.paths.map((e) => [...box(e), e.sites.map((st) => [...box(st), st.paint, st.commands])]);
      if (shapes.squares?.length) enc.q = shapes.squares.map((e) => [...box(e), e.stroke ? 1 : 0]);
      if (shapes.marks?.length) enc.m = shapes.marks.map((e) => box(e));
      if (shapes.glyphBoxes?.length) enc.g = shapes.glyphBoxes.map((e) => [e.id, ...box(e.bbox)]);
      if (shapes.pathsIneligible) enc.pi = 1;
      if (shapes.marksOverflow) enc.mo = 1;
      return enc;
    });
    if (doc.stampSources.pages.some((p) => p && p.length)) {
      envelope.session.stampSources = doc.stampSources.pages.map((p) => (p && p.length
        ? p.map((e) => /** @type {[number, number, number, number, number]} */ ([e.srcRef, e.bbox.left, e.bbox.top, e.bbox.right, e.bbox.bottom])) : null));
    }
    if (doc.assistantChats.chats.length) envelope.session.assistantChats = doc.assistantChats.chats;
    if (doc.redactions.terms.length) envelope.session.redactions = doc.redactions;
    if (doc.type3GlyphMappings.size) envelope.session.type3GlyphMappings = [...doc.type3GlyphMappings];
    if (Object.keys(doc.tableExport.excluded).length || Object.keys(doc.tableExport.names).length) envelope.session.tableExport = doc.tableExport;
  }
  return envelope;
}

/**
 * Export `doc` to `format` as sequential output chunks.
 * Yields `string` chunks for text formats and uncompressed `.scribe`, `Uint8Array` chunks for `docx`, `xlsx`, and compressed `.scribe`, and one `ArrayBuffer` for `pdf`.
 * @param {ScribeDoc} doc
 * @param {'pdf'|'hocr'|'alto'|'docx'|'html'|'xlsx'|'txt'|'md'|'scribe'} format
 * @param {ExportOptions} options
 * @returns {AsyncGenerator<string|ArrayBuffer|Uint8Array>}
 */
async function* exportChunks(doc, format, options) {
  await doc.textReady;
  if (doc._textMissing) throw new Error('The document could not be loaded, so it was not exported.');

  const minPage = options.minPage ?? 0;
  let maxPage = options.maxPage ?? -1;
  let pageArr = options.pageArr ?? null;

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
  const htmlFitWindow = options.htmlFitWindow ?? scribeDocDefaults.htmlFitWindow;
  const dropPageHeadersFooters = options.dropPageHeadersFooters ?? scribeDocDefaults.dropPageHeadersFooters;
  const lineNumbers = options.lineNumbers ?? scribeDocDefaults.lineNumbers;
  const removeMargins = options.removeMargins ?? scribeDocDefaults.removeMargins;
  const includeImagesOpt = options.includeImages ?? scribeDocDefaults.includeImages;
  const convertDupSourceTextToPaths = options.convertDupSourceTextToPaths ?? scribeDocDefaults.convertDupSourceTextToPaths;
  const embedFonts = options.embedFonts ?? scribeDocDefaults.embedFonts;
  const enableLayout = options.enableLayout ?? scribeDocDefaults.enableLayout;
  const compressScribe = options.compressScribe ?? scribeDocDefaults.compressScribe;
  const includeExtraTextScribe = options.includeExtraTextScribe ?? scribeDocDefaults.includeExtraTextScribe;
  const includeCharBoxesScribe = options.includeCharBoxesScribe ?? scribeDocDefaults.includeCharBoxesScribe;
  const includeOcrScribe = options.includeOcrScribe ?? scribeDocDefaults.includeOcrScribe;
  const scribeSession = options.scribeSession ?? scribeDocDefaults.scribeSession;
  const scribeSegments = options.scribeSegments ?? scribeDocDefaults.scribeSegments;
  const scribeSegmentThreshold = options.scribeSegmentThreshold ?? scribeDocDefaults.scribeSegmentThreshold;

  if (!pageArr) {
    if (maxPage === -1) maxPage = doc.inputData.pageCount - 1;
    pageArr = [];
    for (let i = minPage; i <= maxPage; i++) pageArr.push(i);
  }

  // Export a specific named OCR layer when requested (e.g. a single engine's output), else the active one.
  const layerOption = options.layer ?? options.ocrName;
  if (layerOption && layerOption !== 'active' && !doc.pageStore.has(layerOption)) {
    throw new Error(`No OCR layer named "${layerOption}" on this document.`);
  }
  const ocrLayerName = layerOption && layerOption !== 'active' ? layerOption : doc.pageStore.active;

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

  const plainPages = doc.pageStore.pageList(ocrLayerName ?? 'active', false);
  const detailedPages = doc.pageStore.pageList(ocrLayerName ?? 'active', true);
  const ocrDownload = lazyArray(plainPages.length, (n) => n in plainPages, (n) => {
    // Beyond `.scribe`, PDF and HTML exports need `word.chars` outside the `'pdf'` layer (where words may lack `style.size`) to size short or non-Latin lines.
    // Skewed pages also need `chars[0].bbox` to place PDF text lines when deskewing.
    const detail = format === 'scribe' ? includeCharBoxesScribe
      : (format === 'pdf' || format === 'html') && (ocrLayerName !== 'pdf' || Math.abs(doc.pageMetrics[n]?.angle || 0) > 0.05);
    let page = (detail ? detailedPages : plainPages)[n];
    if (page && format !== 'hocr' && enableLayout) page = reorderOcrPage(page, doc.layoutRegions.pages[n]);
    const rects = redactRectsByPage.get(n);
    if (!page || !rects) return page;
    const clone = clonePage(page);
    const dropIds = [];
    for (const line of clone.lines) {
      for (const word of line.words) {
        const b = bboxToPageSpace(word.bbox, line.orientation, clone.dims);
        if (rects.some((r) => b.left < r.right && b.right > r.left && b.top < r.bottom && b.bottom > r.top)) {
          dropIds.push(word.id);
        }
      }
    }
    if (dropIds.length > 0) ocr.deletePageWords(clone, dropIds);
    return clone;
  });

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
            left: Math.min(a.points[0], a.points[2]),
            top: Math.min(a.points[1], a.points[3]),
            right: Math.max(a.points[0], a.points[2]),
            bottom: Math.max(a.points[1], a.points[3]),
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

  if (format === 'pdf') {
    const insertInputPDF = displayMode !== 'ebook' && doc.inputData.pdfMode && addOverlay;
    if (convertDupSourceTextToPaths && !insertInputPDF) {
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

    /** @type {Map<number, number>} */
    const pointScales = new Map();
    if (!insertInputPDF) {
      for (const i of pageArr) {
        const pageSize = doc.inputData.pageStats?.[i]?.pageSize;
        const { dims } = doc.pageMetrics[i];
        if (!pageSize || !(pageSize[0] > 0) || !(pageSize[1] > 0) || !(dims.width > 0) || !(dims.height > 0)) continue;
        const scale = pageSize[0] / dims.width;
        if (scale === 1) continue;
        // Width and height ratios that disagree mean dims came from a coordinate frame other than the PDF page size.
        if (Math.abs(pageSize[1] / dims.height / scale - 1) > 0.02) continue;
        pointScales.set(i, scale);
      }
    }

    const dimsLimit = { width: -1, height: -1 };
    if (standardizePageSize) {
      for (const i of pageArr) {
        const scale = pointScales.get(i) ?? 1;
        dimsLimit.height = Math.max(dimsLimit.height, Math.round(doc.pageMetrics[i].dims.height * scale * 100) / 100);
        dimsLimit.width = Math.max(dimsLimit.width, Math.round(doc.pageMetrics[i].dims.width * scale * 100) / 100);
      }
    }

    let ocrExport = ocrDownload;
    let pageMetricsExport = doc.pageMetrics;
    let annotationsExport = annotationsPagesExport;
    if (pointScales.size > 0) {
      ocrExport = lazyArray(ocrDownload.length, (n) => n in ocrDownload, (n) => {
        const page = ocrDownload[n];
        const scale = pointScales.get(n);
        if (!page || !scale) return page;
        const clone = clonePage(page);
        ocr.scalePage(clone, scale);
        for (const line of clone.lines) {
          for (const word of line.words) {
            if (word.style.size) word.style.size *= scale;
          }
        }
        return clone;
      });
      pageMetricsExport = [...doc.pageMetrics];
      annotationsExport = [...annotationsPagesExport];
      for (const [i, scale] of pointScales) {
        pageMetricsExport[i] = {
          ...pageMetricsExport[i],
          dims: {
            width: Math.round(pageMetricsExport[i].dims.width * scale * 100) / 100,
            height: Math.round(pageMetricsExport[i].dims.height * scale * 100) / 100,
          },
        };
        annotationsExport[i] = (annotationsExport[i] || []).map((annot) => {
          const scaled = structuredClone(annot);
          if ('bbox' in scaled) {
            scaled.bbox.left *= scale;
            scaled.bbox.top *= scale;
            scaled.bbox.right *= scale;
            scaled.bbox.bottom *= scale;
          }
          if ('quads' in scaled && scaled.quads) {
            for (const q of scaled.quads) {
              q.left *= scale;
              q.top *= scale;
              q.right *= scale;
              q.bottom *= scale;
            }
          }
          if ('points' in scaled) {
            for (let k = 0; k < scaled.points.length; k++) scaled.points[k] *= scale;
          }
          if ('vertices' in scaled) {
            for (let k = 0; k < scaled.vertices.length; k++) scaled.vertices[k] *= scale;
          }
          if ('fontSize' in scaled) scaled.fontSize *= scale;
          if ('borderWidth' in scaled && scaled.borderWidth) scaled.borderWidth *= scale;
          // Scaling all four edges turns a note's 24 px UI box into a tiny PDF icon (5.76 pt at 300 DPI), so replace it with a 20 pt box at the scaled anchor.
          if (scaled.type === 'text') scaled.bbox = textAnnotIconBox(scaled.bbox.left, scaled.bbox.top, doc.pageMetrics[i].rotation || 0);
          return scaled;
        });
      }
    }
    // For proof or ocr mode the text layer needs to be combined with a background layer
    if (displayMode !== 'ebook') {
      const rotateBackground = !insertInputPDF && autoRotate;

      const rotateText = !rotateBackground;

      if (insertInputPDF) {
        /** @type {ArrayBuffer} */
        let overlaid;
        try {
          let basePdfData = doc.images.pdfData;
          let overlayOcrArr = ocrDownload;
          let overlayPageMetricsArr = doc.pageMetrics;
          let overlayAnnotationsPages = annotationsPagesExport;
          let overlayContentEditsPages = doc.contentEdits.pages;
          let pageStats = doc.inputData.pageStats;
          let ocrAppliedArr = doc.inputData.ocrApplied;
          let overlayStampSourcesPages = doc.stampSources.pages;
          /** @type {?(srcRef: number, k: number) => number} */
          let srcRefRemap = null;
          // The base PDF is subset by source page number while the overlay arrays are indexed by display position.
          // The two are identical until a page is deleted or reordered.
          const sourceArr = pageArr.map((p) => doc.pageMetrics[p]?.sourcePageN ?? p);
          // A page copied from another document carries a foreign `sourceId`, so multiSource flags an export that spans more than one source PDF.
          const sourceIdArr = pageArr.map((p) => doc.pageMetrics[p]?.sourceId ?? doc.images.primarySourceId);
          const multiSource = sourceIdArr.some((id) => id !== doc.images.primarySourceId);
          // doc.inputData.pageCount shrinks on page deletion, so comparing against it would read a kept leading prefix as identity and pass the deleted pages through.
          const sourcePageCount = doc.images.sources.get(doc.images.primarySourceId)?.sourcePageCount
            || doc.inputData.pageCount;
          // On an unmodified document `sourceArr` equals `pageArr`, so a reorder requested through `pageArr` is detected by comparing with the output index `k`.
          const composed = multiSource || sourceArr.some((s, k) => s !== k) || pageArr.length < sourcePageCount;
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
              if (runBuffers.length === 1) {
                basePdfData = runBuffers[0];
              } else {
                /** @type {Array<Map<number, number>>} */
                const objectMaps = [];
                basePdfData = await mergePdfs(runBuffers, { outline: outlineForOutput, objectMaps });
                // The merge renumbers every object, so a row that names an object of its source (a form field, a stamp annotation) is renumbered through the map of the run its page came in.
                let run = 0;
                const runOfPage = sourceIdArr.map((id, k) => (k > 0 && id !== sourceIdArr[k - 1] ? ++run : run));
                srcRefRemap = (srcRef, k) => objectMaps[runOfPage[k]]?.get(srcRef) ?? -1;
              }
            } else {
              basePdfData = await subsetPdf(basePdfData, sourceArr, { outline: outlineForOutput });
            }
            overlayOcrArr = lazyArray(pageArr.length, () => true, (k) => ocrDownload[pageArr[k]]);
            overlayPageMetricsArr = pageArr.map((i) => doc.pageMetrics[i]);
            const remap = srcRefRemap;
            overlayAnnotationsPages = pageArr.map((i, k) => (annotationsPagesExport[i] || [])
              .map((a) => (remap && (a.type === 'field' || a.type === 'stamp') && a.srcRef != null ? { ...a, srcRef: remap(a.srcRef, k) } : a)));
            overlayStampSourcesPages = pageArr.map((i, k) => {
              const lifted = doc.stampSources.pages[i] || null;
              return lifted && remap ? lifted.map((e) => ({ ...e, srcRef: remap(e.srcRef, k) })) : lifted;
            });
            overlayContentEditsPages = pageArr.map((i) => doc.contentEdits.pages[i] || []);
            pageStats = fullStats ? pageArr.map((i) => fullStats[i]) : null;
            ocrAppliedArr = fullOcrApplied ? pageArr.map((i) => fullOcrApplied[i]) : null;
          }

          if (doc.type3GlyphMappings.size) {
            basePdfData = await replaceType3FontsWithCorrected({ basePdfData, type3GlyphMappings: doc.type3GlyphMappings, humanReadable: humanReadablePDF });
          }

          // Snapshot the real OCR before the routing below empties overlayOcrArr for clean text-native pages,
          // since highlight consolidation still needs the real word/line geometry to coalesce per-word highlights into per-line quads.
          const annotationOcrArr = overlayOcrArr;

          /** @type {?number[]} */
          let convertFullPages = null;
          // Broken-Type3-to-paths conversion rewrites page content and strips a scanned page's invisible OCR text.
          // The annot overlay writes no replacement text layer, so leaving conversion on would silently delete searchable text.
          let convertBrokenType3 = displayMode !== 'annot';
          // convertDupSourceTextToPaths converts ALL text to paths by explicit request,
          // so it skips the category routing below entirely.
          const routeCategories = options.routePageCategories ?? (displayMode === 'invis');
          // Category routing drops overlays on clean pages assuming their text is already embedded in the PDF, which is false when 'User Upload' came from an external OCR file.
          // Require the 'pdf' layer alongside 'User Upload' so a .scribe restore (which also uses 'User Upload' without parsing the PDF) still routes normally.
          const suppliedOcrLayer = doc.pageStore.has('pdf') && ocrLayerName === 'User Upload';
          if (routeCategories && !convertDupSourceTextToPaths && !suppliedOcrLayer && pageStats && pageStats.length > 0
            && (overlayOcrArr.length === 0 || overlayOcrArr.length === pageStats.length)) {
            // Flattening turns the page's own text into paths, leaving the overlay as its only extractable text.
            // The `ocrApplied` conjunct is what keeps a page that was never OCR'd from losing its text that way.
            const flagged = pageStats.map((s, i) => !!(s && (mayHaveBakedText(s) || hasBrokenFontRun(s) || isScanPage(s)))
              && !!(ocrAppliedArr && ocrAppliedArr[i]));
            // Flatten exists ONLY to support an invisible text layer:
            // a flagged page is flattened exactly when it has overlay text to add (from any source), and that text is kept.
            // A flagged page with no text, and any clean page, gets an empty overlay and is left unflattened,
            // so its native text stays the only text layer.
            const ocrIn = overlayOcrArr;
            convertFullPages = [];
            for (let i = 0; i < pageStats.length; i++) {
              if (i in pageStats && flagged[i] && ocrIn[i]?.lines?.length > 0) convertFullPages.push(i);
            }
            overlayOcrArr = lazyArray(pageStats.length, (i) => i in pageStats, (i) => {
              const p = ocrIn[i];
              const hasWords = !!(p && p.lines && p.lines.length > 0);
              if (flagged[i] && hasWords) return p;
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

          overlaid = await overlayPdfText({
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
            stampSourcesPages: overlayStampSourcesPages,
            contentEditsPages: overlayContentEditsPages,
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
        yield overlaid;
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

        yield await writePdf({
          ocrArr: ocrExport,
          pageMetricsArr: pageMetricsExport,
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
          annotationsPages: annotationsExport,
          humanReadable: humanReadablePDF,
          docFonts: doc.fonts,
          doc,
          warningHandler,
          docInfo,
        });
      }
    } else {
      yield await writePdf({
        ocrArr: ocrExport,
        pageMetricsArr: pageMetricsExport,
        pageArr,
        textMode: displayMode,
        rotateText: false,
        rotateBackground: true,
        dimsLimit,
        confThreshHigh,
        confThreshMed,
        proofOpacity: overlayOpacity / 100,
        annotationsPages: annotationsExport,
        humanReadable: humanReadablePDF,
        docFonts: doc.fonts,
        doc,
        warningHandler,
        docInfo,
      });
    }
  } else if (format === 'hocr') {
    // A page under a redaction mark is written without its source markup, which would return the lines the importer dropped unredacted.
    const hocrSource = ocrLayerName ? {
      head: doc.hocrSource.head[ocrLayerName] ?? null,
      pages: lazyArray(doc.hocrSource.pages.length, (i) => !redactRectsByPage.has(i) && !!doc.hocrSource.pages[i]?.[ocrLayerName],
        (i) => heldJson(doc.hocrSource.pages[i][ocrLayerName])),
    } : null;
    yield* writeHocrChunks({
      ocrData: ocrDownload, pageArr, pageMetrics: doc.pageMetrics, hocrSource, doc,
    });
  } else if (format === 'alto') {
    yield* writeAltoChunks({
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
        // The writer reads each page's image by page index, so a subset leaves gaps.
        images[i] = image;
      }
    }

    yield* writeHtmlChunks({
      ocrPages: ocrDownload,
      images,
      layoutPageArr: doc.layoutDataTables.pages,
      annotations: doc.annotations.pages,
      pageArr,
      // HTML ignores `scribeDocDefaults.reflow` and writes the exact layout unless the caller sets `reflow`.
      reflowText: options.reflow ?? false,
      dropPageHeadersFooters,
      removeMargins,
      docFonts: doc.fonts,
      pageMetrics: doc.pageMetrics,
      displayMode,
      confThreshHigh,
      confThreshMed,
      overlayOpacity,
      autoRotate,
      embedFonts,
      htmlFitWindow,
      doc,
    });
  } else if (format === 'txt') {
    yield* writeTextChunks({
      ocrCurrent: ocrDownload,
      layoutPageArr: doc.layoutDataTables.pages,
      pageArr,
      reflowText: reflow,
      dropPageHeadersFooters,
      lineNumbers,
      pageMetrics: doc.pageMetrics,
      doc,
    });
  } else if (format === 'md') {
    yield* writeMarkdownChunks({
      ocrCurrent: ocrDownload,
      layoutPageArr: doc.layoutDataTables.pages,
      pageArr,
      reflowText: reflow,
      dropPageHeadersFooters,
      pageMetrics: doc.pageMetrics,
      doc,
    });
  // Defining `DISABLE_DOCX_XLSX` disables docx/xlsx exports when using build tools.
  // @ts-ignore
  } else if (typeof DISABLE_DOCX_XLSX === 'undefined' && format === 'docx') {
    // Less common export formats are loaded dynamically to reduce initial load time.
    const writeDocxChunks = (await import('./writeDocx.js')).writeDocxChunks;
    yield* writeDocxChunks({
      hocrCurrent: ocrDownload, layoutPageArr: doc.layoutDataTables.pages, pageArr, pageMetrics: doc.pageMetrics, reflowText: reflow, dropPageHeadersFooters, doc,
    });
  // @ts-ignore
  } else if (typeof DISABLE_DOCX_XLSX === 'undefined' && format === 'xlsx') {
    // Less common export formats are loaded dynamically to reduce initial load time.
    const writeXlsxChunks = (await import('./writeTabular.js')).writeXlsxChunks;
    yield* writeXlsxChunks({
      ocrPageArr: ocrDownload,
      layoutPageArr: doc.layoutDataTables.pages,
      inputData: doc.inputData,
      pageArr,
      xlsxFilenameColumn: options.xlsxFilenameColumn ?? scribeDocDefaults.xlsxFilenameColumn,
      xlsxPageNumberColumn: options.xlsxPageNumberColumn ?? scribeDocDefaults.xlsxPageNumberColumn,
      doc,
    });
  } else if (format === 'scribe') {
    const envelope = scribeEnvelope(doc, scribeSession, ocrLayerName);
    const serializeOpts = { includeText: includeExtraTextScribe, includeCharBoxes: includeCharBoxesScribe };
    const ocrOut = includeOcrScribe ? ocrDownload : [];
    if (!compressScribe) {
      yield* scribeJsonChunks(ocrOut, serializeOpts, envelope);
    } else if (scribeSegments && includeOcrScribe) {
      // The segmented layout carries the session's per-page records inside the page records, so a file without pages stays one JSON document.
      let fits = scribeSegmentThreshold > 0;
      /** @type {Array<Uint8Array>} */
      const held = [];
      if (fits) {
        let total = 0;
        const underThreshold = (function* untilThreshold() {
          for (const chunk of scribeJsonChunks(ocrOut, serializeOpts, envelope)) {
            total += chunk.length;
            if (total > scribeSegmentThreshold) {
              fits = false;
              return;
            }
            yield chunk;
          }
        }());
        for await (const bytes of gzipChunks(underThreshold)) if (fits) held.push(bytes);
      }
      if (fits) yield* held;
      else yield* gzipChunks(scribeSegmentChunks(ocrOut, serializeOpts, envelope));
    } else {
      yield* gzipChunks(scribeJsonChunks(ocrOut, serializeOpts, envelope));
    }
  }
}

/**
 * Export this document's OCR data to the specified format.
 * @param {ScribeDoc} doc
 * @param {'pdf'|'hocr'|'alto'|'docx'|'html'|'xlsx'|'txt'|'text'|'md'|'scribe'} [format='txt']
 * @param {ExportOptions} [options]
 * @returns {Promise<string|ArrayBuffer>}
 */
export async function exportData(doc, format = 'txt', options = {}) {
  if (format === 'text') format = 'txt';
  const compressScribe = options.compressScribe ?? scribeDocDefaults.compressScribe;
  /** @type {Array<string|ArrayBuffer|Uint8Array>} */
  const parts = [];
  let total = 0;
  for await (const chunk of exportChunks(doc, format, options)) {
    if (typeof chunk === 'string') {
      total += chunk.length;
      if (total > 536_870_888) {
        throw new Error(format === 'scribe'
          ? 'This document\'s JSON exceeds the JavaScript string limit, so it cannot be exported as uncompressed .scribe.json; export compressed .scribe, or save it with download().'
          : `This document's ${format} export exceeds the JavaScript string limit, so it cannot be returned as one string; save it with download() instead.`);
      }
    }
    parts.push(chunk);
  }
  if (format === 'scribe' ? !compressScribe : ['txt', 'hocr', 'alto', 'html', 'md'].includes(format)) return parts.join('');
  if (format === 'pdf') return /** @type {ArrayBuffer} */ (parts[0]);
  const bytes = concatBytes(/** @type {Array<Uint8Array>} */ (parts));
  return format === 'scribe' ? bytes.buffer : bytes;
}

// A top-level `await` here would make every importing module initialize asynchronously, which deadlocks scribe-ui's import cycles.
const nodeFs = (typeof process !== 'undefined' && typeof process.versions?.node === 'string')
  ? process.getBuiltinModule('node:fs')
  : null;

/**
 * Export this document and save it as a download (browser) or local file (Node.js).
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
  if (!fileName.endsWith(`.${ext}`)) fileName = /\.\w{1,6}$/.test(fileName) ? fileName.replace(/\.\w{1,6}$/, `.${ext}`) : `${fileName}.${ext}`;
  const chunks = exportChunks(doc, format, options);

  if (nodeFs && !opt.saveAs) {
    const stat = nodeFs.statSync(fileName, { throwIfNoEntry: false });
    const target = stat ? nodeFs.realpathSync(fileName) : fileName;
    const savePath = !stat || stat.isFile() ? `${target}.partial` : target;
    const fd = nodeFs.openSync(savePath, 'w');
    let complete = false;
    try {
      for await (const chunk of chunks) nodeFs.writeFileSync(fd, chunk instanceof ArrayBuffer ? new Uint8Array(chunk) : chunk);
      complete = true;
    } finally {
      nodeFs.closeSync(fd);
      if (savePath !== target) {
        if (complete) nodeFs.renameSync(savePath, target);
        else nodeFs.rmSync(savePath, { force: true });
      }
    }
    return;
  }

  /** @type {Array<BlobPart>} */
  let parts = [];
  let pending = 0;
  for await (const chunk of chunks) {
    parts.push(chunk);
    pending += typeof chunk === 'string' ? chunk.length : chunk.byteLength;
    // Wrap accumulated chunks in a Blob to move them out of the JS heap so earlier chunks can be garbage-collected.
    if (pending > 16_777_216) {
      parts = [new Blob(parts)];
      pending = 0;
    }
  }
  await saveAs(new Blob(parts, { type: 'application/octet-stream' }), fileName);
}
