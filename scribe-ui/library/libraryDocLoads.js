// How documents in the document library reach the viewer.
// A gate here holds background raster work back while the reader waits on a load.

import scribeLib from '../../scribe.js';
import { writeSavedDoc } from '../../js/export/writeSavedDoc.js';
import { openDocumentFromFile } from '../js/controls/tools.js';
import { matchByPlace } from '../js/viewerSearch.js';
import { titleOf } from './libraryStore.js';

/**
 * @typedef {Array<{page: number, tier: number, count: number, marks: Array<[number, number]>}>} NearMatches
 *   The near matches of a clicked result row.
 */

/**
 * Open a document from the document library.
 * @param {{readFile: (relPath: string) => Promise<File>, recordsBlob: (hash: string) => Promise<?Blob>, sidecarBlob: (hash: string) => Promise<?Blob>,
 *   writeRecords: (hash: string, blob: Blob) => Promise<void>}} store
 * @param {string} relPath
 * @param {import('./libraryStore.js').LibraryDocEntry} entry
 * @param {{deferText?: boolean, skipFontOpt?: boolean, pdfWorkerN?: number, sessions?: ?import('./docSession.js').DocSessions}} [opts]
 * @returns {Promise<import('../../js/containers/scribeDoc.js').ScribeDoc>}
 */
export const openLibraryDoc = async (store, relPath, entry, {
  deferText = false, skipFontOpt = false, pdfWorkerN = undefined, sessions = null,
} = {}) => {
  const file = await store.readFile(relPath);
  const thumbCache = sessions && entry.hash ? sessions.thumbCache({ hash: entry.hash, relPath, entry }, file) : null;
  let records = entry.hash ? await store.recordsBlob(entry.hash) : null;
  const work = entry.hash ? await store.sidecarBlob(entry.hash) : null;
  /** @type {?import('../../js/containers/scribeDoc.js').ScribeDoc} */
  let doc = null;
  if (!records) {
    const ocrFile = entry.ocrFile ? await store.readFile(`${relPath.slice(0, relPath.lastIndexOf('/') + 1)}${entry.ocrFile}`).catch(() => null) : null;
    // The viewer's open, because its fallback makes a scan's own OCR layer the active text.
    doc = await openDocumentFromFile(file, {
      deferText: deferText && !work, skipFontOpt, pdfWorkerN, ocrFiles: ocrFile ? [ocrFile] : [],
    });
    if (work) {
      records = new Blob((await writeSavedDoc(doc)).parts);
      await store.writeRecords(/** @type {string} */ (entry.hash), records);
      await doc.close();
      doc = null;
    }
  }
  if (!doc) {
    doc = await scribeLib.openDocument({ pdfFiles: [file] }, {
      pdfWorkerN, saved: { records: /** @type {Blob} */ (records), work, pageDims: entry.pageDims?.map(([width, height]) => [width, height]) },
    });
    if (!deferText) await doc.textReady;
  }
  doc.images.setThumbCache(await thumbCache);
  return doc;
};

/**
 * @param {Object} deps
 * @param {import('./docSession.js').DocSessions} deps.sessions
 * @param {ReturnType<typeof import('./search/searchClient.js').createSearchClient>} deps.engine
 * @param {() => ?import('./libraryStore.js').LibraryStore} deps.getStore
 */
export function createDocLoads({ sessions, engine, getStore }) {
  /** Count of loads the user is actively waiting on. */
  let userLoadsActive = 0;
  /** @type {Array<() => void>} */
  const userIdleWaiters = [];
  const beginUserLoad = () => { userLoadsActive++; };
  const endUserLoad = () => {
    userLoadsActive = Math.max(0, userLoadsActive - 1);
    if (userLoadsActive === 0) while (userIdleWaiters.length) /** @type {() => void} */ (userIdleWaiters.shift())();
  };
  const userLoadIdle = () => (userLoadsActive === 0 ? Promise.resolve() : new Promise((resolve) => { userIdleWaiters.push(resolve); }));

  /**
   * @param {string} relPath
   * @param {import('./libraryStore.js').LibraryDocEntry} entry
   * @param {number} pageN
   */
  const persistRasterWindow = (relPath, entry, pageN) => {
    const store = getStore();
    if (!store || !entry?.hash || !entry.pageDims) return;
    const ref = { relPath, entry, hash: entry.hash };
    const pageCount = entry.pageDims.length;
    (async () => {
      for (let n = Math.max(0, pageN - 2); n <= Math.min(pageCount - 1, pageN + 2); n++) {
        await userLoadIdle();
        await sessions.raster(ref, n, true);
      }
    })().catch(() => {});
  };

  /** @type {?{hash: string, query: string, near: NearMatches}} */
  let handoff = null;

  /**
   * @param {string} hash
   * @param {import('../../js/containers/scribeDoc.js').ScribeDoc} doc
   * @returns {(query: string) => Promise<Array<{pageN: number, wordIds: Array<string>}>>}
   */
  const findThroughIndex = (hash, doc) => async (query) => {
    await doc.textReady;
    const store = doc.pageStore;
    const saved = doc._saved;
    // The index does not hold every open document, as while it is rebuilt.
    if (!saved || !(await engine.hasDoc(hash))) return scribeLib.utils.ocr.getDocMatches(query, store.pageList());
    const found = await engine.find(hash, query, handoff && handoff.hash === hash && handoff.query === query ? handoff.near : []);
    const asIndexed = (/** @type {number} */ n) => {
      const record = store.cleanRecord(n);
      return !!record && saved.keyOf.get(record) === saved.keys[n];
    };
    const scanned = [];
    for (let n = 0; n < store.slotCount(); n++) if (store.hasPage(n, 'active') && !asIndexed(n)) scanned.push(store.readOnlyPage(n));
    const matches = found.pages.filter((p) => asIndexed(p.page)).flatMap((p) => p.matches.map((places) => matchByPlace(doc, p.page, places)));
    if (!scanned.length) return matches;
    return [...matches, ...scribeLib.utils.ocr.getDocMatches(query, scanned)].sort((a, b) => a.pageN - b.pageN);
  };

  /**
   * Open an indexed document for a viewer tab and return its provisional seed.
   * @param {string} relPath
   * @param {import('./libraryStore.js').LibraryDocEntry} entry
   * @param {number} pageN
   * @returns {Promise<import('../basic-viewer/pdf-viewer.js').ProvisionalSeed>}
   */
  const makeSeed = async (relPath, entry, pageN) => {
    const { hash } = entry;
    if (!hash || !entry.pageDims) throw new Error('A document seeds only once it is indexed.');
    const ref = { relPath, entry, hash };
    /** @type {(err: unknown) => void} */
    let fail = () => {};
    const failed = new Promise((resolve) => { fail = resolve; });
    const doc = await sessions.openForTab(ref, fail);
    const edited = () => !!(/** @type {typeof doc & {_libraryEdited?: boolean}} */ (doc))._libraryEdited;
    return {
      doc,
      initialPage: Math.min(pageN, doc.pageMetrics.length - 1),
      name: titleOf(relPath),
      raster: (n) => (edited() ? null : sessions.pageImage(hash, n)),
      rendered: (n, bitmap) => { if (!edited()) sessions.storeFromBitmap(ref, n, bitmap).catch(() => {}); },
      find: findThroughIndex(hash, doc),
      failed,
    };
  };

  return {
    persistRasterWindow,
    makeSeed,
    findThroughIndex,
    /**
     * @param {string} hash
     * @param {string} query
     * @param {NearMatches} near
     */
    handOver: (hash, query, near) => { handoff = { hash, query, near }; },
    beginUserLoad,
    endUserLoad,
    userLoadIdle,
    userLoadActive: () => userLoadsActive > 0,
  };
}
