// The library's preview of the selected document, which the main viewer shows in the library's pane.

import { titleOf } from './libraryStore.js';

/** Width of a thumbnail rail image, as the image store renders one. */
const THUMBNAIL_W = 300;

/**
 * @param {?{dims: {width: number, height: number}, rects: Array<{left: number, top: number, right: number, bottom: number}>, per: number}} m
 *   The first `per` of `rects` belong to the first occurrence.
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
 * @property {Array<{page: number, tier: number, count: number, marks: Array<[number, number]>}>} [near] - The near matches of the clicked row.
 *   The find bar marks them beside the document's matches of the query.
 * @property {string} title
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
 * @property {?{current: ?Object}} [holderRef] - The hydration swap's holder reference, moved onto the tab when the preview is pinned.
 * @property {(doc: Object) => void} [onDocHydrated]
 */

/**
 * Own the library's preview in the main viewer.
 * @param {Object} deps
 * @param {import('../basic-viewer/pdf-viewer.js').ScribePDFViewer} deps.viewer
 * @param {import('./docSession.js').DocSessions} deps.sessions
 * @param {ReturnType<typeof import('./search/searchClient.js').createSearchClient>} deps.engine
 * @param {() => ?import('./libraryStore.js').LibraryStore} deps.getStore
 * @param {(hash: string, doc: Object) => void} [deps.onSidecarSaved] - Fires after a preview checkpoint writes a sidecar, so the manifest and search index can follow the edited document.
 * @param {() => void} deps.ensureLit - Light the library's tab in its split form before a document is attached as the preview.
 * @param {(state: 'empty'|'loading'|'ready'|'error', text?: string) => void} deps.onState - The document area's state, for the host's hint over it.
 * @param {(doc: Object, target: PreviewRecord) => void} deps.trackEdits - Route the document's mutations to `target.libraryDirty`.
 */
export function createPreview({
  viewer, sessions, engine, getStore, onSidecarSaved, ensureLit, onState, trackEdits,
}) {
  /**
   * Count of loads the user is actively waiting on.
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
   * @param {Object} seedDoc
   */
  const countHydration = (seedDoc) => {
    const inner = seedDoc._requestHydration;
    if (!inner) return;
    let counted = false;
    seedDoc._requestHydration = () => {
      const p = inner();
      if (!counted) {
        counted = true;
        beginUserLoad();
        Promise.resolve(p).catch(() => {}).finally(endUserLoad);
      }
      return p;
    };
  };

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

  /** @type {?{hash: string, query: string, near: NonNullable<PreviewTarget['near']>}} The query and the near matches the library last handed over with a document, which the document's find reads. */
  let handoff = null;

  /**
   * Build a provisional seed for a page of a library document.
   * @param {string} relPath
   * @param {import('./libraryStore.js').LibraryDocEntry} entry
   * @param {number} pageN
   * @param {?{query: string, near: NonNullable<PreviewTarget['near']>}} [handedOver] - The query the document opens on, with the near matches of the clicked row.
   * @returns {Promise<import('../js/seedDoc.js').ProvisionalSeed>}
   */
  const makeSeed = async (relPath, entry, pageN, handedOver = null) => {
    const { hash } = entry;
    if (!hash || !entry.pageDims) throw new Error('A document seeds only once it is indexed.');
    if (handedOver) handoff = { hash, ...handedOver };
    const ref = { relPath, entry, hash };
    const [changes, pixels] = await Promise.all([sessions.changes(hash), sessions.pixels(ref)]);
    const pageCount = entry.pageDims.length;
    /** @param {Object} a */
    const copyAnnot = (a) => ({ ...a, bbox: { ...a.bbox } });
    return {
      pageCount,
      pageDims: entry.pageDims.map(([width, height, rotation]) => ({ width, height, rotation })),
      initialPage: pageN,
      window: { from: Math.max(0, pageN - 2), to: Math.min(pageCount - 1, pageN + 2) },
      name: titleOf(relPath),
      raster: (n) => sessions.raster(ref, n, true),
      render: (n, width) => sessions.renderAt(ref, n, width),
      ocr: (n) => engine.pages(hash, [n]).then((views) => views[0]),
      // Copies, never the parsed arrays: seed session edits must not leak into the cache.
      // A page the changes file lists, even as empty, replaces the real page at the swap, so removals count.
      // Without a changes file the page appends its session additions instead.
      annots: (n) => Promise.resolve(changes?.annotations ? (changes.annotations[n] ?? []).map(copyAnnot) : null),
      thumb: (n) => sessions.pixels(ref).then((d) => d.images.renderThumbnail(n, THUMBNAIL_W)),
      // The near marks handed over belong to the library's query, so a query typed into the find bar afterward goes without them.
      find: (query) => engine.find(hash, query, handoff && handoff.hash === hash && handoff.query === query ? handoff.near : [])
        .then((r) => r.pages.flatMap((p) => p.matches.map((wordIds) => ({ pageN: p.page, wordIds })))),
      outline: changes?.outline ?? pixels.outline ?? [],
      load: async () => {
        const store = /** @type {import('./libraryStore.js').LibraryStore} */ (getStore());
        const files = [await store.readFile(relPath)];
        const sidecar = await store.readSidecar(hash);
        if (sidecar) files.push(new File([sidecar], `${hash}.scribe`));
        return files;
      },
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
    doc, provisional: doc.id < 0, libraryDirty: false, tab, handle: null,
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
        await store.writeChanges(hash, await /** @type {any} */ (real).exportData('scribe', { scribeSession: true, includeOcrScribe: false }));
        sessions.dropChanges(hash);
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
    if (target.query) handoff = { hash: target.hash, query: target.query, near: target.near ?? [] };
    // Background warming yields for the whole show, because the seed build and priming run before any hydration exists to count.
    beginUserLoad();
    try {
      const s = viewer.scribe;
      if (current && sameDoc && viewer.doc === current.record.doc && s.zoomLevel > 0) {
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
        persistRasterWindow(target.relPath, target.entry, target.pageN);
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
      rec.holderRef = holder;
      // At adoption time rather than on `hydrated`, so no edit can slip between the swap and dirty tracking.
      rec.onDocHydrated = (d) => trackEdits(d, rec);
      holder.current = rec;
      trackEdits(made.seedDoc, rec);
      countHydration(made.seedDoc);
      current = {
        relPath: target.relPath, hash: target.hash, pageN: target.pageN, query: target.query, record: rec,
      };
      await attach(rec, target, prevHash);
      if (t !== token) return;
      await made.primed;
      if (t !== token) return;
      await applyQueryAndPage(target);
      current.anchorTop = s.scrollContainer.scrollTop;
      onState('ready');
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
