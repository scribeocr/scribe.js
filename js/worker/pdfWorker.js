import { ca } from '../canvasAdapter.js';
import { unregisterFontFacesMatching } from '../containers/fontContainer.js';
import { findXrefOffset, parseXref, ObjectCache } from '../pdf/parsePdfUtils.js';
import { getPageObjects, parseSinglePage } from '../pdf/parsePdfDoc.js';
import { renderPdfPageAsImage } from '../pdf/renderPdfPage.js';

const parentPort = typeof process === 'undefined' ? globalThis : (await import('node:worker_threads')).parentPort;

/** @type {?ObjectCache} */
let storedObjCache = null;
/** @type {?Array<{ objNum: number, objText: string, mediaBox: number[], rotate: number }>} */
let storedPages = null;

/**
 * Release `_pdf_d${docId}_*` fonts (Node + browser registries) and clear `storedObjCache` / `storedPages`.
 */
export async function unloadPdf() {
  if (!storedObjCache) return;
  const { docId } = storedObjCache;
  const prefix = `_pdf_d${docId}_`;
  ca.unregisterFontsMatching((name) => name.startsWith(prefix));
  unregisterFontFacesMatching((family) => family.startsWith(prefix));
  storedObjCache = null;
  storedPages = null;
}

/**
 * Load PDF bytes, parse structure, and store for subsequent page operations.
 * Called once per PDF on every worker in the pool.
 *
 * @param {{ pdfBytes: Uint8Array | ArrayBuffer }} args
 */
export async function loadPdfForParsing({ pdfBytes }) {
  await unloadPdf();
  const arr = pdfBytes instanceof Uint8Array ? pdfBytes : new Uint8Array(pdfBytes);
  const xrefOffset = findXrefOffset(arr);
  const xrefEntries = parseXref(arr, xrefOffset);
  storedObjCache = new ObjectCache(arr, xrefEntries);
  storedPages = getPageObjects(storedObjCache);
  return {
    pageCount: storedPages.length,
    pages: storedPages.map((p) => ({ mediaBox: p.cropBox || p.mediaBox, rotate: p.rotate })),
  };
}

/**
 * Parse a single page for text extraction + type-detection scoring.
 * @param {{ pageIndex: number, dpi: number }} args
 */
export async function parsePdfPage({ pageIndex, dpi }) {
  if (!storedObjCache || !storedPages) throw new Error('PDF not loaded in worker');
  return parseSinglePage(storedPages[pageIndex], storedObjCache, pageIndex, dpi);
}

/**
 * Render a single page to a PNG data URL.
 * @param {{ pageIndex: number, colorMode: string, dpi?: number }} args
 */
export async function renderPdfPage({ pageIndex, colorMode, dpi }) {
  if (!storedObjCache || !storedPages) throw new Error('PDF not loaded in worker');
  if (typeof process !== 'undefined') await ca.getCanvasNode();
  const page = storedPages[pageIndex];
  return renderPdfPageAsImage(page.objText, storedObjCache, page.cropBox || page.mediaBox, pageIndex, colorMode, page.rotate, dpi);
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
      renderPdfPage,
      unloadPdf,
    })[func](args)
      .then((/** @type {any} */ x) => port.postMessage({ data: x, id, status: 'resolve' }))
      .catch((/** @type {any} */ err) => port.postMessage({ data: err, id, status: 'reject' }));
  };

  if (typeof process === 'undefined') {
    onmessage = (event) => handleMessage(event.data);
  } else {
    port.on('message', handleMessage);
  }

  port.postMessage({ data: 'ready', id: 0, status: 'resolve' });
}
