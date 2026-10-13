// The library's preview pane is an embedded viewer seeded straight from stored page rasters and sidecars.
// Search results and the list views both mount one.
// Seeding rather than importing is what lets a reader flip through documents without paying for a full load each time.

import scribeLib from '../../scribe.js';
import { openDocumentFromFile } from '../js/controls/tools.js';
import {
  barIcon, createPageNav, createSearchBar, createZoomControls, makeIconButton, makeSeparator,
} from '../js/controls/toolbar.js';
import {
  PAGE_RASTER_WIDTH, RASTER_STORE_MIN_MS, renderPageRaster, WARM_PDF_LIMIT, WARM_SIDECAR_LIMIT,
} from './libraryIngest.js';
import { titleOf } from './libraryStore.js';

const OPEN_IN_TAB_SVG = barIcon('<path d="M12 7H8.5A2.5 2.5 0 0 0 6 9.5v10A2.5 2.5 0 0 0 8.5 22h10a2.5 2.5 0 0 0 2.5-2.5V16"/><path d="M16 6h6v6M22 6l-9 9"/>');

/**
 * The split shell shared by the search-results view and the list-view preview: a resizable left column, a drag sash, and room for the caller-appended right pane.
 * @param {number} defaultWidth
 * @param {() => number} getWidth
 * @param {(w: number) => void} setWidth
 */
export const buildPreviewSplit = (defaultWidth, getWidth, setWidth) => {
  const wrap = document.createElement('div');
  wrap.className = 'scribe-library-results';
  wrap.style.setProperty('--scribe-library-rlist-w', `${getWidth()}px`);
  const left = document.createElement('div');
  left.className = 'scribe-library-rlist';
  wrap.appendChild(left);
  const sash = document.createElement('div');
  sash.className = 'scribe-library-rsplit';
  sash.setAttribute('role', 'separator');
  sash.setAttribute('aria-orientation', 'vertical');
  sash.setAttribute('aria-label', 'Resize the preview split');
  sash.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const startX = e.clientX;
    const startW = left.getBoundingClientRect().width;
    sash.classList.add('drag');
    wrap.classList.add('rsplit-drag');
    const onMove = (ev) => {
      // Clamp to the same bounds as the CSS width clamp so dragging past an edge has no dead travel on the way back.
      setWidth(Math.round(Math.max(280, Math.min(startW + ev.clientX - startX, wrap.getBoundingClientRect().width - 320))));
      wrap.style.setProperty('--scribe-library-rlist-w', `${getWidth()}px`);
    };
    const onUp = () => {
      sash.classList.remove('drag');
      wrap.classList.remove('rsplit-drag');
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  });
  sash.addEventListener('dblclick', () => {
    setWidth(defaultWidth);
    wrap.style.setProperty('--scribe-library-rlist-w', `${defaultWidth}px`);
  });
  wrap.appendChild(sash);
  return { wrap, left };
};

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
 * Own the library's preview panes: at most one is mounted at a time, and it survives host re-renders of the same kind.
 * @param {Object} deps
 * @param {import('../basic-viewer/pdf-viewer.js').ScribePDFViewer} deps.viewer - Supplies the constructor for the embedded viewer.
 * @param {import('./docSession.js').DocSessions} deps.sessions
 * @param {() => ?import('./libraryStore.js').LibraryStore} deps.getStore
 * @param {() => ?import('./libraryStore.js').LibraryManifest} deps.getManifest
 * @param {() => void} deps.onRastersStored - Fires after a raster window lands, so blank rows elsewhere can retry.
 * @param {() => void} deps.saveManifestSoon - Debounced manifest write, for measurements recorded on entries.
 * @param {(hash: string, doc: Object) => void} [deps.onSidecarSaved] - Fires after a pane checkpoint writes a sidecar, so the manifest and search index can follow the edited document.
 */
export function createPreviewPanes({
  viewer, sessions, getStore, getManifest, onRastersStored, saveManifestSoon, onSidecarSaved,
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
   * Count of imports the user is actively waiting on, such as a pane hydration or an open.
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
   * Build an `openProvisional` seed for a page of a library document.
   * Hydration stays on-demand so that flipping through documents never pays for a full import.
   * @param {string} relPath
   * @param {import('./libraryStore.js').LibraryDocEntry} entry
   * @param {number} pageN
   * @param {?import('../../js/containers/scribeDoc.js').ScribeDoc} [liveDoc] - A document already open in a main-viewer tab.
   *   The seed then draws pages, text, and annotations from it, so any page paints without a second import.
   * @returns {Promise<import('../js/seedDoc.js').ProvisionalSeed>}
   */
  const makeSeed = async (relPath, entry, pageN, liveDoc = null) => {
    const load = async () => {
      const pdfFile = await /** @type {import('./libraryStore.js').LibraryStore} */ (getStore()).readFile(relPath);
      const files = [pdfFile];
      if (entry.hash) {
        const sidecar = await /** @type {import('./libraryStore.js').LibraryStore} */ (getStore()).readSidecar(entry.hash);
        if (sidecar) files.push(new File([sidecar], `${entry.hash}.scribe`));
      }
      return files;
    };
    if (liveDoc) {
      const pageCount = liveDoc.pageMetrics.length;
      const n0 = Math.min(pageN, pageCount - 1);
      return {
        pageCount,
        pageDims: liveDoc.pageMetrics.map((pm) => ({ width: pm.dims.width, height: pm.dims.height, rotation: pm.rotation || 0 })),
        initialPage: n0,
        window: { from: Math.max(0, n0 - 2), to: Math.min(pageCount - 1, n0 + 2) },
        name: titleOf(relPath),
        // A closed tab leaves the render rejecting, and null degrades that page to a placeholder instead of an error.
        raster: (n) => liveDoc.images.renderThumbnail(n, PAGE_RASTER_WIDTH, 0.75, true).catch(() => null),
        ocr: async (n) => liveDoc.ocr.active?.[n] ?? null,
        // Copies, never the live arrays: seed session edits must not leak into the tab's document.
        annots: async (n) => (liveDoc.annotations.pages[n] ?? []).map((a) => ({ ...a, bbox: { ...a.bbox } })),
        load,
        hydration: 'on-demand',
      };
    }
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

  /** @type {?Object} The single mounted preview pane (results view or list view), or null. */
  let mountedPane = null;

  /**
   * The right-side preview pane shared by search results and the list views.
   * The embedded viewer is read-only and seeded through `openProvisional`, so it paints before the document has been imported.
   * @param {string} emptyText
   */
  const buildPreviewPane = (emptyText) => {
    const pane = document.createElement('div');
    pane.className = 'scribe-library-pv';
    // The toolbar class applies the toolbar-scoped styles of the find bar and the page input.
    // The find bar's styles stay scoped because the phone layout moves the bar out of the toolbar.
    pane.innerHTML = '<div class="scribe-library-pv-head scribe-pdf-viewer-toolbar" style="display:none;">'
      + '<span class="t"></span><span class="scribe-library-pv-tools"></span></div>'
      + `<div class="scribe-library-pv-stage"><div class="scribe-library-pv-empty">${emptyText}</div><div class="scribe-library-pv-viewer" style="display:none;"></div>`
      + '<div class="scribe-library-pv-loading" style="display:none;"><div class="scribe-library-pv-loading-spin"></div>Loading page…</div></div>';
    const pvHead = /** @type {HTMLElement} */ (pane.querySelector('.scribe-library-pv-head'));
    const pvTitle = /** @type {HTMLElement} */ (pvHead.querySelector('.t'));
    const pvTools = /** @type {HTMLElement} */ (pvHead.querySelector('.scribe-library-pv-tools'));
    const pvEmpty = /** @type {HTMLElement} */ (pane.querySelector('.scribe-library-pv-empty'));
    const pvLoading = /** @type {HTMLElement} */ (pane.querySelector('.scribe-library-pv-loading'));
    const pvHost = /** @type {HTMLElement} */ (pane.querySelector('.scribe-library-pv-viewer'));
    const openBtn = makeIconButton('Open', OPEN_IN_TAB_SVG);
    pvTools.append(makeSeparator(), openBtn);
    /** @type {?ReturnType<typeof createPageNav>} */
    let pageNav = null;
    /** @type {?ReturnType<typeof createSearchBar>} */
    let searchBar = null;
    /** @type {?import('../basic-viewer/pdf-viewer.js').ScribePDFViewer} */
    let paneViewer = null;
    let token = 0;
    /** @type {?string} Selection key (path, page, query) of the show in flight, so identical replays do not restart it. */
    let showBusyKey = null;
    /** @type {?{relPath: string, hash: string, pageN: number, query: ?string, handle: ?Object, window: ?{from: number, to: number}, live: ?Object, anchorTop?: ?number}} */
    let current = null;
    /** True when the shown document has session edits that are not yet in its sidecar. */
    let paneDirty = false;
    /** @type {?Object} Last show target, for re-seeding after a doc handoff. */
    let lastTarget = null;
    let liveLocked = false;
    const onLockedContextMenu = (e) => {
      e.preventDefault();
      e.stopPropagation();
    };
    /**
     * Turn the pane's annotation lock on or off.
     * @param {boolean} locked
     */
    const setLiveLocked = (locked) => {
      if (locked === liveLocked) return;
      liveLocked = locked;
      pane.classList.toggle('scribe-library-pv-live', locked);
      if (locked) pvHost.addEventListener('contextmenu', onLockedContextMenu, true);
      else pvHost.removeEventListener('contextmenu', onLockedContextMenu, true);
    };

    /**
     * Land on the target page and paint (or clear) the query's match marks.
     * A seeded document only has words for its window pages, so the marks stay partial until hydration re-runs this.
     * @param {{pageN: number, query: ?string}} target
     */
    const applyQueryAndPage = async (target) => {
      const ps = /** @type {NonNullable<typeof paneViewer>} */ (paneViewer).scribe;
      const bar = /** @type {NonNullable<typeof searchBar>} */ (searchBar);
      if (target.query) {
        if (!ps.state.searchMode) {
          // Opening would run any query left in the field before the landing search below replaces it.
          bar.searchInputElem.value = '';
          await bar.openSearch({ focus: false });
        }
        bar.searchInputElem.value = target.query;
        await bar.runSearch(target.query, target.pageN);
        if (ps._searchState.matchList.length) return;
      } else if (ps.state.searchMode) bar.closeSearch();
      await ps.displayPage(target.pageN, true, false);
    };

    /**
     * Start the shown provisional document's full load, deferring while another preview hydration is still importing.
     * @param {number} t
     * @param {{hash: string, pageN: number}} target
     */
    const hydrate = (t, target) => {
      if (!(t === token && paneViewer?.doc && paneViewer.doc.id < 0)) return;
      if (hydrationBusy) {
        hydrationBusy.then(() => hydrate(t, target));
        return;
      }
      getStore()?.readPageRaster(target.hash, target.pageN).then((raster) => {
        if (!raster && t === token && paneViewer?.doc && paneViewer.doc.id < 0) pvLoading.style.display = '';
      }).catch(() => {});
      /** @type {any} */ (paneViewer.doc)._requestHydration?.();
    };

    /**
     * Start the shown target's upgrade to the real document.
     * The stored raster keeps painting, and hydration swaps the real render in underneath.
     * A document past the warm-lane size caps never loads automatically, so its preview waits for an explicit Open.
     * @param {{hash: string, pageN: number, entry: import('./libraryStore.js').LibraryDocEntry}} target
     * @param {number} t
     */
    const requestUpgrade = async (target, t) => {
      const store = getStore();
      if (!store || !paneViewer?.doc || paneViewer.doc.id >= 0) return;
      if (target.entry.size > WARM_PDF_LIMIT) return;
      const sidecarBytes = await store.sidecarSize(target.hash);
      if (sidecarBytes !== null && sidecarBytes > WARM_SIDECAR_LIMIT) return;
      if (t !== token) return;
      hydrate(t, target);
    };

    /**
     * Release the pane's current document, saving one that holds session edits back to its sidecar.
     * A still-provisional document finishes loading first, since the swap into the real document is what carries its annotations.
     * @param {?string} hash
     */
    const releaseDoc = (hash) => {
      if (!paneViewer || !paneViewer.doc) return;
      const store = getStore();
      const doc = paneViewer.doc;
      const dirty = paneDirty;
      paneDirty = false;
      // A clean hydrated document goes back to the session pool instead of closing, so returning to it is free.
      if (!dirty && hash && doc.id >= 0) {
        paneViewer._tabs.length = 0;
        paneViewer._activeTab = -1;
        paneViewer._renderTabs();
        paneViewer.detachDoc({ terminate: false });
        sessions.adoptLive(hash, doc);
        return;
      }
      if (!dirty || !hash || !store) {
        if (paneViewer._tabs.length) paneViewer._closeTab(0);
        return;
      }
      paneViewer._tabs.length = 0;
      paneViewer._activeTab = -1;
      paneViewer._renderTabs();
      paneViewer.detachDoc({ terminate: false });
      (async () => {
        /** @type {?Object} */
        let real = null;
        try {
          // A live-backed seed's `_requestHydration` re-seeds rather than loads, so the save prefers the real loader kept under `_hydrateForSave`.
          const dAny = /** @type {any} */ (doc);
          real = doc.id < 0 ? await (dAny._hydrateForSave ?? dAny._requestHydration)() : doc;
          await store.writeSidecar(hash, await /** @type {any} */ (real).exportData('scribe', { scribeSession: true, includeCharBoxesScribe: false }));
          sessions.dropSidecar(hash);
          sessions.adoptLive(hash, /** @type {import('../../js/containers/scribeDoc.js').ScribeDoc} */ (real));
          onSidecarSaved?.(hash, /** @type {Object} */ (real));
        } catch {
          await /** @type {any} */ (real || doc).close?.();
        }
      })().catch(() => {});
    };

    const showEmpty = () => {
      token++;
      showBusyKey = null;
      endVeil();
      setLiveLocked(false);
      releaseDoc(current ? current.hash : null);
      current = null;
      lastTarget = null;
      viewer._previewDocName = null;
      viewer._announceActiveDoc();
      pvHead.style.display = 'none';
      pvHost.style.display = 'none';
      pvLoading.style.display = 'none';
      pane.classList.remove('scribe-library-pv-plated');
      if (pvPlate) pvPlate.style.display = 'none';
      pvEmpty.textContent = emptyText;
      pvEmpty.style.display = '';
    };

    /** @type {?HTMLElement} */
    let pvPlate = null;

    /**
     * Show a file the pane cannot render: its name and kind, and the one action that applies to it.
     * @param {{title: string, badge: string, icon: string, note: string, action: string, onAction: () => void}} target
     */
    const showPlate = (target) => {
      token++;
      showBusyKey = null;
      endVeil();
      setLiveLocked(false);
      releaseDoc(current ? current.hash : null);
      current = null;
      lastTarget = null;
      viewer._previewDocName = target.title;
      viewer._announceActiveDoc();
      pvHead.style.display = '';
      pvTitle.textContent = target.title;
      pvTitle.title = target.title;
      pane.classList.add('scribe-library-pv-plated');
      pvHost.style.display = 'none';
      pvLoading.style.display = 'none';
      pvEmpty.style.display = 'none';
      if (!pvPlate) {
        pvPlate = document.createElement('div');
        pvPlate.className = 'scribe-library-pv-plate';
        /** @type {HTMLElement} */ (pane.querySelector('.scribe-library-pv-stage')).appendChild(pvPlate);
      }
      pvPlate.replaceChildren();
      pvPlate.insertAdjacentHTML('beforeend', `<span class="fi">${target.icon}</span>`);
      const nameEl = document.createElement('div');
      nameEl.className = 'n';
      nameEl.textContent = target.title;
      const badgeEl = document.createElement('span');
      badgeEl.className = 'scribe-library-badge';
      badgeEl.textContent = target.badge;
      const noteEl = document.createElement('div');
      noteEl.className = 'm';
      noteEl.textContent = target.note;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'scribe-library-btn';
      btn.textContent = target.action;
      btn.addEventListener('click', () => target.onAction());
      pvPlate.append(nameEl, badgeEl, noteEl, btn);
      pvPlate.style.display = '';
    };

    /** @type {?{elem: HTMLElement, timers: number[]}} */
    let veil = null;

    /**
     * Remove the veil.
     * With `v` given, only when it is still the one that call created.
     * @param {HTMLElement} [v]
     */
    const endVeil = (v) => {
      if (!veil || (v && veil.elem !== v)) return;
      for (const timer of veil.timers) clearTimeout(timer);
      veil.elem.remove();
      veil = null;
    };

    /**
     * Freeze the pane's current pixels while the next target prepares underneath, so the swap reveals already anchored.
     * A dim after 400ms signals a slow preparation, and a 2s cap reveals whatever exists rather than reading as a dead click.
     * @returns {HTMLElement}
     */
    const beginVeil = () => {
      endVeil();
      const cover = document.createElement('div');
      cover.className = 'scribe-library-pv-veil';
      const rect = pvHost.getBoundingClientRect();
      if (rect.width && rect.height) {
        const snap = document.createElement('canvas');
        const dpr = window.devicePixelRatio || 1;
        snap.width = Math.round(rect.width * dpr);
        snap.height = Math.round(rect.height * dpr);
        const ctx = snap.getContext('2d');
        if (ctx) {
          ctx.scale(dpr, dpr);
          let drew = false;
          for (const c of pvHost.querySelectorAll('canvas')) {
            const cr = c.getBoundingClientRect();
            if (!cr.width || !cr.height || cr.bottom < rect.top || cr.top > rect.bottom) continue;
            try {
              ctx.drawImage(c, cr.left - rect.left, cr.top - rect.top, cr.width, cr.height);
              drew = true;
            } catch { /* A zero-sized or unreadable canvas leaves that page blank in the freeze. */ }
          }
          // A background image rather than a canvas child, so anything polling for the viewer's canvases never matches the veil.
          if (drew) cover.style.backgroundImage = `url(${snap.toDataURL()})`;
        }
      }
      const timers = [
        window.setTimeout(() => { cover.style.opacity = '0.5'; }, 400),
        window.setTimeout(() => endVeil(cover), 2000),
      ];
      pvHost.appendChild(cover);
      veil = { elem: cover, timers };
      return cover;
    };

    /**
     * Show page `n` of `count` in the page control.
     * @param {number} n - One-based page number.
     * @param {number} count
     */
    const setPageNav = (n, count) => {
      if (!pageNav) return;
      pageNav.pageNumElem.value = String(n);
      pageNav.pageCountElem.textContent = String(count);
    };
    const syncPageNav = () => {
      const d = paneViewer?.doc;
      if (d && d.pageMetrics.length) setPageNav(paneViewer.scribe.state.cp.n + 1, d.pageMetrics.length);
    };

    /**
     * Preview a page in the embedded viewer, painting match marks when a query is given.
     * A `jump` target lands on far pages by re-seeding; without it, a page outside the seeded window accelerates the full load as scrolling there would.
     * @param {{relPath: string, hash: string, entry: import('./libraryStore.js').LibraryDocEntry,
     *   pageN: number, query: ?string, title: string, jump?: boolean}} target
     */
    const show = async (target) => {
      // A fit run while the surface is hidden commits a nonpositive zoom, which no later resize repairs.
      // Record the target for the reshow that runs when the surface is shown again.
      if (!pane.clientWidth) {
        token++;
        showBusyKey = null;
        lastTarget = target;
        return;
      }
      // Host re-renders and ingest churn replay the shown target, so one selection reaches here many times over.
      // A replay must never restart the show in flight for it, because under load the restarts outpace the paints and the pane stays stuck on the previous document.
      const selKey = `${target.relPath}|${target.pageN}|${target.query ?? ''}`;
      if (showBusyKey === selKey) return;
      const t = ++token;
      showBusyKey = selKey;
      // Pending documents all carry an empty hash, so an empty hash identifies a document only together with its path.
      const sameDoc = !!(current && current.hash === target.hash && (target.hash || current.relPath === target.relPath));
      const changed = !sameDoc || !current || current.pageN !== target.pageN || current.query !== target.query;
      if (!sameDoc) searchBar?.resetSearch();
      pvHead.style.display = '';
      pvTitle.textContent = target.title;
      pvTitle.title = target.title;
      // Announced before the swap, so the embedding page never sees the document-less gap between releasing the old preview and opening the new one.
      viewer._previewDocName = target.title;
      viewer._announceActiveDoc();
      pvEmpty.style.display = 'none';
      pvLoading.style.display = 'none';
      pane.classList.remove('scribe-library-pv-plated');
      if (pvPlate) pvPlate.style.display = 'none';
      pvHost.style.display = '';
      if (!paneViewer) {
        paneViewer = new /** @type {any} */ (viewer.constructor)(pvHost, {
          edit: false, showToolbar: false, showDropZone: false, showSidebar: false, fit: 'width',
        });
        const ps = /** @type {NonNullable<typeof paneViewer>} */ (paneViewer).scribe;
        // The pane must never compete with the main viewer for canvas memory.
        ps.imageCache.canvasCacheBytes = 64 * 1024 * 1024;
        /** @type {any} */ (pvHost).scribeViewer = paneViewer;
        // Annotation gestures and comment text edits in the pane checkpoint like tab edits do.
        ps.onAnnotationsEdited = () => { paneDirty = true; };
        pvHost.addEventListener('input', () => { paneDirty = true; }, true);
        pageNav = createPageNav(ps);
        const navWrap = document.createElement('span');
        navWrap.className = 'scribe-library-pv-nav';
        navWrap.append(pageNav.prevElem, pageNav.nextElem, pageNav.pageInputGroup);
        pvTitle.after(navWrap);
        const { pageNumElem } = pageNav;
        pageNumElem.addEventListener('focus', () => pageNumElem.select());
        // Wrapped because the pair sets its display inline, which would override the width rule that hides it.
        const zoomWrap = document.createElement('span');
        zoomWrap.className = 'scribe-library-pv-zoom';
        zoomWrap.appendChild(createZoomControls(ps).zoomControls);
        searchBar = createSearchBar(ps, pane);
        pvTools.prepend(zoomWrap, searchBar.searchElem);
        pvHead.appendChild(searchBar.findGroupElem);
        const innerDisplay = ps.displayPageCallback;
        ps.displayPageCallback = () => {
          innerDisplay?.();
          syncPageNav();
        };
      }
      // A host re-render of the already-shown document carries a stale initial position once the reader has scrolled, so the live state wins.
      if (sameDoc && paneViewer.doc) syncPageNav();
      else setPageNav(target.pageN + 1, target.entry.pageCount || 1);
      lastTarget = target;
      // Background warming yields for the whole show, because the seed build and priming run before any hydration exists to count.
      beginUserLoad();
      try {
        // Clicking a result on a far page of the same provisional document re-seeds around that page instead of forcing the full load.
        const jumpOutsideSeed = !!(current && paneViewer.doc && paneViewer.doc.id < 0
          && target.jump && current.window
          && (target.pageN < current.window.from || target.pageN > current.window.to));
        const liveTab = target.hash
          ? viewer._tabs.find((tab) => tab.libraryHash === target.hash && !tab.provisional && !tab.asleep)
          : null;
        const liveDoc = liveTab && liveTab.doc && liveTab.doc.id >= 0 ? liveTab.doc : null;
        // A closed or reopened tab leaves the seed's callbacks bound to a dead document.
        // A nonpositive zoom means the last show finished while the surface was hidden, so the existing paint cannot be kept.
        if (current && sameDoc && paneViewer.doc && !jumpOutsideSeed
          && current.live === liveDoc && paneViewer.scribe.zoomLevel > 0) {
          // A re-render landing on the same page and query must leave the reader's scroll and paint untouched.
          const samePlace = !changed;
          current.pageN = target.pageN;
          current.query = target.query;
          // A folder rename or move can re-path the same document, and the hydration write-back looks its entry up by path.
          current.relPath = target.relPath;
          if (samePlace) return;
          if (current.handle) await current.handle.primed;
          if (t !== token) return;
          await applyQueryAndPage(target);
          current.anchorTop = paneViewer.scribe.scrollContainer.scrollTop;
          endVeil();
          const entry = getManifest()?.docs[target.relPath];
          if (paneViewer.doc && paneViewer.doc.id >= 0 && entry) persistRasterWindow(paneViewer.doc, entry, target.pageN);
          else if (current.live && entry) persistRasterWindow(current.live, entry, target.pageN);
          else if (!current.live) requestUpgrade(target, t);
          return;
        }
        // With an open tab, the live-backed seed below is the single source of truth.
        // A stale pool copy is left idle for eviction.
        const pooled = liveDoc ? null : sessions.takeLive(target.hash);
        if (pooled) {
          const cover = beginVeil();
          releaseDoc(current ? current.hash : null);
          current = null;
          await paneViewer._openDocAsTab(pooled, titleOf(target.relPath), { lastPage: target.pageN });
          if (t !== token) return;
          setLiveLocked(false);
          current = {
            relPath: target.relPath, hash: target.hash, pageN: target.pageN, query: target.query, handle: null, window: null, live: null,
          };
          await applyQueryAndPage(target);
          current.anchorTop = paneViewer.scribe.scrollContainer.scrollTop;
          endVeil(cover);
          const entry = getManifest()?.docs[target.relPath];
          if (entry) persistRasterWindow(paneViewer.doc, entry, target.pageN);
          return;
        }
        // With no raster for the target page a seed could only paint blank pages, so the real document loads directly instead.
        const rastered = target.hash
          ? await /** @type {import('./libraryStore.js').LibraryStore} */ (getStore()).readPageRaster(target.hash, target.pageN)
          : null;
        if (t !== token) return;
        if (!liveDoc && !rastered) {
          const cover = beginVeil();
          pvLoading.style.display = '';
          releaseDoc(current ? current.hash : null);
          current = null;
          // Serialized so that a flip storm can never hold several full imports at once.
          while (hydrationBusy) {
            await hydrationBusy;
            if (t !== token) return;
          }
          const t0 = performance.now();
          const loadP = (async () => {
            const s = /** @type {import('./libraryStore.js').LibraryStore} */ (getStore());
            const files = [await s.readFile(target.relPath)];
            if (target.hash) {
              const sidecar = await s.readSidecar(target.hash);
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
          await paneViewer._openDocAsTab(doc, titleOf(target.relPath), { lastPage: target.pageN });
          if (t !== token) return;
          setLiveLocked(false);
          current = {
            relPath: target.relPath, hash: target.hash, pageN: target.pageN, query: target.query, handle: null, window: null, live: null,
          };
          await applyQueryAndPage(target);
          current.anchorTop = paneViewer.scribe.scrollContainer.scrollTop;
          pvLoading.style.display = 'none';
          endVeil(cover);
          const entry = getManifest()?.docs[target.relPath];
          if (entry) {
            entry.firstPaintMs = Math.round(performance.now() - t0);
            saveManifestSoon();
            persistRasterWindow(doc, entry, target.pageN);
          }
          return;
        }
        const seed = await makeSeed(target.relPath, target.entry, target.pageN, liveDoc);
        if (t !== token) return;
        const cover = beginVeil();
        const prevDoc = paneViewer.doc;
        /** @type {?{pages: Array<Array<Object>>, baseline: Set<number>}} */
        let carried = null;
        if (current && sameDoc && prevDoc && prevDoc.id < 0 && paneDirty) {
          // Re-seeding the same edited document carries its unsaved session annotations into the new seed, and the dirty flag stays for the real save.
          carried = {
            pages: prevDoc.annotations.pages.map((page) => page.map((a) => ({ ...a, bbox: { ...a.bbox } }))),
            baseline: new Set(prevDoc._annotBaseline),
          };
          if (paneViewer._tabs.length) paneViewer._closeTab(0);
        } else {
          releaseDoc(current ? current.hash : null);
        }
        current = null;
        const baseAnnots = seed.annots;
        const carriedPages = carried;
        const handle = await paneViewer.openProvisional(carriedPages ? {
          ...seed,
          annots: (n) => (carriedPages.baseline.has(n) || carriedPages.pages[n].length
            ? Promise.resolve(carriedPages.pages[n].map((a) => ({ ...a, bbox: { ...a.bbox } })))
            : Promise.resolve(baseAnnots ? baseAnnots(n) : null)),
        } : seed);
        if (t !== token) return;
        // The seed reads from the open tab's document, so annotation edits made here would diverge from the copy the tab saves.
        setLiveLocked(!!liveDoc);
        if (liveDoc) {
          const seedDoc = /** @type {any} */ (paneViewer.doc);
          const loadForSave = seedDoc._requestHydration;
          // The release-time save is the one consumer that may still load for real, so a leaked edit is never dropped.
          seedDoc._hydrateForSave = () => {
            beginUserLoad();
            const p = loadForSave();
            Promise.resolve(p).catch(() => {}).finally(endUserLoad);
            return p;
          };
          // Every other hydration trigger re-seeds around the reader's page instead of loading.
          // The document is already open in a tab, so a second import is never paid.
          let reseeding = false;
          seedDoc._requestHydration = () => {
            const n = paneViewer ? paneViewer.scribe.state.cp.n : 0;
            if (!reseeding && lastTarget && current && current.handle === handle && paneViewer?.doc === seedDoc
              && current.window && (n < current.window.from || n > current.window.to)) {
              reseeding = true;
              Promise.resolve(show({ ...lastTarget, pageN: n, jump: true })).finally(() => { reseeding = false; });
            }
            return Promise.resolve();
          };
        } else {
          countHydration(paneViewer.doc, target);
        }
        current = {
          relPath: target.relPath, hash: target.hash, pageN: target.pageN, query: target.query, handle, window: seed.window, live: liveDoc,
        };
        // Started before priming rather than after, because priming can stream megabytes of sidecar for a big document.
        // A live-backed seed renders every page from the open tab's document, so there is nothing to upgrade to.
        if (!liveDoc) requestUpgrade(target, t);
        await handle.primed;
        if (t !== token) return;
        await applyQueryAndPage(target);
        current.anchorTop = paneViewer.scribe.scrollContainer.scrollTop;
        endVeil(cover);
        if (liveDoc) {
          const entry = getManifest()?.docs[target.relPath];
          if (entry) persistRasterWindow(liveDoc, entry, target.pageN);
        }
        handle.hydrated.finally(() => {
          if (t === token) pvLoading.style.display = 'none';
        }).catch(() => {});
        handle.hydrated.then(() => {
          if (!(current && current.handle === handle && paneViewer?.doc)) return;
          const ps = /** @type {NonNullable<typeof paneViewer>} */ (paneViewer).scribe;
          const sc = ps.scrollContainer;
          // Once the reader scrolled away from the anchored spot, hydration must not yank them back.
          const readerMoved = current.anchorTop != null && Math.abs(sc.scrollTop - current.anchorTop) > 2;
          if (current.query && searchBar) {
            // The swap rebuilt the word objects, so re-derive the matches from the real document at whatever page the reader has reached.
            searchBar.runSearch(current.query, undefined, !readerMoved).then(() => {
              if (!readerMoved && current && current.handle === handle) current.anchorTop = sc.scrollTop;
            }).catch(() => {});
          }
          const entry = getManifest()?.docs[current.relPath];
          if (entry) persistRasterWindow(paneViewer.doc, entry, ps.state.cp.n);
        }).catch(() => {});
      } catch {
        if (t === token) {
          endVeil();
          pvHost.style.display = 'none';
          pvLoading.style.display = 'none';
          pvEmpty.textContent = 'This page could not be rendered.';
          pvEmpty.style.display = '';
        }
      } finally {
        if (t === token) showBusyKey = null;
        endUserLoad();
      }
    };

    const shownHash = () => (current ? current.hash : null);

    /**
     * Hand the pane's hydrated document to the caller for promotion into a main-viewer tab.
     * Returns null while the pane is still provisional or empty.
     * @returns {?import('../../js/containers/scribeDoc.js').ScribeDoc}
     */
    const takeHydratedDoc = () => {
      if (!paneViewer || !current || !paneViewer.doc || paneViewer.doc.id < 0) return null;
      const doc = paneViewer.doc;
      // The tab this document lands in announces it from here on.
      viewer._previewDocName = null;
      paneViewer._tabs.length = 0;
      paneViewer._activeTab = -1;
      paneViewer._renderTabs();
      paneViewer.detachDoc({ terminate: false });
      current = null;
      return doc;
    };

    /**
     * Replay the last shown target.
     * Repaints a pane left stale by a doc handoff or by a show that arrived while the surface was hidden.
     */
    const reshow = () => {
      if (lastTarget) show(lastTarget);
    };

    const destroy = () => {
      token++;
      showBusyKey = null;
      endVeil();
      releaseDoc(current ? current.hash : null);
      current = null;
      viewer._previewDocName = null;
      viewer._announceActiveDoc();
      if (paneViewer) {
        paneViewer.destroy();
        paneViewer = null;
      }
      if (mountedPane === self) mountedPane = null;
    };

    const self = {
      pane,
      openBtn,
      /** Which view hosts this pane ('results' | 'list'); reuse is only within a kind. */
      kind: '',
      /** The query the results view last rendered with, so a new search resets the pane. */
      shownQuery: '',
      /** @type {?() => void} Rebound on every host render; a reused pane must never stack listeners. */
      onOpen: null,
      /**
       * Open the pane's find bar.
       * Returns false when no document is shown.
       */
      openFind: () => {
        if (!searchBar || !paneViewer?.doc) return false;
        searchBar.openSearch();
        return true;
      },
      show,
      showEmpty,
      showPlate,
      shownHash,
      takeHydratedDoc,
      reshow,
      destroy,
      /** The embedded viewer, for routing the shared top-bar tools at the previewed doc. */
      viewerRef: () => paneViewer,
      /** Consume the dirty flag; the caller owns the save. */
      takeDirty: () => {
        const d = paneDirty;
        paneDirty = false;
        return d;
      },
      isDirty: () => paneDirty,
      /** Finish a provisional pane's load in place, so promotion adopts the document instead of the tab re-importing it. */
      finishHydration: async () => {
        const doc = /** @type {any} */ (paneViewer?.doc);
        if (doc && doc.id < 0 && doc._requestHydration) {
          await doc._requestHydration().catch(() => {});
        }
      },
    };
    openBtn.addEventListener('click', () => { if (!openBtn.classList.contains('disabled')) self.onOpen?.(); });
    mountedPane = self;
    return self;
  };

  return {
    /**
     * The pane for a hosting view, reusing the mounted one when the same kind re-renders.
     * A List/Compact switch or an ingest-progress re-render must not tear down the embedded viewer or its painted pages.
     * @param {string} kind
     * @param {string} emptyText
     */
    ensurePane: (kind, emptyText) => {
      if (mountedPane && mountedPane.kind === kind) return mountedPane;
      if (mountedPane) mountedPane.destroy();
      const pv = buildPreviewPane(emptyText);
      pv.kind = kind;
      return pv;
    },

    /** @returns {?Object} The mounted pane, or null when none is up. */
    mounted: () => mountedPane,

    persistRasterWindow,
    makeSeed,
    beginUserLoad,
    endUserLoad,
    userLoadIdle,

    /** Whether the user is waiting on a load right now, for callers that must not block to find out. */
    userLoadActive: () => userLoadsActive > 0,
  };
}
