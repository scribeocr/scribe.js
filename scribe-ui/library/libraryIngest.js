import scribeLib from '../../scribe.js';
import { openDocumentFromFile } from '../js/controls/tools.js';

const THUMB_WIDTH = 300;
/** Stored page rasters stand in for the live preview, so they need its pane width rather than thumbnail width. */
export const PAGE_RASTER_WIDTH = 900;
/** How many of the most recently added documents the warm lane cushions, and how many leading pages each gets. */
export const CUSHION_DOCS = 150;
export const CUSHION_PAGES = 3;
/**
 * First-paint cost (structural open plus first-page render, ms) at or above which a document's page rasters are stored.
 * A document that paints faster than this gains nothing from a stored stand-in.
 */
export const RASTER_STORE_MIN_MS = 500;
/**
 * Sidecar and PDF sizes past which no speculative import runs.
 * The results warmer leaves the hit row blank, and the preview pane waits for an explicit Open.
 * The PDF cap admits 500+ page books, which run 25-45MB and top the ranking for generic queries.
 */
export const WARM_SIDECAR_LIMIT = 16 * 1024 * 1024;
export const WARM_PDF_LIMIT = 64 * 1024 * 1024;
/** WebP quality for pages routed lossy. In Chromium, quality 1.0 switches the encoder to lossless, so 0.9 is the top lossy setting. */
const RASTER_LOSSY_QUALITY = 0.9;
/**
 * Byte cap for a lossless page raster. A page past it re-encodes lossy.
 * Catches gradient-heavy synthetic pages, which the geometry rule cannot see.
 */
const RASTER_LOSSLESS_CAP = 250 * 1024;
/** Page-area fraction covered by a single image at or above which a page's raster encodes lossy. */
const RASTER_LOSSY_IMAGE_FRAC = 0.2;
/** Ingest timeout, so one pathological file cannot wedge the queue forever. */
const DOC_TIMEOUT_MS = 240 * 1000;

/**
 * Render one page's stored raster, a 900px WebP.
 * Synthetic pages (text, vector art) encode lossless, photographic ones lossy.
 * @param {import('../../js/containers/scribeDoc.js').ScribeDoc} doc
 * @param {number} n
 * @returns {Promise<?Blob>} The encoded raster, or null when the page cannot be rendered.
 */
export const renderPageRaster = async (doc, n) => {
  const stats = doc.inputData.pageStats?.[n];
  // Image-coverage geometry rather than readable-text detection, because what makes lossless win is a synthetic render.
  // A Type3 or outline-text page has no readable characters yet encodes like a text page.
  // Unknown geometry routes lossy, whose error costs only status-quo quality, where lossless on a photograph costs several times the bytes.
  const lossy = !stats || stats.largestImageFrac >= RASTER_LOSSY_IMAGE_FRAC;
  const blob = await doc.images.renderThumbnail(n, PAGE_RASTER_WIDTH, lossy ? RASTER_LOSSY_QUALITY : 1.0, true, 'webp');
  if (blob && !lossy && blob.size > RASTER_LOSSLESS_CAP) {
    return (await doc.images.renderThumbnail(n, PAGE_RASTER_WIDTH, RASTER_LOSSY_QUALITY, true, 'webp')) ?? blob;
  }
  return blob;
};

/** @param {ArrayBuffer} buf @returns {Promise<string>} First 16 hex chars of SHA-256. */
const hashBytes = async (buf) => {
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(digest, 0, 8)].map((b) => b.toString(16).padStart(2, '0')).join('');
};

export class LibraryIngest {
  /**
   * @param {import('./libraryStore.js').LibraryStore} store
   * @param {import('./libraryStore.js').LibraryManifest} manifest - Shared with the caller and mutated in place.
   * @param {import('./librarySearch.js').LibraryIndex} index
   * @param {Object} [callbacks]
   * @param {(state: {done: number, total: number, current: string}) => void} [callbacks.onProgress]
   * @param {(relPath: string) => void} [callbacks.onDocDone] - Fires after a document reaches a terminal status.
   * @param {() => boolean} [callbacks.warmGate] - Permission check for speculative warm-lane work.
   *    Omitting it disables warm work entirely.
   */
  constructor(store, manifest, index, { onProgress, onDocDone, warmGate } = {}) {
    this.store = store;
    this.manifest = manifest;
    this.index = index;
    this.onProgress = onProgress;
    this.onDocDone = onDocDone;
    this.warmGate = warmGate || null;
    /** @type {Array<{relPath: string, kind: 'ingest'|'verify'}>} Explicit user requests. Always drained first. */
    this.userLane = [];
    /** @type {Array<{relPath: string, kind: 'ingest'|'verify'|'upgrade'}>} Scan-discovered work. */
    this.discoveryLane = [];
    /**
     * Cushion candidates for the warm lane.
     * Null means the plan is stale and is rebuilt when the other lanes drain.
     * An empty array means there is nothing left to cushion.
     * @type {?Array<{relPath: string, hash: string, pages: number}>}
     */
    this.warmLane = null;
    this.running = false;
    this.done = 0;
    /** @type {number} Pages rendered by the warm lane since construction, for the gate's session cap. */
    this.warmPagesDone = 0;
    /** Keeps warm work off after a cancel, since an enqueue resets the plan and would otherwise revive it. */
    this.warmCancelled = false;
    /** When set, start() stops draining after the in-flight task, so a folder operation can run against a quiet queue. */
    this.paused = false;
    /** @type {?{relPath: string, kind: 'ingest'|'verify'|'upgrade'}} */
    this.current = null;
  }

  /**
   * Diff the folder against the manifest, queueing the work that new, vanished, and changed files imply.
   * An entry left `pending` by an interrupted ingest re-enqueues here, which is what makes the queue resumable across reloads.
   */
  async scan() {
    const seen = new Set();
    const dirs = [];
    const others = [];
    for await (const f of this.store.listFiles()) {
      if (f.kind === 'dir') {
        dirs.push(f.relPath);
        continue;
      }
      if (f.kind === 'other') {
        others.push(f.relPath);
        continue;
      }
      seen.add(f.relPath);
      const entry = this.manifest.docs[f.relPath];
      if (!entry) {
        this.manifest.docs[f.relPath] = {
          hash: '',
          size: f.size,
          mtime: f.mtime,
          pageCount: 0,
          added: Date.now(),
          lastOpened: 0,
          status: 'pending',
          requiresOCR: false,
        };
        this.discoveryLane.push({ relPath: f.relPath, kind: 'ingest' });
      } else if (entry.status === 'pending') {
        this.discoveryLane.push({ relPath: f.relPath, kind: 'ingest' });
      } else if (entry.status === 'missing') {
        // The file is back at its old path.
        entry.status = entry.hash ? 'indexed' : 'pending';
        this.discoveryLane.push({ relPath: f.relPath, kind: entry.hash ? 'verify' : 'ingest' });
      } else if (entry.status === 'error' && entry.errorKind === 'interrupted' && !entry.retried) {
        // A crash or timeout is worth one automatic retry.
        // A deterministic parse failure would just fail again.
        entry.retried = true;
        entry.status = 'pending';
        this.discoveryLane.push({ relPath: f.relPath, kind: 'ingest' });
      } else if (entry.size !== f.size || entry.mtime !== f.mtime) {
        this.discoveryLane.push({ relPath: f.relPath, kind: 'verify' });
      } else if (entry.status === 'indexed' && !entry.pageDims) {
        this.discoveryLane.push({ relPath: f.relPath, kind: 'upgrade' });
      }
    }
    for (const [relPath, entry] of Object.entries(this.manifest.docs)) {
      if (!seen.has(relPath) && entry.status !== 'missing') entry.status = 'missing';
    }
    this.manifest.dirs = dirs.sort();
    this.manifest.others = others.sort();
    await this.store.writeManifest(this.manifest);
    this.warmLane = null;
    this.warmCancelled = false;
    this.store.sweepArtifacts(this.manifest).catch(() => {});
  }

  /**
   * Queue one document for (re-)ingest, creating or resetting its manifest entry.
   * Goes to the user lane, ahead of any scan-discovered backlog.
   * @param {string} relPath
   * @param {{size?: number, mtime?: number}} [info]
   */
  async enqueue(relPath, info = {}) {
    const existing = this.manifest.docs[relPath];
    this.manifest.docs[relPath] = {
      hash: existing?.hash || '',
      size: info.size ?? existing?.size ?? 0,
      mtime: info.mtime ?? existing?.mtime ?? 0,
      pageCount: existing?.pageCount ?? 0,
      added: existing?.added ?? Date.now(),
      lastOpened: existing?.lastOpened ?? 0,
      status: 'pending',
      requiresOCR: existing?.requiresOCR ?? false,
    };
    await this.store.writeManifest(this.manifest);
    this.userLane.push({ relPath, kind: 'ingest' });
    this.warmLane = null;
  }

  /**
   * Discard every queued lane.
   * The document already in flight still finishes.
   */
  cancel() {
    this.userLane.length = 0;
    this.discoveryLane.length = 0;
    this.warmLane = [];
    this.warmCancelled = true;
    this.done = 0;
  }

  /**
   * Re-key queued work after an in-app directory rename, so pending tasks follow their files.
   * The in-flight task raced the disk move, so it is requeued at its new path in case its read failed.
   * @param {string} oldDir
   * @param {string} newDir
   */
  renameDirPrefix(oldDir, newDir) {
    const oldPrefix = `${oldDir}/`;
    /** @param {string} p */
    const rekey = (p) => (p.startsWith(oldPrefix) ? newDir + p.slice(oldDir.length) : p);
    for (const t of this.userLane) t.relPath = rekey(t.relPath);
    for (const t of this.discoveryLane) t.relPath = rekey(t.relPath);
    this.warmLane = null;
    if (this.current && rekey(this.current.relPath) !== this.current.relPath) {
      this.discoveryLane.unshift({ relPath: rekey(this.current.relPath), kind: this.current.kind });
    }
  }

  /**
   * Process the lanes serially: user, then discovery, then warm.
   * Safe to call when already running.
   */
  async start() {
    if (this.running || this.paused) return;
    this.running = true;
    let manifestPending = false;
    let manifestWrittenAt = 0;
    try {
      let idle = false;
      while (!idle) {
        if (this.paused) break;
        const task = this.userLane.shift() || this.discoveryLane.shift();
        if (task) {
          this.current = task;
          this.done++;
          this.onProgress?.({ done: this.done, total: this.done + this.userLane.length + this.discoveryLane.length, current: task.relPath });
          if (task.kind === 'verify') await this._verify(task.relPath);
          else if (task.kind === 'upgrade') await this._upgrade(task.relPath);
          else await this._ingest(task.relPath);
          // The manifest is rewritten whole, so writing it per document would cost O(n^2) over a large folder.
          manifestPending = true;
          if (Date.now() - manifestWrittenAt > 1000) {
            manifestWrittenAt = Date.now();
            manifestPending = false;
            await this.store.writeManifest(this.manifest);
          }
          this.onDocDone?.(task.relPath);
          this.current = null;
          continue;
        }
        if (manifestPending && Date.now() - manifestWrittenAt > 1000) {
          manifestWrittenAt = Date.now();
          manifestPending = false;
          await this.store.writeManifest(this.manifest);
        }
        // Warm rounds record `firstPaintMs` measurements on entries, so they mark the manifest dirty too.
        const warmed = await this._warmNext();
        if (warmed) manifestPending = true;
        idle = !warmed;
      }
    } finally {
      this.running = false;
      this.current = null;
      if (manifestPending) await this.store.writeManifest(this.manifest).catch(() => {});
      this.onProgress?.({ done: this.done, total: this.done + this.userLane.length + this.discoveryLane.length, current: '' });
      this.done = 0;
    }
  }

  /**
   * Re-hash a document whose size or mtime drifted.
   * New content is badged `changed` rather than re-ingested, so the sidecar's user edits survive until the user asks for a re-index.
   * @param {string} relPath
   */
  async _verify(relPath) {
    const entry = this.manifest.docs[relPath];
    if (!entry) return;
    try {
      const file = await this.store.readFile(relPath);
      const hash = await hashBytes(await file.arrayBuffer());
      entry.size = file.size;
      entry.mtime = file.lastModified;
      entry.status = hash === entry.hash ? 'indexed' : 'changed';
    } catch {
      entry.status = 'missing';
    }
  }

  /**
   * Backfill the per-page dims for a legacy entry that predates them, so it can open provisionally.
   * The sidecar, text cache, and search index may hold later user edits, so they are never touched here.
   * @param {string} relPath
   */
  async _upgrade(relPath) {
    const entry = this.manifest.docs[relPath];
    if (!entry || !entry.hash || entry.pageDims) return;
    /** @type {?import('../../js/containers/scribeDoc.js').ScribeDoc} */
    let doc = null;
    try {
      const files = [await this.store.readFile(relPath)];
      const sidecar = await this.store.readSidecar(entry.hash);
      if (sidecar) files.push(new File([sidecar], `${entry.hash}.scribe`));
      doc = await scribeLib.openDocument(files, { skipFontOpt: true, pdfWorkerN: 1 });
      entry.pageDims = doc.pageMetrics.map((pm) => [
        Math.round(pm.dims.width * 100) / 100, Math.round(pm.dims.height * 100) / 100, pm.rotation || 0,
      ]);
    } catch { /* The next scan retries. */
    } finally {
      await doc?.close();
    }
  }

  /** @param {string} relPath */
  async _ingest(relPath) {
    const entry = this.manifest.docs[relPath];
    if (!entry) return;
    /** @type {?import('../../js/containers/scribeDoc.js').ScribeDoc} */
    let doc = null;
    /** @type {?number} */
    let timer = null;
    try {
      const result = await Promise.race([
        (async () => {
          const file = await this.store.readFile(relPath);
          const buf = await file.arrayBuffer();
          const hash = await hashBytes(buf);
          entry.size = file.size;
          entry.mtime = file.lastModified;

          // A missing entry with this hash means the file moved rather than arrived, so its record and data files carry over.
          for (const [oldPath, oldEntry] of Object.entries(this.manifest.docs)) {
            if (oldPath !== relPath && oldEntry.hash === hash && oldEntry.status === 'missing') {
              this.manifest.docs[relPath] = {
                ...oldEntry, size: file.size, mtime: file.lastModified, status: 'indexed',
              };
              delete this.manifest.docs[oldPath];
              return null;
            }
          }

          // The hashed buffer doubles as the import input, so the file's bytes are read and held once.
          doc = await openDocumentFromFile(buf, { skipFontOpt: true });
          entry.hash = hash;
          entry.pageCount = doc.inputData.pageCount;
          entry.requiresOCR = !!doc.inputData.requiresOCR;
          entry.pageDims = doc.pageMetrics.map((pm) => [
            Math.round(pm.dims.width * 100) / 100, Math.round(pm.dims.height * 100) / 100, pm.rotation || 0,
          ]);

          const pagesText = (doc.ocr.active || []).map((page) => (page ? scribeLib.utils.ocr.getPageText(page) : ''));
          await this.store.writeTextCache(hash, pagesText.join('\f'));
          try {
            const thumb = await doc.images.renderThumbnail(0, THUMB_WIDTH);
            if (thumb) await this.store.writeThumb(hash, thumb);
          } catch { /* A failed thumbnail leaves a blank card. */ }
          // Sidecars are this application's own session store, so app-side state such as pending text edits belongs in them.
          // Per-character boxes are half a sidecar's bytes, so they are dropped here.
          // A document reopened from its sidecar has word boxes only.
          try {
            await this.store.writeSidecar(hash, await doc.exportData('scribe', { scribeSession: true, includeCharBoxesScribe: false }));
            delete entry.sidecarError;
          } catch (err) {
            // A document without a sidecar still indexes and reopens from its source file, losing only saved session state.
            entry.sidecarError = err instanceof Error ? err.message : String(err);
          }
          return { hash, pagesText };
        })(),
        new Promise((resolve, reject) => {
          timer = setTimeout(() => {
            const err = new Error(`Timed out after ${Math.round(DOC_TIMEOUT_MS / 1000)}s.`);
            err.name = 'IngestTimeoutError';
            reject(err);
          }, DOC_TIMEOUT_MS);
        }),
      ]);
      if (result) this.index.addDoc(result.hash, result.pagesText);
      entry.status = 'indexed';
      delete entry.error;
      delete entry.errorKind;
      delete entry.retried;
    } catch (err) {
      entry.status = 'error';
      entry.error = err instanceof Error ? err.message : String(err);
      const name = err instanceof Error ? err.name : '';
      entry.errorKind = (name === 'WorkerCrashError' || name === 'IngestTimeoutError') ? 'interrupted' : 'parse';
    } finally {
      if (timer !== null) clearTimeout(timer);
      await doc?.close();
    }
  }

  /**
   * Render the first-open cushion for one recently added document, if the gate and budget allow.
   * One document per call, so the lanes and the gate are re-checked between documents.
   * Doubles as the measurement pass, recording `firstPaintMs` and storing the rendered pages only when it clears the store gate.
   * @returns {Promise<boolean>} Whether a document was processed. False ends the run.
   */
  async _warmNext() {
    if (this.warmCancelled || !this.warmGate || !this.warmGate()) return false;
    if (this.warmLane === null) {
      this.warmLane = Object.entries(this.manifest.docs)
        .filter(([, e]) => e.status === 'indexed' && e.hash && e.pageDims && e.pageCount > 0)
        .sort((a, b) => b[1].added - a[1].added)
        .slice(0, CUSHION_DOCS)
        .map(([relPath, e]) => ({ relPath, hash: e.hash, pages: Math.min(CUSHION_PAGES, e.pageCount) }));
    }
    while (this.warmLane.length) {
      const cand = /** @type {{relPath: string, hash: string, pages: number}} */ (this.warmLane.shift());
      const entry = this.manifest.docs[cand.relPath];
      if (!entry || entry.status !== 'indexed' || entry.hash !== cand.hash) continue;
      // Skipped rather than re-measured, so a fast document does not spend a render on every warm pass.
      if (entry.firstPaintMs !== undefined && entry.firstPaintMs < RASTER_STORE_MIN_MS) continue;
      if (this.store.rasterBytes !== null && this.store.rasterBytes > this.store.rasterBudget) return false;
      if (await this.store.readPageRaster(cand.hash, 0)) continue;
      /** @type {?import('../../js/containers/scribeDoc.js').ScribeDoc} */
      let doc = null;
      try {
        const t0 = performance.now();
        const files = [await this.store.readFile(cand.relPath)];
        const sidecar = await this.store.readSidecar(cand.hash);
        if (sidecar) files.push(new File([sidecar], `${cand.hash}.scribe`));
        // Skipping text extraction is safe here because the sidecar already carries this document's text.
        doc = await scribeLib.openDocument(files, { deferText: true, skipFontOpt: true, pdfWorkerN: 1 });
        // This read, open, and render are the same sequence a preview of this document would pay, so they double as the measurement.
        const raster0 = await renderPageRaster(doc, 0).catch(() => null);
        this.warmPagesDone++;
        const firstPaintMs = Math.round(performance.now() - t0);
        if (raster0) {
          entry.firstPaintMs = firstPaintMs;
          if (firstPaintMs < RASTER_STORE_MIN_MS) return true;
          await this.store.writePageRaster(cand.hash, 0, raster0);
        }
        // A failed page-0 render falls through here unmeasured, so the document is treated as slow rather than recorded fast.
        for (let n = 1; n < cand.pages; n++) {
          const raster = await renderPageRaster(doc, n);
          this.warmPagesDone++;
          if (raster) await this.store.writePageRaster(cand.hash, n, raster);
        }
      } catch { /* Cushions are best-effort, so a failure leaves the document indexed. */
      } finally {
        await doc?.close();
      }
      return true;
    }
    return false;
  }
}
