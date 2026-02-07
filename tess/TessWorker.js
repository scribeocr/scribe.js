import createJob from './createJob.js';
import getEnvironment from './utils/getEnvironment.js';
import { OEM, PSM } from './constants.js';

/** @typedef {TessImageLike} ImageLike */
/** @typedef {TessRecognizeOptions} RecognizeOptions */
/** @typedef {TessOutputFormats} OutputFormats */
/** @typedef {TessRecognizeResult} RecognizeResult */
/** @typedef {TessPage} Page */

const isBrowser = getEnvironment('type') === 'browser';

const resolveURL = isBrowser ? (s) => (new URL(s, window.location.href)).href : (s) => s;

const resolvePaths = (options) => {
  const opts = { ...options };
  ['corePath', 'langPath'].forEach((key) => {
    if (options[key]) {
      opts[key] = resolveURL(opts[key]);
    }
  });
  return opts;
};

const circularize = (page) => {
  const blocks = [];
  const paragraphs = [];
  const lines = [];
  const words = [];
  const symbols = [];

  if (page.blocks) {
    page.blocks.forEach((block) => {
      block.paragraphs.forEach((paragraph) => {
        paragraph.lines.forEach((line) => {
          line.words.forEach((word) => {
            word.symbols.forEach((sym) => {
              symbols.push({
                ...sym, page, block, paragraph, line, word,
              });
            });
            words.push({
              ...word, page, block, paragraph, line,
            });
          });
          lines.push({
            ...line, page, block, paragraph,
          });
        });
        paragraphs.push({
          ...paragraph, page, block,
        });
      });
      blocks.push({
        ...block, page,
      });
    });
  }

  return {
    ...page, blocks, paragraphs, lines, words, symbols,
  };
};

const loadImage = async (image) => {
  let loadImageImp;
  if (typeof process === 'undefined') {
    loadImageImp = (await import('./worker/browser/loadImage.js')).default;
  } else {
    loadImageImp = (await import('./worker/node/loadImage.js')).default;
  }
  return loadImageImp(image);
};

export class TessWorker {
  static #workerCounter = 0;

  static PSM = PSM;

  static OEM = OEM;

  #id;

  #worker = null;

  #promises = {};

  #currentLangs;

  #currentOem;

  #currentConfig;

  #lstmOnlyCore;

  #options;

  #logger;

  #errorHandler;

  #workerRes;

  constructor(langs = 'eng', oem = OEM.LSTM_ONLY, _options = {}, config = {}) {
    const {
      logger,
      errorHandler,
      ...options
    } = resolvePaths({
      logger: () => {},
      ..._options,
    });

    this.#id = `Worker-${TessWorker.#workerCounter}-${Math.random().toString(16).slice(3, 8)}`;
    this.#logger = logger;
    this.#errorHandler = errorHandler;
    this.#options = options;
    this.#currentLangs = typeof langs === 'string' ? langs.split('+') : langs;
    this.#currentOem = oem;
    this.#currentConfig = config;
    this.#lstmOnlyCore = [OEM.DEFAULT, OEM.LSTM_ONLY].includes(oem) && !options.legacyCore;

    TessWorker.#workerCounter += 1;

    this.#workerRes = this.#initWorker(langs, oem, config);
  }

  get id() {
    return this.#id;
  }

  get worker() {
    return this.#worker;
  }

  get ready() {
    return this.#workerRes;
  }

  static async create(langs = 'eng', oem = OEM.LSTM_ONLY, options = {}, config = {}) {
    const instance = new TessWorker(langs, oem, options, config);
    await instance.ready;
    return instance;
  }

  async #initWorker(langs, oem, config) {
    let workerResReject;
    let workerResResolve;
    const workerRes = new Promise((resolve, reject) => {
      workerResResolve = resolve;
      workerResReject = reject;
    });

    const readyPromise = new Promise((resolve, reject) => {
      this.#promises['ready-ready'] = { resolve, reject, func: 'ready' };
    });

    const workerError = (event) => { workerResReject(event.message); };

    if (typeof process === 'undefined') {
      this.#worker = new Worker(new URL('./worker-script/index.js', import.meta.url), { type: 'module' });
      this.#worker.onerror = workerError;
      this.#worker.onmessage = (event) => this.#messageHandler(event.data, workerResReject);
    } else {
      const { Worker: WorkerNode } = await import('node:worker_threads');
      this.#worker = new WorkerNode(new URL('./worker-script/index.js', import.meta.url));
      this.#worker.on('error', workerError);
      this.#worker.on('message', (data) => this.#messageHandler(data, workerResReject));
    }

    await readyPromise;

    try {
      await this.#loadInternal();
      await this.#loadLanguageInternal(langs);
      await this.#initializeInternal(langs, oem, config);
      workerResResolve(this);
    } catch (err) {
      workerResReject(err);
    }

    return workerRes;
  }

  #messageHandler(data, workerResReject) {
    const {
      jobId, status, action, data: responseData,
    } = data;
    const promiseId = `${action}-${jobId}`;

    if (status === 'resolve') {
      let d = responseData;
      if (action === 'recognize') {
        d = circularize(responseData);
      }
      this.#promises[promiseId].resolve({ jobId, data: d });
      delete this.#promises[promiseId];
    } else if (status === 'reject') {
      this.#promises[promiseId].reject(responseData);
      delete this.#promises[promiseId];
      if (action === 'load') workerResReject(responseData);
      if (this.#errorHandler) {
        this.#errorHandler(responseData);
      } else {
        throw Error(responseData);
      }
    } else if (status === 'progress') {
      this.#logger({ ...responseData, userJobId: jobId });
    }
  }

  #send(packet) {
    this.#worker.postMessage(packet);
  }

  #startJob({ id: jobId, action, payload }) {
    return new Promise((resolve, reject) => {
      const promiseId = `${action}-${jobId}`;
      this.#promises[promiseId] = { resolve, reject };
      this.#send({
        workerId: this.#id,
        jobId,
        action,
        payload,
      });
    });
  }

  /**
   * @returns {[Promise<RecognizeResult>, Promise<RecognizeResult>]}
   */
  #startJob2({ id: jobId, action, payload }) {
    /** @type {Promise<RecognizeResult>} */
    const promiseB = new Promise((resolve, reject) => {
      const promiseId = `${action}-${jobId}b`;
      this.#promises[promiseId] = { resolve, reject };
    });

    /** @type {Promise<RecognizeResult>} */
    const promiseA = new Promise((resolve, reject) => {
      const promiseId = `${action}-${jobId}`;
      this.#promises[promiseId] = { resolve, reject };
      this.#send({
        workerId: this.#id,
        jobId,
        action,
        payload,
      });
    });

    return ([promiseA, promiseB]);
  }

  #loadInternal(jobId) {
    return this.#startJob(createJob({
      id: jobId,
      action: 'load',
      payload: {
        options: {
          lstmOnly: this.#lstmOnlyCore,
          vanillaEngine: this.#options.vanillaEngine,
          logging: this.#options.logging,
        },
      },
    }));
  }

  #loadLanguageInternal(langs, jobId) {
    return this.#startJob(createJob({
      id: jobId,
      action: 'loadLanguage',
      payload: {
        langs,
        options: {
          langPath: this.#options.langPath,
          dataPath: this.#options.dataPath,
          cachePath: this.#options.cachePath,
          cacheMethod: this.#options.cacheMethod,
          gzip: this.#options.gzip,
          lstmOnly: [OEM.LSTM_ONLY, OEM.TESSERACT_LSTM_COMBINED].includes(this.#currentOem)
            && !this.#options.legacyLang,
        },
      },
    }));
  }

  #initializeInternal(langs, oem, config, jobId) {
    return this.#startJob(createJob({
      id: jobId,
      action: 'initialize',
      payload: { langs, oem, config },
    }));
  }

  reinitialize(langs = 'eng', oem, config, jobId) {
    if (this.#lstmOnlyCore && [OEM.TESSERACT_ONLY, OEM.TESSERACT_LSTM_COMBINED].includes(oem)) {
      throw Error('Legacy model requested but code missing.');
    }

    const _oem = oem || this.#currentOem;
    this.#currentOem = _oem;

    const _config = config || this.#currentConfig;
    this.#currentConfig = _config;

    const langsArr = typeof langs === 'string' ? langs.split('+') : langs;
    const _langs = langsArr.filter((x) => !this.#currentLangs.includes(x));
    this.#currentLangs.push(..._langs);

    if (_langs.length > 0) {
      return this.#loadLanguageInternal(_langs, jobId)
        .then(() => this.#initializeInternal(langs, _oem, _config, jobId));
    }

    return this.#initializeInternal(langs, _oem, _config, jobId);
  }

  setParameters(params = {}, jobId) {
    return this.#startJob(createJob({
      id: jobId,
      action: 'setParameters',
      payload: { params },
    }));
  }

  /**
   * @param {ImageLike} image
   * @param {Partial<RecognizeOptions>} opts
   * @param {Partial<OutputFormats>} output
   * @param {string} [jobId]
   * @returns {Promise<RecognizeResult>}
   */
  async recognize(image, opts = {}, output = {
    blocks: true, text: true,
  }, jobId) {
    return this.#startJob(createJob({
      id: jobId,
      action: 'recognize',
      payload: { image: await loadImage(image), options: opts, output },
    }));
  }

  /**
   * @param {ImageLike} image
   * @param {Partial<RecognizeOptions>} opts
   * @param {Partial<OutputFormats>} output
   * @param {string} [jobId]
   * @returns {Promise<[Promise<RecognizeResult>, Promise<RecognizeResult>]>}
   */
  async recognize2(image, opts = {}, output = {
    blocks: true, text: true,
  }, jobId) {
    return this.#startJob2(createJob({
      id: jobId,
      action: 'recognize2',
      payload: { image: await loadImage(image), options: opts, output },
    }));
  }

  async terminate() {
    if (this.#worker !== null) {
      await this.#worker.terminate();
      this.#worker = null;
    }
  }
}
