// The library store's method surface over a PDF portfolio's embedded files, held in memory while the portfolio is open.
// The library view, its ingest and its preview panes call these methods without knowing the files live inside another PDF, so this surface has to stay in step with LibraryStore.
import { RASTER_BUDGET_BYTES } from './libraryStore.js';

/**
 * @typedef {Object} PortfolioMember
 * @property {string} relPath - The path the library keys the file by: its folder path and display name, made unique within the folder.
 * @property {import('../../js/pdf/parseAttachments.js').AttachmentFile} file
 */

/** @param {import('../../js/pdf/parseAttachments.js').AttachmentFile} file */
const mtimeOf = (file) => (file.modDate ? Date.parse(file.modDate) || 0 : 0);

export class PortfolioStore {
  /**
   * @param {import('../../js/containers/scribeDoc.js').ScribeDoc} doc - The portfolio document, whose worker serves the members' bytes.
   * @param {string} name - The portfolio's display name.
   */
  constructor(doc, name) {
    this.doc = doc;
    /** Stands in for `LibraryStore.root`, the folder handle, of which the library reads only the name. */
    this.root = { name };
    /** @type {?number} Running byte total of held page rasters, null until the first sweep. */
    this.rasterBytes = null;
    this.rasterBudget = RASTER_BUDGET_BYTES;
    /** @type {Map<string, PortfolioMember>} */
    this.members = new Map();
    /** @type {Map<string, Promise<ArrayBuffer>>} Decoded bytes by attachment key, so ingest, preview and open decode each member once. */
    this.bytes = new Map();
    /** @type {Map<string, ArrayBuffer>} */
    this.sidecars = new Map();
    /** @type {Map<string, ArrayBuffer>} */
    this.sidecarBackups = new Map();
    /** @type {Map<string, string>} */
    this.textCache = new Map();
    /** @type {Map<string, Blob>} */
    this.thumbs = new Map();
    /** @type {Map<string, Map<number, Blob>>} */
    this.rasters = new Map();
    /** @type {?Object} */
    this.searchIndex = null;

    const { files, collection } = doc.attachments;
    /** @type {Array<string>} The collection's folders as the paths the library keys its subdirectories by, parent-first. */
    this.folders = [];
    /** @type {Map<number, string>} */
    const pathOfFolder = new Map();
    for (const f of collection?.folders ?? []) {
      // A slash inside a name would read as a path separator in the library's keys, so it becomes the division slash.
      const parent = pathOfFolder.get(f.parentId);
      const path = (parent ? `${parent}/` : '') + (f.name.replace(/\//g, '\u2215') || `Folder ${f.id}`);
      pathOfFolder.set(f.id, path);
      this.folders.push(path);
    }
    files.forEach((file) => {
      const base = (file.name || file.key).replace(/\//g, '\u2215');
      const dot = base.lastIndexOf('.');
      const stem = dot > 0 ? base.slice(0, dot) : base;
      const ext = dot > 0 ? base.slice(dot) : '';
      const dir = file.folderId != null ? pathOfFolder.get(file.folderId) : undefined;
      const prefix = dir ? `${dir}/` : '';
      let relPath = `${prefix}${base}`;
      // One folder's members can share a display name, because the name tree keys them uniquely but their `/UF` names need not differ.
      for (let n = 2; this.members.has(relPath); n++) relPath = `${prefix}${stem} (${n})${ext}`;
      this.members.set(relPath, { relPath, file });
    });
  }

  /** @param {string} relPath */
  memberOf(relPath) {
    return this.members.get(relPath)?.file ?? null;
  }

  /** @param {string} key - An attachment key, as `doc.attachments.collection.initial` names one. */
  relPathOfKey(key) {
    for (const m of this.members.values()) if (m.file.key === key) return m.relPath;
    return null;
  }

  /** Drop everything held for the portfolio once its surface closes. */
  dispose() {
    this.bytes.clear();
    this.sidecars.clear();
    this.sidecarBackups.clear();
    this.textCache.clear();
    this.thumbs.clear();
    this.rasters.clear();
    this.searchIndex = null;
    this.rasterBytes = 0;
  }

  // --- The LibraryStore surface -------------------------------------------

  // eslint-disable-next-line class-methods-use-this
  async permissionState() {
    return 'granted';
  }

  // eslint-disable-next-line class-methods-use-this
  async requestPermission() {
    return 'granted';
  }

  // eslint-disable-next-line class-methods-use-this
  async init() { /* Nothing to create: everything lives in memory. */ }

  /** @returns {Promise<import('./libraryStore.js').LibraryManifest>} A fresh manifest, because a portfolio's records live only while it is open. */
  // eslint-disable-next-line class-methods-use-this
  async readManifest() {
    return {
      version: 1, docs: {}, dirs: [], others: [],
    };
  }

  // eslint-disable-next-line class-methods-use-this, no-unused-vars
  async writeManifest(manifest) { /* The instance holds the one manifest object. */ }

  /**
   * Every folder, then every member, PDFs as documents and the rest as other files, in name-tree order.
   * @returns {AsyncGenerator<{relPath: string, name: string, kind: 'dir' | 'other'} | {relPath: string, name: string, kind: 'file', size: number, mtime: number}>}
   */
  async* listFiles() {
    for (const path of this.folders) yield { relPath: path, name: path.split('/').pop() || path, kind: 'dir' };
    for (const m of this.members.values()) {
      const name = m.relPath.split('/').pop() || m.relPath;
      // The library's rule for what is a document, kept the same here so both surfaces list the same kinds of file.
      if (name.toLowerCase().endsWith('.pdf')) {
        yield {
          relPath: m.relPath, name, kind: 'file', size: m.file.size ?? 0, mtime: mtimeOf(m.file),
        };
      } else {
        yield { relPath: m.relPath, name, kind: 'other' };
      }
    }
  }

  /**
   * A member's bytes as a `File` named after it, decoded by the portfolio's worker once and held for the surface's life.
   * @param {string} relPath
   * @returns {Promise<File>}
   */
  async readFile(relPath) {
    const m = this.members.get(relPath);
    if (!m) throw new Error(`No file in the portfolio is named “${relPath}”.`);
    let pending = this.bytes.get(m.file.key);
    if (!pending) {
      pending = this.doc.getAttachmentBytes(m.file.key);
      this.bytes.set(m.file.key, pending);
      pending.catch(() => this.bytes.delete(m.file.key));
    }
    const buf = await pending;
    return new File([buf], m.relPath, { type: m.file.mimeType || 'application/octet-stream', lastModified: mtimeOf(m.file) });
  }

  /** @param {string} hash @param {ArrayBuffer|Blob} data */
  async writeSidecar(hash, data) {
    this.sidecars.set(hash, data instanceof Blob ? await data.arrayBuffer() : data);
  }

  /** @param {string} hash @returns {Promise<?ArrayBuffer>} */
  async readSidecar(hash) {
    return this.sidecars.get(hash) ?? null;
  }

  /** @param {string} hash @returns {Promise<?number>} */
  async sidecarSize(hash) {
    return this.sidecars.get(hash)?.byteLength ?? null;
  }

  /** @param {string} hash */
  async deleteSidecar(hash) {
    this.sidecars.delete(hash);
  }

  /** @param {string} hash @returns {Promise<boolean>} Whether there was a sidecar to back up. */
  async backupSidecar(hash) {
    const data = this.sidecars.get(hash);
    if (!data) return false;
    this.sidecarBackups.set(hash, data);
    return true;
  }

  /** @param {string} hash @returns {Promise<boolean>} Whether a backup existed. */
  async restoreSidecarBackup(hash) {
    const data = this.sidecarBackups.get(hash);
    if (!data) return false;
    this.sidecars.set(hash, data);
    this.sidecarBackups.delete(hash);
    return true;
  }

  /** @param {string} hash */
  async deleteSidecarBackup(hash) {
    this.sidecarBackups.delete(hash);
  }

  /** @param {string} hash @param {string} text */
  async writeTextCache(hash, text) {
    this.textCache.set(hash, text);
  }

  /** @param {string} hash @returns {Promise<?string>} */
  async readTextCache(hash) {
    return this.textCache.get(hash) ?? null;
  }

  /** @param {string} hash */
  async deleteTextCache(hash) {
    this.textCache.delete(hash);
  }

  /** @param {string} hash @param {Blob} blob */
  async writeThumb(hash, blob) {
    this.thumbs.set(hash, blob);
  }

  /** @param {string} hash @returns {Promise<?Blob>} */
  async readThumb(hash) {
    return this.thumbs.get(hash) ?? null;
  }

  /** @param {string} hash */
  async deleteThumb(hash) {
    this.thumbs.delete(hash);
  }

  /** @param {string} hash @param {number} n @param {Blob} blob */
  async writePageRaster(hash, n, blob) {
    let pages = this.rasters.get(hash);
    if (!pages) {
      pages = new Map();
      this.rasters.set(hash, pages);
    }
    this.rasterBytes = (this.rasterBytes ?? 0) - (pages.get(n)?.size ?? 0) + blob.size;
    pages.set(n, blob);
  }

  /** @param {string} hash @param {number} n @returns {Promise<?Blob>} */
  async readPageRaster(hash, n) {
    return this.rasters.get(hash)?.get(n) ?? null;
  }

  /** @param {string} hash */
  async deletePageRasters(hash) {
    const pages = this.rasters.get(hash);
    if (!pages) return;
    for (const blob of pages.values()) this.rasterBytes = (this.rasterBytes ?? 0) - blob.size;
    this.rasters.delete(hash);
  }

  /** @param {Object} indexData */
  async writeSearchIndex(indexData) {
    this.searchIndex = indexData;
  }

  /** @returns {Promise<?Object>} */
  async readSearchIndex() {
    return this.searchIndex;
  }

  /**
   * Drop artifacts no manifest entry references and recount the raster bytes.
   * @param {import('./libraryStore.js').LibraryManifest} manifest
   */
  async sweepArtifacts(manifest) {
    const live = new Set(Object.values(manifest.docs).map((e) => e.hash).filter(Boolean));
    for (const map of [this.sidecars, this.sidecarBackups, this.textCache, this.thumbs, this.rasters]) {
      for (const hash of [...map.keys()]) if (!live.has(hash)) map.delete(hash);
    }
    let total = 0;
    for (const pages of this.rasters.values()) for (const blob of pages.values()) total += blob.size;
    this.rasterBytes = total;
  }

  // A portfolio holds what its author put in it, so the folder operations throw.

  // eslint-disable-next-line class-methods-use-this
  async importSourceFile() {
    throw new Error('A portfolio is read-only.');
  }

  // eslint-disable-next-line class-methods-use-this
  async moveFile() {
    throw new Error('A portfolio is read-only.');
  }

  // eslint-disable-next-line class-methods-use-this
  async createDir() {
    throw new Error('A portfolio is read-only.');
  }

  // eslint-disable-next-line class-methods-use-this
  async renameDir() {
    throw new Error('A portfolio is read-only.');
  }

  // eslint-disable-next-line class-methods-use-this
  async dirAt() {
    throw new Error('A portfolio is read-only.');
  }
}
