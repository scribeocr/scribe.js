// Per-document sessions for the library: one owner for the in-memory state of each content hash.

import scribeLib from '../../scribe.js';
import { PageMetrics } from '../../js/objects/pageMetricsObjects.js';
import {
  renderPageRaster, PAGE_RASTER_WIDTH, RASTER_LOSSY_QUALITY, RASTER_LOSSLESS_CAP,
} from './libraryIngest.js';

/** How many idle live documents the pool keeps open before evicting the least recently used. */
const MAX_IDLE_LIVE = 2;
// A pixel source is cheap to reopen, 2 to 8 ms, so the pool is small.
const MAX_PIXEL_SOURCES = 3;
/** How long after a viewer's last focus call a pixel source counts as on screen, which keeps the pool's eviction off it. */
const FOCUS_PIN_MS = 30_000;
/** How many page-image object URLs stay alive across all sessions. */
const MAX_PAGE_URLS = 400;
const NO_TEXT = { native: { supp: false, main: false }, ocr: { supp: false, main: false } };

/**
 * @typedef {Object} NotesHeader
 * @property {Array<Array<Object>>} [annotations]
 * @property {Array<Object>} [outline]
 * @property {Array<number>} [pageRotations]
 * @property {{contentEdits?: Array<?Array<Object>>, pageSourceIndices?: Array<?number>}} [session]
 */

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
    /** @type {?Promise<?NotesHeader>} */
    this.headerPromise = null;
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
    /** When a viewer last told this session's pixel source which page it is on. */
    this.lastFocusAt = -Infinity;
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
    /** Stored-raster writes run one at a time: a write holds the directory a read of the same document waits on. */
    this.writeQueue = Promise.resolve();
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
   * The document-level blocks of the document's sidecar, or null when it has none saved.
   * Callers share one parsed object.
   * @param {string} hash
   * @returns {Promise<?NotesHeader>}
   */
  header(hash) {
    const s = this.session(hash);
    if (!s.headerPromise) {
      const store = this.store;
      if (!store) return Promise.resolve(null);
      const p = store.sidecarBlob(hash).then(async (blob) => {
        if (!blob) return null;
        const magic = new Uint8Array(await blob.slice(0, 2).arrayBuffer());
        let stream = blob.stream();
        if (magic[0] === 0x1F && magic[1] === 0x8B) stream = stream.pipeThrough(new DecompressionStream('gzip'));
        const reader = stream.getReader();
        /** @type {Uint8Array[]} */
        const chunks = [];
        let length = 0;
        let ended = false;
        // The sidecar's segmented form puts the document-level blocks on its first line, ahead of the page records.
        while (!ended) {
          const part = await reader.read();
          if (part.done) break;
          const nl = part.value.indexOf(0x0A);
          const piece = nl === -1 ? part.value : part.value.subarray(0, nl);
          chunks.push(piece);
          length += piece.length;
          ended = nl !== -1;
        }
        await reader.cancel().catch(() => {});
        const line = new Uint8Array(length);
        let at = 0;
        for (const c of chunks) {
          line.set(c, at);
          at += c.length;
        }
        return /** @type {NotesHeader} */ (JSON.parse(new TextDecoder().decode(line)));
      }).catch(() => null);
      s.headerPromise = p;
    }
    return s.headerPromise;
  }

  /**
   * Forget the parsed header and the pixel source built from it.
   * @param {string} hash
   */
  dropHeader(hash) {
    const s = this.map.get(hash);
    if (!s) return;
    s.headerPromise = null;
    closePixels(s);
  }

  /**
   * The document's pixel source: the PDF open in the worker with no text parse.
   * It shows the pages as the document's changes arrange them: their order and content edits.
   * The pixel source stays in the pool, so it is shared by every caller and closed by pool eviction.
   * @param {DocRef} ref
   * @returns {Promise<import('../../js/containers/scribeDoc.js').ScribeDoc>}
   */
  pixels(ref) {
    const s = this.session(ref.hash);
    s.pixelsUse = ++this.useTick;
    if (!s.pixelsPromise) {
      const store = this.store;
      if (!store) return Promise.reject(new Error('No library is open.'));
      const p = (async () => {
        const [file, header] = await Promise.all([store.readFile(ref.relPath), this.header(ref.hash)]);
        const doc = await scribeLib.openDocument([file], {
          usePDFText: NO_TEXT, keepPDFTextAlways: false, skipFontOpt: true, pdfWorkerN: 1,
        });
        const dims = ref.entry.pageDims;
        if (dims) {
          const sources = header?.session?.pageSourceIndices;
          const metrics = dims.map(([width, height], i) => {
            const pm = new PageMetrics({ width, height });
            pm.sourcePageN = sources?.[i] ?? i;
            return pm;
          });
          doc.pageMetrics.splice(0, doc.pageMetrics.length, ...metrics);
          doc.inputData.pageCount = metrics.length;
        }
        if (header?.session?.contentEdits) doc.contentEdits.pages = header.session.contentEdits;
        if (s.pixelsPromise === p) s.pixelsDoc = doc;
        else doc.close().catch(() => {});
        return doc;
      })();
      p.catch(() => {
        if (s.pixelsPromise === p) s.pixelsPromise = null;
      });
      s.pixelsPromise = p;
      this.#evictPixels(s);
    }
    return s.pixelsPromise;
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
   * One page rendered through the pixel source at `width` pixels.
   * The caller owns the bitmap.
   * @param {DocRef} ref
   * @param {number} n
   * @param {number} width
   * @param {import('../../tess/TessScheduler.js').Lane} [lane='display'] - A display render may be dropped when the viewer moves on, which resolves null.
   * @returns {Promise<?ImageBitmap>}
   */
  async renderAt(ref, n, width, lane = 'display') {
    const doc = await this.pixels(ref);
    const wrapper = await doc.images.renderViewerRaster(n, width, lane);
    return wrapper && typeof wrapper === 'object' && 'imageBitmap' in wrapper ? wrapper.imageBitmap : null;
  }

  /**
   * Tell the document's pixel source which page the viewer is on and which pages it still wants, so its staged display renders rank by the page and the rest are dropped.
   * A source focused recently is the one on screen, and the pool's eviction leaves it alone.
   * @param {DocRef} ref
   * @param {?number} n
   * @param {?Set<number>} keep
   */
  focus(ref, n, keep) {
    const s = this.map.get(ref.hash);
    if (!s) return;
    s.lastFocusAt = performance.now();
    s.pixelsDoc?.images.setViewerFocus(n, keep);
  }

  /**
   * Tell the document's pixel source which page the thumbnail rail is centered on.
   * @param {DocRef} ref
   * @param {?number} n
   */
  thumbFocus(ref, n) {
    this.map.get(ref.hash)?.pixelsDoc?.images.setThumbFocus(n);
  }

  /**
   * Set the workers the document's pixel source holds, as the viewer's tier for it changes.
   * @param {DocRef} ref
   * @param {number} n
   */
  async setWorkerTarget(ref, n) {
    const s = this.map.get(ref.hash);
    const doc = s?.pixelsDoc ?? (s?.pixelsPromise ? await s.pixelsPromise.catch(() => null) : null);
    if (doc && this.map.get(ref.hash)?.pixelsDoc === doc) await doc.images.setWorkerTarget(n);
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
   * Drop everything cached for one document.
   * Call when its content or stored artifacts changed.
   * @param {string} hash
   */
  invalidate(hash) {
    const s = this.map.get(hash);
    if (!s) return;
    if (s.liveDoc) s.liveDoc.close().catch(() => {});
    closePixels(s);
    for (const url of s.pageUrls.values()) URL.revokeObjectURL(url);
    if (s.coverUrl) URL.revokeObjectURL(s.coverUrl);
    this.map.delete(hash);
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
      // A source a viewer focused within the window is on screen, so it is never the victim.
      if (performance.now() - s.lastFocusAt < FOCUS_PIN_MS) continue;
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
