const IDB_NAME = 'scribe-library';
const IDB_STORE = 'handles';
const HANDLE_KEY = 'library-root';
const RECENTS_KEY = 'recent-folders';
const RECENTS_MAX = 8;
const DATA_DIR = '.scribe';
const APP_DATA_DIR = 'libraries';

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
 * @property {string} [ocrFile] - Name of the OCR file beside the source file that the import used.
 * @property {string} [ocrFileNote] - What the import did to align that OCR file, when its page count differed from the PDF's.
 * @property {string} [ocrFileError] - Why the OCR file beside the source file was not used, when there was one.
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
 * @property {boolean} [portfolio] - The file is a PDF portfolio (a catalog with a collection dictionary), so opening it lists its embedded files rather than showing its cover page.
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
 * Whether two directory handles name the same directory.
 * Two handles to the same directory can be distinct objects.
 * @param {FileSystemDirectoryHandle} a
 * @param {FileSystemDirectoryHandle} b
 */
export const sameEntry = async (a, b) => a === b
  // @ts-ignore - isSameEntry is Chromium-only.
  || (typeof a.isSameEntry === 'function' && await a.isSameEntry(b).catch(() => false));

const newFolderId = () => [...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, '0')).join('');

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
    const file = await (await dir.getFileHandle(name)).getFile();
    // `writeFileIn` creates the file before its writable opens, so a zero-byte file is a write that has not finished.
    // Nothing under `dataDir` is written empty.
    return file.size ? file : null;
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
  /**
   * @param {FileSystemDirectoryHandle} rootHandle
   * @param {{id?: string, notesBeside?: ?boolean}} [known] - What the recents list records for the folder.
   */
  constructor(rootHandle, { id = '', notesBeside = null } = {}) {
    this.root = rootHandle;
    /** Name of the folder's data directory in the site's storage. */
    this.id = id;
    /**
     * Whether the sidecars live in the folder's hidden `.scribe/docs` rather than in the site's storage.
     * Null until `init` settles it for a folder this version has not opened before.
     * @type {?boolean}
     */
    this.notesBeside = notesBeside;
    /** @type {?FileSystemDirectoryHandle} The folder's own `.scribe` directory when one exists, whether an older version's leftover or the sidecars' home. */
    this.folderDataDir = null;
    this.persistAsked = false;
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

  /**
   * The recents list as stored, newest first.
   * @typedef {{handle: FileSystemDirectoryHandle, lastOpened: number, id?: string, notesBeside?: boolean}} RecentRecord
   * @returns {Promise<RecentRecord[]>}
   */
  static async recentRecords() {
    try {
      const list = await idbOp('readonly', (s) => s.get(RECENTS_KEY));
      if (Array.isArray(list) && list.length) return list.filter((r) => r && r.handle);
      // A profile from before the recents list holds its one folder under the old key.
      const legacy = await idbOp('readonly', (s) => s.get(HANDLE_KEY));
      return legacy ? [{ handle: legacy, lastOpened: 0 }] : [];
    } catch {
      return [];
    }
  }

  /**
   * Folders opened before, newest first.
   * @returns {Promise<FileSystemDirectoryHandle[]>}
   */
  static async recentFolders() {
    return (await LibraryStore.recentRecords()).map((r) => r.handle);
  }

  /**
   * @param {FileSystemDirectoryHandle} handle
   * @returns {Promise<?RecentRecord>}
   */
  static async recordFor(handle) {
    for (const r of await LibraryStore.recentRecords()) if (await sameEntry(r.handle, handle)) return r;
    return null;
  }

  /**
   * A store for a remembered folder, carrying what the recents list records for it.
   * @param {FileSystemDirectoryHandle} handle
   */
  static async forHandle(handle) {
    const rec = await LibraryStore.recordFor(handle);
    // A record without an id is from before this version, or from a folder just remembered.
    // `init` decides where such a folder's data lives.
    return new LibraryStore(handle, { id: rec?.id ?? '', notesBeside: rec?.id ? !!rec.notesBeside : null });
  }

  /**
   * Record `handle` as the folder opened most recently, keeping what its record already holds.
   * @param {FileSystemDirectoryHandle} handle
   * @param {{id?: string, notesBeside?: boolean}} [patch]
   */
  static async persistHandle(handle, patch = {}) {
    try {
      /** @type {?RecentRecord} */
      let own = null;
      /** @type {RecentRecord[]} */
      const kept = [];
      for (const r of await LibraryStore.recentRecords()) {
        if (await sameEntry(r.handle, handle)) own = own ?? r;
        else kept.push(r);
      }
      const now = Date.now();
      const list = [{ ...(own ?? {}), ...patch, handle }, ...kept].slice(0, RECENTS_MAX).map((r, i) => ({ ...r, lastOpened: now - i }));
      await idbOp('readwrite', (s) => s.put(list, RECENTS_KEY));
      await idbOp('readwrite', (s) => s.put(handle, HANDLE_KEY));
    } catch { /* Private mode or blocked storage. */ }
  }

  /**
   * Set record fields for a remembered folder without moving it in the list.
   * @param {FileSystemDirectoryHandle} handle
   * @param {{id?: string, notesBeside?: boolean}} patch
   */
  static async updateRecord(handle, patch) {
    try {
      const list = await LibraryStore.recentRecords();
      let found = false;
      for (let i = 0; i < list.length; i++) {
        if (!(await sameEntry(list[i].handle, handle))) continue;
        list[i] = { ...list[i], ...patch };
        found = true;
      }
      if (found) await idbOp('readwrite', (s) => s.put(list, RECENTS_KEY));
    } catch { /* Private mode or blocked storage. */ }
  }

  static async forgetHandle() {
    try {
      await idbOp('readwrite', (s) => s.delete(HANDLE_KEY));
    } catch { /* Nothing to forget. */ }
  }

  /**
   * Whether a remembered folder is still on disk.
   * Only a missing directory counts as gone.
   * @param {FileSystemDirectoryHandle} handle
   * @returns {Promise<boolean>}
   */
  static async folderExists(handle) {
    try {
      const entries = handle.keys();
      await entries.next();
      await entries.return?.();
      return true;
    } catch (err) {
      return !(err instanceof DOMException && err.name === 'NotFoundError');
    }
  }

  /**
   * Drop a folder from the recents list.
   * @param {FileSystemDirectoryHandle} handle
   */
  static async forgetFolder(handle) {
    try {
      const kept = [];
      for (const r of await LibraryStore.recentRecords()) if (!(await sameEntry(r.handle, handle))) kept.push(r);
      const now = Date.now();
      await idbOp('readwrite', (s) => s.put(kept.map((r, i) => ({ ...r, lastOpened: now - i })), RECENTS_KEY));
      // An emptied list falls back to the single-folder key, which would bring the folder back.
      const legacy = await idbOp('readonly', (s) => s.get(HANDLE_KEY));
      if (legacy && await sameEntry(legacy, handle)) await idbOp('readwrite', (s) => s.delete(HANDLE_KEY));
    } catch { /* Private mode or blocked storage. */ }
  }

  /** Empty the recents list. */
  static async clearRecentFolders() {
    try {
      await idbOp('readwrite', (s) => s.put([], RECENTS_KEY));
      await idbOp('readwrite', (s) => s.delete(HANDLE_KEY));
    } catch { /* Private mode or blocked storage. */ }
  }

  /**
   * Prompt the user to pick a library folder. Must run within a user gesture.
   * @returns {Promise<LibraryStore>}
   */
  static async connectNew() {
    // Opening only reads the folder, so the browser's prompt asks to view it, and each action that writes asks to edit.
    // The desktop shell learns a folder's path only from the picker's write request, and grants that request without a prompt, so there the picker still asks to edit.
    const mode = /** @type {any} */ (window).electronAPI ? 'readwrite' : 'read';
    // @ts-ignore - showDirectoryPicker is Chromium-only and absent from lib.dom.
    const handle = await window.showDirectoryPicker({ mode });
    await LibraryStore.persistHandle(handle);
    return LibraryStore.forHandle(handle);
  }

  /** @returns {'read'|'readwrite'} */
  openMode() {
    return this.notesBeside ? 'readwrite' : 'read';
  }

  /**
   * @param {'read'|'readwrite'} [mode]
   * @returns {Promise<'granted'|'prompt'|'denied'>}
   */
  async permissionState(mode = this.openMode()) {
    // Handles without the permission API, such as OPFS, are always writable.
    // @ts-ignore - queryPermission is Chromium-only.
    if (!this.root.queryPermission) return 'granted';
    // @ts-ignore
    return this.root.queryPermission({ mode });
  }

  /**
   * @param {'read'|'readwrite'} [mode]
   * @returns {Promise<'granted'|'prompt'|'denied'>} Must run within a user gesture.
   */
  async requestPermission(mode = this.openMode()) {
    // @ts-ignore - requestPermission is Chromium-only.
    if (!this.root.requestPermission) return 'granted';
    // @ts-ignore
    return this.root.requestPermission({ mode });
  }

  /**
   * Whether the folder may be written to, asking the user when it may not yet be.
   * Must run within a user gesture, at the start of the action that writes.
   * @returns {Promise<boolean>}
   */
  async ensureWritable() {
    try {
      if ((await this.permissionState('readwrite')) === 'granted') return true;
      return (await this.requestPermission('readwrite')) === 'granted';
    } catch {
      return false;
    }
  }

  /**
   * Open the folder's data directories in the site's storage, and its sidecars where they live.
   * Nothing is written into the folder unless its sidecars already live there.
   */
  async init() {
    if (!this.id) this.id = newFolderId();
    const appRoot = await (await navigator.storage.getDirectory()).getDirectoryHandle(APP_DATA_DIR, { create: true });
    this.dataDir = await appRoot.getDirectoryHandle(this.id, { create: true });
    this.textDir = await this.dataDir.getDirectoryHandle('text', { create: true });
    this.thumbsDir = await this.dataDir.getDirectoryHandle('thumbs', { create: true });
    this.pagesDir = await this.dataDir.getDirectoryHandle('pages', { create: true });
    this.folderDataDir = await this.root.getDirectoryHandle(DATA_DIR).catch(() => null);
    if (this.notesBeside === null) {
      this.notesBeside = false;
      if (this.folderDataDir && !(await readFileIn(this.dataDir, MANIFEST_FILE))) {
        // A folder an older version opened keeps its data in its own `.scribe` directory, which is copied here once and left for the user to remove.
        // Page previews are left out, since they are the bulk and are rendered again as pages are viewed.
        for (const name of [MANIFEST_FILE, INDEX_FILE]) {
          const file = await readFileIn(this.folderDataDir, name);
          if (file) await writeFileIn(this.dataDir, name, file);
        }
        /** @type {Array<[?FileSystemDirectoryHandle, FileSystemDirectoryHandle]>} */
        const pairs = [
          [await this.folderDataDir.getDirectoryHandle('text').catch(() => null), this.textDir],
          [await this.folderDataDir.getDirectoryHandle('thumbs').catch(() => null), this.thumbsDir],
          [await this.folderDataDir.getDirectoryHandle('docs').catch(() => null), await this.dataDir.getDirectoryHandle('docs', { create: true })],
        ];
        for (const [from, to] of pairs) {
          if (!from) continue;
          // @ts-ignore - entries() is missing from lib.dom's FileSystemDirectoryHandle.
          for await (const [name, handle] of from.entries()) {
            if (handle.kind === 'file') await writeFileIn(to, name, await handle.getFile());
          }
        }
      }
    }
    if (this.notesBeside) {
      this.folderDataDir = await this.root.getDirectoryHandle(DATA_DIR, { create: true });
      this.docsDir = await this.folderDataDir.getDirectoryHandle('docs', { create: true });
    } else {
      this.docsDir = await this.dataDir.getDirectoryHandle('docs', { create: true });
    }
    await LibraryStore.updateRecord(this.root, { id: this.id, notesBeside: this.notesBeside });
    try {
      // The previews must leave room in the site's storage quota for the notes and the index.
      const estimate = await navigator.storage.estimate();
      if (estimate.quota) this.rasterBudget = Math.min(RASTER_BUDGET_BYTES, Math.floor(estimate.quota / 4));
    } catch { /* The fixed budget stands. */ }
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
   * Delete a source document from the folder.
   * Only copies the app itself made may be deleted this way.
   * @param {string} relPath
   */
  async deleteSourceFile(relPath) {
    const cut = relPath.lastIndexOf('/');
    const dir = await this.dirAt(cut < 0 ? '' : relPath.slice(0, cut));
    await dir.removeEntry(relPath.slice(cut + 1));
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
    // Notes kept in the site's storage can be evicted under disk pressure unless the browser is asked to keep them.
    // Chromium decides that request without a prompt.
    if (!this.notesBeside && !this.persistAsked) {
      this.persistAsked = true;
      navigator.storage.persist?.().catch(() => {});
    }
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
   * Byte totals of what the app keeps for the folder, and of what an older version left inside it.
   * `index` covers the manifest, the search index, the extracted text and the thumbnails.
   * `older` is the folder's own `.scribe` directory, less the sidecars when they live there.
   * @returns {Promise<{previews: number, index: number, notes: number, older: number}>}
   */
  async measure() {
    /**
     * @param {?FileSystemDirectoryHandle} dir
     * @param {Set<string>} [skip]
     * @returns {Promise<number>}
     */
    const sizeOf = async (dir, skip = new Set()) => {
      if (!dir) return 0;
      let total = 0;
      // @ts-ignore - entries() is missing from lib.dom's FileSystemDirectoryHandle.
      for await (const [name, handle] of dir.entries()) {
        if (skip.has(name)) continue;
        total += handle.kind === 'directory' ? await sizeOf(handle) : (await handle.getFile()).size;
      }
      return total;
    };
    return {
      previews: await sizeOf(this.pagesDir),
      index: await sizeOf(this.dataDir, new Set(['pages', 'docs'])),
      notes: await sizeOf(this.docsDir),
      older: await sizeOf(this.folderDataDir, new Set(this.notesBeside ? ['docs'] : [])),
    };
  }

  async clearPreviews() {
    const pagesDir = /** @type {FileSystemDirectoryHandle} */ (this.pagesDir);
    const names = [];
    // @ts-ignore - keys() is missing from lib.dom's FileSystemDirectoryHandle.
    for await (const name of pagesDir.keys()) names.push(name);
    for (const name of names) await pagesDir.removeEntry(name, { recursive: true }).catch(() => {});
    this.rasterBytes = 0;
  }

  /**
   * Delete the derived data: the search index, the extracted text, the thumbnails and the previews.
   * The manifest stays, so each document keeps its record of edits and recognition.
   * A rebuild then regenerates the rest from the sidecars.
   */
  async deleteCaches() {
    const dataDir = /** @type {FileSystemDirectoryHandle} */ (this.dataDir);
    const names = [];
    // @ts-ignore - keys() is missing from lib.dom's FileSystemDirectoryHandle.
    for await (const name of dataDir.keys()) if (name !== 'docs' && name !== MANIFEST_FILE) names.push(name);
    for (const name of names) await dataDir.removeEntry(name, { recursive: true }).catch(() => {});
    this.textDir = await dataDir.getDirectoryHandle('text', { create: true });
    this.thumbsDir = await dataDir.getDirectoryHandle('thumbs', { create: true });
    this.pagesDir = await dataDir.getDirectoryHandle('pages', { create: true });
    this.rasterBytes = 0;
  }

  /**
   * Delete everything the app keeps for the folder, and any `.scribe` directory inside it.
   * Removing that directory needs write access to the folder, without which it silently stays.
   */
  async deleteAll() {
    await LibraryStore.deleteAppData(this.id);
    if (this.folderDataDir) await this.root.removeEntry(DATA_DIR, { recursive: true }).catch(() => {});
    this.folderDataDir = null;
  }

  /** @param {string} id */
  static async deleteAppData(id) {
    if (!id) return;
    try {
      const appRoot = await (await navigator.storage.getDirectory()).getDirectoryHandle(APP_DATA_DIR);
      await appRoot.removeEntry(id, { recursive: true });
    } catch { /* Nothing stored. */ }
  }

  /**
   * @param {string} id
   * @returns {Promise<{docs: number, edited: number}>}
   */
  static async countsIn(id) {
    try {
      const appRoot = await (await navigator.storage.getDirectory()).getDirectoryHandle(APP_DATA_DIR);
      const file = await readFileIn(await appRoot.getDirectoryHandle(id), MANIFEST_FILE);
      const parsed = file ? JSON.parse(await file.text()) : null;
      const entries = Object.values(parsed?.docs ?? {});
      return { docs: entries.length, edited: entries.filter((e) => e && e.editedAt).length };
    } catch {
      return { docs: 0, edited: 0 };
    }
  }

  /**
   * Remove what an older version left in the folder's `.scribe` directory, sparing the sidecars when they live there.
   * Requires write access to the folder.
   */
  async removeOlderFiles() {
    const dir = this.folderDataDir;
    if (!dir) return;
    if (!this.notesBeside) {
      await this.root.removeEntry(DATA_DIR, { recursive: true });
      this.folderDataDir = null;
      return;
    }
    const names = [];
    // @ts-ignore - keys() is missing from lib.dom's FileSystemDirectoryHandle.
    for await (const name of dir.keys()) if (name !== 'docs') names.push(name);
    for (const name of names) await dir.removeEntry(name, { recursive: true });
  }

  /**
   * Move the sidecars into the folder's hidden `.scribe/docs` directory, or back into the site's storage.
   * Moving into the folder requires write access to it.
   * @param {boolean} beside
   */
  async setNotesBeside(beside) {
    if (beside === this.notesBeside) return;
    const from = /** @type {FileSystemDirectoryHandle} */ (this.docsDir);
    let to;
    if (beside) {
      this.folderDataDir = await this.root.getDirectoryHandle(DATA_DIR, { create: true });
      to = await this.folderDataDir.getDirectoryHandle('docs', { create: true });
    } else {
      to = await /** @type {FileSystemDirectoryHandle} */ (this.dataDir).getDirectoryHandle('docs', { create: true });
    }
    const names = [];
    // @ts-ignore - entries() is missing from lib.dom's FileSystemDirectoryHandle.
    for await (const [name, handle] of from.entries()) if (handle.kind === 'file') names.push(name);
    for (const name of names) {
      await writeFileIn(to, name, await (await from.getFileHandle(name)).getFile());
      await deleteFileIn(from, name);
    }
    this.docsDir = to;
    this.notesBeside = beside;
    if (!beside && this.folderDataDir) {
      // The folder keeps its `.scribe` directory only while an older version's files are still in it.
      let rest = 0;
      // @ts-ignore - keys() is missing from lib.dom's FileSystemDirectoryHandle.
      for await (const name of this.folderDataDir.keys()) if (name !== 'docs') rest++;
      if (rest) await this.folderDataDir.removeEntry('docs', { recursive: true }).catch(() => {});
      else {
        await this.root.removeEntry(DATA_DIR, { recursive: true }).catch(() => {});
        this.folderDataDir = null;
      }
    }
    await LibraryStore.updateRecord(this.root, { notesBeside: beside });
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
