/**
 * Initializes a general worker and returns an object with methods controlled by the worker.
 * @returns {Promise} A promise that resolves to an object with control methods.
 */
export async function initBitmapWorker() {
  // This method of creating workers works natively in the browser, Node.js, and Webpack 5.
  // Do not change without confirming compatibility with all three.
  const obj = {};
  let worker;
  if (typeof process === 'undefined') {
    worker = new Worker(new URL('./bitmapWorker.js', import.meta.url), { type: 'module' });
  } else {
    const WorkerNode = (await import('node:worker_threads')).Worker;
    worker = new WorkerNode(new URL('./bitmapWorker.js', import.meta.url));
  }

  return new Promise((resolve, reject) => {
    /** @type {?Error} */
    let workerError = null;

    // A dead worker never answers, so every pending promise must reject or callers hang forever.
    const errorHandler = (err) => {
      console.error(err);
      const message = (err && typeof err === 'object' && 'message' in err && err.message) || 'Bitmap worker crashed.';
      workerError = new Error(String(message));
      workerError.name = 'WorkerCrashError';
      for (const id of Object.keys(workerPromises)) {
        workerPromises[id].reject(workerError);
        delete workerPromises[id];
      }
    };

    if (typeof process === 'undefined') {
      // @ts-ignore
      worker.onerror = errorHandler;
    } else {
      // @ts-ignore
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
      // @ts-ignore
      worker.onmessage = (event) => messageHandler(event.data);
    } else {
      // @ts-ignore
      worker.on('message', messageHandler);
    }

    /**
     * Wraps a function to be called via worker messages.
     * @param {string} func The function name to call.
     * @returns {Function} A function that returns a promise resolving to the worker's response.
     */
    function wrap(func, transferPayload = false) {
      return function (...args) {
        if (workerError) return Promise.reject(workerError);
        return new Promise((innerResolve, innerReject) => {
          const id = promiseId++;
          workerPromises[id] = { resolve: innerResolve, reject: innerReject, func };
          // When requested, transfer the payload (an ImageBitmap) into the worker zero-copy instead of cloning it.
          const transfer = transferPayload && args[0] ? [args[0]] : [];
          worker.postMessage([func, args[0], id], transfer);
        });
      };
    }

    obj.getImageBitmap = wrap('getImageBitmap');
    obj.compressBitmap = wrap('compressBitmap', true);

    // A killed worker never answers, so teardown rejects outstanding calls too.
    obj.terminate = () => {
      workerError = new Error('Bitmap worker terminated.');
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
