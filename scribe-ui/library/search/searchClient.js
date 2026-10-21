import { pageInputOf } from './searchTokenizer.js';

const QUERY_TIMEOUT_MS = 20000;
const INGEST_TIMEOUT_MS = 600000;

/**
 * @param {Object} [settings] - Engine settings, as `ENGINE_DEFAULTS` in searchEngine.js.
 */
export const createSearchClient = (settings = {}) => {
  /** @type {?Worker} */
  let worker = null;
  let nextId = 1;
  /** @type {Map<number, {resolve: (v: any) => void, reject: (e: Error) => void, timer: number}>} */
  const pending = new Map();
  /** @type {Map<number, (tiers: ?SearchResponse) => void>} */
  const tierHandlers = new Map();
  /** @type {?{libraryId: ?string}} */
  let openArgs = null;
  let reopen = false;
  let terminated = false;
  /** @param {Error} err */
  const failAll = (err) => {
    for (const [, p] of pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    pending.clear();
    tierHandlers.clear();
  };
  const spawn = () => {
    worker = new Worker(new URL('./searchWorker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (e) => {
      const {
        id, ok, result, error, phase,
      } = e.data;
      if (phase === 'tiers') {
        const handler = tierHandlers.get(id);
        tierHandlers.delete(id);
        if (!ok) console.warn(`search worker: the fallback tiers failed: ${error}`);
        if (handler) handler(ok ? result : null);
        return;
      }
      const p = pending.get(id);
      if (!p) return;
      pending.delete(id);
      clearTimeout(p.timer);
      if (ok) p.resolve(result);
      else {
        tierHandlers.delete(id);
        p.reject(new Error(error));
      }
    };
    worker.onerror = (e) => {
      failAll(new Error(`search worker: ${e.message || 'crashed'}`));
    };
  };
  spawn();
  /**
   * @param {string} op
   * @param {Object} [args]
   * @param {(tiers: ?SearchResponse) => void} [onTiers]
   * @returns {Promise<any>}
   */
  const call = (op, args = {}, onTiers = undefined) => new Promise((resolve, reject) => {
    if (terminated || !worker) {
      reject(new Error('The search worker is terminated.'));
      return;
    }
    const id = nextId++;
    const limit = op === 'addDoc' || op === 'removeDoc' || op === 'open' || op === 'reset' ? INGEST_TIMEOUT_MS : QUERY_TIMEOUT_MS;
    const timer = window.setTimeout(() => {
      if (!pending.has(id)) return;
      pending.delete(id);
      failAll(new Error(`search worker: ${op} did not answer in ${Math.round(limit / 1000)} s; the worker was replaced`));
      // The worker handles one message at a time, so a call that never settles would stall every later call until the worker is replaced.
      worker?.terminate();
      spawn();
      reopen = openArgs !== null;
      reject(new Error(`search worker: ${op} did not answer in ${Math.round(limit / 1000)} s`));
    }, limit);
    pending.set(id, { resolve, reject, timer });
    if (onTiers) tierHandlers.set(id, onTiers);
    worker.postMessage({ id, op, args });
  });
  let chain = Promise.resolve();
  let queriesInFlight = 0;
  /** @type {Array<() => void>} */
  const queryWaiters = [];
  /**
   * @param {string} op
   * @param {Object} [args]
   * @param {(tiers: ?SearchResponse) => void} [onTiers]
   */
  const serial = (op, args, onTiers = undefined) => {
    // Each call waits here for the one before it to settle, so its timeout never counts time spent queued behind a slow call in the worker.
    const run = chain.then(async () => {
      if (op === 'open') reopen = false;
      else if (reopen) {
        reopen = false;
        try {
          await call('open', { ...openArgs, settings });
        } catch (err) {
          reopen = true;
          throw new Error(`search worker: the replaced worker could not reopen the library: ${err instanceof Error ? err.message : err}`);
        }
      }
      return call(op, args, onTiers);
    });
    chain = run.catch(() => {});
    return run;
  };
  return {
    settings,
    /** @param {?string} libraryId - Null keeps the index in memory, for a surface with no storage of its own. */
    open: (libraryId) => {
      openArgs = { libraryId };
      return serial('open', { libraryId, settings });
    },
    /**
     * @param {string} hash
     * @param {Array<?import('../../../js/objects/ocrObjects.js').OcrPage>} pages
     */
    addDoc: (hash, pages) => serial('addDoc', { hash, pages: pages.map(pageInputOf) }),
    /** @param {string} hash */
    removeDoc: (hash) => serial('removeDoc', { hash }),
    /** @param {string} hash @returns {Promise<boolean>} */
    hasDoc: (hash) => serial('hasDoc', { hash }),
    /**
     * @param {string} query
     * @param {{bound?: number}} [opts]
     * @param {(tiers: ?SearchResponse) => void} [onTiers] - Called at most once, after the query resolves, with the fallback tiers' answer or null when they were skipped, canceled or failed.
     * @returns {Promise<SearchResponse>}
     */
    query: (query, opts, onTiers) => {
      queriesInFlight++;
      const run = serial('query', { query, opts }, onTiers);
      const settled = () => {
        queriesInFlight--;
        if (!queriesInFlight) for (const resolve of queryWaiters.splice(0)) resolve();
      };
      run.then(settled, settled);
      return run;
    },
    querying: () => queriesInFlight > 0,
    /** @returns {Promise<void>} */
    queriesSettled: () => new Promise((resolve) => {
      if (queriesInFlight) queryWaiters.push(resolve);
      else resolve();
    }),
    /**
     * @param {string} hash
     * @param {Array<{page: number, marks: Array<[number, number]>}>} pages
     * @returns {Promise<Array<{page: number, snippet: ?Snippet, rects: ?Array<Array<Box>>, dims: ?{width: number, height: number}}>>}
     */
    snippets: (hash, pages) => serial('snippets', { hash, pages }),
    /**
     * @param {string} hash
     * @param {number[]} pageNs
     * @returns {Promise<Array<?import('./searchPageRecords.js').PageView>>}
     */
    pages: (hash, pageNs) => serial('pages', { hash, pageNs }),
    /**
     * Every page of one document holding the query's phrase, as typed or with a longer last word, in page order, with the ids of each occurrence's words.
     * @param {string} hash
     * @param {string} query
     * @param {Array<{page: number, tier: number, count: number, marks: Array<[number, number]>}>} [near] - Near matches of the document to return with its matches, as the results list shows them.
     * @returns {Promise<{pages: Array<{page: number, count: number, matches: Array<Array<string>>}>}>}
     */
    find: (hash, query, near = []) => serial('find', { hash, query, near }),
    stats: () => serial('stats'),
    reset: () => serial('reset'),
    close: () => {
      openArgs = null;
      return serial('close');
    },
    terminate: () => {
      terminated = true;
      failAll(new Error('The search worker is terminated.'));
      worker?.terminate();
      worker = null;
    },
  };
};

/**
 * @typedef {Object} Snippet
 * @property {string} text
 * @property {Array<[number, number]>} marks - Highlight offsets into `text`.
 * @property {boolean} before
 * @property {boolean} after
 */

/**
 * @typedef {Object} ResponsePage
 * @property {number} page
 * @property {number} tier - 1 the phrase as typed and 2 the phrase with a longer word in place of its last, both in the answer.
 *   3 the words in order within the window, 4 any order within it and 5 anywhere on the page, the near matches.
 * @property {number} count - Occurrences on the page, except in tier 5, where it is the number of query terms.
 * @property {number} score - BM25 in tier 5, 0 elsewhere.
 * @property {Array<[number, number]>} marks - (position << 1 | span) values of each occurrence's first and last token.
 * @property {?Snippet} snippet
 * @property {?Array<Array<Box>>} rects - Null for a page off the first screen.
 * @property {?{width: number, height: number}} dims
 */
/** @typedef {bbox} Box */

/**
 * @typedef {Object} SearchResponse
 * @property {string} query
 * @property {string[]} terms
 * @property {number} matches
 * @property {boolean} bounded
 * @property {boolean} partial - Whether an index file was left out because its list of words beginning with the last word was cut short.
 * @property {number} bound
 * @property {Array<{hash: string, total: number, pages: Array<ResponsePage>}>} docs - Best first, each document's pages best first.
 * @property {{sweep: number, snippets: number, total: number}} ms
 * @property {boolean} [fallbackTiers]
 * @property {number} [found]
 * @property {number} [exactPages]
 */
