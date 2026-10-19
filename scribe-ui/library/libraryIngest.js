import scribeLib from '../../scribe.js';
import { selectOcrPages } from '../../js/pdf/ocrPageSelection.js';

/**
 * @typedef {Object} LiveDoc
 * @property {import('../../js/containers/scribeDoc.js').ScribeDoc} doc
 * @property {(recognized: boolean) => Promise<void>} [checkpoint] - Present when a viewer tab owns the copy.
 *    Persists the sidecar the way that tab's own checkpoint does, stamping the recognition when `recognized` is true.
 */
import { openDocumentFromFile, filesNamedForPdf } from '../js/controls/tools.js';

const THUMB_WIDTH = 300;
/** Stored page rasters stand in for the live preview, so they need its pane width rather than thumbnail width. */
export const PAGE_RASTER_WIDTH = 900;
/** WebP quality for pages routed lossy. In Chromium, quality 1.0 switches the encoder to lossless, so 0.9 is the top lossy setting. */
const RASTER_LOSSY_QUALITY = 0.9;
/**
 * Byte cap for a lossless page raster. A page past it re-encodes lossy.
 * Catches gradient-heavy synthetic pages, which the geometry rule cannot see, and every photograph when a page comes without statistics.
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
  // Without the geometry, as from the pixel source, a page encodes lossless and the byte cap below catches the photographs.
  const lossy = !!stats && stats.largestImageFrac >= RASTER_LOSSY_IMAGE_FRAC;
  const blob = await doc.images.renderThumbnail(n, PAGE_RASTER_WIDTH, lossy ? RASTER_LOSSY_QUALITY : 1.0, true, 'webp');
  if (blob && !lossy && blob.size > RASTER_LOSSLESS_CAP) {
    return (await doc.images.renderThumbnail(n, PAGE_RASTER_WIDTH, RASTER_LOSSY_QUALITY, true, 'webp')) ?? blob;
  }
  return blob;
};

/**
 * Record the import's text verdict and per-mode OCR page counts on a manifest entry.
 * @param {import('./libraryStore.js').LibraryDocEntry} entry
 * @param {import('../../js/containers/scribeDoc.js').ScribeDoc} doc
 */
const recordTextSignals = (entry, doc) => {
  const stats = doc.inputData.pageStats;
  const pdfType = doc.inputData.pdfType ?? null;
  entry.pdfType = pdfType;
  entry.ocrShallow = stats ? selectOcrPages(stats, pdfType, 'autoShallow').filter(Boolean).length : 0;
  entry.ocrDeep = stats ? selectOcrPages(stats, pdfType, 'autoDeep').filter(Boolean).length : 0;
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
   * @param {Object} callbacks
   * @param {ReturnType<typeof import('./search/searchClient.js').createSearchClient>} callbacks.engine
   * @param {(state: {done: number, total: number, current: string, kind?: string, pageDone?: number, pageTotal?: number}) => void} [callbacks.onProgress]
   *    `kind` names the running task; recognition tasks also report page progress.
   * @param {(relPath: string) => void} [callbacks.onDocDone] - Fires after a document reaches a terminal status.
   * @param {(explicit: boolean) => boolean} [callbacks.recognizeGate] - Permission check before each recognition task.
   *    `explicit` is true for a request made this session, false for one resumed from the manifest.
   *    Omitting it disables recognition entirely.
   * @param {() => string[]} [callbacks.langs] - Recognition languages.
   * @param {() => ('speed'|'quality')} [callbacks.recognizeMode] - Recognition speed, passed to `recognize()` as `mode`.
   * @param {(hash: string) => (LiveDoc | null | Promise<LiveDoc | null>)} [callbacks.liveDoc] - The copy of a document already open, so recognition runs on it rather than a second copy.
   *    A tab-owned copy comes with `checkpoint`, which persists it through that tab.
   *    A copy without one is handed over until `releaseLiveDoc`.
   * @param {(hash: string, doc: import('../../js/containers/scribeDoc.js').ScribeDoc) => void} [callbacks.releaseLiveDoc] - Hands a copy taken through `liveDoc` back once recognition is over.
   */
  constructor(store, manifest, {
    engine, onProgress, onDocDone, recognizeGate, langs, recognizeMode, liveDoc, releaseLiveDoc,
  }) {
    this.store = store;
    this.manifest = manifest;
    this.engine = engine;
    this.onProgress = onProgress;
    this.onDocDone = onDocDone;
    this.recognizeGate = recognizeGate || null;
    this.langs = langs || null;
    this.recognizeMode = recognizeMode || null;
    this.liveDoc = liveDoc || null;
    this.releaseLiveDoc = releaseLiveDoc || null;
    /**
     * The document a recognition task is running on, while one runs.
     * A viewer tab opening that document mid-run adopts this copy through `adoptRecognizing`, so the run and the tab never hold two copies.
     * @type {?{hash: string, doc: ?import('../../js/containers/scribeDoc.js').ScribeDoc, inTab: boolean, adopted: boolean}}
     */
    this.recognizing = null;
    /** @type {Array<{relPath: string, kind: 'ingest'|'verify', resetSidecar?: boolean}>} Explicit user requests. Always drained first. */
    this.userLane = [];
    /** @type {Array<{relPath: string, kind: 'ingest'|'verify'}>} Scan-discovered work. */
    this.discoveryLane = [];
    /** @type {Array<{relPath: string, kind: 'recognize', explicit: boolean}>} Text recognition, drained after the index lanes and gated separately. */
    this.recognizeLane = [];
    this.running = false;
    this.done = 0;
    /** When set, start() stops draining after the in-flight task, so a folder operation can run against a quiet queue. */
    this.paused = false;
    /** @type {?{relPath: string, kind: 'ingest'|'verify'|'recognize'}} */
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
      }
      // A recognition request survives a reload, so it resumes here as non-explicit work that waits for an idle machine.
      if (entry?.ocrQueued && !this.recognizeLane.some((r) => r.relPath === f.relPath)) {
        this.recognizeLane.push({ relPath: f.relPath, kind: 'recognize', explicit: false });
      }
    }
    for (const [relPath, entry] of Object.entries(this.manifest.docs)) {
      if (!seen.has(relPath) && entry.status !== 'missing') entry.status = 'missing';
    }
    this.manifest.dirs = dirs.sort();
    this.manifest.others = others.sort();
    await this.store.writeManifest(this.manifest);
    this.store.sweepArtifacts(this.manifest).catch(() => {});
  }

  /**
   * Queue one document for (re-)ingest, creating or resetting its manifest entry.
   * Goes to the user lane, ahead of any scan-discovered backlog.
   * A plain ingest rebuilds the derived data and leaves any existing sidecar, which holds the user's edits, in place.
   * `resetSidecar` is the revert path, rewriting the sidecar from the source file.
   * @param {string} relPath
   * @param {{size?: number, mtime?: number}} [info]
   * @param {{resetSidecar?: boolean, writeManifest?: boolean}} [opts]
   */
  async enqueue(relPath, info = {}, { resetSidecar = false, writeManifest = true } = {}) {
    const existing = this.manifest.docs[relPath];
    /** @type {import('./libraryStore.js').LibraryDocEntry} */
    const entry = {
      hash: existing?.hash || '',
      size: info.size ?? existing?.size ?? 0,
      mtime: info.mtime ?? existing?.mtime ?? 0,
      pageCount: existing?.pageCount ?? 0,
      added: existing?.added ?? Date.now(),
      lastOpened: existing?.lastOpened ?? 0,
      status: 'pending',
    };
    if (existing?.order !== undefined) entry.order = existing.order;
    if (!resetSidecar) {
      if (existing?.editedAt) entry.editedAt = existing.editedAt;
      if (existing?.recognizedAt) entry.recognizedAt = existing.recognizedAt;
    }
    this.manifest.docs[relPath] = entry;
    if (writeManifest) await this.store.writeManifest(this.manifest);
    this.userLane.push({ relPath, kind: 'ingest', resetSidecar });
  }

  /**
   * Queue a document for text recognition. Its manifest flag makes the request survive a reload.
   * @param {string} relPath
   * @param {{writeManifest?: boolean}} [opts]
   */
  async enqueueRecognize(relPath, { writeManifest = true } = {}) {
    const entry = this.manifest.docs[relPath];
    if (!entry || !entry.hash) return;
    entry.ocrQueued = true;
    delete entry.ocrError;
    if (writeManifest) await this.store.writeManifest(this.manifest);
    if (!this.recognizeLane.some((r) => r.relPath === relPath)) this.recognizeLane.push({ relPath, kind: 'recognize', explicit: true });
  }

  /**
   * Discard every queued lane.
   * The document already in flight still finishes.
   */
  cancel() {
    this.userLane.length = 0;
    this.discoveryLane.length = 0;
    for (const r of this.recognizeLane) {
      const entry = this.manifest.docs[r.relPath];
      if (entry) delete entry.ocrQueued;
    }
    this.recognizeLane.length = 0;
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
    for (const t of this.recognizeLane) t.relPath = rekey(t.relPath);
    if (this.current && rekey(this.current.relPath) !== this.current.relPath) {
      this.discoveryLane.unshift({ relPath: rekey(this.current.relPath), kind: this.current.kind });
    }
  }

  /**
   * Process the lanes serially: user, then discovery, then recognition (when its gate allows).
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
        let task = this.userLane.shift() || this.discoveryLane.shift();
        if (!task && this.recognizeLane.length && this.recognizeGate?.(this.recognizeLane[0].explicit)) task = this.recognizeLane.shift();
        if (task) {
          this.current = task;
          this.done++;
          this.onProgress?.({
            done: this.done, total: this.done + this.pendingCount(), current: task.relPath, kind: task.kind,
          });
          try {
            if (task.kind === 'verify') await this._verify(task.relPath);
            else if (task.kind === 'recognize') await this._recognize(task.relPath);
            else await this._ingest(task.relPath, !!task.resetSidecar);
          } catch (err) {
            // Each task records its own outcome on the entry; a throw past that point is a close that failed after the fact.
            console.error(err);
          }
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
        idle = true;
      }
    } finally {
      this.running = false;
      this.current = null;
      if (manifestPending) await this.store.writeManifest(this.manifest).catch(() => {});
      this.onProgress?.({ done: this.done, total: this.done + this.pendingCount(), current: '' });
      this.done = 0;
    }
  }

  /** Tasks still waiting in the lanes the progress display counts. */
  pendingCount() {
    return this.userLane.length + this.discoveryLane.length + this.recognizeLane.length;
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
   * Import a document and rebuild everything derived from it.
   * An existing sidecar for the same bytes holds the user's edits, so it is opened alongside the source and left in place.
   * @param {string} relPath
   * @param {boolean} [resetSidecar] - Rewrite the sidecar from the source file, discarding the user's edits.
   */
  async _ingest(relPath, resetSidecar = false) {
    const entry = this.manifest.docs[relPath];
    if (!entry) return;
    /** @type {?import('../../js/containers/scribeDoc.js').ScribeDoc} */
    let doc = null;
    /** @type {?number} */
    let timer = null;
    try {
      await Promise.race([
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
              return;
            }
          }

          const sidecar = resetSidecar ? null : await this.store.readSidecar(hash);
          // The hashed buffer doubles as the import input, so the file's bytes are read and held once.
          if (sidecar) {
            doc = await scribeLib.openDocument([new File([buf], relPath.split('/').pop() || relPath), new File([sidecar], `${hash}.scribe`)], { skipFontOpt: true });
          } else {
            // The sidecar holds the document's text and edits, so the OCR file is read only without one.
            const cut = relPath.lastIndexOf('/');
            const dir = await this.store.dirAt(cut < 0 ? '' : relPath.slice(0, cut));
            const names = [];
            // @ts-ignore - keys() is missing from lib.dom's FileSystemDirectoryHandle.
            for await (const name of dir.keys()) names.push(name);
            const ocrName = filesNamedForPdf(relPath.slice(cut + 1), names).ocrFiles[0];
            const ocrFile = ocrName ? await (await dir.getFileHandle(ocrName)).getFile() : null;
            delete entry.ocrFile;
            delete entry.ocrFileNote;
            delete entry.ocrFileError;
            /** @param {number} n */
            const pages = (n) => `${n} page${n === 1 ? '' : 's'}`;
            doc = await openDocumentFromFile(buf, {
              skipFontOpt: true,
              ocrFiles: ocrFile ? [ocrFile] : [],
              onOcrFileRejected: (err) => {
                entry.ocrFileError = err.name === 'OcrPageMismatchError'
                  ? `Text data not used — PDF has ${pages(err.pageCount ?? 0)}, text data (${ocrName}) has ${pages(err.ocrPages ?? 0)}. Text data could not be aligned with PDF.`
                  : `Text data not used — ${ocrName} could not be read as text data.`;
              },
            });
            if (ocrFile && !entry.ocrFileError) {
              entry.ocrFile = ocrName;
              const match = doc.inputData.ocrPageMatch;
              if (match) entry.ocrFileNote = `Text misalignment repaired — PDF has ${pages(doc.inputData.pageCount)}, text data (${ocrName}) has ${pages(match.ocrPages)}. Text data auto-aligned with PDF.`;
            }
          }
          entry.hash = hash;
          entry.pageCount = doc.inputData.pageCount;
          // A portfolio's own page is only a cover sheet, so the library opens the entry as a portfolio view instead.
          if (doc.attachments.collection) entry.portfolio = true;
          else delete entry.portfolio;
          entry.pageDims = doc.pageMetrics.map((pm) => [
            Math.round(pm.dims.width * 100) / 100, Math.round(pm.dims.height * 100) / 100, pm.rotation || 0,
          ]);
          recordTextSignals(entry, doc);
          if (resetSidecar) {
            delete entry.editedAt;
            delete entry.recognizedAt;
            await this.store.deleteChanges(hash);
          }

          await this.engine.addDoc(hash, doc.ocr.active || []);
          try {
            const thumb = await doc.images.renderThumbnail(0, THUMB_WIDTH);
            if (thumb) await this.store.writeThumb(hash, thumb);
          } catch { /* A failed thumbnail leaves a blank card. */ }
          // Sidecars are this application's own session store, so app-side state such as pending text edits belongs in them.
          // Per-character boxes are half a sidecar's bytes, so they are dropped here.
          // A document reopened from its sidecar has word boxes only.
          if (!sidecar) {
            try {
              await this.store.writeSidecar(hash, await doc.exportData('scribe', { scribeSession: true, includeCharBoxesScribe: false }));
              delete entry.sidecarError;
            } catch (err) {
              // A document without a sidecar still indexes and reopens from its source file, losing only saved session state.
              entry.sidecarError = err instanceof Error ? err.message : String(err);
            }
          }
          // Even an unedited document gets a changes file, because a provisional document takes the PDF's own annotations from it.
          await this.store.writeChanges(hash, await doc.exportData('scribe', { scribeSession: true, includeOcrScribe: false }));
        })(),
        new Promise((resolve, reject) => {
          timer = setTimeout(() => {
            const err = new Error(`Timed out after ${Math.round(DOC_TIMEOUT_MS / 1000)}s.`);
            err.name = 'IngestTimeoutError';
            reject(err);
          }, DOC_TIMEOUT_MS);
        }),
      ]);
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
   * Recognize text for one queued document and persist the result the way a viewer edit is persisted.
   * Page selection is the deep one the viewer's own Recognize uses, so plausible image-borne text is sent to the engine too.
   * A copy owned by a viewer tab is persisted through that tab's checkpoint instead.
   * @param {string} relPath
   */
  async _recognize(relPath) {
    const entry = this.manifest.docs[relPath];
    if (!entry) return;
    delete entry.ocrQueued;
    if (!entry.hash || entry.status !== 'indexed') return;
    const hash = entry.hash;
    // Whatever copy is already open is the one recognized, so a tab's next checkpoint cannot overwrite the result with a copy that lacks it.
    // A copy opened here is adoptable by a tab for the same reason.
    const live = (await this.liveDoc?.(hash)) ?? null;
    /** @type {?import('../../js/containers/scribeDoc.js').ScribeDoc} */
    let doc = live?.doc ?? null;
    this.recognizing = {
      hash, doc, inTab: !!live?.checkpoint, adopted: false,
    };
    try {
      if (!doc) {
        const files = [await this.store.readFile(relPath)];
        const sidecar = await this.store.readSidecar(hash);
        if (sidecar) files.push(new File([sidecar], `${hash}.scribe`));
        // One PDF worker, like the other background copies, because recognition is bound by the OCR engine rather than by page rendering.
        doc = await scribeLib.openDocument(files, { skipFontOpt: true, pdfWorkerN: 1 });
        this.recognizing.doc = doc;
      }
      const stats = doc.inputData.pageStats;
      const pageTotal = stats ? selectOcrPages(stats, doc.inputData.pdfType, 'autoDeep').filter(Boolean).length : 0;
      const seen = new Set();
      const prevProgress = doc.progressHandler;
      doc.progressHandler = (msg) => {
        prevProgress?.(msg);
        if (msg && msg.type === 'convert' && typeof msg.n === 'number') seen.add(msg.n);
        this.onProgress?.({
          done: this.done, total: this.done + this.pendingCount(), current: relPath, kind: 'recognize', pageDone: seen.size, pageTotal,
        });
      };
      try {
        await doc.recognize({ langs: this.langs?.() ?? ['eng'], mode: this.recognizeMode?.(), ocrPages: 'autoDeep' });
      } finally {
        doc.progressHandler = prevProgress;
      }
      if (live?.checkpoint) {
        await live.checkpoint(true);
      } else {
        await this.store.writeSidecar(hash, await doc.exportData('scribe', { scribeSession: true, includeCharBoxesScribe: false }));
        await this.store.writeChanges(hash, await doc.exportData('scribe', { scribeSession: true, includeOcrScribe: false }));
        await this.engine.addDoc(hash, doc.ocr.active || []);
        entry.recognizedAt = Date.now();
      }
      delete entry.ocrError;
    } catch (err) {
      entry.ocrError = err instanceof Error ? err.message : String(err);
    } finally {
      const { adopted } = this.recognizing;
      this.recognizing = null;
      if (doc && !live?.checkpoint && !adopted) {
        if (live) this.releaseLiveDoc?.(hash, doc);
        // A crashed worker can make close() itself throw; the entry already carries the outcome.
        else await doc.close().catch(() => {});
      }
    }
  }

  /**
   * Hand the copy being recognized to a viewer tab that is opening the same document mid-run.
   * The tab owns the copy from here, so recognition finishes on it and this lane does not close it.
   * @param {string} hash
   * @returns {?import('../../js/containers/scribeDoc.js').ScribeDoc}
   */
  adoptRecognizing(hash) {
    const r = this.recognizing;
    if (!r || r.hash !== hash || !r.doc || r.inTab || r.adopted) return null;
    r.adopted = true;
    return r.doc;
  }
}
