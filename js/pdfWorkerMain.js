import { TessScheduler } from '../tess/TessScheduler.js';

/**
 * Creates a single PDF worker and returns an object with wrapped methods.
 * Same pattern as initGeneralWorker() in generalWorkerMain.js.
 */
export async function initPdfWorker() {
  const obj = {};
  let worker;
  if (typeof process === 'undefined') {
    worker = new Worker(new URL('./worker/pdfWorker.js', import.meta.url), { type: 'module' });
  } else {
    const WorkerNode = (await import('node:worker_threads')).Worker;
    worker = new WorkerNode(new URL('./worker/pdfWorker.js', import.meta.url));
  }

  return new Promise((resolve, reject) => {
    const errorHandler = (err) => {
      console.error(err);
    };

    if (typeof process === 'undefined') {
      worker.onerror = errorHandler;
    } else {
      worker.on('error', errorHandler);
    }

    const workerPromises = {};
    let promiseId = 0;

    const ready = new Promise((innerResolve, innerReject) => {
      workerPromises['0'] = { resolve: innerResolve, reject: innerReject, func: 'ready' };
    });

    const messageHandler = async (data) => {
      if (workerPromises[data.id]) {
        if (data.status === 'reject') {
          workerPromises[data.id].reject(data.data);
          delete workerPromises[data.id];
        } else {
          workerPromises[data.id].resolve(data.data);
          delete workerPromises[data.id];
        }
      }
    };

    if (typeof process === 'undefined') {
      worker.onmessage = (event) => messageHandler(event.data);
    } else {
      worker.on('message', messageHandler);
    }

    function wrap(func) {
      return function (...args) {
        return new Promise((innerResolve, innerReject) => {
          const id = promiseId++;
          workerPromises[id] = { resolve: innerResolve, reject: innerReject, func };
          worker.postMessage([func, args[0], id]);
        });
      };
    }

    obj.loadPdfForParsing = wrap('loadPdfForParsing');
    obj.parsePdfPage = wrap('parsePdfPage');
    obj.renderPdfPage = wrap('renderPdfPage');
    obj.unloadPdf = wrap('unloadPdf');

    obj.terminate = () => worker.terminate();

    ready.then(() => resolve(obj));
  });
}

/**
 * Manages a dedicated pool of PDF workers with a TessScheduler.
 */
export class PdfScheduler {
  /**
   * @param {TessScheduler} scheduler
   * @param {Array<Object>} workers
   */
  constructor(scheduler, workers) {
    this.scheduler = scheduler;
    this.workers = workers;
  }

  /**
   * Dispatch a single page for text extraction via the scheduler.
   * @param {{ pageIndex: number, dpi: number }} args
   */
  parsePdfPage = (args) => this.scheduler.addJob('parsePdfPage', args);

  /**
   * Dispatch a single page for rendering via the scheduler.
   * @param {{ pageIndex: number, colorMode: string, dpi?: number }} args
   * @param {boolean} [priorityJob=false]
   */
  renderPdfPage = (args, priorityJob = false) => this.scheduler.addJob('renderPdfPage', args, priorityJob);

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

  async terminate() {
    await this.scheduler.terminate();
  }
}

/**
 * Initialize the dedicated PDF worker pool.
 * Creates 1-3 workers depending on hardware concurrency.
 * @param {number} [numWorkers]
 */
export async function initPdfScheduler(numWorkers) {
  if (!numWorkers) {
    if (typeof process === 'undefined') {
      numWorkers = Math.min(Math.round((globalThis.navigator.hardwareConcurrency || 8) / 2), 3);
    } else {
      const cpuN = Math.floor((await import('node:os')).cpus().length / 2);
      numWorkers = Math.max(Math.min(cpuN, 3), 1);
    }
  }

  const scheduler = new TessScheduler();
  const workers = [];

  const w0 = await initPdfWorker();
  w0.id = `pdf-${Math.random().toString(16).slice(3, 8)}`;
  scheduler.addWorker(w0);
  workers.push(w0);

  const rest = Array.from({ length: numWorkers - 1 }, async () => {
    const w = await initPdfWorker();
    w.id = `pdf-${Math.random().toString(16).slice(3, 8)}`;
    scheduler.addWorker(w);
    workers.push(w);
  });
  await Promise.all(rest);

  return new PdfScheduler(scheduler, workers);
}
