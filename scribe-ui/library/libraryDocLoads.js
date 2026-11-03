// How documents in the document library reach the viewer.
// A gate here holds background raster work back while the reader waits on a load.

import scribeLib from '../../scribe.js';
import { openDocumentFromFile } from '../js/controls/tools.js';
import { titleOf } from './libraryStore.js';

/** Width of a thumbnail rail image, as the image store renders one. */
const THUMBNAIL_W = 300;

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
   * @param {string} relPath
   * @param {import('./libraryStore.js').LibraryDocEntry} entry
   * @param {number} pageN
   * @returns {Promise<import('../js/seedDoc.js').ProvisionalSeed>}
   */
  const makeSeed = async (relPath, entry, pageN) => {
    const { hash } = entry;
    if (!hash || !entry.pageDims) throw new Error('A document seeds only once it is indexed.');
    const ref = { relPath, entry, hash };
    const [header, pixels] = await Promise.all([sessions.header(hash), sessions.pixels(ref)]);
    const pageCount = entry.pageDims.length;
    /** @param {Object} a */
    const copyAnnot = (a) => ({ ...a, bbox: { ...a.bbox } });
    return {
      pageCount,
      pageDims: entry.pageDims.map(([width, height, rotation]) => ({ width, height, rotation })),
      initialPage: pageN,
      window: { from: Math.max(0, pageN - 2), to: Math.min(pageCount - 1, pageN + 2) },
      name: titleOf(relPath),
      pdfType: entry.pdfType ?? null,
      raster: (n) => sessions.raster(ref, n, true),
      render: (n, width) => sessions.renderAt(ref, n, width),
      ocr: (n) => engine.pages(hash, [n]).then((views) => views[0]),
      // Copies, because the seed's edits must not leak into the cached header.
      // A page the saved header lists, even as empty, replaces the real page at the swap, so removals count.
      // Without a sidecar the baseline is the PDF's own annotations, which is what hydration lifts too.
      annots: (n) => (header?.annotations ? Promise.resolve((header.annotations[n] ?? []).map(copyAnnot)) : pixels.liftPdfAnnotations(n)),
      thumb: (n) => sessions.pixels(ref).then((d) => d.images.renderThumbnail(n, THUMBNAIL_W)),
      find: findThroughIndex(hash),
      outline: header?.outline ?? pixels.outline ?? [],
      // Without a sidecar the text is extracted before the open resolves, so the real document arrives with its text, as the modes that asked for it expect.
      load: () => openLibraryDoc(/** @type {import('./libraryStore.js').LibraryStore} */ (getStore()), relPath, entry),
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
