// Per-document sessions for the library: one owner for the in-memory state of each content hash.

import scribeLib from '../../scribe.js';
import {
  renderPageRaster, PAGE_RASTER_WIDTH, RASTER_LOSSY_QUALITY, RASTER_LOSSLESS_CAP,
} from './libraryIngest.js';

/** How many idle live documents the pool keeps open before evicting the least recently used. */
const MAX_IDLE_LIVE = 2;
// A pixel source is cheap to reopen, 2 to 8 ms, so the pool is small.
const MAX_PIXEL_SOURCES = 3;
/** How many page-image object URLs stay alive across all sessions. */
const MAX_PAGE_URLS = 400;

/**
 * An object URL over a copy of `blob`'s bytes.
 * A `File` read from OPFS can lose its backing store later, which kills object URLs made directly from it.
 * @param {Blob} blob
 * @returns {Promise<string>}
 */
const stableUrl = async (blob) => URL.createObjectURL(new Blob([await blob.arrayBuffer()], { type: blob.type }));

/** @param {DocSession} s */
const closePixels = (s) => {
  const doc = s.pixelsDoc;
  const pending = s.pixelsPromise;
  s.pixelsDoc = null;
  s.pixelsPromise = null;
  if (doc) doc.close().catch(() => {});
  else if (pending) pending.then((d) => d.close()).catch(() => {});
};

class DocSession {
  /** @param {string} hash */
  constructor(hash) {
    this.hash = hash;
    this.lastUse = 0;
    /** @type {?Promise<import('../../js/containers/scribeDoc.js').ScribeDoc>} */
    this.livePromise = null;
    /** @type {?import('../../js/containers/scribeDoc.js').ScribeDoc} Resolved pool document, null while loading or absent. */
    this.liveDoc = null;
    /** @type {?Promise<import('../../js/containers/scribeDoc.js').ScribeDoc>} */
    this.pixelsPromise = null;
    /** @type {?import('../../js/containers/scribeDoc.js').ScribeDoc} */
    this.pixelsDoc = null;
    this.pixelsUse = 0;
    /**
     * Document open in a tab for this hash.
     * @type {?WeakRef<import('../../js/containers/scribeDoc.js').ScribeDoc>}
     */
    this.tabDoc = null;
    /** @type {?string} */
    this.coverUrl = null;
    /** @type {?Promise<?string>} */
    this.coverPromise = null;
    /** @type {Map<number, string>} Page -> object URL over the page's raster, stored or rendered this session. */
    this.pageUrls = new Map();
    /** @type {Map<number, Blob>} Rasters rendered this session and not stored, kept so a later view of the page can store them. */
    this.pageBlobs = new Map();
    /** @type {Map<number, Promise<?string>>} */
    this.rasterPending = new Map();
    /** @type {?Promise<Set<number>>} The pages with a stored raster, listed once, so a page without one is answered without a file read. */
    this.storedPages = null;
    /** @type {?Promise<Set<number>>} The source pages with a stored thumbnail. */
    this.storedThumbs = null;
    /** Whether the pool has asked this session's pixel source to close once its running job settles. */
    this.closeWhenIdle = false;
  }
}

/**
 * @typedef {Object} DocRef
 * @property {string} hash
 * @property {string} relPath
 * @property {import('./libraryStore.js').LibraryDocEntry} entry
 */

export class DocSessions {
  constructor() {
    /** @type {Map<string, DocSession>} */
    this.map = new Map();
    /** @type {?import('./libraryStore.js').LibraryStore} */
    this.store = null;
    this.useTick = 0;
    /** @type {Array<{session: DocSession, n: number}>} Page-URL creation order, oldest first. */
    this.urlOrder = [];
    /** @type {Set<(hash: string, n: number) => void>} */
    this.rasterListeners = new Set();
    /** @type {Set<(hash: string, url: string) => void>} */
    this.coverListeners = new Set();
    /** Stored-raster writes run one at a time: a write holds the directory a read of the same document waits on. */
    this.writeQueue = Promise.resolve();
  }

  /**
   * Point the registry at a store, dropping every session from the previous one.
   * @param {?import('./libraryStore.js').LibraryStore} store
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
   * Close the pooled pixel source for `hash`.
   * @param {string} hash
   */
  dropPixels(hash) {
    const s = this.map.get(hash);
    if (s) closePixels(s);
  }

  /**
   * Open the document from its saved files.
   * @param {DocRef} ref
   * @param {boolean} text - Whether to load page text in the background.
   * @param {(err: unknown) => void} [onError] - Called when the text cannot be read.
   * @returns {Promise<import('../../js/containers/scribeDoc.js').ScribeDoc>}
   */
  async #openSaved(ref, text, onError) {
    const store = this.store;
    if (!store) throw new Error('No library is open.');
    const s = this.session(ref.hash);
    if (!s.storedThumbs) s.storedThumbs = store.listPageThumbs(ref.hash).catch(() => new Set());
    const [file, records, work] = await Promise.all([store.readFile(ref.relPath), store.recordsBlob(ref.hash), store.sidecarBlob(ref.hash), s.storedThumbs]);
    if (!records && text) throw new Error('The document has no records file.');
    const dims = ref.entry.pageDims;
    const doc = await scribeLib.openDocument({ pdfFiles: [file] }, records ? {
      pdfWorkerN: 1,
      saved: {
        records, work, pageDims: dims ? dims.map(([width, height]) => [width, height]) : undefined, text, onError,
      },
    } : {
      pdfWorkerN: 1, usePDFText: { native: { main: false, supp: false }, ocr: { main: false, supp: false } },
    });
    doc.images.setThumbCache(await this.thumbCache(ref, file));
    return doc;
  }

  /**
   * The store's thumbnails of a document's pages, for a copy of the document opened from `file`.
   * Null when the file is not known to hold the bytes the entry's hash names.
   * @param {DocRef} ref
   * @param {File} file
   * @returns {Promise<?import('../../js/containers/imageContainer.js').PageThumbCache>}
   */
  async thumbCache(ref, file) {
    const store = this.store;
    const { hash, entry } = ref;
    // A changed file keeps its entry's old hash until it is indexed again.
    // A file modified since the last scan still reads as indexed, so its size and time are checked against the entry's.
    if (!store || !hash || entry.status !== 'indexed' || file.size !== entry.size || file.lastModified !== entry.mtime) return null;
    const s = this.session(hash);
    if (!s.storedThumbs) s.storedThumbs = store.listPageThumbs(hash).catch(() => new Set());
    const stored = await s.storedThumbs;
    return {
      has: (sourcePageN) => stored.has(sourcePageN),
      get: async (sourcePageN) => {
        try {
          const thumb = await store.readPageThumb(hash, sourcePageN);
          // A file read from OPFS can lose its backing store later, which kills object URLs made directly from it.
          if (thumb) return new Blob([await thumb.arrayBuffer()], { type: 'image/jpeg' });
        } catch { /* Read as a thumbnail that is gone. */ }
        stored.delete(sourcePageN);
        return null;
      },
      put: (sourcePageN, blob) => {
        if (stored.has(sourcePageN) || (store.rasterBytes !== null && store.rasterBytes > store.rasterBudget)) return;
        this.writeQueue = this.writeQueue.then(async () => {
          if (this.store !== store || stored.has(sourcePageN)) return;
          await store.writePageThumb(hash, sourcePageN, blob);
          stored.add(sourcePageN);
        }).catch(() => {});
      },
    };
  }

  /**
   * The document's pixel source, showing its pages with their saved order and edits.
   * It is the document an unedited tab holds, else a pooled copy shared by every caller.
   * The caller does not own it and must not close it.
   * @param {DocRef} ref
   * @returns {Promise<import('../../js/containers/scribeDoc.js').ScribeDoc>}
   */
  pixels(ref) {
    const s = this.session(ref.hash);
    const lent = s.tabDoc?.deref();
    if (lent) {
      // A closed document holds no PDF.
      if (!lent.images.pdfData) s.tabDoc = null;
      else if (!(/** @type {typeof lent & {_libraryEdited?: boolean}} */ (lent))._libraryEdited) return Promise.resolve(lent);
    }
    s.pixelsUse = ++this.useTick;
    if (!s.pixelsPromise) {
      const p = this.#openSaved(ref, false).then((doc) => {
        if (s.pixelsPromise === p) s.pixelsDoc = doc;
        else doc.close().catch(() => {});
        return doc;
      });
      p.catch(() => {
        if (s.pixelsPromise === p) s.pixelsPromise = null;
      });
      s.pixelsPromise = p;
      this.#evictPixels(s);
    }
    return s.pixelsPromise;
  }

  /**
   * Open the document from its saved files for a tab.
   * The caller owns the returned document and must close it.
   * @param {DocRef} ref
   * @param {(err: unknown) => void} onError - Called if background text loading fails.
   * @returns {Promise<import('../../js/containers/scribeDoc.js').ScribeDoc>}
   */
  openForTab(ref, onError) {
    closePixels(this.session(ref.hash));
    return this.#openSaved(ref, true, onError);
  }

  /**
   * Records the document a tab holds for `hash`.
   * Page rasters come from it while the tab has edited nothing.
   * @param {string} hash
   * @param {import('../../js/containers/scribeDoc.js').ScribeDoc} doc
   */
  lendTab(hash, doc) {
    this.session(hash).tabDoc = new WeakRef(doc);
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
      /** @type {Promise<?string>} */
      const p = store.readThumb(hash).then(async (blob) => {
        if (!blob) return null;
        const url = await stableUrl(blob);
        // `invalidate` puts a new session object in the map, so the session is looked up again here.
        const now = this.map.get(hash);
        if (now?.coverPromise !== p) {
          URL.revokeObjectURL(url);
          return now?.coverUrl ?? null;
        }
        now.coverUrl = url;
        return url;
      }).catch(() => null);
      s.coverPromise = p;
      p.then((url) => {
        const now = this.map.get(hash);
        if (url === null && now?.coverPromise === p) now.coverPromise = null;
      });
    }
    return s.coverPromise;
  }

  /**
   * Take a cover just written to the store as the document's cover, in place of the one handed out before it.
   * @param {string} hash
   * @param {Blob} blob
   */
  setCover(hash, blob) {
    const s = this.map.get(hash);
    if (!s || (s.coverUrl === null && s.coverPromise === null)) return;
    const replaced = s.coverUrl;
    const url = URL.createObjectURL(blob);
    s.coverUrl = url;
    s.coverPromise = Promise.resolve(url);
    for (const listener of this.coverListeners) listener(hash, url);
    if (replaced) setTimeout(() => URL.revokeObjectURL(replaced), 0);
  }

  /**
   * Object URL over one page's raster, stored or rendered this session, or null when there is none.
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
    if (!s.storedPages) s.storedPages = store.listPageRasters(hash).catch(() => new Set());
    if (!(await s.storedPages).has(n)) return s.pageUrls.get(n) ?? null;
    const blob = await store.readPageRaster(hash, n).catch(() => null);
    if (!blob) return s.pageUrls.get(n) ?? null;
    const again = s.pageUrls.get(n);
    if (again) return again;
    const url = await stableUrl(blob);
    this.#rememberUrl(s, n, url);
    return url;
  }

  /**
   * Object URL over one page's raster.
   * The raster is this session's, else the stored one, else a render through the pixel source.
   * With `persist`, a page rendered here is also stored, as a page the reader viewed, while the raster budget allows.
   * @param {DocRef} ref
   * @param {number} n
   * @param {boolean} persist
   * @returns {Promise<?string>}
   */
  raster(ref, n, persist) {
    const s = this.session(ref.hash);
    const store = this.store;
    const storeBlob = (/** @type {Blob} */ blob) => {
      if (!store || (store.rasterBytes !== null && store.rasterBytes > store.rasterBudget)) return;
      s.pageBlobs.delete(n);
      this.writeQueue = this.writeQueue.then(async () => {
        if (this.store !== store) return;
        await store.writePageRaster(ref.hash, n, blob);
        (await s.storedPages)?.add(n);
      }).catch(() => {});
    };
    const cached = s.pageUrls.get(n);
    if (cached) {
      const unstored = s.pageBlobs.get(n);
      if (persist && unstored) storeBlob(unstored);
      return Promise.resolve(cached);
    }
    const pending = s.rasterPending.get(n);
    if (pending) return pending;
    const p = (async () => {
      const stored = await this.pageImage(ref.hash, n);
      if (stored) return stored;
      const doc = await this.pixels(ref);
      const blob = await renderPageRaster(doc, n);
      if (!blob) return null;
      const again = s.pageUrls.get(n);
      if (again) return again;
      const url = URL.createObjectURL(blob);
      this.#rememberUrl(s, n, url);
      if (persist) storeBlob(blob);
      else s.pageBlobs.set(n, blob);
      return url;
    })().catch(() => null);
    s.rasterPending.set(n, p);
    p.finally(() => {
      if (s.rasterPending.get(n) === p) s.rasterPending.delete(n);
    });
    return p;
  }

  /**
   * Store page `n`'s raster cut from a display render at least as wide, so a page the reader viewed is stored without a second render.
   * The bitmap is drawn before this returns, since it may be closed afterwards, and encoded asynchronously: lossless, or lossy when the lossless encoding passes the cap.
   * A narrower render falls back to a render in the store lane.
   * @param {DocRef} ref
   * @param {number} n
   * @param {ImageBitmap} bitmap
   * @returns {Promise<void>}
   */
  async storeFromBitmap(ref, n, bitmap) {
    const s = this.session(ref.hash);
    const store = this.store;
    if (!store || s.pageUrls.has(n) || s.rasterPending.has(n)) return;
    if (bitmap.width < PAGE_RASTER_WIDTH || typeof OffscreenCanvas === 'undefined') {
      await this.raster(ref, n, true);
      return;
    }
    const canvas = new OffscreenCanvas(PAGE_RASTER_WIDTH, Math.max(1, Math.round(PAGE_RASTER_WIDTH * (bitmap.height / bitmap.width))));
    const ctx = /** @type {OffscreenCanvasRenderingContext2D} */ (canvas.getContext('2d'));
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const p = (async () => {
      let blob = await canvas.convertToBlob({ type: 'image/webp', quality: 1.0 });
      if (blob.size > RASTER_LOSSLESS_CAP) blob = await canvas.convertToBlob({ type: 'image/webp', quality: RASTER_LOSSY_QUALITY });
      if (s.pageUrls.has(n)) return s.pageUrls.get(n) ?? null;
      const url = URL.createObjectURL(blob);
      this.#rememberUrl(s, n, url);
      if (store.rasterBytes !== null && store.rasterBytes > store.rasterBudget) {
        s.pageBlobs.set(n, blob);
        return url;
      }
      this.writeQueue = this.writeQueue.then(async () => {
        if (this.store !== store) return;
        await store.writePageRaster(ref.hash, n, blob);
        (await s.storedPages)?.add(n);
      }).catch(() => {});
      return url;
    })().catch(() => null);
    s.rasterPending.set(n, p);
    p.finally(() => {
      if (s.rasterPending.get(n) === p) s.rasterPending.delete(n);
    });
    await p;
  }

  /**
   * Cache a page-image object URL, revoking the oldest past the cap.
   * @param {DocSession} s
   * @param {number} n
   * @param {string} url
   */
  #rememberUrl(s, n, url) {
    s.pageUrls.set(n, url);
    for (const listener of this.rasterListeners) listener(s.hash, n);
    this.urlOrder.push({ session: s, n });
    while (this.urlOrder.length > MAX_PAGE_URLS) {
      const old = /** @type {{session: DocSession, n: number}} */ (this.urlOrder.shift());
      const oldUrl = old.session.pageUrls.get(old.n);
      if (oldUrl) {
        URL.revokeObjectURL(oldUrl);
        old.session.pageUrls.delete(old.n);
        old.session.pageBlobs.delete(old.n);
      }
    }
  }

  /**
   * Clear a store's page previews, and the sessions' record of which pages have one.
   * @param {import('./libraryStore.js').LibraryStore} store
   * @returns {Promise<void>}
   */
  clearPreviews(store) {
    // The clear takes its turn in the write queue, so a write queued before it cannot put its file back afterwards.
    const cleared = this.writeQueue.then(async () => {
      await store.clearPreviews();
      if (this.store !== store) return;
      for (const s of [...this.map.values()]) {
        s.storedPages = null;
        (await s.storedThumbs)?.clear();
      }
    });
    this.writeQueue = cleared.catch(() => {});
    return cleared;
  }

  /**
   * Drop everything cached for one document but its cover.
   * Call when its content or stored artifacts changed.
   * @param {string} hash
   */
  invalidate(hash) {
    const s = this.map.get(hash);
    if (!s) return;
    if (s.liveDoc) s.liveDoc.close().catch(() => {});
    closePixels(s);
    for (const url of s.pageUrls.values()) URL.revokeObjectURL(url);
    this.map.delete(hash);
    if (s.coverUrl === null && s.coverPromise === null) return;
    // Cards on screen show the cover, so it stays until `setCover` replaces it.
    const kept = new DocSession(hash);
    kept.coverUrl = s.coverUrl;
    kept.coverPromise = s.coverPromise;
    this.map.set(hash, kept);
  }

  /** Close every pooled document and revoke every URL. */
  reset() {
    for (const s of this.map.values()) {
      if (s.liveDoc) s.liveDoc.close().catch(() => {});
      closePixels(s);
      for (const url of s.pageUrls.values()) URL.revokeObjectURL(url);
      if (s.coverUrl) URL.revokeObjectURL(s.coverUrl);
    }
    this.map.clear();
    this.urlOrder.length = 0;
  }

  /** @param {?DocSession} keep - The session that must survive this pass. */
  #evictPixels(keep) {
    const open = [...this.map.values()].filter((s) => s.pixelsPromise && s !== keep);
    open.sort((a, b) => a.pixelsUse - b.pixelsUse);
    let excess = open.length - (MAX_PIXEL_SOURCES - 1);
    for (const s of open) {
      if (excess <= 0) break;
      // A still-opening source waits for a later pass.
      if (!s.pixelsDoc) continue;
      const sched = s.pixelsDoc.images.pdfScheduler;
      if (sched?.busy) {
        // Closing a source drops the renders queued on it, so a busy one closes once its running jobs settle, if the pool is still over its cap then.
        if (!s.closeWhenIdle) {
          s.closeWhenIdle = true;
          sched.onIdle(() => {
            s.closeWhenIdle = false;
            this.#evictPixels(null);
          });
        }
        continue;
      }
      closePixels(s);
      excess -= 1;
    }
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
