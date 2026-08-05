// Per-document sessions for the library: one owner for the in-memory state of each content hash.
// Persistent artifacts stay in LibraryStore, so a surface rebuild never discards live documents, parsed sidecars, or decoded image URLs.

/** How many idle live documents the pool keeps open before evicting the least recently used. */
const MAX_IDLE_LIVE = 2;
/** How many parsed sidecars stay cached, each holding a whole document's word geometry. */
const MAX_SIDECARS = 4;
/** How many page-image object URLs stay alive across all sessions. */
const MAX_PAGE_URLS = 400;

/**
 * An object URL over a copy of `blob`'s bytes.
 * A `File` read from OPFS can lose its backing store later, which kills object URLs made directly from it.
 * @param {Blob} blob
 * @returns {Promise<string>}
 */
const stableUrl = async (blob) => URL.createObjectURL(new Blob([await blob.arrayBuffer()], { type: blob.type || 'image/jpeg' }));

class DocSession {
  /** @param {string} hash */
  constructor(hash) {
    this.hash = hash;
    this.lastUse = 0;
    /** @type {?Promise<import('../../js/containers/scribeDoc.js').ScribeDoc>} */
    this.livePromise = null;
    /** @type {?import('../../js/containers/scribeDoc.js').ScribeDoc} Resolved pool document, null while loading or absent. */
    this.liveDoc = null;
    /** @type {?Promise<?{ocr: ?Array<Object>, annotations: ?Array<Array<Object>>}>} */
    this.sidecarPromise = null;
    /** @type {?string} */
    this.coverUrl = null;
    /** @type {?Promise<?string>} */
    this.coverPromise = null;
    /** @type {Map<number, string>} Page -> object URL over the stored raster. */
    this.pageUrls = new Map();
  }
}

export class DocSessions {
  constructor() {
    /** @type {Map<string, DocSession>} */
    this.map = new Map();
    /** @type {?import('./libraryStore.js').LibraryStore} */
    this.store = null;
    this.useTick = 0;
    /** @type {Array<DocSession>} Sessions holding a parsed sidecar, oldest first. */
    this.sidecarOrder = [];
    /** @type {Array<{session: DocSession, n: number}>} Page-URL creation order, oldest first. */
    this.urlOrder = [];
  }

  /**
   * Point the registry at a store, dropping every session from the previous one.
   * @param {import('./libraryStore.js').LibraryStore} store
   */
  connect(store) {
    this.reset();
    this.store = store;
  }

  /** @param {string} hash */
  session(hash) {
    let s = this.map.get(hash);
    if (!s) {
      s = new DocSession(hash);
      this.map.set(hash, s);
    }
    s.lastUse = ++this.useTick;
    return s;
  }

  /**
   * The pooled live document for `hash` when one is already resolved.
   * Never triggers a load.
   * @param {string} hash
   * @returns {?import('../../js/containers/scribeDoc.js').ScribeDoc}
   */
  peekLive(hash) {
    return this.map.get(hash)?.liveDoc ?? null;
  }

  /** @param {string} hash @returns {boolean} Whether a live document exists or is loading. */
  hasLive(hash) {
    return !!this.map.get(hash)?.livePromise;
  }

  /**
   * Get-or-start the live document for `hash`.
   * The document stays in the idle pool, so it is shared by later callers and closed by pool eviction.
   * @param {string} hash
   * @param {() => Promise<import('../../js/containers/scribeDoc.js').ScribeDoc>} loader
   */
  liveDocOrLoad(hash, loader) {
    const s = this.session(hash);
    if (!s.livePromise) {
      const p = Promise.resolve().then(loader).then((doc) => {
        if (s.livePromise === p) s.liveDoc = doc;
        return doc;
      });
      p.catch(() => {
        if (s.livePromise === p) s.livePromise = null;
      });
      s.livePromise = p;
      this.#evictLive(s);
    }
    return s.livePromise;
  }

  /**
   * Adopt an already-open, hydrated document into the idle pool.
   * @param {string} hash
   * @param {import('../../js/containers/scribeDoc.js').ScribeDoc} doc
   */
  adoptLive(hash, doc) {
    const s = this.session(hash);
    if (s.liveDoc === doc) return;
    if (s.liveDoc) s.liveDoc.close().catch(() => {});
    s.liveDoc = doc;
    s.livePromise = Promise.resolve(doc);
    this.#evictLive(s);
  }

  /**
   * Remove and return the resolved live document.
   * The caller takes ownership and must close it.
   * @param {string} hash
   * @returns {?import('../../js/containers/scribeDoc.js').ScribeDoc}
   */
  takeLive(hash) {
    const s = this.map.get(hash);
    if (!s || !s.liveDoc) return null;
    const doc = s.liveDoc;
    s.liveDoc = null;
    s.livePromise = null;
    return doc;
  }

  /**
   * Parsed sidecar content for seeds, previews, and match marks.
   * @param {string} hash
   * @returns {Promise<?{ocr: ?Array<Object>, annotations: ?Array<Array<Object>>}>}
   */
  sidecar(hash) {
    const s = this.session(hash);
    if (!s.sidecarPromise) {
      const store = this.store;
      if (!store) return Promise.resolve(null);
      s.sidecarPromise = store.readSidecar(hash).then(async (data) => {
        if (!data) return null;
        const json = JSON.parse(await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream('gzip'))).text());
        return {
          ocr: Array.isArray(json.ocr) ? json.ocr : null,
          annotations: Array.isArray(json.annotations) ? json.annotations : null,
        };
      }).catch(() => null);
      this.sidecarOrder.push(s);
      while (this.sidecarOrder.length > MAX_SIDECARS) {
        const old = /** @type {DocSession} */ (this.sidecarOrder.shift());
        if (old !== s) old.sidecarPromise = null;
      }
    }
    return s.sidecarPromise;
  }

  /**
   * Drop the cached sidecar parse.
   * Call after writing a new sidecar so the next read sees it.
   * @param {string} hash
   */
  dropSidecar(hash) {
    const s = this.map.get(hash);
    if (s) s.sidecarPromise = null;
  }

  /**
   * The cover-thumb URL when it has already been made, for synchronous card paints.
   * @param {string} hash
   * @returns {?string}
   */
  coverUrlNow(hash) {
    return this.map.get(hash)?.coverUrl ?? null;
  }

  /**
   * Object URL for the document's cover thumbnail, or null when none is stored.
   * @param {string} hash
   * @returns {Promise<?string>}
   */
  cover(hash) {
    const s = this.session(hash);
    if (!s.coverPromise) {
      const store = this.store;
      if (!store) return Promise.resolve(null);
      s.coverPromise = store.readThumb(hash).then(async (blob) => {
        if (!blob) return null;
        s.coverUrl = await stableUrl(blob);
        return s.coverUrl;
      }).catch(() => null);
      s.coverPromise.then((url) => {
        if (url === null) s.coverPromise = null;
      });
    }
    return s.coverPromise;
  }

  /**
   * Object URL over the stored raster of one page, or null when absent.
   * Never renders and never imports, so an absent raster leaves the caller to show a placeholder.
   * @param {string} hash
   * @param {number} n
   * @returns {Promise<?string>}
   */
  async pageImage(hash, n) {
    const s = this.session(hash);
    const cached = s.pageUrls.get(n);
    if (cached) return cached;
    const store = this.store;
    if (!store) return null;
    const blob = await store.readPageRaster(hash, n).catch(() => null);
    if (!blob) return null;
    const again = s.pageUrls.get(n);
    if (again) return again;
    const url = await stableUrl(blob);
    s.pageUrls.set(n, url);
    this.urlOrder.push({ session: s, n });
    while (this.urlOrder.length > MAX_PAGE_URLS) {
      const old = /** @type {{session: DocSession, n: number}} */ (this.urlOrder.shift());
      const oldUrl = old.session.pageUrls.get(old.n);
      if (oldUrl) {
        URL.revokeObjectURL(oldUrl);
        old.session.pageUrls.delete(old.n);
      }
    }
    return url;
  }

  /**
   * Drop everything cached for one document.
   * Call when its content or stored artifacts changed.
   * @param {string} hash
   */
  invalidate(hash) {
    const s = this.map.get(hash);
    if (!s) return;
    if (s.liveDoc) s.liveDoc.close().catch(() => {});
    for (const url of s.pageUrls.values()) URL.revokeObjectURL(url);
    if (s.coverUrl) URL.revokeObjectURL(s.coverUrl);
    this.map.delete(hash);
  }

  /** Close every pooled document and revoke every URL. */
  reset() {
    for (const s of this.map.values()) {
      if (s.liveDoc) s.liveDoc.close().catch(() => {});
      for (const url of s.pageUrls.values()) URL.revokeObjectURL(url);
      if (s.coverUrl) URL.revokeObjectURL(s.coverUrl);
    }
    this.map.clear();
    this.sidecarOrder.length = 0;
    this.urlOrder.length = 0;
  }

  /**
   * Close idle live documents past the pool cap, least recently used first.
   * @param {DocSession} keep - The session that must survive this eviction.
   */
  #evictLive(keep) {
    const live = [...this.map.values()].filter((s) => s.livePromise && s !== keep);
    live.sort((a, b) => a.lastUse - b.lastUse);
    while (live.length > MAX_IDLE_LIVE - 1) {
      const victim = /** @type {DocSession} */ (live.shift());
      const doc = victim.liveDoc;
      const pending = victim.livePromise;
      victim.liveDoc = null;
      victim.livePromise = null;
      if (doc) doc.close().catch(() => {});
      else if (pending) pending.then((d) => d.close()).catch(() => {});
    }
  }
}
