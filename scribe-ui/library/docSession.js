// Per-document sessions for the library: one owner for the in-memory state of each content hash.
// Persistent artifacts stay in LibraryStore, so a surface rebuild never discards live documents, parsed sidecar pages, or decoded image URLs.

/** How many idle live documents the pool keeps open before evicting the least recently used. */
const MAX_IDLE_LIVE = 2;
/** How many parsed sidecar pages stay cached across all sessions. Must comfortably exceed one read-ahead window. */
const MAX_SIDECAR_PAGES = 64;
/**
 * Decompressed character cap for parsing a single-JSON sidecar whole.
 * Documents past it yield no sidecar data rather than a renderer-sized JSON graph.
 */
const SIDECAR_JSON_CHAR_LIMIT = 64 * 1024 * 1024;
/** How many page-image object URLs stay alive across all sessions. */
const MAX_PAGE_URLS = 400;

/**
 * An object URL over a copy of `blob`'s bytes.
 * A `File` read from OPFS can lose its backing store later, which kills object URLs made directly from it.
 * @param {Blob} blob
 * @returns {Promise<string>}
 */
const stableUrl = async (blob) => URL.createObjectURL(new Blob([await blob.arrayBuffer()], { type: blob.type }));

class DocSession {
  /** @param {string} hash */
  constructor(hash) {
    this.hash = hash;
    this.lastUse = 0;
    /** @type {?Promise<import('../../js/containers/scribeDoc.js').ScribeDoc>} */
    this.livePromise = null;
    /** @type {?import('../../js/containers/scribeDoc.js').ScribeDoc} Resolved pool document, null while loading or absent. */
    this.liveDoc = null;
    /** @type {Map<number, {ocr: ?Object, annotations: ?Array<Object>}>} */
    this.sidecarPages = new Map();
    /** @type {?Promise<void>} Tail of the serialized sidecar-read chain, so concurrent page requests share one pass. */
    this.sidecarPass = null;
    /** Bumped when the stored sidecar changes, so an in-flight pass never caches stale pages. */
    this.sidecarEpoch = 0;
    /** Whether the stored sidecar was missing or unparseable. */
    this.sidecarBroken = false;
    /** Whether the sidecar's single-JSON form exceeds the parse budget. */
    this.sidecarTooBig = false;
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
    /** @type {Array<{session: DocSession, n: number}>} Sidecar-page cache order, oldest first. */
    this.sidecarPageOrder = [];
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
   * Parsed sidecar content for selected pages: raw OCR page objects and annotation arrays, for seeds, previews, and match marks.
   * Requesting pages one at a time is cheap, since misses are batched into a streaming read that never retains a whole-document sidecar graph.
   * A page with no readable sidecar data is absent from the result.
   * @param {string} hash
   * @param {number[]} pageNs
   * @returns {Promise<Map<number, {ocr: ?Object, annotations: ?Array<Object>}>>}
   */
  async sidecarPages(hash, pageNs) {
    const s = this.session(hash);
    /** @type {Map<number, {ocr: ?Object, annotations: ?Array<Object>}>} */
    const result = new Map();
    /** @type {number[]} */
    let missing = [];
    const collect = () => {
      missing = [];
      for (const n of pageNs) {
        if (result.has(n)) continue;
        const entry = s.sidecarPages.get(n);
        if (entry) result.set(n, entry);
        else missing.push(n);
      }
    };
    collect();
    if (!missing.length || s.sidecarBroken || s.sidecarTooBig || !this.store) return result;
    const pass = (s.sidecarPass || Promise.resolve()).then(async () => {
      collect();
      if (!missing.length || s.sidecarBroken || s.sidecarTooBig) return;
      // A pass costs a full decompression however few pages it keeps, so each miss drags a read-ahead window into the same pass.
      // Large batches already amortize that cost, so they are not padded.
      let wanted = missing;
      if (missing.length <= 8) {
        const padded = new Set();
        for (const n of missing) for (let k = Math.max(0, n - 2); k <= n + 29; k++) padded.add(k);
        if (padded.size <= 48) wanted = [...padded];
      }
      const epoch = s.sidecarEpoch;
      /** @type {?ReadableStreamDefaultReader<Uint8Array>} */
      let reader = null;
      /** @type {Map<number, {ocr: ?Object, annotations: ?Array<Object>}>} */
      const found = new Map();
      try {
        const data = this.store ? await this.store.readSidecar(s.hash) : null;
        if (!data) {
          s.sidecarBroken = true;
          return;
        }
        const bytes = new Uint8Array(data);
        const isGzipped = bytes[0] === 0x1F && bytes[1] === 0x8B;
        let stream = new Blob([bytes]).stream();
        if (isGzipped) stream = stream.pipeThrough(new DecompressionStream('gzip'));
        reader = stream.getReader();
        const decoder = new TextDecoder('utf-8');

        const SEG_SNIFF = '{"scribeSegments"';
        let buf = '';
        let part = await reader.read();
        while (!part.done && buf.length < SEG_SNIFF.length) {
          buf += decoder.decode(part.value, { stream: true });
          part = await reader.read();
        }

        if (buf.startsWith(SEG_SNIFF)) {
          // Segmented layout: a header line of doc-level fields (annotations included), then one JSON record per page.
          const want = new Set(wanted);
          /** @type {?Array<Array<Object>>} */
          let headerAnnots = null;
          let gotHeader = false;
          /** @type {string[]} Decoded text since the last completed line. */
          let pending = [];
          /** @param {string} line */
          const feedLine = (line) => {
            if (!gotHeader) {
              gotHeader = true;
              const header = line ? JSON.parse(line) : {};
              headerAnnots = Array.isArray(header.annotations) ? header.annotations : null;
              // Read-ahead can pad past the last page, and those pages are never found, so the read would run to the end of the file waiting for them.
              if (Number.isInteger(header.pageCount)) {
                for (const p of [...want]) if (p >= header.pageCount) want.delete(p);
              }
              return;
            }
            const m = /^\{"i":(\d+)[,}]/.exec(line);
            if (!m || !want.has(+m[1])) return;
            const rec = JSON.parse(line);
            found.set(rec.i, { ocr: rec.ocr ?? null, annotations: null });
            want.delete(rec.i);
          };
          // Lines are page-sized while chunks are small, so concatenating per chunk re-copies each line once per chunk, which is quadratic.
          let pendingLen = 0;
          /** @param {string} chunk */
          const feedText = (chunk) => {
            pending.push(chunk);
            pendingLen += chunk.length;
            if (pendingLen > SIDECAR_JSON_CHAR_LIMIT) throw new Error('Sidecar record exceeds the parse budget.');
            if (!chunk.includes('\n')) return;
            const lines = pending.join('').split('\n');
            pending = [lines.pop() ?? ''];
            pendingLen = pending[0].length;
            for (const line of lines) feedLine(line);
          };
          feedText(buf);
          while (!part.done && (!gotHeader || want.size)) {
            feedText(decoder.decode(part.value, { stream: true }));
            part = await reader.read();
          }
          if (part.done) {
            pending.push(decoder.decode());
            const tail = pending.join('');
            if (tail) feedLine(tail);
          }
          for (const n of wanted) {
            const entry = found.get(n) || { ocr: null, annotations: null };
            entry.annotations = headerAnnots?.[n] ?? null;
            found.set(n, entry);
          }
        } else {
          // The single-JSON layout has no per-page boundaries, so the whole graph must be parsed and then dropped once the wanted pages are plucked.
          const parts = [buf];
          let total = buf.length;
          while (total <= SIDECAR_JSON_CHAR_LIMIT && !part.done) {
            const chunk = decoder.decode(part.value, { stream: true });
            total += chunk.length;
            parts.push(chunk);
            part = await reader.read();
          }
          if (total > SIDECAR_JSON_CHAR_LIMIT) {
            s.sidecarTooBig = true;
            return;
          }
          parts.push(decoder.decode());
          const json = JSON.parse(parts.join(''));
          const ocrArr = Array.isArray(json.ocr) ? json.ocr : null;
          const annotsArr = Array.isArray(json.annotations) ? json.annotations : null;
          for (const n of wanted) found.set(n, { ocr: ocrArr?.[n] ?? null, annotations: annotsArr?.[n] ?? null });
        }
      } catch {
        s.sidecarBroken = true;
        found.clear();
      } finally {
        reader?.cancel().catch(() => {});
      }
      if (s.sidecarEpoch === epoch) {
        for (const [n, entry] of found) {
          if (!s.sidecarPages.has(n)) {
            this.sidecarPageOrder.push({ session: s, n });
            while (this.sidecarPageOrder.length > MAX_SIDECAR_PAGES) {
              const old = /** @type {{session: DocSession, n: number}} */ (this.sidecarPageOrder.shift());
              old.session.sidecarPages.delete(old.n);
            }
          }
          s.sidecarPages.set(n, entry);
        }
      }
      for (const [n, entry] of found) result.set(n, entry);
    });
    s.sidecarPass = pass.then(() => {}, () => {});
    await pass;
    collect();
    return result;
  }

  /**
   * Drop the cached sidecar parse.
   * Call after writing a new sidecar so the next read sees it.
   * @param {string} hash
   */
  dropSidecar(hash) {
    const s = this.map.get(hash);
    if (!s) return;
    s.sidecarPages.clear();
    s.sidecarEpoch++;
    s.sidecarBroken = false;
    s.sidecarTooBig = false;
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
    this.#rememberUrl(s, n, url);
    return url;
  }

  /**
   * Cache a freshly rendered page image so it serves like a stored raster, without writing it to disk.
   * For documents measured too fast to keep rasters stored, where a search-hit row still needs its image.
   * @param {string} hash
   * @param {number} n
   * @param {Blob} blob
   */
  adoptPageImage(hash, n, blob) {
    const s = this.session(hash);
    if (s.pageUrls.has(n)) return;
    this.#rememberUrl(s, n, URL.createObjectURL(blob));
  }

  /**
   * Cache a page-image object URL, revoking the oldest past the cap.
   * @param {DocSession} s
   * @param {number} n
   * @param {string} url
   */
  #rememberUrl(s, n, url) {
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
    this.sidecarPageOrder.length = 0;
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
