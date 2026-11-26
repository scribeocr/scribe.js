import { PdfCore } from '../pdf/pdfCore.js';
import { pageFillShapes, wordSignalsOf } from '../pdf/parsePdfDoc.js';
import {
  encodePageRecord, encodeDetailRecord, decodePageRecord, readPageRecordExtras,
} from '../containers/pageRecord.js';
import {
  deflateRecord, inflateRecord, fillShapeFlags, detailOrderAfter,
} from '../containers/pageStore.js';

const parentPort = typeof process === 'undefined' ? globalThis : (await import('node:worker_threads')).parentPort;

const core = new PdfCore();

/**
 * Load PDF bytes, parse structure, and store for subsequent page operations.
 * Called once per PDF on every worker in the pool.
 * @param {{ pdfBytes: Uint8Array | ArrayBuffer }} args
 */
export async function loadPdfForParsing({ pdfBytes }) {
  return core.load(pdfBytes);
}

/**
 * Parse a single page for text extraction + type-detection scoring.
 * @param {{ pageIndex: number, dpi: number }} args
 */
export async function parsePdfPage(args) {
  return core.parsePage(args);
}

/**
 * Deflated page and detail records plus per-page metadata from a worker page parse.
 * @typedef {Object} ParsedPageRecords
 * @property {Uint8Array} record
 * @property {Uint8Array} detail
 * @property {number} flags - Fill-shape flags stored in the page record header.
 * @property {number} words
 * @property {number} nativeWords - Number of words with a native-text entry.
 * @property {number} angle
 * @property {Array<[string, boolean, ?number, boolean]>} signals - `[wordId, artifact, mcid, brokenFont]` tuples for words with parse signals.
 * @property {ReturnType<PdfCore['parsePage']>['pageStats']} pageStats
 * @property {ReturnType<PdfCore['parsePage']>['annotations']} annotations
 * @property {ReturnType<PdfCore['parsePage']>['dataTablePage']} dataTablePage
 * @property {ReturnType<PdfCore['parsePage']>['provisionalTables']} provisionalTables
 * @property {ReturnType<PdfCore['parsePage']>['langSet']} langSet
 */

/**
 * Parse a single page for text extraction and return its deflated records and per-page metadata.
 * @param {{ pageIndex: number, dpi: number }} args
 * @returns {Promise<ParsedPageRecords>}
 */
export async function parsePdfPageRecords(args) {
  const parsed = core.parsePage(args);
  const { pageObj } = parsed;
  const nativeText = parsed.nativeText || {};
  const fillShapes = pageFillShapes(parsed);
  const flags = fillShapeFlags(pageObj, fillShapes);
  let words = 0;
  let nativeWords = 0;
  for (const line of pageObj.lines) {
    for (const word of line.words) {
      words++;
      if (nativeText[word.id]) nativeWords++;
    }
  }
  return {
    record: await deflateRecord(encodePageRecord(pageObj, nativeText, flags)),
    detail: await deflateRecord(encodeDetailRecord(pageObj, nativeText, fillShapes)),
    flags,
    words,
    nativeWords,
    angle: pageObj.angle,
    signals: [...(parsed.wordSignals || [])].map(([word, sig]) => [word.id, sig.artifact, sig.mcid, sig.brokenFont]),
    pageStats: parsed.pageStats,
    annotations: parsed.annotations,
    dataTablePage: parsed.dataTablePage,
    provisionalTables: parsed.provisionalTables,
    langSet: parsed.langSet,
  };
}

/**
 * Lay out a run of consecutive pages from their deflated page records.
 * @param {{ pages: Array<{record: Uint8Array, flags: number, signals: ParsedPageRecords['signals'], dataTablePage: ParsedPageRecords['dataTablePage'],
 *   provisionalTables: ParsedPageRecords['provisionalTables']}>, pdfType: "image"|"text"|"ocr", carry: ?import('../pdf/parsePdfDoc.js').ChunkCarry,
 *   docPageCount: number }} args
 * @returns {Promise<{pages: Array<{record: Uint8Array, order: ?Int32Array, words: number, nativeWords: number, dataTablePage: ParsedPageRecords['dataTablePage']}>,
 *   tableLinkSuggestions: ReturnType<PdfCore['layoutChunk']>['tableLinkSuggestions'], carry: import('../pdf/parsePdfDoc.js').ChunkCarry,
 *   notePatches: ReturnType<PdfCore['layoutChunk']>['notePatches']}>}
 *   Updated deflated page records and any detail-record word-order permutations.
 */
export async function layoutPdfChunkRecords({
  pages, pdfType, carry, docPageCount,
}) {
  const idsBefore = [];
  const nativeBits = [];
  const results = pages.map((given) => {
    const raw = inflateRecord(given.record);
    const pageObj = decodePageRecord(raw);
    const { wordBits } = readPageRecordExtras(raw);
    /** @type {?Record<string, {uneditable: boolean}>} */
    const bits = wordBits ? {} : null;
    const ids = [];
    for (const line of pageObj.lines) {
      for (const word of line.words) {
        if (bits && wordBits && wordBits[ids.length] & 1) bits[word.id] = { uneditable: (wordBits[ids.length] & 2) !== 0 };
        ids.push(word.id);
      }
    }
    idsBefore.push(ids);
    nativeBits.push(bits);
    return {
      pageObj, wordSignals: wordSignalsOf(pageObj, given.signals), dataTablePage: given.dataTablePage, provisionalTables: given.provisionalTables,
    };
  });
  const out = core.layoutChunk({
    results, pdfType, carry, docPageCount,
  });
  const done = [];
  for (let k = 0; k < results.length; k++) {
    const bits = nativeBits[k];
    let words = 0;
    let nativeWords = 0;
    for (const line of results[k].pageObj.lines) {
      for (const word of line.words) {
        words++;
        if (bits && bits[word.id]) nativeWords++;
      }
    }
    done.push({
      record: await deflateRecord(encodePageRecord(results[k].pageObj, bits, pages[k].flags)),
      order: detailOrderAfter(idsBefore[k], results[k].pageObj),
      words,
      nativeWords,
      dataTablePage: results[k].dataTablePage,
    });
  }
  return {
    pages: done, tableLinkSuggestions: out.tableLinkSuggestions, carry: out.carry, notePatches: out.notePatches,
  };
}

/**
 * A page's own annotations, lifted without its text.
 * @param {{ pageIndex: number, dpi: number }} args
 */
export async function parsePdfPageAnnotations(args) {
  return core.parsePageAnnotations(args);
}

/**
 * Render a single page to an image data URL, a JPEG/WebP blob, or a transferable ImageBitmap.
 * @param {{ pageIndex: number, colorMode: string, dpi?: number, targetWidth?: number, outputFormat?: 'png'|'jpeg'|'webp'|'bitmap', quality?: number,
 * edits?: ?RenderEdits }} args
 */
export async function renderPdfPage(args) {
  return core.renderPage(args);
}

/**
 * Render one of a page's annotations alone, on a transparent background, as a PNG blob.
 * @param {{ pageIndex: number, annotRef: number, dpi?: number }} args
 */
export async function renderPdfAnnotation(args) {
  return core.renderAnnotation(args);
}

/**
 * The font program the renderer draws a given embedded font with.
 * @param {{ fontObjNum: number, pageIndex?: number }} args
 */
export async function getPdfFontBytes(args) {
  return core.getFontBytes(args);
}

/** Every Type 3 font in the file with the outline hash of each glyph, keyed by character code. */
export async function getPdfType3GlyphHashes() {
  return core.getType3GlyphHashes();
}

/**
 * The glyphs of a page's words as the content stream draws them.
 * @param {{ pageIndex: number, dpi: number, records: ?Array<ContentEdit>, words: Array<TextEditWordSpec> }} args
 */
export async function getPdfLineState(args) {
  return core.getLineState(args);
}

/**
 * The glyphs of a line as a replacement would draw them, for the editor's preview.
 * @param {{ pageIndex: number, dpi: number, records: ?Array<ContentEdit>, req: import('../pdf/textPatch.js').TextEditRequest }} args
 */
export async function previewPdfTextEdit(args) {
  return core.previewTextEdit(args);
}

/**
 * A deletion, style change or replacement of a line's words as content-stream patch records, verified against a re-parse.
 * @param {{ pageIndex: number, dpi: number, records: ?Array<ContentEdit>, req: import('../pdf/textPatch.js').TextEditRequest, groupId?: string }} args
 */
export async function applyPdfTextEdit(args) {
  return core.applyTextEdit(args);
}

/**
 * The decoded bytes of an embedded file stream (a portfolio member or a plain attachment).
 * @param {{ objNum: number }} args
 */
export async function getPdfEmbeddedFileBytes(args) {
  return core.getEmbeddedFileBytes(args);
}

/**
 * Set the byte budget of this worker's decoded-image cache.
 * @param {{ bytes: number }} args
 */
export async function setImageCacheBudget({ bytes }) {
  return core.setImageCacheBudget(bytes);
}

/**
 * Release this worker's loaded PDF and its `_pdf_d${docId}_*` fonts.
 */
export async function unloadPdf() {
  return core.unload();
}

if (parentPort) {
  // Browser worker: `parentPort === globalThis` (postMessage + onmessage).
  // Node worker_thread: `parentPort` is a `MessagePort` (on/postMessage).
  // The union isn't callable under strict TS; cast to `any`.
  /** @type {any} */
  const port = parentPort;
  const handleMessage = async (/** @type {any[]} */ data) => {
    const func = data[0];
    const args = data[1];
    const id = data[2];

    ({
      loadPdfForParsing,
      parsePdfPage,
      parsePdfPageRecords,
      layoutPdfChunkRecords,
      parsePdfPageAnnotations,
      renderPdfPage,
      renderPdfAnnotation,
      getPdfFontBytes,
      getPdfType3GlyphHashes,
      getPdfLineState,
      previewPdfTextEdit,
      applyPdfTextEdit,
      getPdfEmbeddedFileBytes,
      setImageCacheBudget,
      unloadPdf,
    })[func](args)
      .then((/** @type {any} */ x) => {
        // Font and embedded-file bytes are per-call copies, so transferring them detaches nothing shared.
        const transfer = (typeof ImageBitmap !== 'undefined' && x && x.bitmap instanceof ImageBitmap) ? [x.bitmap]
          : (x && x.bytes instanceof ArrayBuffer ? [x.bytes] : []);
        if (func === 'parsePdfPageRecords') transfer.push(x.record.buffer, x.detail.buffer);
        if (func === 'layoutPdfChunkRecords') for (const page of x.pages) transfer.push(page.record.buffer);
        port.postMessage({ data: x, id, status: 'resolve' }, transfer);
      })
      .catch((/** @type {any} */ err) => port.postMessage({ data: err, id, status: 'reject' }));
  };

  if (typeof process === 'undefined') {
    onmessage = (event) => handleMessage(event.data);
  } else {
    port.on('message', handleMessage);
  }

  port.postMessage({ data: 'ready', id: 0, status: 'resolve' });
}
