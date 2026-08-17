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
   * Dispatch a single page for rendering via the scheduler.
   * @param {{ pageIndex: number, colorMode: string, dpi?: number, targetWidth?: number, outputFormat?: 'png'|'jpeg'|'bitmap', quality?: number,
   * edits?: ?{records: Array<ContentEdit>, dims: {width: number, height: number}} }} args
   * @param {boolean} [forViewer=false] - Viewer renders are served ahead of background work.
   *   A superseded viewer render may be dropped, resolving to SKIPPED.
   */
  renderPdfPage = (args, forViewer = false) => this.scheduler.addJob('renderPdfPage', args, forViewer);

  /**
   * The font program the renderer draws a given embedded font with.
   * `pageIndex` lets the answering worker resolve a font from a page it never touched itself.
   * @param {{ fontObjNum: number, pageIndex?: number }} args
   */
  getPdfFontBytes = (args) => this.scheduler.addJob('getPdfFontBytes', args);

  /**
   * Set the page the main viewer is on, so staged viewer renders dispatch closest-to-current first.
   * @param {?number} n
   */
  setViewerFocus = (n) => this.scheduler.setViewerFocus(n);

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
   * Render a single page to image data URL.
   * The viewer lane (`forViewer`) only exists to keep the worker queue bounded.
   * In-process renders always run, so it is accepted and ignored.
   * @param {{ pageIndex: number, colorMode: string, dpi?: number, targetWidth?: number, outputFormat?: 'png'|'jpeg'|'bitmap', quality?: number }} args
   * @param {boolean} [forViewer=false]
   */
  // eslint-disable-next-line no-unused-vars
  renderPdfPage = (args, forViewer = false) => this.#core.renderPage(args);

  /**
   * The font program the renderer draws a given embedded font with, for native-text editing.
   * @param {{ fontObjNum: number, pageIndex?: number }} args
   */
  getPdfFontBytes = (args) => this.#core.getFontBytes(args);

  /**
   * No-op: in-process renders run immediately, so there is no staged queue to prioritize.
   * @param {?number} n
   */
  // eslint-disable-next-line no-unused-vars, class-methods-use-this
  setViewerFocus = (n) => {};

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
