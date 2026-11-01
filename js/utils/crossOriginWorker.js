import { opt } from '../containers/app.js';

const NativeWorker = globalThis.Worker;

/** @type {Map<string, Promise<string>>} */
const fetchedScripts = new Map();

class FetchedWorker extends EventTarget {
  /** @type {?globalThis.Worker} */
  #worker = null;

  /** @type {Array<[any, (Transferable[] | StructuredSerializeOptions | undefined)]>} */
  #queue = [];

  #terminated = false;

  /** @type {?((ev: MessageEvent) => any)} */
  #onmessage = null;

  /** @type {?((ev: MessageEvent) => any)} */
  #onmessageerror = null;

  /** @type {?((ev: ErrorEvent) => any)} */
  #onerror = null;

  /**
   * @param {string} href
   * @param {WorkerOptions} [options]
   */
  constructor(href, options) {
    super();
    let script = fetchedScripts.get(href);
    if (!script) {
      script = fetch(href).then(async (res) => {
        if (!res.ok) throw new Error(`${res.status} ${res.statusText} fetching the worker script ${href}`);
        return URL.createObjectURL(new Blob([await res.text()], { type: 'text/javascript' }));
      });
      fetchedScripts.set(href, script);
      script.catch(() => fetchedScripts.delete(href));
    }
    script.then((blobUrl) => {
      if (this.#terminated) return;
      const worker = new NativeWorker(blobUrl, options);
      worker.addEventListener('message', (ev) => this.dispatchEvent(new MessageEvent('message', { data: ev.data, ports: [...ev.ports] })));
      worker.addEventListener('messageerror', (ev) => this.dispatchEvent(new MessageEvent('messageerror', { data: ev.data })));
      worker.addEventListener('error', (ev) => this.dispatchEvent(new ErrorEvent('error', {
        message: ev.message, filename: ev.filename, lineno: ev.lineno, colno: ev.colno, error: ev.error,
      })));
      this.#worker = worker;
      for (const [message, transfer] of this.#queue) worker.postMessage(message, /** @type {any} */ (transfer));
      this.#queue = [];
    }).catch((err) => {
      this.dispatchEvent(new ErrorEvent('error', { message: err instanceof Error ? err.message : String(err), error: err }));
    });
  }

  /**
   * @param {any} message
   * @param {Transferable[] | StructuredSerializeOptions} [transfer]
   */
  postMessage(message, transfer) {
    if (this.#worker) this.#worker.postMessage(message, /** @type {any} */ (transfer));
    else this.#queue.push([message, transfer]);
  }

  terminate() {
    this.#terminated = true;
    this.#queue = [];
    this.#worker?.terminate();
  }

  get onmessage() { return this.#onmessage; }

  set onmessage(fn) {
    if (this.#onmessage) this.removeEventListener('message', /** @type {EventListener} */ (this.#onmessage));
    this.#onmessage = fn;
    if (fn) this.addEventListener('message', /** @type {EventListener} */ (fn));
  }

  get onmessageerror() { return this.#onmessageerror; }

  set onmessageerror(fn) {
    if (this.#onmessageerror) this.removeEventListener('messageerror', /** @type {EventListener} */ (this.#onmessageerror));
    this.#onmessageerror = fn;
    if (fn) this.addEventListener('messageerror', /** @type {EventListener} */ (fn));
  }

  get onerror() { return this.#onerror; }

  set onerror(fn) {
    if (this.#onerror) this.removeEventListener('error', /** @type {EventListener} */ (this.#onerror));
    this.#onerror = fn;
    if (fn) this.addEventListener('error', /** @type {EventListener} */ (fn));
  }
}

/**
 * `Worker` that accepts a script URL on another origin.
 * @type {typeof globalThis.Worker}
 */
export const Worker = typeof NativeWorker !== 'function' ? NativeWorker : /** @type {typeof globalThis.Worker} */ (/** @type {unknown} */ (
  /**
   * @param {string | URL} scriptURL
   * @param {WorkerOptions} [options]
   * @returns {globalThis.Worker}
   */
  function CrossOriginWorker(scriptURL, options) {
    const here = globalThis.location;
    let url;
    try {
      url = new URL(String(scriptURL), here.href);
    } catch {
      return new NativeWorker(scriptURL, options);
    }
    if (url.protocol === 'blob:' || url.protocol === 'data:') return new NativeWorker(scriptURL, options);
    if (opt.fetchWorkerScripts) return /** @type {globalThis.Worker} */ (/** @type {unknown} */ (new FetchedWorker(url.href, options)));
    // Protocol and host rather than `origin`, which can be the opaque "null" for the custom schemes desktop shells and editors serve pages from.
    if (url.protocol === here.protocol && url.host === here.host) return new NativeWorker(scriptURL, options);
    // The imported module keeps its own `import.meta.url`, so everything it resolves relative to itself still works.
    const body = options?.type === 'module' ? `await import(${JSON.stringify(url.href)});` : `importScripts(${JSON.stringify(url.href)});`;
    return new NativeWorker(URL.createObjectURL(new Blob([body], { type: 'text/javascript' })), options);
  }
));
