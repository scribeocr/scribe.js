import { TessScheduler } from '../tess/TessScheduler.js';
import { opt } from './containers/app.js';
import { PdfCore } from './pdf/pdfCore.js';
import { acquireWorkers, releaseWorkers } from './pdfWorkerPool.js';

/**
 * Schedules one source's PDF work on workers leased from the process-wide pool.
 */
export class PdfScheduler {
  /**
   * @param {TessScheduler} scheduler
   * @param {Array<Object>} workers
   */
  constructor(scheduler, workers) {
    this.scheduler = scheduler;
    this.workers = workers;
    this.released = false;
  }

  /**
   * Dispatch a single page for text extraction via the scheduler.
   * @param {{ pageIndex: number, dpi: number }} args
   */
  parsePdfPage = (args) => this.scheduler.addJob('parsePdfPage', args);

  /**
   * Dispatch a single page for its own annotations, lifted without a text parse.
   * @param {{ pageIndex: number, dpi: number }} args
   */
  parsePdfPageAnnotations = (args) => this.scheduler.addJob('parsePdfPageAnnotations', args);

  /**
   * Dispatch a single page for rendering via the scheduler.
   * @param {{ pageIndex: number, colorMode: string, dpi?: number, targetWidth?: number, outputFormat?: 'png'|'jpeg'|'webp'|'bitmap', quality?: number,
   * edits?: ?RenderEdits }} args
   * @param {import('../tess/TessScheduler.js').Lane|boolean} [lane='background'] - The lane the render is served in; `true` is display and `false` background.
   *   A display or preview render the viewer no longer wants may be dropped, resolving to SKIPPED.
   */
  renderPdfPage = (args, lane = 'background') => this.scheduler.addJob('renderPdfPage', args, lane);

  /**
   * The font program the renderer draws a given embedded font with.
   * `pageIndex` lets the answering worker resolve a font from a page it never touched itself.
   * @param {{ fontObjNum: number, pageIndex?: number }} args
   */
  getPdfFontBytes = (args) => this.scheduler.addJob('getPdfFontBytes', args);

  /**
   * Every Type 3 font in the file with the outline hash of each glyph, keyed by character code.
   * @param {{}} args
   */
  getPdfType3GlyphHashes = (args) => this.scheduler.addJob('getPdfType3GlyphHashes', args);

  /**
   * The glyphs of a page's words as the content stream draws them.
   * @param {{ pageIndex: number, dpi: number, records: ?Array<ContentEdit>, words: Array<TextEditWordSpec> }} args
   */
  getPdfLineState = (args) => this.scheduler.addJob('getPdfLineState', args);

  /**
   * The glyphs of a line as a replacement would draw them, for the editor's preview.
   * @param {{ pageIndex: number, dpi: number, records: ?Array<ContentEdit>, req: import('./pdf/textPatch.js').TextEditRequest }} args
   */
  previewPdfTextEdit = (args) => this.scheduler.addJob('previewPdfTextEdit', args);

  /**
   * A deletion, style change or replacement of a line's words as content-stream patch records, verified against a re-parse.
   * @param {{ pageIndex: number, dpi: number, records: ?Array<ContentEdit>, req: import('./pdf/textPatch.js').TextEditRequest, groupId?: string }} args
   */
  applyPdfTextEdit = (args) => this.scheduler.addJob('applyPdfTextEdit', args);

  /**
   * The decoded bytes of an embedded file stream (a portfolio member or a plain attachment).
   * @param {{ objNum: number }} args
   */
  getPdfEmbeddedFileBytes = (args) => this.scheduler.addJob('getPdfEmbeddedFileBytes', args);

  /**
   * Set the page the main viewer is on, so staged display renders dispatch closest-to-current first.
   * With `keep`, the staged display renders for pages outside it are dropped at once.
   * @param {?number} n
   * @param {?Set<number>} [keep]
   */
  setViewerFocus = (n, keep = null) => this.scheduler.setViewerFocus(n, keep);

  /**
   * Call `cb` once, the next time nothing is staged and nothing runs.
   * @param {() => void} cb
   */
  onIdle = (cb) => this.scheduler.onIdle(cb);

  /**
   * Settle every staged job of the given lanes as skipped.
   * @param {Array<import('../tess/TessScheduler.js').Lane>} lanes
   */
  dropLanes = (lanes) => this.scheduler.dropLanes(lanes);

  /**
   * Add leased workers that already hold the document.
   * @param {Array<Object>} ws
   */
  addWorkers = (ws) => {
    for (const w of ws) {
      this.workers.push(w);
      this.scheduler.addWorker(w);
    }
  };

  /**
   * Take `k` workers out of the lease, idle ones first. Each handoff settles with its worker once that worker has no running job.
   * @param {number} k
   * @returns {Array<Promise<?Object>>}
   */
  removeWorkers = (k) => {
    const idle = this.workers.filter((w) => !this.scheduler.isRunning(w.id));
    const busy = this.workers.filter((w) => this.scheduler.isRunning(w.id));
    const leaving = [...idle, ...busy].slice(0, k);
    this.workers = this.workers.filter((w) => !leaving.includes(w));
    return leaving.map((w) => this.scheduler.removeWorker(w.id));
  };

  /**
   * Set the decoded-image cache budget of every worker in the lease.
   * @param {number} bytes
   */
  setImageCacheBudget = (bytes) => Promise.all(this.workers.map((w) => w.setImageCacheBudget({ bytes })));

  /**
   * Set the page at the centre of the thumbnail rail, so staged thumbnail renders dispatch closest-to-view first.
   * @param {?number} n
   */
  setThumbFocus = (n) => this.scheduler.setThumbFocus(n);

  /**
   * Load PDF bytes into all workers in the pool.
   * Each worker creates its own ObjectCache and page tree.
   * @param {Uint8Array} pdfBytes
   */
  loadPdfInAllWorkers = async (pdfBytes) => {
    const results = await Promise.all(
      this.workers.map((w) => w.loadPdfForParsing({ pdfBytes })),
    );
    return results[0];
  };

  unloadPdfInAllWorkers = async () => {
    await Promise.all(this.workers.map((w) => w.unloadPdf({})));
  };

  get busy() {
    return this.scheduler.getQueueLen() > 0 || this.scheduler.getRunningLen() > 0;
  }

  async terminate() {
    // A second terminate must be a no-op, because by then these workers may already be leased to another source.
    if (this.released) return;
    this.released = true;
    await this.scheduler.terminate(true);
    await releaseWorkers(this.workers);
  }
}

/**
 * In-process replacement for `PdfScheduler` (same method surface), selected when `opt.inProcess` is set:
 * each operation runs on the calling thread, not a worker pool.
 */
export class PdfSchedulerInProcess {
  #core = new PdfCore();

  /**
   * Parse a single page for text extraction + type-detection scoring.
   * @param {{ pageIndex: number, dpi: number }} args
   */
  parsePdfPage = (args) => this.#core.parsePage(args);

  /**
   * A single page's own annotations, lifted without a text parse.
   * @param {{ pageIndex: number, dpi: number }} args
   */
  parsePdfPageAnnotations = (args) => this.#core.parsePageAnnotations(args);

  /**
   * Render a single page to image data URL.
   * The lane only exists to order and bound a worker queue.
   * In-process renders always run, so it is accepted and ignored.
   * @param {{ pageIndex: number, colorMode: string, dpi?: number, targetWidth?: number, outputFormat?: 'png'|'jpeg'|'webp'|'bitmap', quality?: number }} args
   * @param {import('../tess/TessScheduler.js').Lane|boolean} [lane='background']
   */
  // eslint-disable-next-line no-unused-vars
  renderPdfPage = (args, lane = 'background') => this.#core.renderPage(args);

  /**
   * The font program the renderer draws a given embedded font with, for native-text editing.
   * @param {{ fontObjNum: number, pageIndex?: number }} args
   */
  getPdfFontBytes = (args) => this.#core.getFontBytes(args);

  /**
   * Every Type 3 font in the file with the outline hash of each glyph, keyed by character code.
   * @param {{}} args
   */
  // eslint-disable-next-line no-unused-vars
  getPdfType3GlyphHashes = (args) => this.#core.getType3GlyphHashes();

  /**
   * The glyphs of a page's words as the content stream draws them.
   * @param {{ pageIndex: number, dpi: number, records: ?Array<ContentEdit>, words: Array<TextEditWordSpec> }} args
   */
  getPdfLineState = (args) => this.#core.getLineState(args);

  /**
   * The glyphs of a line as a replacement would draw them, for the editor's preview.
   * @param {{ pageIndex: number, dpi: number, records: ?Array<ContentEdit>, req: import('./pdf/textPatch.js').TextEditRequest }} args
   */
  previewPdfTextEdit = (args) => this.#core.previewTextEdit(args);

  /**
   * A deletion, style change or replacement of a line's words as content-stream patch records.
   * The records are verified against a re-parse.
   * @param {{ pageIndex: number, dpi: number, records: ?Array<ContentEdit>, req: import('./pdf/textPatch.js').TextEditRequest, groupId?: string }} args
   */
  applyPdfTextEdit = (args) => this.#core.applyTextEdit(args);

  /**
   * The decoded bytes of an embedded file stream (a portfolio member or a plain attachment).
   * @param {{ objNum: number }} args
   */
  getPdfEmbeddedFileBytes = (args) => this.#core.getEmbeddedFileBytes(args);

  /**
   * No-op: in-process renders run immediately, so there is no staged queue to prioritize or drop from.
   * @param {?number} n
   * @param {?Set<number>} [keep]
   */
  // eslint-disable-next-line no-unused-vars, class-methods-use-this
  setViewerFocus = (n, keep = null) => {};

  /**
   * In process nothing is ever staged, so `cb` runs at once.
   * @param {() => void} cb
   */
  // eslint-disable-next-line class-methods-use-this
  onIdle = (cb) => { Promise.resolve().then(cb); };

  /** No-op counterpart to `PdfScheduler.dropLanes`: nothing is ever staged in process. */
  // eslint-disable-next-line no-unused-vars, class-methods-use-this
  dropLanes = (lanes) => {};

  /** In process there is no lease to grow. */
  // eslint-disable-next-line no-unused-vars, class-methods-use-this
  addWorkers = (ws) => {};

  /** In process there is no lease to shrink. */
  // eslint-disable-next-line no-unused-vars, class-methods-use-this
  removeWorkers = (k) => [];

  /**
   * Set the decoded-image cache budget of the in-process renderer.
   * @param {number} bytes
   */
  setImageCacheBudget = async (bytes) => { this.#core.setImageCacheBudget(bytes); };

  /**
   * No-op counterpart to `PdfScheduler.setThumbFocus` (see `setViewerFocus`).
   * @param {?number} n
   */
  // eslint-disable-next-line no-unused-vars, class-methods-use-this
  setThumbFocus = (n) => {};

  /**
   * Load PDF bytes and parse the document structure.
   * @param {Uint8Array} pdfBytes
   */
  loadPdfInAllWorkers = (pdfBytes) => this.#core.load(pdfBytes);

  unloadPdfInAllWorkers = () => this.#core.unload();

  /** In-process operations run on the calling thread, so there is never staged work to drain. */
  // eslint-disable-next-line class-methods-use-this
  get busy() {
    return false;
  }

  async terminate() {
    await this.#core.unload();
  }
}

/**
 * Initialize the dedicated PDF worker pool.
 * Creates 1-3 workers depending on hardware concurrency, capped by `opt.workerN` when set.
 * When `opt.inProcess` is set (and no explicit `numWorkers` is requested),
 * no workers are created and PDF operations run on the calling thread instead.
 * @param {number} [numWorkers]
 */
export async function initPdfScheduler(numWorkers) {
  if (!numWorkers && opt.inProcess) return new PdfSchedulerInProcess();
  if (!numWorkers) {
    if (opt.workerN) {
      numWorkers = Math.min(opt.workerN, 3);
    } else if (typeof process === 'undefined') {
      numWorkers = Math.min(Math.round((globalThis.navigator.hardwareConcurrency || 8) / 2), 3);
    } else {
      const cpuN = Math.floor((await import('node:os')).cpus().length / 2);
      numWorkers = Math.max(Math.min(cpuN, 3), 1);
    }
  }

  const scheduler = new TessScheduler();
  const workers = await acquireWorkers(numWorkers);
  for (const w of workers) scheduler.addWorker(w);

  return new PdfScheduler(scheduler, workers);
}
