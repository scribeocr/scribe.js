import { createSearchEngine, memoryStorage } from './searchEngine.js';

/** @type {?ReturnType<typeof createSearchEngine>} */
let engine = null;

const WATCHDOG_MS = 5000;
const HANDLE_WAIT_MS = 2000;
const HANDLE_TRIES = 3;
const NOT_YET = Symbol('not yet');
const inFlight = new Set();
/** @type {Map<string, number>} */
const handlesOpen = new Map();
/**
 * @template T
 * @param {string} op
 * @param {string} name
 * @param {Promise<T>} promise
 * @returns {Promise<T>}
 */
const tracked = (op, name, promise) => {
  const call = {
    op, name, at: performance.now(), stack: new Error().stack,
  };
  inFlight.add(call);
  return promise.finally(() => inFlight.delete(call));
};

/**
 * @template T
 * @param {string} op
 * @param {string} name
 * @param {() => Promise<T>} request
 * @param {(late: T) => unknown} release
 * @returns {Promise<T>}
 */
const handleOf = async (op, name, request, release) => {
  // Chromium now and then never answers a request for a sync access handle.
  for (let tries = 1; tries <= HANDLE_TRIES; tries++) {
    const pending = tracked(op, name, request());
    let timer = 0;
    const answer = await Promise.race([pending, new Promise((resolve) => { timer = setTimeout(resolve, HANDLE_WAIT_MS, NOT_YET); })]);
    clearTimeout(timer);
    if (answer !== NOT_YET) return /** @type {T} */ (answer);
    pending.then(release, () => {});
    console.warn(`search worker: ${op} of ${name} did not answer in ${HANDLE_WAIT_MS} ms (request ${tries} of ${HANDLE_TRIES})`);
  }
  throw new Error(`${op} of ${name} did not answer in ${HANDLE_TRIES} requests of ${HANDLE_WAIT_MS} ms`);
};

/** @param {FileSystemDirectoryHandle} dir */
const opfsStorage = (dir) => ({
  list: async () => {
    const names = [];
    // @ts-ignore - keys() is missing from lib.dom's FileSystemDirectoryHandle.
    for await (const name of dir.keys()) names.push(name);
    return names;
  },
  open: async (name) => {
    const file = await tracked('getFileHandle', name, dir.getFileHandle(name));
    // Chromium leaves a request for a read-write handle unanswered far more often than one for a read-only handle.
    // @ts-ignore - lib.dom's createSyncAccessHandle takes no options.
    const handle = await handleOf('createSyncAccessHandle', name, () => file.createSyncAccessHandle({ mode: 'read-only' }), (late) => late.close());
    handlesOpen.set(name, (handlesOpen.get(name) || 0) + 1);
    const size = handle.getSize();
    let closed = false;
    return {
      size,
      read: (offset, length) => {
        const buf = new Uint8Array(length);
        const n = handle.read(buf, { at: offset });
        return n === length ? buf : buf.subarray(0, n);
      },
      close: () => {
        if (!closed) {
          closed = true;
          const left = (handlesOpen.get(name) || 1) - 1;
          if (left) handlesOpen.set(name, left);
          else handlesOpen.delete(name);
        }
        handle.close();
      },
    };
  },
  write: async (name, bytes) => {
    const file = await tracked('getFileHandle', name, dir.getFileHandle(name, { create: true }));
    // A writable stream needs no read-write sync access handle, whose request Chromium now and then leaves unanswered.
    const writable = await handleOf('createWritable', name, () => file.createWritable(), (late) => late.abort().catch(() => {}));
    try {
      await tracked('write', name, writable.write(bytes));
      await tracked('close', name, writable.close());
    } catch (err) {
      await writable.abort().catch(() => {});
      throw err;
    }
  },
  remove: async (name) => dir.removeEntry(name).catch(() => {}),
});

let queue = Promise.resolve();

/** @type {?{cancelled: boolean, pause: () => Promise<void>}} */
let tiersJob = null;
// A yield that runs the tasks already queued, such as an arrived message, without the clamp nested timers get.
const yieldChannel = new MessageChannel();
/** @type {Array<() => void>} */
const yielded = [];
yieldChannel.port1.onmessage = () => {
  const resume = yielded.shift();
  if (resume) resume();
};
/** @returns {Promise<void>} */
const pause = () => new Promise((resolve) => {
  yielded.push(resolve);
  yieldChannel.port2.postMessage(null);
});

globalThis.addEventListener('message', (e) => {
  const { id, op, args } = e.data;
  if (tiersJob && op !== 'snippets' && op !== 'stats' && op !== 'hasDoc') tiersJob.cancelled = true;
  queue = queue.then(async () => {
    const started = performance.now();
    const watchdog = setTimeout(() => {
      const now = performance.now();
      console.warn(`search worker: ${op}${args && args.query ? ` "${args.query}"` : ''} has run ${Math.round(now - started)} ms; ${JSON.stringify({
        openFiles: [...handlesOpen.keys()],
        inFlight: [...inFlight].map((c) => ({
          op: c.op, name: c.name, ms: Math.round(now - c.at), stack: c.stack,
        })),
      })}`);
    }, WATCHDOG_MS);
    try {
      let result = null;
      if (op === 'open') {
        engine?.close();
        engine = null;
        let storage;
        if (args.libraryId === null) storage = memoryStorage();
        else {
          const root = await navigator.storage.getDirectory();
          const dir = await (await (await root.getDirectoryHandle('libraries', { create: true })).getDirectoryHandle(args.libraryId, { create: true })).getDirectoryHandle('search', { create: true });
          storage = opfsStorage(dir);
        }
        const opened = createSearchEngine(storage, args.settings || {});
        try {
          await opened.open();
        } catch (err) {
          opened.close();
          throw err;
        }
        engine = opened;
        result = engine.stats();
      } else if (!engine) {
        throw new Error('The search engine is not open.');
      } else if (op === 'addDoc') {
        result = await engine.addDoc(args.hash, args.pages);
      } else if (op === 'removeDoc') {
        await engine.removeDoc(args.hash);
      } else if (op === 'hasDoc') {
        result = engine.hasDoc(args.hash);
      } else if (op === 'query') {
        result = await engine.query(args.query, args.opts || {});
        if (engine.options.fallbackTiers) {
          globalThis.postMessage({ id, ok: true, result });
          // A lone word has no near matches: every page holding it, or a longer word beginning with it, is in the answer.
          if ((engine.options.tiersSkipBounded && result.bounded) || result.terms.length < 2) {
            globalThis.postMessage({
              id, phase: 'tiers', ok: true, result: null,
            });
            return;
          }
          const job = { cancelled: false, pause };
          tiersJob = job;
          // The tiers run beside `queue` and yield between slices of work, so the requests that arrive meanwhile are answered.
          engine.tiers(args.query, job).then(
            (tiers) => globalThis.postMessage({
              id, phase: 'tiers', ok: true, result: tiers,
            }),
            (err) => globalThis.postMessage({
              id, phase: 'tiers', ok: false, error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
            }),
          ).finally(() => {
            if (tiersJob === job) tiersJob = null;
          });
          return;
        }
      } else if (op === 'snippets') {
        result = await engine.snippets(args.hash, args.pages);
      } else if (op === 'pages') {
        result = await engine.pages(args.hash, args.pageNs);
      } else if (op === 'find') {
        result = await engine.find(args.hash, args.query, args.near || []);
      } else if (op === 'stats') {
        result = engine.stats();
      } else if (op === 'reset') {
        await engine.reset();
      } else if (op === 'close') {
        engine.close();
        engine = null;
      } else {
        throw new Error(`Unknown search worker op ${op}`);
      }
      globalThis.postMessage({ id, ok: true, result });
    } catch (err) {
      globalThis.postMessage({ id, ok: false, error: err instanceof Error ? `${err.name}: ${err.message}` : String(err) });
    } finally {
      clearTimeout(watchdog);
    }
  });
});
