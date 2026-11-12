// How documents in the document library reach the viewer.
// A gate here holds background raster work back while the reader waits on a load.

import scribeLib from '../../scribe.js';
import { openDocumentFromFile } from '../js/controls/tools.js';
import { titleOf } from './libraryStore.js';

/**
 * @typedef {Array<{page: number, tier: number, count: number, marks: Array<[number, number]>}>} NearMatches
 *   The near matches of a clicked result row.
 */

/**
 * Open a document from the document library as the ingest read it.
 * With a sidecar, the sidecar supplies the text and the saved work.
 * Without one the document opens from its source file with the OCR file the ingest used, if any.
 * @param {{readFile: (relPath: string) => Promise<File>, readSidecar: (hash: string) => Promise<?ArrayBuffer>}} store
 * @param {string} relPath
 * @param {import('./libraryStore.js').LibraryDocEntry} entry
 * @param {{deferText?: boolean, skipFontOpt?: boolean, pdfWorkerN?: number}} [opts]
 * @returns {Promise<import('../../js/containers/scribeDoc.js').ScribeDoc>}
 */
export const openLibraryDoc = async (store, relPath, entry, { deferText = false, skipFontOpt = false, pdfWorkerN = undefined } = {}) => {
  const file = await store.readFile(relPath);
  const sidecar = entry.hash ? await store.readSidecar(entry.hash) : null;
  if (sidecar) return scribeLib.openDocument([file, new File([sidecar], `${entry.hash}.scribe`)], { deferText, skipFontOpt, pdfWorkerN });
  const ocrFile = entry.ocrFile ? await store.readFile(`${relPath.slice(0, relPath.lastIndexOf('/') + 1)}${entry.ocrFile}`).catch(() => null) : null;
  // The viewer's open, because its fallback makes a scan's own OCR layer the active text.
  return openDocumentFromFile(file, {
    deferText, skipFontOpt, pdfWorkerN, ocrFiles: ocrFile ? [ocrFile] : [],
  });
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
   * @returns {(query: string) => Promise<Array<{pageN: number, wordIds: Array<string>}>>}
   */
  const findThroughIndex = (hash) => (query) => engine.find(hash, query, handoff && handoff.hash === hash && handoff.query === query ? handoff.near : [])
    .then((r) => r.pages.flatMap((p) => p.matches.map((wordIds) => ({ pageN: p.page, wordIds }))));

  /**
   * Builds the seed that opens a document for on-demand loading, with what it shows before it loads.
   * @param {string} relPath
   * @param {import('./libraryStore.js').LibraryDocEntry} entry
   * @param {number} pageN
   * @returns {Promise<import('../basic-viewer/pdf-viewer.js').ProvisionalSeed>}
   */
  const makeSeed = async (relPath, entry, pageN) => {
    const { hash } = entry;
    if (!hash || !entry.pageDims) throw new Error('A document seeds only once it is indexed.');
    const ref = { relPath, entry, hash };
    const [header, doc] = await Promise.all([sessions.header(hash), sessions.takePixels(ref)]);
    const pageCount = doc.pageMetrics.length;
    const edited = () => !!(/** @type {typeof doc & {_libraryEdited?: boolean}} */ (doc))._libraryEdited;
    return {
      doc,
      initialPage: Math.min(pageN, pageCount - 1),
      window: { from: Math.max(0, pageN - 2), to: Math.min(pageCount - 1, pageN + 2) },
      name: titleOf(relPath),
      raster: (n) => (edited() ? null : sessions.pageImage(hash, n)),
      rendered: (n, bitmap) => { if (!edited()) sessions.storeFromBitmap(ref, n, bitmap).catch(() => {}); },
      ocr: (n) => engine.pages(hash, [n]).then((views) => views[0]),
      // A saved file's annotations are all in place at open.
      annots: header?.annotations ? undefined : (n) => doc.liftPdfAnnotations(n),
      find: findThroughIndex(hash),
      hydration: 'on-demand',
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
