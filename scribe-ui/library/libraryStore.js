const IDB_NAME = 'scribe-library';
const IDB_STORE = 'handles';
const HANDLE_KEY = 'library-root';
const DATA_DIR = '.scribe';

const MANIFEST_VERSION = 1;
const INDEX_FILE = 'search-index.json.gz';
const MANIFEST_FILE = 'index.json';

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
 * @property {boolean} requiresOCR
 * @property {string} [error] - Failure message when status is 'error'.
 * @property {number} [order] - Manual position under the Custom sort; absent until the user first drag-reorders.
 * @property {Array<[number, number, number]>} [pageDims] - Per-page `[width, height, rotation]` in points, captured at ingest.
 * @property {number} [pageRasterW] - Pixel width the stored page rasters were rendered at.
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

  /** @param {string} hash */
  async deleteSidecar(hash) {
    await deleteFileIn(/** @type {FileSystemDirectoryHandle} */ (this.docsDir), `${hash}.scribe`);
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
    await writeFileIn(dir, `${n}.jpg`, blob);
  }

  /** @param {string} hash @param {number} n @returns {Promise<?Blob>} */
  async readPageRaster(hash, n) {
    try {
      const dir = await /** @type {FileSystemDirectoryHandle} */ (this.pagesDir).getDirectoryHandle(hash);
      return await readFileIn(dir, `${n}.jpg`);
    } catch {
      return null;
    }
  }

  /** @param {string} hash */
  async deletePageRasters(hash) {
    await /** @type {FileSystemDirectoryHandle} */ (this.pagesDir).removeEntry(hash, { recursive: true }).catch(() => {});
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
}
