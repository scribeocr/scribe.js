import { PdfCore } from '../pdf/pdfCore.js';

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
 * Render a single page to an image data URL, a JPEG blob, or a transferable ImageBitmap.
 * @param {{ pageIndex: number, colorMode: string, dpi?: number, targetWidth?: number, outputFormat?: 'png'|'jpeg'|'bitmap', quality?: number,
 * textEdits?: ?{records: Array<TextEdit>, dims: {width: number, height: number}} }} args
 */
export async function renderPdfPage(args) {
  return core.renderPage(args);
}

/**
 * The font program the renderer draws a given embedded font with.
 * @param {{ fontObjNum: number, pageIndex?: number }} args
 */
export async function getPdfFontBytes(args) {
  return core.getFontBytes(args);
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
      renderPdfPage,
      getPdfFontBytes,
      unloadPdf,
    })[func](args)
      .then((/** @type {any} */ x) => {
        // Font bytes are a per-call copy, so transferring them detaches nothing shared.
        const transfer = (typeof ImageBitmap !== 'undefined' && x && x.bitmap instanceof ImageBitmap) ? [x.bitmap]
          : (x && x.bytes instanceof ArrayBuffer ? [x.bytes] : []);
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
