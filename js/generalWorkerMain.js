import { opt } from './containers/app.js';

/**
 * Initializes a general worker and returns an object with methods controlled by the worker.
 * @returns {Promise} A promise that resolves to an object with control methods.
 */
export async function initGeneralWorker() {
  // This method of creating workers works natively in the browser, Node.js, and Webpack 5.
  // Do not change without confirming compatibility with all three.
  const obj = {};
  let worker;
  if (typeof process === 'undefined') {
    worker = new Worker(new URL('./worker/generalWorker.js', import.meta.url), { type: 'module' });
  } else {
    const WorkerNode = (await import('node:worker_threads')).Worker;
    worker = new WorkerNode(new URL('./worker/generalWorker.js', import.meta.url));
  }

  return new Promise((resolve, reject) => {
    const errorHandler = (err) => {
      console.error(err);
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
    function wrap(func) {
      return function (...args) {
        return new Promise((innerResolve, innerReject) => {
          const id = promiseId++;
          workerPromises[id] = { resolve: innerResolve, reject: innerReject, func };
          worker.postMessage([func, args[0], id]);
        });
      };
    }

    /**
     * Similar to wrap, but handles two promises.
     * @param {string} func The function name to call.
     * @returns {Array} Returns two promises in an array.
     */
    function wrap2(func) {
      return function (...args) {
        const id = promiseId++;
        const promiseB = new Promise((innerResolve, innerReject) => {
          workerPromises[`${id}b`] = { resolve: innerResolve, reject: innerReject, func };
        });

        const promiseA = new Promise((innerResolve, innerReject) => {
          workerPromises[id] = { resolve: innerResolve, reject: innerReject, func };
          worker.postMessage([func, args[0], id]);
        });

        return [promiseA, promiseB];
      };
    }

    obj.convertPageHocr = wrap('convertPageHocr');
    obj.convertPageAbbyy = wrap('convertPageAbbyy');
    obj.convertPageStext = wrap('convertPageStext');
    obj.convertDocTextract = wrap('convertDocTextract');
    obj.convertDocAzureDocIntel = wrap('convertDocAzureDocIntel');
    obj.convertPageGoogleVision = wrap('convertPageGoogleVision');
    obj.convertPageText = wrap('convertPageText');

    obj.optimizeFont = wrap('optimizeFont');

    obj.evalPageFont = wrap('evalPageFont');
    obj.evalPageBase = wrap('evalPageBase');
    obj.evalWords = wrap('evalWords');
    obj.compareOCRPageImp = wrap('compareOCRPageImp');
    obj.nudgePageFontSize = wrap('nudgePageFontSize');
    obj.nudgePageBaseline = wrap('nudgePageBaseline');

    obj.reinitialize = wrap('reinitialize');
    obj.reinitialize2 = wrap('reinitialize2');
    obj.recognize = wrap('recognize');
    obj.recognizeAndConvert = wrap('recognizeAndConvert');
    obj.recognizeAndConvert2 = wrap2('recognizeAndConvert2');
    obj.renderPageStaticImp = wrap('renderPageStaticImp');

    obj.loadFontsWorker = wrap('loadFontsWorker');
    obj.updateFontContWorker = wrap('updateFontContWorker');

    obj.terminate = () => worker.terminate();

    ready.then(() => resolve(obj));
  });
}

/**
 * This class stores the scheduler and related promises.
 */
export class gs {
  // Individual promises are used to track the readiness of different components in the scheduler/workers.
  // This is used rather than storing the scheduler in a promise for a couple reasons:
  // (1) The scheduler only loads certain features on an as-needed basis, and we need to be able to track the readiness of these individually.
  //     When initially set up, the scheduler will not have fonts loaded, or the Tesseract worker loaded.
  // (2) The scheduler is accessed directly from this object within in many non-async functions,
  //     so storing as a promise would require a lot of refactoring for little benefit.
  //     The scheduler is a singleton that is only set up once, so there is no need to store it in a promise as long as setup race conditions are avoided.

  /** Whether built-in fonts have been loaded in workers. */
  static loadedBuiltInFontsRawWorker = false;

  /** Whether optimized fonts have been loaded in workers. */
  static loadedBuiltInFontsOptWorker = false;

  static loadedBuiltInFontsDocWorker = false;

  /** @type {?GeneralScheduler} */
  // static scheduler = null;

  /** @type {?import('../tess/tesseract.esm.min.js').default} */
  static schedulerInner = null;

  /** @type {?Promise<void>} */
  static schedulerReady = null;

  /** @type {?Function} */
  static #resReadyTesseract = null;

  /** @type {?Promise<void>} */
  static schedulerReadyTesseract = null;

  /**
   * @param {Parameters<typeof import('./worker/compareOCRModule.js').compareOCRPageImp>[0]} args
   * @returns {ReturnType<typeof import('./worker/compareOCRModule.js').compareOCRPageImp>}
   */
  static compareOCRPageImp = async (args) => await gs.schedulerInner.addJob('compareOCRPageImp', args);

  /**
   * @param {Parameters<typeof import('./import/convertPageHocr.js').convertPageHocr>[0]} args
   * @returns {ReturnType<typeof import('./import/convertPageHocr.js').convertPageHocr>}
   */
  static convertPageHocr = async (args) => {
    await gs.getGeneralScheduler();
    return gs.schedulerInner.addJob('convertPageHocr', args);
  };

  /**
   * @param {Parameters<typeof import('./import/convertPageAbbyy.js').convertPageAbbyy>[0]} args
   * @returns {ReturnType<typeof import('./import/convertPageAbbyy.js').convertPageAbbyy>}
   */
  static convertPageAbbyy = async (args) => {
    await gs.getGeneralScheduler();
    return gs.schedulerInner.addJob('convertPageAbbyy', args);
  };

  /**
   * @param {Parameters<typeof import('./import/convertDocTextract.js').convertDocTextract>[0]} args
   * @returns {ReturnType<typeof import('./import/convertDocTextract.js').convertDocTextract>}
   */
  static convertDocTextract = async (args) => {
    await gs.getGeneralScheduler();
    return gs.schedulerInner.addJob('convertDocTextract', args);
  };

  /**
   * @param {Parameters<typeof import('./import/convertDocAzureDocIntel.js').convertDocAzureDocIntel>[0]} args
   * @returns {ReturnType<typeof import('./import/convertDocAzureDocIntel.js').convertDocAzureDocIntel>}
   */
  static convertDocAzureDocIntel = async (args) => {
    await gs.getGeneralScheduler();
    return gs.schedulerInner.addJob('convertDocAzureDocIntel', args);
  };

  /**
   * @param {Parameters<typeof import('./import/convertPageGoogleVision.js').convertPageGoogleVision>[0]} args
   * @returns {ReturnType<typeof import('./import/convertPageGoogleVision.js').convertPageGoogleVision>}
   */
  static convertPageGoogleVision = async (args) => {
    await gs.getGeneralScheduler();
    return gs.schedulerInner.addJob('convertPageGoogleVision', args);
  };

  /**
   * @param {Parameters<typeof import('./import/convertPageStext.js').convertPageStext>[0]} args
   * @returns {ReturnType<typeof import('./import/convertPageStext.js').convertPageStext>}
   */
  static convertPageStext = async (args) => {
    await gs.getGeneralScheduler();
    return gs.schedulerInner.addJob('convertPageStext', args);
  };

  /**
   * @param {Parameters<typeof import('./import/convertPageText.js').convertPageText>[0]} args
   * @returns {ReturnType<typeof import('./import/convertPageText.js').convertPageText>}
   */
  static convertPageText = async (args) => {
    await gs.getGeneralScheduler();
    return gs.schedulerInner.addJob('convertPageText', args);
  };

  /**
   * @param {Parameters<typeof import('./worker/optimizeFontModule.js').optimizeFont>[0]} args
   * @returns {ReturnType<typeof import('./worker/optimizeFontModule.js').optimizeFont>}
   */
  static optimizeFont = async (args) => {
    await gs.getGeneralScheduler();
    return gs.schedulerInner.addJob('optimizeFont', args);
  };

  /**
   * @template {Partial<Tesseract.OutputFormats>} TO
   * @param {Object} args
   * @param {Parameters<Tesseract.Worker['recognize']>[0]} args.image
   * @param {Parameters<Tesseract.Worker['recognize']>[1]} args.options
   * @param {TO} args.output
   * @returns {Promise<Tesseract.Page<TO>>}
   * Exported for type inference purposes, should not be imported anywhere.
   */
  static recognize = async (args) => (await gs.schedulerInner.addJob('recognize', args));

  /**
   * @param {Parameters<typeof import('./worker/generalWorker.js').recognizeAndConvert>[0]} args
   * @returns {ReturnType<typeof import('./worker/generalWorker.js').recognizeAndConvert>}
   */
  static recognizeAndConvert = async (args) => (await gs.schedulerInner.addJob('recognizeAndConvert', args));

  /**
   * @param {Parameters<typeof import('./worker/generalWorker.js').recognizeAndConvert2>[0]} args
   * @returns {Promise<[ReturnType<typeof import('./worker/generalWorker.js').recognizeAndConvert>, ReturnType<typeof import('./worker/generalWorker.js').recognizeAndConvert>]>}
   */
  static recognizeAndConvert2 = async (args) => (await gs.schedulerInner.addJob('recognizeAndConvert2', args));

  /**
   * @param {Parameters<typeof import('./worker/compareOCRModule.js').evalPageBase>[0]} args
   * @returns {ReturnType<typeof import('./worker/compareOCRModule.js').evalPageBase>}
   */
  static evalPageBase = async (args) => await gs.schedulerInner.addJob('evalPageBase', args);

  /**
   * @param {Parameters<typeof import('./worker/compareOCRModule.js').evalWords>[0]} args
   * @returns {ReturnType<typeof import('./worker/compareOCRModule.js').evalWords>}
   */
  static evalWords = async (args) => (await gs.schedulerInner.addJob('evalWords', args));

  /**
   * @param {Parameters<typeof import('./worker/compareOCRModule.js').evalPageFont>[0]} args
   * @returns {ReturnType<typeof import('./worker/compareOCRModule.js').evalPageFont>}
   */
  static evalPageFont = async (args) => await gs.schedulerInner.addJob('evalPageFont', args);

  /**
   * @param {Parameters<typeof import('./worker/compareOCRModule.js').renderPageStaticImp>[0]} args
   * @returns {ReturnType<typeof import('./worker/compareOCRModule.js').renderPageStaticImp>}
   */
  static renderPageStaticImp = async (args) => (await gs.schedulerInner.addJob('renderPageStaticImp', args));

  static init = async () => {
    let workerN;
    if (opt.workerN) {
      workerN = opt.workerN;
    } else if (typeof process === 'undefined') {
      workerN = Math.min(Math.round((globalThis.navigator.hardwareConcurrency || 8) / 2), 6);
    } else {
      const cpuN = Math.floor((await import('node:os')).cpus().length / 2);
      workerN = Math.min(cpuN - 1, 8);
    }

    const Tesseract = typeof process === 'undefined' ? (await import('../tess/tesseract.esm.min.js')).default : await import('@scribe.js/tesseract.js');

    gs.schedulerInner = await Tesseract.createScheduler();
    gs.schedulerInner.workers = new Array(workerN);

    const addGeneralWorker = async (i) => {
      const w = await initGeneralWorker();
      w.id = `png-${Math.random().toString(16).slice(3, 8)}`;
      gs.schedulerInner.addWorker(w);
      gs.schedulerInner.workers[i] = w;
    };

    // Wait for the first worker to load.
    // A behavior (likely bug) was observed where, if the workers are loaded in parallel,
    // data will be loaded over network from all workers (rather than downloading once and caching).
    await addGeneralWorker(0);

    const resArr = Array.from({ length: workerN }, (v, k) => k).slice(1).map((i) => addGeneralWorker(i));

    await Promise.all(resArr);

    return;
  };

  /**
   *
   * @param {Object} params
   * @param {boolean} [params.anyOk=false] - Is any Tesseract worker okay to use?
   *    If `true`, this function returns immediately if Tesseract workers are already loaded,
   *    without checking the particular language/oem settings.
   * @param {boolean} [params.vanillaMode=false] - Use vanilla Tesseract rather than Scribe OCR fork.
   * @param {string[]} [params.langs] - Array of language codes to load. If not provided, all languages are loaded.
   * @param {Object<string, string>} [params.config={}] - Config params to pass to to Tesseract.js.
   * @returns
   */
  static initTesseract = async ({
    anyOk = true, vanillaMode = false, langs = ['eng'], config = {},
  }) => {
    await gs.schedulerReady;

    if (anyOk && gs.schedulerReadyTesseract) return gs.schedulerReadyTesseract;

    if (gs.schedulerReadyTesseract) await gs.schedulerReadyTesseract;

    gs.schedulerReadyTesseract = new Promise((resolve, reject) => {
      gs.#resReadyTesseract = resolve;
    });

    // Wait for the first worker to load.
    // A behavior (likely bug) was observed where, if the workers are loaded in parallel,
    // data will be loaded over network from all workers (rather than downloading once and caching).
    const worker0 = gs.schedulerInner.workers[0];
    await worker0.reinitialize({ langs, vanillaMode, config });

    if (gs.schedulerInner.workers.length > 0) {
      const resArr = gs.schedulerInner.workers.slice(1).map((x) => x.reinitialize({ langs, vanillaMode, config }));
      await Promise.allSettled(resArr);
    }
    // @ts-ignore
    gs.#resReadyTesseract(true);
    return gs.schedulerReadyTesseract;
  };

  /**
   * Gets the general scheduler if it exists, otherwise creates a new one.
   */
  static getGeneralScheduler = () => {
    if (gs.schedulerReady) {
      return gs.schedulerReady;
    }

    gs.schedulerReady = gs.init();

    return gs.schedulerReady;
  };

  static clear = () => {
    gs.loadedBuiltInFontsOptWorker = false;
  };

  static terminate = async () => {
    gs.clear();
    // This function can be run while the scheduler is still initializing.
    // This happens when we pre-load the scheduler, but then terminate before it finishes loading,
    // and it is never actually used.
    await gs.schedulerReady;
    await gs.schedulerInner.terminate();
    gs.schedulerInner = null;
    gs.schedulerReady = null;
    gs.#resReadyTesseract = null;
    gs.schedulerReadyTesseract = null;
    gs.loadedBuiltInFontsRawWorker = false;
  };
}
