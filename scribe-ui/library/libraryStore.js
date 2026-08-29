const IDB_NAME = 'scribe-library';
const IDB_STORE = 'handles';
const HANDLE_KEY = 'library-root';
const DATA_DIR = '.scribe';

const MANIFEST_VERSION = 1;
const INDEX_FILE = 'search-index.json.gz';
const MANIFEST_FILE = 'index.json';

/** Byte cap for stored page rasters, enforced by the artifact sweep. */
export const RASTER_BUDGET_BYTES = 1.5 * 1024 * 1024 * 1024;

// Display names are always the file name, never PDF metadata.
// Info Titles in the wild are word-processor template paths, "untitled", and similar junk.
/** @param {string} relPath */
export const titleOf = (relPath) => relPath.split('/').pop() || relPath;

/**
 * Why `name` can't be used as a folder name, or null when it can.
 * @param {string} name
 * @returns {?string}
 */
export const folderNameProblem = (name) => {
  if (!name) return 'the name is empty';
  if (/[/\\]/.test(name)) return 'folder names can\'t contain slashes';
  // Dot-names are skipped by the folder walk, so the folder and its contents would vanish from the library.
  if (name.startsWith('.')) return 'folder names can\'t start with a period';
  // Windows rejects these even where the current filesystem allows them, and a library folder can move between the two.
  // eslint-disable-next-line no-control-regex
  if (/[<>:"|?*\u0000-\u001f]/.test(name)) return 'folder names can\'t contain < > : " | ? or *';
  if (/[. ]$/.test(name)) return 'folder names can\'t end with a period or space';
  return null;
};

/**
 * One document's record in the library manifest.
 * Entries are keyed by path relative to the library root.
 * @typedef {Object} LibraryDocEntry
 * @property {string} hash - First 16 hex chars of the SHA-256 of the source bytes.
 * @property {number} size
 * @property {number} mtime
 * @property {number} pageCount
 * @property {number} added - Epoch ms when the document entered the library.
 * @property {number} lastOpened - Epoch ms; 0 when never opened.
 * @property {'pending'|'indexed'|'error'|'missing'|'changed'} status
 * @property {?('text'|'ocr'|'image')} [pdfType] - The import's document verdict.
 *    Absent on entries that predate it, until the upgrade lane backfills them.
 * @property {number} [ocrShallow] - Pages the conservative automatic OCR selection would recognize. Informational only.
 * @property {number} [ocrDeep] - Pages the deep automatic OCR selection would recognize, which drives Recognize eligibility and the queued run's scope.
 *    Never a user-facing claim about the document.
 * @property {number} [editedAt] - Epoch ms of the last checkpoint save that followed edits, absent while the sidecar is as imported.
 * @property {number} [recognizedAt] - Epoch ms when text recognition last completed for this document.
 * @property {boolean} [ocrQueued] - Waiting in the recognition queue, and stored so the queue resumes after a reload.
 * @property {string} [ocrError] - Why the last recognition attempt did not finish, cleared by the next request or completed run.
 * @property {string} [error] - Failure message when status is 'error'.
 * @property {'interrupted'|'parse'} [errorKind] - Failure class when status is 'error'.
 *    Interrupted failures get one automatic retry at the next scan.
 * @property {boolean} [retried] - Set once the automatic retry for an interrupted failure has been spent.
 * @property {number} [order] - Manual position under the Custom sort; absent until the user first drag-reorders.
 * @property {Array<[number, number, number]>} [pageDims] - Per-page `[width, height, rotation]` in points, captured at ingest.
 * @property {number} [firstPaintMs] - Measured cost, in ms, of a cold open of this document plus its first-page render.
 *    Recorded only from an open the app performs anyway, never from one run to measure.
 * @property {number} [pageRasterW] - Pixel width of the stored page rasters.
 *    Read from older manifests, never written.
 */

/**
 * @typedef {Object} LibraryManifest
 * @property {number} version
 * @property {Object<string, LibraryDocEntry>} docs
 * @property {string[]} [dirs] - Every subdirectory seen at the last folder scan, empty ones included.
 * @property {string[]} [others] - Every non-PDF file seen at the last folder scan, for the optional "Other files" listing.
 */

/** @returns {Promise<IDBDatabase>} */
const openIdb = () => new Promise((resolve, reject) => {
  const req = indexedDB.open(IDB_NAME, 1);
  req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

/**
 * @param {IDBTransaction['mode']} mode
 * @param {(store: IDBObjectStore) => IDBRequest} fn
 */
const idbOp = async (mode, fn) => {
  const db = await openIdb();
  try {
    return await new Promise((resolve, reject) => {
      const req = fn(db.transaction(IDB_STORE, mode).objectStore(IDB_STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
};

/** @param {string} text */
const gzip = async (text) => new Uint8Array(
  await new Response(new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer(),
);

/** @param {Uint8Array|ArrayBuffer} data */
const gunzip = (data) => new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream('gzip'))).text();

/**
 * @param {FileSystemDirectoryHandle} dir
 * @param {string} name
 * @param {Blob|ArrayBuffer|Uint8Array} data
 */
const writeFileIn = async (dir, name, data) => {
  const fileHandle = await dir.getFileHandle(name, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(data);
  await writable.close();
};

/**
 * @param {FileSystemDirectoryHandle} dir
 * @param {string} name
 * @returns {Promise<File|null>}
 */
const readFileIn = async (dir, name) => {
  try {
    return await (await dir.getFileHandle(name)).getFile();
  } catch {
    return null;
  }
};

/**
 * @param {FileSystemDirectoryHandle} dir
 * @param {string} name
 */
const deleteFileIn = async (dir, name) => {
  try {
    await dir.removeEntry(name);
  } catch { /* Already gone. */ }
};

/**
 * First unused file name in `dir`, either `name` itself or a numbered variant of it.
 * @param {FileSystemDirectoryHandle} dir
 * @param {string} name
 */
const freeNameIn = async (dir, name) => {
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  let candidate = name;
  for (let n = 2; n < 1000; n++) {
    try {
      await dir.getFileHandle(candidate);
    } catch {
      return candidate;
    }
    candidate = `${stem} (${n})${ext}`;
  }
  throw new Error(`Couldn't find a free name for “${name}” — 999 numbered copies already exist.`);
};

/**
 * First unused folder name in `dir`, either `base` itself or a numbered variant of it.
 * Entries of both handle kinds count as collisions.
 * @param {FileSystemDirectoryHandle} dir
 * @param {string} base
 */
const freeFolderNameIn = async (dir, base) => {
  let candidate = base;
  for (let n = 2; n < 1000; n++) {
    const taken = await dir.getFileHandle(candidate).then(() => true, () => false)
      || await dir.getDirectoryHandle(candidate).then(() => true, () => false);
    if (!taken) return candidate;
    candidate = `${base} (${n})`;
  }
  throw new Error(`Couldn't find a free name for “${base}” — 999 numbered copies already exist.`);
};

export class LibraryStore {
  /** @param {FileSystemDirectoryHandle} rootHandle */
  constructor(rootHandle) {
    this.root = rootHandle;
    /** @type {?FileSystemDirectoryHandle} */
    this.dataDir = null;
    /** @type {?FileSystemDirectoryHandle} */
    this.docsDir = null;
    /** @type {?FileSystemDirectoryHandle} */
    this.textDir = null;
    /** @type {?FileSystemDirectoryHandle} */
    this.thumbsDir = null;
    /** @type {?FileSystemDirectoryHandle} */
    this.pagesDir = null;
    /** @type {?number} Running byte total of stored page rasters. Null until the first sweep establishes it. */
    this.rasterBytes = null;
    /** @type {number} Byte cap the sweep enforces on stored page rasters. */
    this.rasterBudget = RASTER_BUDGET_BYTES;
  }

  static isSupported() {
    return typeof window !== 'undefined' && 'showDirectoryPicker' in window;
  }

  /** @returns {Promise<?FileSystemDirectoryHandle>} */
  static async restoreHandle() {
    try {
      return (await idbOp('readonly', (s) => s.get(HANDLE_KEY))) || null;
    } catch {
      return null;
    }
  }

  /** @param {FileSystemDirectoryHandle} handle */
  static async persistHandle(handle) {
    try {
      await idbOp('readwrite', (s) => s.put(handle, HANDLE_KEY));
    } catch { /* Private mode or blocked storage. */ }
  }

  static async forgetHandle() {
    try {
      await idbOp('readwrite', (s) => s.delete(HANDLE_KEY));
    } catch { /* Nothing to forget. */ }
  }

  /**
   * Prompt the user to pick a library folder. Must run within a user gesture.
   * @returns {Promise<LibraryStore>}
   */
  static async connectNew() {
    // @ts-ignore - showDirectoryPicker is Chromium-only and absent from lib.dom.
    const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
    await LibraryStore.persistHandle(handle);
    return new LibraryStore(handle);
  }

  /** @returns {Promise<'granted'|'prompt'|'denied'>} */
  async permissionState() {
    // Handles without the permission API, such as OPFS, are always writable.
    // @ts-ignore - queryPermission is Chromium-only.
    if (!this.root.queryPermission) return 'granted';
    // @ts-ignore
    return this.root.queryPermission({ mode: 'readwrite' });
  }

  /** @returns {Promise<'granted'|'prompt'|'denied'>} Must run within a user gesture. */
  async requestPermission() {
    // @ts-ignore - requestPermission is Chromium-only.
    if (!this.root.requestPermission) return 'granted';
    // @ts-ignore
    return this.root.requestPermission({ mode: 'readwrite' });
  }

  /** Create the `.scribe/` data directories. Requires granted permission. */
  async init() {
    this.dataDir = await this.root.getDirectoryHandle(DATA_DIR, { create: true });
    this.docsDir = await this.dataDir.getDirectoryHandle('docs', { create: true });
    this.textDir = await this.dataDir.getDirectoryHandle('text', { create: true });
    this.thumbsDir = await this.dataDir.getDirectoryHandle('thumbs', { create: true });
    this.pagesDir = await this.dataDir.getDirectoryHandle('pages', { create: true });
  }

  /**
   * Parsed manifest, or a fresh empty one when the file is missing or unreadable.
   * @returns {Promise<LibraryManifest>}
   */
  async readManifest() {
    const file = await readFileIn(/** @type {FileSystemDirectoryHandle} */ (this.dataDir), MANIFEST_FILE);
    if (file) {
      try {
        const parsed = JSON.parse(await file.text());
        if (parsed && parsed.version === MANIFEST_VERSION && parsed.docs) return parsed;
      } catch { /* Corrupt manifest. */ }
    }
    return { version: MANIFEST_VERSION, docs: {} };
  }

  /** @param {LibraryManifest} manifest */
  async writeManifest(manifest) {
    await writeFileIn(/** @type {FileSystemDirectoryHandle} */ (this.dataDir), MANIFEST_FILE, new Blob([JSON.stringify(manifest)]));
  }

  /**
   * Walk the library folder, yielding every subdirectory and file and skipping dot-directories.
   * Entries of kind 'other' are for listing only and must never be ingested.
   * @returns {AsyncGenerator<{relPath: string, name: string, kind: 'dir' | 'other'} | {relPath: string, name: string, kind: 'file', size: number, mtime: number}>}
   */
  async* listFiles() {
    /**
     * @param {FileSystemDirectoryHandle} dir
     * @param {string} prefix
     * @returns {AsyncGenerator<{relPath: string, name: string, kind: 'dir' | 'other'} | {relPath: string, name: string, kind: 'file', size: number, mtime: number}>}
     */
    async function* walk(dir, prefix) {
      // @ts-ignore - entries() is missing from lib.dom's FileSystemDirectoryHandle.
      for await (const [name, handle] of dir.entries()) {
        if (name.startsWith('.')) continue;
        if (handle.kind === 'directory') {
          yield { relPath: `${prefix}${name}`, name, kind: 'dir' };
          yield* walk(handle, `${prefix}${name}/`);
        } else if (name.toLowerCase().endsWith('.pdf')) {
          const file = await handle.getFile();
          yield {
            relPath: `${prefix}${name}`, name, kind: 'file', size: file.size, mtime: file.lastModified,
          };
        } else {
          yield { relPath: `${prefix}${name}`, name, kind: 'other' };
        }
      }
    }
    yield* walk(this.root, '');
  }

  /**
   * @param {string} relDir - Directory path relative to the root, '' for the root itself.
   * @returns {Promise<FileSystemDirectoryHandle>}
   */
  async dirAt(relDir) {
    let dir = this.root;
    for (const segment of relDir ? relDir.split('/') : []) dir = await dir.getDirectoryHandle(segment);
    return dir;
  }

  /**
   * Copy a document into the library folder.
   * A name collision gets a numbered suffix rather than overwriting the existing file.
   * @param {string} name
   * @param {Blob} data
   * @param {string} [destDir] - Destination directory relative to the root; the root when omitted.
   * @returns {Promise<string>} The relative path of the created file.
   */
  async importSourceFile(name, data, destDir = '') {
    const dir = await this.dirAt(destDir);
    const candidate = await freeNameIn(dir, name);
    await writeFileIn(dir, candidate, data);
    return destDir ? `${destDir}/${candidate}` : candidate;
  }

  /**
   * Move a source document into another directory of the library folder.
   * A collision in the destination gets a numbered suffix rather than overwriting the existing file.
   * @param {string} relPath
   * @param {string} destDir - Destination directory relative to the root, '' for the root itself.
   * @returns {Promise<{relPath: string, mtime: number}>} The new path and the copy's timestamp.
   */
  async moveFile(relPath, destDir) {
    const cut = relPath.lastIndexOf('/');
    const srcDir = await this.dirAt(cut < 0 ? '' : relPath.slice(0, cut));
    const name = relPath.slice(cut + 1);
    const dest = await this.dirAt(destDir);
    const candidate = await freeNameIn(dest, name);
    await writeFileIn(dest, candidate, await (await srcDir.getFileHandle(name)).getFile());
    const written = await (await dest.getFileHandle(candidate)).getFile();
    await srcDir.removeEntry(name);
    return { relPath: destDir ? `${destDir}/${candidate}` : candidate, mtime: written.lastModified };
  }

  /**
   * Create a new subdirectory in the library folder.
   * A name collision gets a numbered suffix rather than resolving the existing entry.
   * @param {string} name
   * @param {string} [parentRel] - Parent directory relative to the root; the root when omitted.
   * @returns {Promise<string>} The relative path of the created directory.
   */
  async createDir(name, parentRel = '') {
    const problem = folderNameProblem(name);
    if (problem) throw new Error(problem);
    const parent = await this.dirAt(parentRel);
    const candidate = await freeFolderNameIn(parent, name);
    await parent.getDirectoryHandle(candidate, { create: true });
    return parentRel ? `${parentRel}/${candidate}` : candidate;
  }

  /**
   * Rename or move a directory, transferring its entire contents to the new path.
   * An interrupted transfer can duplicate files but never lose them.
   * @param {string} oldRel
   * @param {string} newRel
   * @returns {Promise<Map<string, number>>} Timestamp of every transferred file, keyed by its new relative path.
   */
  async renameDir(oldRel, newRel) {
    const oldCut = oldRel.lastIndexOf('/');
    const newCut = newRel.lastIndexOf('/');
    const oldName = oldRel.slice(oldCut + 1);
    const newName = newRel.slice(newCut + 1);
    const problem = folderNameProblem(newName);
    if (problem) throw new Error(problem);
    const oldParent = await this.dirAt(oldCut < 0 ? '' : oldRel.slice(0, oldCut));
    const newParent = await this.dirAt(newCut < 0 ? '' : newRel.slice(0, newCut));
    const src = await oldParent.getDirectoryHandle(oldName);
    if (await newParent.getFileHandle(newName).then(() => true, () => false)) throw new Error('a file with that name already exists');
    const existing = await newParent.getDirectoryHandle(newName).then((h) => h, () => null);
    if (existing && !(await existing.isSameEntry(src))) throw new Error('a folder with that name already exists');
    if (existing) {
      // A case-insensitive filesystem resolved the source itself, so creating the new name would transfer the tree into itself.
      // The temp name stays visible to the folder walk, so an interrupted hop cannot hide files.
      const tempName = await freeFolderNameIn(oldParent, `${newName}.renaming`);
      const prefix = oldCut < 0 ? '' : `${oldRel.slice(0, oldCut)}/`;
      await this.renameDir(oldRel, `${prefix}${tempName}`);
      return this.renameDir(`${prefix}${tempName}`, newRel);
    }
    const dest = await newParent.getDirectoryHandle(newName, { create: true });
    /** @type {Map<string, number>} */
    const moved = new Map();
    /** @type {Array<{srcDir: FileSystemDirectoryHandle, destDir: FileSystemDirectoryHandle, name: string, viaMove: boolean}>} */
    const placed = [];
    /** @type {?boolean} Whether file handles support move() here, decided by the first file. */
    let canMove = null;
    // The walk reads raw entries() rather than listFiles, so dot-files the library skips still travel with the folder.
    /**
     * @param {FileSystemDirectoryHandle} from
     * @param {FileSystemDirectoryHandle} to
     * @param {string} prefix
     */
    const transfer = async (from, to, prefix) => {
      // @ts-ignore - entries() is missing from lib.dom's FileSystemDirectoryHandle.
      for await (const [name, handle] of from.entries()) {
        if (handle.kind === 'directory') {
          await transfer(handle, await to.getDirectoryHandle(name, { create: true }), `${prefix}${name}/`);
          continue;
        }
        let viaMove = false;
        if (canMove !== false && typeof handle.move === 'function') {
          try {
            await handle.move(to);
            canMove = true;
            viaMove = true;
          } catch (err) {
            if (canMove === true) throw err;
            canMove = false;
          }
        } else if (canMove === null) canMove = false;
        if (!viaMove) await writeFileIn(to, name, await handle.getFile());
        placed.push({
          srcDir: from, destDir: to, name, viaMove,
        });
        moved.set(`${prefix}${name}`, (await (await to.getFileHandle(name)).getFile()).lastModified);
      }
    };
    try {
      await transfer(src, dest, `${newRel}/`);
    } catch (err) {
      for (const p of placed.reverse()) {
        try {
          if (p.viaMove) await /** @type {any} */ (await p.destDir.getFileHandle(p.name)).move(p.srcDir);
          else await deleteFileIn(p.destDir, p.name);
        } catch { /* Rollback is best-effort, and the next scan adopts whatever stays split. */ }
      }
      await newParent.removeEntry(newName, { recursive: true }).catch(() => {});
      throw err;
    }
    await oldParent.removeEntry(oldName, { recursive: true });
    return moved;
  }

  /**
   * @param {string} relPath
   * @returns {Promise<File>}
   */
  async readFile(relPath) {
    const cut = relPath.lastIndexOf('/');
    const dir = await this.dirAt(cut < 0 ? '' : relPath.slice(0, cut));
    return (await dir.getFileHandle(relPath.slice(cut + 1))).getFile();
  }

  /**
   * @param {string} hash
   * @param {ArrayBuffer|Uint8Array|Blob} data - Serialized `.scribe` data for this document.
   */
  async writeSidecar(hash, data) {
    await writeFileIn(/** @type {FileSystemDirectoryHandle} */ (this.docsDir), `${hash}.scribe`, data);
  }

  /** @param {string} hash @returns {Promise<?ArrayBuffer>} */
  async readSidecar(hash) {
    const file = await readFileIn(/** @type {FileSystemDirectoryHandle} */ (this.docsDir), `${hash}.scribe`);
    return file ? file.arrayBuffer() : null;
  }

  /** @param {string} hash @returns {Promise<?number>} Byte size of the stored sidecar without reading it, or null when absent. */
  async sidecarSize(hash) {
    const file = await readFileIn(/** @type {FileSystemDirectoryHandle} */ (this.docsDir), `${hash}.scribe`);
    return file ? file.size : null;
  }

  /** @param {string} hash */
  async deleteSidecar(hash) {
    await deleteFileIn(/** @type {FileSystemDirectoryHandle} */ (this.docsDir), `${hash}.scribe`);
  }

  /**
   * Copy the sidecar into its one backup slot before a revert overwrites it.
   * @param {string} hash
   * @returns {Promise<boolean>} Whether there was a sidecar to back up.
   */
  async backupSidecar(hash) {
    const file = await readFileIn(/** @type {FileSystemDirectoryHandle} */ (this.docsDir), `${hash}.scribe`);
    if (!file) return false;
    await writeFileIn(/** @type {FileSystemDirectoryHandle} */ (this.docsDir), `${hash}.scribe.bak`, file);
    return true;
  }

  /**
   * Put the backed-up sidecar back in place and drop the backup.
   * @param {string} hash
   * @returns {Promise<boolean>} Whether a backup existed.
   */
  async restoreSidecarBackup(hash) {
    const file = await readFileIn(/** @type {FileSystemDirectoryHandle} */ (this.docsDir), `${hash}.scribe.bak`);
    if (!file) return false;
    await writeFileIn(/** @type {FileSystemDirectoryHandle} */ (this.docsDir), `${hash}.scribe`, file);
    await deleteFileIn(/** @type {FileSystemDirectoryHandle} */ (this.docsDir), `${hash}.scribe.bak`);
    return true;
  }

  /** @param {string} hash */
  async deleteSidecarBackup(hash) {
    await deleteFileIn(/** @type {FileSystemDirectoryHandle} */ (this.docsDir), `${hash}.scribe.bak`);
  }

  /**
   * @param {string} hash
   * @param {string} text - Full document text, pages separated by form-feed characters.
   */
  async writeTextCache(hash, text) {
    await writeFileIn(/** @type {FileSystemDirectoryHandle} */ (this.textDir), `${hash}.txt.gz`, await gzip(text));
  }

  /** @param {string} hash @returns {Promise<?string>} */
  async readTextCache(hash) {
    const file = await readFileIn(/** @type {FileSystemDirectoryHandle} */ (this.textDir), `${hash}.txt.gz`);
    if (!file) return null;
    try {
      return await gunzip(await file.arrayBuffer());
    } catch {
      return null;
    }
  }

  /** @param {string} hash */
  async deleteTextCache(hash) {
    await deleteFileIn(/** @type {FileSystemDirectoryHandle} */ (this.textDir), `${hash}.txt.gz`);
  }

  /** @param {string} hash @param {Blob} blob */
  async writeThumb(hash, blob) {
    await writeFileIn(/** @type {FileSystemDirectoryHandle} */ (this.thumbsDir), `${hash}.jpg`, blob);
  }

  /** @param {string} hash @returns {Promise<?Blob>} */
  async readThumb(hash) {
    return readFileIn(/** @type {FileSystemDirectoryHandle} */ (this.thumbsDir), `${hash}.jpg`);
  }

  /** @param {string} hash */
  async deleteThumb(hash) {
    await deleteFileIn(/** @type {FileSystemDirectoryHandle} */ (this.thumbsDir), `${hash}.jpg`);
  }

  /**
   * Store one page's pre-rendered raster.
   * @param {string} hash
   * @param {number} n - 0-indexed page.
   * @param {Blob} blob
   */
  async writePageRaster(hash, n, blob) {
    const dir = await /** @type {FileSystemDirectoryHandle} */ (this.pagesDir).getDirectoryHandle(hash, { create: true });
    await writeFileIn(dir, `${n}.webp`, blob);
    if (this.rasterBytes !== null) this.rasterBytes += blob.size;
  }

  /** @param {string} hash @param {number} n @returns {Promise<?Blob>} */
  async readPageRaster(hash, n) {
    try {
      const dir = await /** @type {FileSystemDirectoryHandle} */ (this.pagesDir).getDirectoryHandle(hash);
      return await readFileIn(dir, `${n}.webp`);
    } catch {
      return null;
    }
  }

  /** @param {string} hash */
  async deletePageRasters(hash) {
    await /** @type {FileSystemDirectoryHandle} */ (this.pagesDir).removeEntry(hash, { recursive: true }).catch(() => {});
    // The deleted set's size is unknown here, so the running total is stale until the next sweep.
    this.rasterBytes = null;
  }

  /** @param {Object} indexData - Serialized search index. */
  async writeSearchIndex(indexData) {
    await writeFileIn(/** @type {FileSystemDirectoryHandle} */ (this.dataDir), INDEX_FILE, await gzip(JSON.stringify(indexData)));
  }

  /** @returns {Promise<?Object>} Parsed search index, or null when missing or corrupt. */
  async readSearchIndex() {
    const file = await readFileIn(/** @type {FileSystemDirectoryHandle} */ (this.dataDir), INDEX_FILE);
    if (!file) return null;
    try {
      return JSON.parse(await gunzip(await file.arrayBuffer()));
    } catch {
      return null;
    }
  }

  /**
   * Delete derived artifacts no manifest entry references, then evict page rasters past the byte budget.
   * Orphans appear when a changed file re-ingests under a new hash.
   * Eviction removes whole documents, least recently opened first.
   * Also establishes `rasterBytes`, the running total that `writePageRaster` keeps current between sweeps.
   * @param {LibraryManifest} manifest
   */
  async sweepArtifacts(manifest) {
    /** @type {Map<string, number>} Referenced hash -> most recent open (falling back to added time). */
    const lastUse = new Map();
    for (const e of Object.values(manifest.docs)) {
      if (e.hash) lastUse.set(e.hash, Math.max(lastUse.get(e.hash) || 0, e.lastOpened || 0, e.added || 0));
    }
    const flatDirs = /** @type {Array<[?FileSystemDirectoryHandle, string]>} */ ([
      [this.docsDir, '.scribe'], [this.docsDir, '.scribe.bak'], [this.textDir, '.txt.gz'], [this.thumbsDir, '.jpg'],
    ]);
    for (const [dir, ext] of flatDirs) {
      if (!dir) continue;
      // @ts-ignore - entries() is missing from lib.dom's FileSystemDirectoryHandle.
      for await (const [name] of dir.entries()) {
        if (name.endsWith(ext) && !lastUse.has(name.slice(0, -ext.length))) await deleteFileIn(dir, name);
      }
    }
    const pagesDir = this.pagesDir;
    if (!pagesDir) return;
    /** @type {Array<{hash: string, bytes: number, use: number}>} */
    const kept = [];
    let total = 0;
    // @ts-ignore - entries() is missing from lib.dom's FileSystemDirectoryHandle.
    for await (const [hash, handle] of pagesDir.entries()) {
      if (handle.kind !== 'directory') continue;
      if (!lastUse.has(hash)) {
        await pagesDir.removeEntry(hash, { recursive: true }).catch(() => {});
        continue;
      }
      let bytes = 0;
      // @ts-ignore - entries() is missing from lib.dom's FileSystemDirectoryHandle.
      for await (const [name, fileHandle] of handle.entries()) {
        if (fileHandle.kind !== 'file') continue;
        // Page rasters are WebP, so any other image here is stale and would otherwise hold budget forever.
        if (name.endsWith('.jpg')) {
          await deleteFileIn(handle, name);
          continue;
        }
        bytes += (await fileHandle.getFile()).size;
      }
      kept.push({ hash, bytes, use: lastUse.get(hash) || 0 });
      total += bytes;
    }
    kept.sort((a, b) => a.use - b.use);
    for (const rec of kept) {
      if (total <= this.rasterBudget) break;
      await pagesDir.removeEntry(rec.hash, { recursive: true }).catch(() => {});
      total -= rec.bytes;
    }
    this.rasterBytes = total;
  }
}
