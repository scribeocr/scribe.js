// Process-wide pool of reusable PDF workers, leased to per-source schedulers.
// Spawning a PDF worker costs hundreds of milliseconds, so it is paid once per process here rather than on every document open, tab wake, and ingest step.

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
    /** @type {?Error} */
    let workerError = null;

    // A dead worker never answers, so every pending promise must reject or callers hang forever.
    const errorHandler = (err) => {
      console.error(err);
      const message = (err && typeof err === 'object' && 'message' in err && err.message) || 'PDF worker crashed.';
      workerError = new Error(String(message));
      workerError.name = 'WorkerCrashError';
      for (const id of Object.keys(workerPromises)) {
        workerPromises[id].reject(workerError);
        delete workerPromises[id];
      }
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
        if (workerError) return Promise.reject(workerError);
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
    obj.getPdfFontBytes = wrap('getPdfFontBytes');
    obj.unloadPdf = wrap('unloadPdf');

    // A killed worker never answers, so teardown rejects outstanding calls too.
    obj.terminate = () => {
      workerError = new Error('PDF worker terminated.');
      workerError.name = 'WorkerTerminatedError';
      for (const id of Object.keys(workerPromises)) {
        workerPromises[id].reject(workerError);
        delete workerPromises[id];
      }
      return worker.terminate();
    };

    ready.then(() => resolve(obj), reject);
  });
}

/** How long a released worker gets to answer the unload probe before it is judged wedged and destroyed. */
const RELEASE_PROBE_MS = 3000;

/** @type {Array<Object>} */
const spare = [];

/** @type {Set<Object>} */
const leased = new Set();

/** @type {number} */
let spawning = 0;

/**
 * Soft cap on total pool size.
 * Acquires past the cap still spawn rather than block, so a viewer document and a background ingest can never deadlock waiting on each other's workers.
 */
export const poolSoftCap = () => {
  if (typeof process === 'undefined') return Math.min(Math.round((globalThis.navigator.hardwareConcurrency || 8) / 2), 6);
  return 6;
};

// In-flight spawns count toward the total so concurrent acquires do not each see room under the cap and overshoot it.
const totalWorkers = () => spare.length + leased.size + spawning;

/**
 * Lease `n` workers, reusing spares and spawning the shortfall.
 * @param {number} n
 * @returns {Promise<Array<Object>>}
 */
export async function acquireWorkers(n) {
  /** @type {Array<Object>} */
  const out = [];
  while (out.length < n && spare.length) {
    const w = spare.pop();
    leased.add(w);
    out.push(w);
  }
  const shortfall = n - out.length;
  if (shortfall > 0) {
    if (totalWorkers() + shortfall > poolSoftCap()) {
      console.warn(`[pdf-pool] soft cap ${poolSoftCap()} exceeded (leasing ${shortfall} extra)`);
    }
    spawning += shortfall;
    try {
      const fresh = await Promise.all(Array.from({ length: shortfall }, async () => {
        const w = await initPdfWorker();
        w.id = `pdf-${Math.random().toString(16).slice(3, 8)}`;
        return w;
      }));
      for (const w of fresh) {
        leased.add(w);
        out.push(w);
      }
    } finally {
      spawning -= shortfall;
    }
  }
  return out;
}

/**
 * Return leased workers to the pool.
 * The unload probe both clears the document state a worker holds and proves it responsive.
 * A worker that rejects or cannot answer in time is destroyed instead of returned.
 * @param {Array<Object>} workers
 */
export async function releaseWorkers(workers) {
  await Promise.all(workers.map(async (w) => {
    // A worker already returned by an earlier release or claimed by teardown may have been re-leased, and probing it would unload the next lessee's document.
    if (!leased.has(w)) return;
    let timer = null;
    try {
      await Promise.race([
        w.unloadPdf({}),
        new Promise((resolve, reject) => {
          timer = setTimeout(() => reject(new Error('unload probe timed out')), RELEASE_PROBE_MS);
        }),
      ]);
      // The worker stays in `leased` through the probe so a concurrent destroyAllPdfWorkers can still terminate it.
      // A failed delete means teardown got there first, so the now-dead worker must not be returned.
      if (leased.delete(w)) spare.push(w);
    } catch {
      leased.delete(w);
      try {
        w.terminate();
      } catch { /* Already dead. */ }
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  }));
}

/**
 * Destroy every pooled worker, including leased ones.
 * Leased workers are force-terminated because the same teardown closes the documents that own them.
 */
export async function destroyAllPdfWorkers() {
  const all = [...spare, ...leased];
  spare.length = 0;
  leased.clear();
  await Promise.all(all.map((w) => {
    try {
      return w.terminate();
    } catch {
      return null;
    }
  }));
}
