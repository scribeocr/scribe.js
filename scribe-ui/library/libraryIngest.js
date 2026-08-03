import scribeLib from '../../scribe.js';
import { openDocumentFromFile } from '../js/controls/tools.js';

const THUMB_WIDTH = 300;
/** Stored page rasters stand in for the live preview, so they need its pane width rather than thumbnail width. */
const PAGE_RASTER_WIDTH = 900;

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
   */
  constructor(store, manifest, index, { onProgress, onDocDone } = {}) {
    this.store = store;
    this.manifest = manifest;
    this.index = index;
    this.onProgress = onProgress;
    this.onDocDone = onDocDone;
    /** @type {Array<{relPath: string, kind: 'ingest'|'verify'|'upgrade'}>} */
    this.queue = [];
    this.running = false;
    this.cancelled = false;
    this.done = 0;
  }

  /**
   * Diff the folder against the manifest, queueing the work that new, vanished, and changed files imply.
   * An entry left `pending` by an interrupted ingest re-enqueues here, which is what makes the queue resumable across reloads.
   */
  async scan() {
    const seen = new Set();
    const dirs = [];
    for await (const f of this.store.listFiles()) {
      if (f.kind === 'dir') {
        dirs.push(f.relPath);
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
        this.queue.push({ relPath: f.relPath, kind: 'ingest' });
      } else if (entry.status === 'pending') {
        this.queue.push({ relPath: f.relPath, kind: 'ingest' });
      } else if (entry.status === 'missing') {
        // The file is back at its old path.
        entry.status = entry.hash ? 'indexed' : 'pending';
        this.queue.push({ relPath: f.relPath, kind: entry.hash ? 'verify' : 'ingest' });
      } else if (entry.size !== f.size || entry.mtime !== f.mtime) {
        this.queue.push({ relPath: f.relPath, kind: 'verify' });
      } else if (entry.status === 'indexed' && (!entry.pageDims || entry.pageRasterW !== PAGE_RASTER_WIDTH)) {
        this.queue.push({ relPath: f.relPath, kind: 'upgrade' });
      }
    }
    for (const [relPath, entry] of Object.entries(this.manifest.docs)) {
      if (!seen.has(relPath) && entry.status !== 'missing') entry.status = 'missing';
    }
    this.manifest.dirs = dirs.sort();
    await this.store.writeManifest(this.manifest);
  }

  /**
   * Queue one document for (re-)ingest, creating or resetting its manifest entry.
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
    this.queue.push({ relPath, kind: 'ingest' });
  }

  cancel() {
    this.cancelled = true;
  }

  /** Process the queue serially. Safe to call when already running. */
  async start() {
    if (this.running) return;
    this.running = true;
    this.cancelled = false;
    try {
      while (this.queue.length && !this.cancelled) {
        const task = /** @type {{relPath: string, kind: 'ingest'|'verify'|'upgrade'}} */ (this.queue.shift());
        this.done++;
        this.onProgress?.({ done: this.done, total: this.done + this.queue.length, current: task.relPath });
        if (task.kind === 'verify') await this._verify(task.relPath);
        else if (task.kind === 'upgrade') await this._upgrade(task.relPath);
        else await this._ingest(task.relPath);
        await this.store.writeManifest(this.manifest);
        this.onDocDone?.(task.relPath);
      }
    } finally {
      this.running = false;
      this.onProgress?.({ done: this.done, total: this.done + this.queue.length, current: '' });
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
   * Rebuild the per-page dims and page rasters for an entry that lacks them or has them at an older raster width.
   * The sidecar, text cache, and search index may hold later user edits, so they are never touched here.
   * The manifest fields are written last, so a rebuild that fails partway never advertises rasters that are not there.
   * @param {string} relPath
   */
  async _upgrade(relPath) {
    const entry = this.manifest.docs[relPath];
    if (!entry || !entry.hash || (entry.pageDims && entry.pageRasterW === PAGE_RASTER_WIDTH)) return;
    /** @type {?import('../../js/containers/scribeDoc.js').ScribeDoc} */
    let doc = null;
    try {
      doc = await openDocumentFromFile(await this.store.readFile(relPath));
      await this.store.deletePageRasters(entry.hash);
      for (let n = 0; n < doc.inputData.pageCount; n++) {
        try {
          const raster = await doc.images.renderThumbnail(n, PAGE_RASTER_WIDTH, 0.75, true);
          if (raster) await this.store.writePageRaster(entry.hash, n, raster);
        } catch { /* Skip this page's raster. */ }
      }
      entry.pageDims = doc.pageMetrics.map((pm) => [
        Math.round(pm.dims.width * 100) / 100, Math.round(pm.dims.height * 100) / 100, pm.rotation || 0,
      ]);
      entry.pageRasterW = PAGE_RASTER_WIDTH;
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
    try {
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
          return;
        }
      }

      doc = await openDocumentFromFile(file);
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
      // Per-page rasters let an open paint before the document has been imported.
      for (let n = 0; n < doc.inputData.pageCount; n++) {
        try {
          const raster = await doc.images.renderThumbnail(n, PAGE_RASTER_WIDTH, 0.75, true);
          if (raster) await this.store.writePageRaster(hash, n, raster);
        } catch { /* Skip this page's raster. */ }
      }
      entry.pageRasterW = PAGE_RASTER_WIDTH;
      // Sidecars are this application's own session store, so app-side state such as pending text edits belongs in them.
      await this.store.writeSidecar(hash, await doc.exportData('scribe', { scribeSession: true }));
      this.index.addDoc(hash, pagesText);
      entry.status = 'indexed';
      delete entry.error;
    } catch (err) {
      entry.status = 'error';
      entry.error = err instanceof Error ? err.message : String(err);
    } finally {
      await doc?.close();
    }
  }
}
