// The library's preview of the selected document, which the main viewer shows in the library's pane.
// Seeding from stored page rasters and sidecars is what lets a reader flip through documents without paying for a full load each time.

import scribeLib from '../../scribe.js';
import { openDocumentFromFile } from '../js/controls/tools.js';
import {
  RASTER_STORE_MIN_MS, renderPageRaster, WARM_PDF_LIMIT, WARM_SIDECAR_LIMIT,
} from './libraryIngest.js';
import { titleOf } from './libraryStore.js';

/**
 * Word boxes for every occurrence of the query on a page, for painting match marks over a render.
 * Accepts a live `OcrPage` or a raw sidecar page.
 * @param {?{n: number, lines: Array<{words: Array<{id: string, text: string, bbox: {left: number, top: number, right: number, bottom: number}}>}>, dims?: {width: number, height: number}}} page
 * @param {?{width: number, height: number}} dims - Page dimensions when the page object carries none.
 * @param {string} query
 * @returns {?{dims: {width: number, height: number}, rects: Array<{left: number, top: number, right: number, bottom: number}>, per: number}}
 */
export const getMatchRects = (page, dims, query) => {
  if (!page || !Array.isArray(page.lines) || !dims) return null;
  const matches = scribeLib.utils.ocr.getDocMatches(query, [page]);
  if (!matches.length) return null;
  const boxes = new Map();
  for (const line of page.lines) for (const w of (line.words || [])) if (w && w.bbox) boxes.set(w.id, w.bbox);
  const rects = [];
  for (const m of matches) for (const id of m.wordIds) if (boxes.has(id)) rects.push(boxes.get(id));
  return { dims: page.dims || dims, rects, per: matches[0].wordIds.length };
};

/**
 * @param {?ReturnType<typeof getMatchRects>} m
 * @returns {string} Absolutely positioned percent-unit mark spans, the first occurrence in the active color.
 */
export const markOverlayHTML = (m) => {
  if (!m || !m.rects.length) return '';
  let html = '';
  for (let i = 0; i < m.rects.length; i++) {
    const r = m.rects[i];
    const act = i < m.per ? ' act' : '';
    html += `<span class="scribe-mark${act}" style="left:${(r.left / m.dims.width) * 100}%;top:${(r.top / m.dims.height) * 100}%;`
      + `width:${((r.right - r.left) / m.dims.width) * 100}%;height:${((r.bottom - r.top) / m.dims.height) * 100}%;"></span>`;
  }
  return html;
};

/**
 * What the preview is showing.
 * @typedef {Object} PreviewTarget
 * @property {string} relPath
 * @property {string} hash
 * @property {import('./libraryStore.js').LibraryDocEntry} entry
 * @property {number} pageN
 * @property {?string} query
 * @property {string} title
 * @property {boolean} [jump] - Land on a far page by re-seeding; without it, a page outside the seeded window accelerates the full load as scrolling there would.
 */

/**
 * The record standing in for a tab while a document is a preview.
 * The hydration swap writes the loaded document into `doc`, and the library's dirty tracking marks `libraryDirty`.
 * @typedef {Object} PreviewRecord
 * @property {Object} doc
 * @property {boolean} provisional
 * @property {boolean} libraryDirty
 * @property {?Object} tab - The lane tab that owns the document, when the preview shows a tab's document.
 * @property {?{primed: Promise<void>, hydrated: Promise<void>, cancel: () => void}} handle
 * @property {?{from: number, to: number}} window - The seeded page window.
 * @property {?{current: ?Object}} [holderRef] - The hydration swap's holder reference, moved onto the tab when the preview is pinned.
 * @property {(doc: Object) => void} [onDocHydrated]
 */

/**
 * Own the library's preview in the main viewer.
 * @param {Object} deps
 * @param {import('../basic-viewer/pdf-viewer.js').ScribePDFViewer} deps.viewer
 * @param {import('./docSession.js').DocSessions} deps.sessions
 * @param {() => ?import('./libraryStore.js').LibraryStore} deps.getStore
 * @param {() => ?import('./libraryStore.js').LibraryManifest} deps.getManifest
 * @param {() => void} deps.onRastersStored - Fires after a raster window lands, so blank rows elsewhere can retry.
 * @param {() => void} deps.saveManifestSoon - Debounced manifest write, for measurements recorded on entries.
 * @param {(hash: string, doc: Object) => void} [deps.onSidecarSaved] - Fires after a preview checkpoint writes a sidecar, so the manifest and search index can follow the edited document.
 * @param {() => void} deps.ensureLit - Light the library's tab in its split form before a document is attached as the preview.
 * @param {(state: 'empty'|'loading'|'ready'|'error', text?: string) => void} deps.onState - The document area's state, for the host's hint over it.
 * @param {(doc: Object, target: PreviewRecord) => void} deps.trackEdits - Route the document's mutations to `target.libraryDirty`.
 */
export function createPreview({
  viewer, sessions, getStore, getManifest, onRastersStored, saveManifestSoon, onSidecarSaved, ensureLit, onState, trackEdits,
}) {
  /**
   * The pooled live document for a legacy entry that cannot seed (no stored pageDims), loading it on first use.
   * @param {string} relPath
   * @param {string} hash
   */
  const sessionDoc = (relPath, hash) => sessions.liveDocOrLoad(
    // Pending entries all carry an empty hash, and one shared pool key would hand every one of them the first loaded document.
    hash || relPath,
    () => /** @type {import('./libraryStore.js').LibraryStore} */ (getStore()).readFile(relPath).then((file) => openDocumentFromFile(file)),
  );

  /** @type {?Promise<void>} Import of the in-flight preview hydration, so upgrades start at most one at a time. */
  let hydrationBusy = null;

  /**
   * Count of imports the user is actively waiting on, such as a preview hydration or an open.
   * Background raster work pauses while this is nonzero.
   */
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
   * Count a provisional document's eventual hydration as a user-facing load, and measure it.
   * Wraps `_requestHydration` so every trigger (selection, scroll, promotion, save) pauses background warming for its duration.
   * A hydration request runs a cold open through to the first render, so its duration is recorded as the document's `firstPaintMs`.
   * @param {Object} seedDoc
   * @param {{relPath: string}} target
   */
  const countHydration = (seedDoc, target) => {
    const inner = seedDoc._requestHydration;
    if (!inner) return;
    let counted = false;
    seedDoc._requestHydration = () => {
      const p = inner();
      if (!counted) {
        counted = true;
        beginUserLoad();
        const t0 = performance.now();
        const track = Promise.resolve(p).then(() => {
          const entry = getManifest()?.docs[target.relPath];
          if (entry) {
            entry.firstPaintMs = Math.round(performance.now() - t0);
            saveManifestSoon();
          }
        }).catch(() => {}).finally(() => {
          endUserLoad();
          if (hydrationBusy === track) hydrationBusy = null;
        });
        hydrationBusy = track;
      }
      return p;
    };
  };

  /**
   * Persist the two pages either side of `pageN` from an open document, so the next open of that spot paints instantly.
   * Skipped when the document's pages were edited, since stored rasters are keyed by the ingested page order.
   * @param {Object} doc
   * @param {import('./libraryStore.js').LibraryDocEntry} entry
   * @param {number} pageN
   */
  const persistRasterWindow = (doc, entry, pageN) => {
    const d = /** @type {import('../../js/containers/scribeDoc.js').ScribeDoc} */ (doc);
    const store = getStore();
    if (!store || !entry?.hash || !d || d.id < 0) return;
    if (d.pageMetrics.length !== entry.pageCount) return;
    // These renders run on an already-open document, so timing them here would understate a cold first paint.
    if (entry.firstPaintMs !== undefined && entry.firstPaintMs < RASTER_STORE_MIN_MS) return;
    if (store.rasterBytes !== null && store.rasterBytes > store.rasterBudget) return;
    const s = store;
    const { hash, pageCount } = entry;
    (async () => {
      for (let n = Math.max(0, pageN - 2); n <= Math.min(pageCount - 1, pageN + 2); n++) {
        await userLoadIdle();
        if (await s.readPageRaster(hash, n)) continue;
        const raster = await renderPageRaster(d, n);
        if (raster) await s.writePageRaster(hash, n, raster);
      }
      // Freshly persisted pages may belong to blank search-result rows.
      onRastersStored();
    })().catch(() => {});
  };

  /**
   * Build a provisional seed for a page of a library document.
   * Hydration stays on-demand so that flipping through documents never pays for a full import.
   * @param {string} relPath
   * @param {import('./libraryStore.js').LibraryDocEntry} entry
   * @param {number} pageN
   * @returns {Promise<import('../js/seedDoc.js').ProvisionalSeed>}
   */
  const makeSeed = async (relPath, entry, pageN) => {
    const load = async () => {
      const pdfFile = await /** @type {import('./libraryStore.js').LibraryStore} */ (getStore()).readFile(relPath);
      const files = [pdfFile];
      if (entry.hash) {
        const sidecar = await /** @type {import('./libraryStore.js').LibraryStore} */ (getStore()).readSidecar(entry.hash);
        if (sidecar) files.push(new File([sidecar], `${entry.hash}.scribe`));
      }
      return files;
    };
    if (entry.pageDims && !sessions.hasLive(entry.hash)) {
      const pageCount = entry.pageDims.length;
      const from = Math.max(0, pageN - 2);
      const to = Math.min(pageCount - 1, pageN + 2);
      // One pass warms the whole seed window, so the per-page reads below hit the cache instead of each re-reading the sidecar.
      sessions.sidecarPages(entry.hash, Array.from({ length: to - from + 1 }, (_, i) => from + i)).catch(() => {});
      return {
        pageCount,
        pageDims: entry.pageDims.map(([width, height, rotation]) => ({ width, height, rotation })),
        initialPage: pageN,
        window: { from, to },
        name: titleOf(relPath),
        raster: (n) => /** @type {import('./libraryStore.js').LibraryStore} */ (getStore()).readPageRaster(entry.hash, n),
        ocr: (n) => sessions.sidecarPages(entry.hash, [n]).then((m) => m.get(n)?.ocr ?? null),
        // Copies, never the cached arrays: seed session edits must not leak into the cache.
        annots: (n) => sessions.sidecarPages(entry.hash, [n]).then((m) => {
          const side = m.get(n);
          return side ? (side.annotations ?? []).map((a) => ({ ...a, bbox: { ...a.bbox } })) : null;
        }),
        load,
        hydration: 'on-demand',
      };
    }
    beginUserLoad();
    /** @type {import('../../js/containers/scribeDoc.js').ScribeDoc} */
    let doc;
    try {
      doc = await sessionDoc(relPath, entry.hash);
    } finally {
      endUserLoad();
    }
    const pageCount = doc.pageMetrics.length;
    return {
      pageCount,
      pageDims: doc.pageMetrics.map((pm) => ({ width: pm.dims.width, height: pm.dims.height, rotation: pm.rotation || 0 })),
      initialPage: pageN,
      window: { from: Math.max(0, pageN - 2), to: Math.min(pageCount - 1, pageN + 2) },
      name: titleOf(relPath),
      raster: (n) => sessions.pageImage(entry.hash, n),
      ocr: async (n) => (await sessionDoc(relPath, entry.hash)).ocr.active?.[n] ?? null,
      annots: async (n) => ((await sessionDoc(relPath, entry.hash)).annotations.pages[n] ?? [])
        .map((a) => ({ ...a, bbox: { ...a.bbox } })),
      load,
      hydration: 'on-demand',
    };
  };

  let token = 0;
  /** @type {?string} Selection key (path, page, query) of the show in flight, so identical replays do not restart it. */
  let showBusyKey = null;
  /** @type {?{relPath: string, hash: string, pageN: number, query: ?string, record: PreviewRecord, anchorTop?: ?number}} The shown target. */
  let current = null;
  /** @type {?PreviewRecord} The record of the document this controller has attached to the viewer, until something displaces it. */
  let attached = null;
  /** @type {?PreviewTarget} The last target shown, which an Open leaves in place for the return. */
  let lastTarget = null;

  /**
   * A record for a document the preview shows.
   * @param {Object} doc
   * @param {?Object} tab
   * @returns {PreviewRecord}
   */
  const recordFor = (doc, tab = null) => ({
    doc, provisional: doc.id < 0, libraryDirty: false, tab, handle: null, window: null,
  });

  /**
   * Let go of a record's document once the viewer no longer shows it.
   * A tab's document stays the tab's, a clean hydrated document returns to the session pool, and one with session edits is saved to its sidecar first.
   * A still-provisional document with edits finishes loading first, since the swap into the real document is what carries its annotations.
   * @param {?PreviewRecord} rec
   * @param {?string} hash
   */
  const release = (rec, hash) => {
    if (!rec || rec.tab) return;
    const { doc } = rec;
    if (viewer.doc === doc) return;
    const store = getStore();
    const dirty = rec.libraryDirty;
    rec.libraryDirty = false;
    if (!dirty && hash && doc.id >= 0) {
      sessions.adoptLive(hash, doc);
      return;
    }
    if (!dirty || !hash || !store) {
      rec.handle?.cancel();
      doc.close().catch(() => {});
      return;
    }
    (async () => {
      /** @type {?Object} */
      let real = null;
      try {
        real = doc.id < 0 ? await /** @type {any} */ (doc)._requestHydration() : doc;
        await store.writeSidecar(hash, await /** @type {any} */ (real).exportData('scribe', { scribeSession: true, includeCharBoxesScribe: false }));
        sessions.dropSidecar(hash);
        sessions.adoptLive(hash, /** @type {import('../../js/containers/scribeDoc.js').ScribeDoc} */ (real));
        onSidecarSaved?.(hash, /** @type {Object} */ (real));
      } catch {
        await /** @type {any} */ (real || doc).close?.();
      }
    })().catch(() => {});
  };

  /**
   * Put `rec`'s document on screen as the preview, veiling the switch until its landing page has painted, then let go of whatever it displaced.
   * @param {PreviewRecord} rec
   * @param {PreviewTarget} target
   * @param {?string} displacedHash
   */
  const attach = async (rec, target, displacedHash) => {
    const displaced = attached;
    attached = rec;
    if (viewer.doc !== rec.doc) {
      const veil = viewer.doc ? viewer._buildSwapVeil() : null;
      try {
        await viewer.attachPreview(rec.doc, target.pageN, target.title);
        if (veil) {
          const pc = viewer.scribe.imageCache.pageCanvases[viewer.scribe.state.cp.n];
          if (pc) await Promise.race([pc, new Promise((r) => { setTimeout(r, 2000); })]);
          await new Promise((r) => { requestAnimationFrame(() => r(null)); });
        }
      } finally {
        veil?.remove();
      }
    } else {
      await viewer.attachPreview(rec.doc, target.pageN, target.title);
    }
    if (displaced && displaced !== rec) release(displaced, displacedHash);
  };

  /**
   * Land on the target page and paint (or clear) the query's match marks.
   * A seeded document only has words for its window pages, so the marks stay partial until hydration re-runs this.
   * @param {{pageN: number, query: ?string}} target
   */
  const applyQueryAndPage = async (target) => {
    const s = viewer.scribe;
    const bar = viewer._searchBar;
    if (target.query && bar) {
      if (!s.state.searchMode) {
        // Opening would run any query left in the field before the landing search below replaces it.
        bar.searchInputElem.value = '';
        await bar.openSearch({ focus: false });
      }
      bar.searchInputElem.value = target.query;
      await bar.runSearch(target.query, target.pageN);
      if (s._searchState.matchList.length) return;
    } else if (s.state.searchMode && bar) bar.closeSearch();
    await s.displayPage(target.pageN, true, false);
  };

  /**
   * Start the shown provisional document's full load, deferring while another preview hydration is still importing.
   * @param {number} t
   * @param {{hash: string, pageN: number}} target
   */
  const hydrate = (t, target) => {
    if (!(t === token && current && viewer.doc === current.record.doc && current.record.doc.id < 0)) return;
    if (hydrationBusy) {
      hydrationBusy.then(() => hydrate(t, target));
      return;
    }
    getStore()?.readPageRaster(target.hash, target.pageN).then((raster) => {
      if (!raster && t === token && current && viewer.doc === current.record.doc && current.record.doc.id < 0) onState('loading');
    }).catch(() => {});
    /** @type {any} */ (current.record.doc)._requestHydration?.();
  };

  /**
   * Start the shown target's upgrade to the real document.
   * The stored raster keeps painting, and hydration swaps the real render in underneath.
   * A document past the warm-lane size caps never loads automatically, so its preview waits for an explicit Open.
   * @param {PreviewTarget} target
   * @param {number} t
   */
  const requestUpgrade = async (target, t) => {
    const store = getStore();
    if (!store || !current || current.record.doc.id >= 0) return;
    if (target.entry.size > WARM_PDF_LIMIT) return;
    const sidecarBytes = await store.sidecarSize(target.hash);
    if (sidecarBytes !== null && sidecarBytes > WARM_SIDECAR_LIMIT) return;
    if (t !== token) return;
    hydrate(t, target);
  };

  /** Clear the preview, emptying the pane and letting go of the shown document. */
  const showEmpty = () => {
    token++;
    showBusyKey = null;
    const prev = current;
    current = null;
    lastTarget = null;
    viewer.detachPreview();
    if (attached) {
      release(attached, prev ? prev.hash : null);
      attached = null;
    }
    onState('empty');
  };

  /**
   * Show a page of a library document in the viewer, painting match marks when a query is given.
   * @param {PreviewTarget} target
   */
  const show = async (target) => {
    ensureLit();
    // Host re-renders and ingest churn replay the shown target, so one selection reaches here many times over.
    // A replay must never restart the show in flight for it, because under load the restarts outpace the paints and the viewer stays stuck on the previous document.
    const selKey = `${target.relPath}|${target.pageN}|${target.query ?? ''}`;
    if (showBusyKey === selKey) return;
    const t = ++token;
    showBusyKey = selKey;
    // Pending documents all carry an empty hash, so an empty hash identifies a document only together with its path.
    const sameDoc = !!(current && current.hash === target.hash && (target.hash || current.relPath === target.relPath));
    const changed = !sameDoc || !current || current.pageN !== target.pageN || current.query !== target.query;
    lastTarget = target;
    // Background warming yields for the whole show, because the seed build and priming run before any hydration exists to count.
    beginUserLoad();
    try {
      const s = viewer.scribe;
      // Clicking a result on a far page of the same provisional document re-seeds around that page instead of forcing the full load.
      const jumpOutsideSeed = !!(current && sameDoc && current.record.doc.id < 0
        && target.jump && current.record.window
        && (target.pageN < current.record.window.from || target.pageN > current.record.window.to));
      if (current && sameDoc && viewer.doc === current.record.doc && !jumpOutsideSeed && s.zoomLevel > 0) {
        // A re-render landing on the same page and query must leave the reader's scroll and paint untouched.
        const samePlace = !changed;
        current.pageN = target.pageN;
        current.query = target.query;
        // A folder rename or move can re-path the same document, and the hydration write-back looks its entry up by path.
        current.relPath = target.relPath;
        if (samePlace) return;
        if (current.record.handle) await current.record.handle.primed;
        if (t !== token) return;
        await applyQueryAndPage(target);
        current.anchorTop = s.scrollContainer.scrollTop;
        const entry = getManifest()?.docs[target.relPath];
        if (current.record.doc.id >= 0 && entry) persistRasterWindow(current.record.doc, entry, target.pageN);
        else if (!current.record.tab) requestUpgrade(target, t);
        return;
      }
      const prevHash = current ? current.hash : null;
      // A document open in a tab is previewed as itself.
      const liveTab = target.hash
        ? viewer._tabs.find((tab) => tab.libraryHash === target.hash && !tab.asleep)
        : null;
      if (liveTab) {
        const rec = recordFor(liveTab.doc, liveTab);
        rec.provisional = !!liveTab.provisional;
        current = {
          relPath: target.relPath, hash: target.hash, pageN: target.pageN, query: target.query, record: rec,
        };
        await attach(rec, target, prevHash);
        if (t !== token) return;
        await applyQueryAndPage(target);
        current.anchorTop = s.scrollContainer.scrollTop;
        onState('ready');
        const entry = getManifest()?.docs[target.relPath];
        if (entry && liveTab.doc.id >= 0) persistRasterWindow(liveTab.doc, entry, target.pageN);
        return;
      }
      const pooled = sessions.takeLive(target.hash);
      if (pooled) {
        const rec = recordFor(pooled);
        trackEdits(pooled, rec);
        current = {
          relPath: target.relPath, hash: target.hash, pageN: target.pageN, query: target.query, record: rec,
        };
        await attach(rec, target, prevHash);
        if (t !== token) return;
        await applyQueryAndPage(target);
        current.anchorTop = s.scrollContainer.scrollTop;
        onState('ready');
        const entry = getManifest()?.docs[target.relPath];
        if (entry) persistRasterWindow(pooled, entry, target.pageN);
        return;
      }
      // With no raster for the target page a seed could only paint blank pages, so the real document loads directly instead.
      const rastered = target.hash
        ? await /** @type {import('./libraryStore.js').LibraryStore} */ (getStore()).readPageRaster(target.hash, target.pageN)
        : null;
      if (t !== token) return;
      if (!rastered) {
        onState('loading');
        // Serialized so that a flip storm can never hold several full imports at once.
        while (hydrationBusy) {
          await hydrationBusy;
          if (t !== token) return;
        }
        const t0 = performance.now();
        const loadP = (async () => {
          const st = /** @type {import('./libraryStore.js').LibraryStore} */ (getStore());
          const files = [await st.readFile(target.relPath)];
          if (target.hash) {
            const sidecar = await st.readSidecar(target.hash);
            if (sidecar) files.push(new File([sidecar], `${target.hash}.scribe`));
          }
          return scribeLib.openDocument(files, { deferText: true });
        })();
        const track = loadP.then(() => {}, () => {}).finally(() => { if (hydrationBusy === track) hydrationBusy = null; });
        hydrationBusy = track;
        const doc = await loadP;
        if (t !== token) {
          // Abandoned by a later selection, so the document is pooled to keep a return to it free.
          // A pending document has no hash to pool it under and closes instead.
          if (target.hash) sessions.adoptLive(target.hash, doc);
          else doc.close().catch(() => {});
          return;
        }
        const rec = recordFor(doc);
        trackEdits(doc, rec);
        current = {
          relPath: target.relPath, hash: target.hash, pageN: target.pageN, query: target.query, record: rec,
        };
        await attach(rec, target, prevHash);
        if (t !== token) return;
        await applyQueryAndPage(target);
        current.anchorTop = s.scrollContainer.scrollTop;
        onState('ready');
        const entry = getManifest()?.docs[target.relPath];
        if (entry) {
          entry.firstPaintMs = Math.round(performance.now() - t0);
          saveManifestSoon();
          persistRasterWindow(doc, entry, target.pageN);
        }
        return;
      }
      const seed = await makeSeed(target.relPath, target.entry, target.pageN);
      if (t !== token) return;
      const prevRec = current ? current.record : null;
      /** @type {?{pages: Array<Array<Object>>, baseline: Set<number>}} */
      let carried = null;
      if (prevRec && sameDoc && prevRec.doc.id < 0 && prevRec.libraryDirty) {
        // Re-seeding the same edited document carries its unsaved session annotations into the new seed, and the dirty flag stays for the real save.
        const prevDoc = /** @type {any} */ (prevRec.doc);
        carried = {
          pages: prevDoc.annotations.pages.map((page) => page.map((a) => ({ ...a, bbox: { ...a.bbox } }))),
          baseline: new Set(prevDoc._annotBaseline),
        };
        prevRec.libraryDirty = false;
      }
      const baseAnnots = seed.annots;
      const carriedPages = carried;
      /** @type {{current: ?Object}} */
      const holder = { current: null };
      const made = viewer._makeProvisional(carriedPages ? {
        ...seed,
        annots: (n) => (carriedPages.baseline.has(n) || carriedPages.pages[n].length
          ? Promise.resolve(carriedPages.pages[n].map((a) => ({ ...a, bbox: { ...a.bbox } })))
          : Promise.resolve(baseAnnots ? baseAnnots(n) : null)),
      } : seed, holder);
      const rec = recordFor(made.seedDoc);
      rec.libraryDirty = !!carried;
      rec.handle = made;
      rec.window = seed.window;
      rec.holderRef = holder;
      // At adoption time rather than on `hydrated`, so no edit can slip between the swap and dirty tracking.
      rec.onDocHydrated = (d) => trackEdits(d, rec);
      holder.current = rec;
      trackEdits(made.seedDoc, rec);
      countHydration(made.seedDoc, target);
      current = {
        relPath: target.relPath, hash: target.hash, pageN: target.pageN, query: target.query, record: rec,
      };
      await attach(rec, target, prevHash);
      if (t !== token) return;
      // Started before priming rather than after, because priming can stream megabytes of sidecar for a big document.
      requestUpgrade(target, t);
      await made.primed;
      if (t !== token) return;
      await applyQueryAndPage(target);
      current.anchorTop = s.scrollContainer.scrollTop;
      onState('ready');
      made.hydrated.finally(() => {
        if (t === token) onState('ready');
      }).catch(() => {});
      made.hydrated.then(() => {
        if (!(current && current.record === rec && viewer.doc === rec.doc)) return;
        const sc = s.scrollContainer;
        // Once the reader scrolled away from the anchored spot, hydration must not yank them back.
        const readerMoved = current.anchorTop != null && Math.abs(sc.scrollTop - current.anchorTop) > 2;
        if (current.query && viewer._searchBar) {
          // The swap rebuilt the word objects, so re-derive the matches from the real document at whatever page the reader has reached.
          viewer._searchBar.runSearch(current.query, undefined, !readerMoved).then(() => {
            if (!readerMoved && current && current.record === rec) current.anchorTop = sc.scrollTop;
          }).catch(() => {});
        }
        const entry = getManifest()?.docs[current.relPath];
        if (entry) persistRasterWindow(rec.doc, entry, s.state.cp.n);
      }).catch(() => {});
    } catch {
      if (t === token) onState('error', 'This page could not be rendered.');
    } finally {
      if (t === token) showBusyKey = null;
      endUserLoad();
    }
  };

  return {
    show,
    showEmpty,
    /** The hash of the shown document, or null. */
    shownHash: () => (current ? current.hash : null),
    /** The last target shown, which an Open leaves in place for the return. */
    lastTarget: () => lastTarget,
    /** Whether `doc` is the document this preview attached and still owns. */
    owns: (doc) => !!(attached && attached.doc === doc && !attached.tab),

    /**
     * Adopt the document already on screen as the preview of `target`, when it is that document, and report whether it was.
     * The lane tab that owns it stays its owner, so Open on it activates that tab.
     * @param {PreviewTarget} target
     * @returns {boolean}
     */
    adoptAttached: (target) => {
      const { doc } = viewer;
      if (!doc) return false;
      const tab = viewer._activeTab >= 0 ? viewer._tabs[viewer._activeTab] : null;
      const ownTab = tab && tab.doc === doc && tab.libraryHash && tab.libraryHash === target.hash ? tab : null;
      if (!ownTab && !(attached && attached.doc === doc)) return false;
      const rec = ownTab ? recordFor(doc, ownTab) : /** @type {PreviewRecord} */ (attached);
      attached = rec;
      lastTarget = target;
      current = {
        relPath: target.relPath, hash: target.hash, pageN: viewer.scribe.state.cp.n, query: target.query, record: rec,
      };
      viewer.attachPreview(doc, viewer.scribe.state.cp.n, target.title).catch(() => {});
      onState('ready');
      return true;
    },

    /**
     * Hand the attached preview to a lane tab, which takes over the record's document, dirty state and hydration.
     * @param {string} name
     * @param {Object} fields - The tab's library fields.
     * @returns {?Object} The tab, or null when no preview the library owns is attached.
     */
    pin: (name, fields) => {
      const rec = attached;
      if (!rec || rec.tab || viewer.doc !== rec.doc) return null;
      const tab = viewer.pinPreview(name, { ...fields, provisional: rec.provisional });
      if (!tab) return null;
      tab.libraryDirty = rec.libraryDirty;
      rec.tab = tab;
      // The hydration swap and the dirty tracking write into the tab from here on.
      tab.onDocHydrated = (d) => trackEdits(d, tab);
      trackEdits(rec.doc, tab);
      if (rec.holderRef) rec.holderRef.current = tab;
      attached = null;
      return tab;
    },

    /** The viewer moved on to a tab's document, so the preview's own document is let go of. */
    displaced: () => {
      if (!attached || viewer.doc === attached.doc) return;
      release(attached, current ? current.hash : null);
      attached = null;
    },

    destroy: () => {
      token++;
      showBusyKey = null;
      const prev = current;
      current = null;
      lastTarget = null;
      if (attached) {
        if (viewer.doc === attached.doc) viewer.detachPreview();
        release(attached, prev ? prev.hash : null);
        attached = null;
      }
    },

    persistRasterWindow,
    makeSeed,
    beginUserLoad,
    endUserLoad,
    userLoadIdle,
    /** Whether the user is waiting on a load right now, for callers that must not block to find out. */
    userLoadActive: () => userLoadsActive > 0,
  };
}
