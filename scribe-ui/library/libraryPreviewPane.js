// The library's read-only preview pane: an embedded viewer seeded straight from stored page rasters and sidecars,
// with its own find bar, zoom, page nav, and match marks. Search results and the list views both mount one.
// Seeding rather than importing is what lets a reader flip through documents without paying for a full load each time.

import { ZOOM_IN_SVG, ZOOM_OUT_SVG } from '../js/controls/toolbar.js';
import { openDocumentFromFile } from '../js/controls/tools.js';
import { findText, goToMatch } from '../js/viewerSearch.js';
import { PAGE_RASTER_WIDTH } from './libraryIngest.js';
import { titleOf } from './libraryStore.js';

// eslint-disable-next-line max-len
const PANE_FIND_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/></svg>';

/** How long a reader lingers on a rasterless page before it loads for real. */
const DWELL_LOAD_MS = 2500;

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
 * Accepts a live `OcrPage` or a raw sidecar page, anything with `lines[].words[].{text, bbox}`.
 * @param {?{lines: Array<Object>, dims?: {width: number, height: number}}} page
 * @param {?{width: number, height: number}} dims - Page dimensions when the page object carries none.
 * @param {string} query
 * @returns {?{dims: {width: number, height: number}, rects: Array<{left: number, top: number, right: number, bottom: number}>, per: number}}
 */
export const getMatchRects = (page, dims, query) => {
  if (!page || !Array.isArray(page.lines) || !dims) return null;
  const tokens = query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((t) => t.length);
  if (!tokens.length) return null;
  const words = [];
  for (const line of page.lines) for (const w of (line.words || [])) if (w && w.text && w.bbox) words.push(w);
  const norm = (s) => s.toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
  const rects = [];
  for (let i = 0; i + tokens.length <= words.length; i++) {
    let ok = true;
    for (let j = 0; j < tokens.length; j++) {
      const t = norm(words[i + j].text);
      if (!(j === tokens.length - 1 ? t.startsWith(tokens[j]) : t === tokens[j])) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    for (let j = 0; j < tokens.length; j++) rects.push(words[i + j].bbox);
  }
  return { dims: page.dims || dims, rects, per: tokens.length };
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
 */
export function createPreviewPanes({
  viewer, sessions, getStore, getManifest, onRastersStored,
}) {
  /**
   * The pooled live document for a legacy entry that cannot seed (no stored pageDims), loading it on first use.
   * @param {string} relPath
   * @param {string} hash
   */
  const sessionDoc = (relPath, hash) => sessions.liveDocOrLoad(
    hash,
    () => /** @type {import('./libraryStore.js').LibraryStore} */ (getStore()).readFile(relPath).then((file) => openDocumentFromFile(file)),
  );

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
   * Count a provisional document's eventual hydration as a user-facing load.
   * Wraps `_requestHydration` so every trigger (dwell, click, scroll, promotion, save) pauses background warming for its duration.
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
    if (store.rasterBytes !== null && store.rasterBytes > store.rasterBudget) return;
    const s = store;
    const { hash, pageCount } = entry;
    (async () => {
      for (let n = Math.max(0, pageN - 2); n <= Math.min(pageCount - 1, pageN + 2); n++) {
        await userLoadIdle();
        if (await s.readPageRaster(hash, n)) continue;
        const raster = await d.images.renderThumbnail(n, PAGE_RASTER_WIDTH, 0.75, true);
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
   * @param {string} prevLabel
   * @param {string} nextLabel
   */
  const buildPreviewPane = (emptyText, prevLabel, nextLabel) => {
    const pane = document.createElement('div');
    pane.className = 'scribe-library-pv';
    pane.innerHTML = '<div class="scribe-library-pv-head" style="display:none;"><span class="t"></span><span class="m"></span><span class="grow"></span>'
      + `<button class="scribe-library-pv-zoom" type="button" data-zoom-out aria-label="Zoom out" title="Zoom out">${ZOOM_OUT_SVG}</button>`
      + `<button class="scribe-library-pv-zoom" type="button" data-zoom-in aria-label="Zoom in" title="Zoom in">${ZOOM_IN_SVG}</button>`
      + `<span class="scribe-library-pv-find">${PANE_FIND_SVG}<input type="text" placeholder="Find" aria-label="Find in the previewed document"></span>`
      + '<span class="vertical-separator"></span>'
      + '<button class="scribe-library-pv-open" type="button">Open<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" '
      + 'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 17L17 7M9 7h8v8"/></svg></button>'
      + '<button class="scribe-library-pv-x" type="button" aria-label="Close preview"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" '
      + 'stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/></svg></button></div>'
      + `<div class="scribe-library-pv-stage"><div class="scribe-library-pv-empty">${emptyText}</div><div class="scribe-library-pv-viewer" style="display:none;"></div>`
      + '<div class="scribe-library-pv-loading" style="display:none;"><div class="scribe-library-pv-loading-spin"></div>Loading page…</div></div>'
      + `<div class="scribe-library-pv-foot" style="display:none;"><button type="button" data-prev>${prevLabel}</button><button type="button" data-next>${nextLabel}</button>`
      + '<span class="grow"></span><span data-pos></span></div>';
    const pvHead = /** @type {HTMLElement} */ (pane.querySelector('.scribe-library-pv-head'));
    const pvEmpty = /** @type {HTMLElement} */ (pane.querySelector('.scribe-library-pv-empty'));
    const pvLoading = /** @type {HTMLElement} */ (pane.querySelector('.scribe-library-pv-loading'));
    const pvHost = /** @type {HTMLElement} */ (pane.querySelector('.scribe-library-pv-viewer'));
    const pvFoot = /** @type {HTMLElement} */ (pane.querySelector('.scribe-library-pv-foot'));
    const pvFindInput = /** @type {HTMLInputElement} */ (pane.querySelector('.scribe-library-pv-find input'));
    /** @type {?import('../basic-viewer/pdf-viewer.js').ScribePDFViewer} */
    let paneViewer = null;
    let token = 0;
    /** @type {?{relPath: string, hash: string, pageN: number, query: ?string, handle: ?Object, window: ?{from: number, to: number}, live: ?Object}} */
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
      if (target.query) {
        ps.state.searchMode = true;
        findText(ps, target.query);
        const idx = ps._searchState.matchList.findIndex((m) => m.pageN === target.pageN);
        if (idx >= 0) await goToMatch(ps, idx);
        else await ps.displayPage(target.pageN, true, false);
      } else {
        if (ps._searchState.search) findText(ps, '');
        ps.state.searchMode = false;
        await ps.displayPage(target.pageN, true, false);
      }
    };

    /** @type {HTMLElement} */ (pane.querySelector('[data-zoom-in]')).addEventListener('click', () => {
      if (paneViewer?.doc) paneViewer.scribe.zoom(1.1, paneViewer.scribe.getViewportCenter());
    });
    /** @type {HTMLElement} */ (pane.querySelector('[data-zoom-out]')).addEventListener('click', () => {
      if (paneViewer?.doc) paneViewer.scribe.zoom(0.9, paneViewer.scribe.getViewportCenter());
    });
    let pvFindLast = '';
    const pvClearFind = () => {
      pvFindLast = '';
      if (!paneViewer?.doc) return;
      const ps = paneViewer.scribe;
      if (ps._searchState.search) findText(ps, '');
      ps.state.searchMode = false;
    };
    const pvRunFind = async () => {
      if (!paneViewer?.doc) return;
      const ps = paneViewer.scribe;
      const q = pvFindInput.value.trim();
      if (!q) return;
      if (q !== pvFindLast) {
        pvFindLast = q;
        ps.state.searchMode = true;
        findText(ps, q);
        const idx = ps._searchState.matchList.findIndex((m) => m.pageN >= ps.state.cp.n);
        await goToMatch(ps, idx >= 0 ? idx : 0);
      } else {
        await goToMatch(ps, ps._searchState.activeMatch + 1);
      }
    };
    pvFindInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        pvRunFind();
      } else if (e.key === 'Escape' && pvFindInput.value) {
        e.preventDefault();
        e.stopPropagation();
        pvFindInput.value = '';
        pvClearFind();
      }
    });
    pvFindInput.addEventListener('input', () => {
      if (!pvFindInput.value.trim()) pvClearFind();
    });

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
        } catch {
          await /** @type {any} */ (real || doc).close?.();
        }
      })().catch(() => {});
    };

    const showEmpty = () => {
      token++;
      endVeil();
      setLiveLocked(false);
      releaseDoc(current ? current.hash : null);
      current = null;
      lastTarget = null;
      pvHead.style.display = 'none';
      pvFoot.style.display = 'none';
      pvHost.style.display = 'none';
      pvLoading.style.display = 'none';
      pvEmpty.textContent = emptyText;
      pvEmpty.style.display = '';
    };

    /** @type {?number} */
    let dwellTimer = null;

    /**
     * Arm the dwell load.
     * Lingering on a page with no stored raster is what loads the image, so rapid flipping stays free.
     * @param {{hash: string, pageN: number}} target
     * @param {number} t
     * @param {boolean} [immediate] Load now instead of after the dwell, for an explicit click on this hit.
     */
    const armDwell = async (target, t, immediate = false) => {
      if (dwellTimer !== null) {
        clearTimeout(dwellTimer);
        dwellTimer = null;
      }
      const store = getStore();
      if (!store || !paneViewer?.doc || paneViewer.doc.id >= 0) return;
      if (await store.readPageRaster(target.hash, target.pageN)) return;
      if (t !== token) return;
      const hydrate = () => {
        if (!(t === token && paneViewer?.doc && paneViewer.doc.id < 0)) return;
        pvLoading.style.display = '';
        /** @type {any} */ (paneViewer.doc)._requestHydration?.();
      };
      if (immediate) {
        hydrate();
        return;
      }
      dwellTimer = window.setTimeout(() => {
        dwellTimer = null;
        hydrate();
      }, DWELL_LOAD_MS);
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
     * Preview a page in the embedded viewer, painting match marks when a query is given.
     * A `jump` target lands on far pages by re-seeding; without it, a page outside the seeded window accelerates the full load as scrolling there would.
     * @param {{relPath: string, hash: string, entry: import('./libraryStore.js').LibraryDocEntry,
     *   pageN: number, query: ?string, title: string, meta: string, pos: string, jump?: boolean, immediate?: boolean}} target
     */
    const show = async (target) => {
      // A width-fit while the surface is hidden commits zoom 0, which no later resize repairs.
      // Record the target for the reshow that runs when the surface is shown again.
      if (!pane.clientWidth) {
        token++;
        lastTarget = target;
        return;
      }
      const t = ++token;
      if (!current || current.hash !== target.hash) {
        pvFindInput.value = '';
        pvFindLast = '';
      }
      pvHead.style.display = '';
      pvFoot.style.display = '';
      /** @type {HTMLElement} */ (pvHead.querySelector('.t')).textContent = target.title;
      /** @type {HTMLElement} */ (pvHead.querySelector('.m')).textContent = target.meta;
      /** @type {HTMLElement} */ (pvFoot.querySelector('[data-pos]')).textContent = target.pos;
      pvEmpty.style.display = 'none';
      pvLoading.style.display = 'none';
      pvHost.style.display = '';
      if (!paneViewer) {
        paneViewer = new /** @type {any} */ (viewer.constructor)(pvHost, {
          edit: false, showToolbar: false, showDropZone: false, showThumbnails: false, fit: 'width',
        });
        // The pane must never compete with the main viewer for canvas memory.
        /** @type {NonNullable<typeof paneViewer>} */ (paneViewer).scribe.imageCache.canvasCacheBytes = 64 * 1024 * 1024;
        /** @type {any} */ (pvHost).scribeViewer = paneViewer;
        // Annotation gestures and comment text edits in the pane checkpoint like tab edits do.
        /** @type {NonNullable<typeof paneViewer>} */ (paneViewer).scribe.onAnnotationsEdited = () => { paneDirty = true; };
        pvHost.addEventListener('input', () => { paneDirty = true; }, true);
      }
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
        // Zoom 0 means the last show finished while the surface was hidden, so the existing paint cannot be kept.
        if (current && current.hash === target.hash && paneViewer.doc && !jumpOutsideSeed
          && current.live === liveDoc && paneViewer.scribe.zoomLevel > 0) {
          // A re-render landing on the same page and query must leave the reader's scroll and paint untouched.
          const samePlace = current.pageN === target.pageN && current.query === target.query;
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
          else if (!current.live) armDwell(target, t, target.immediate);
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
        const seed = await makeSeed(target.relPath, target.entry, target.pageN, liveDoc);
        if (t !== token) return;
        const cover = beginVeil();
        const prevDoc = paneViewer.doc;
        /** @type {?{pages: Array<Array<Object>>, baseline: Set<number>}} */
        let carried = null;
        if (current && current.hash === target.hash && prevDoc && prevDoc.id < 0 && paneDirty) {
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
          countHydration(paneViewer.doc);
        }
        current = {
          relPath: target.relPath, hash: target.hash, pageN: target.pageN, query: target.query, handle, window: seed.window, live: liveDoc,
        };
        // An explicit click on an unwarmed hit starts its full load here, in parallel with the seed's priming.
        // Priming can stream megabytes of sidecar for a big document, and the reader is already waiting.
        // A live-backed seed renders every page from the open tab's document, so the dwell load has nothing to accelerate.
        if (target.immediate && !liveDoc) armDwell(target, t, true);
        await handle.primed;
        if (t !== token) return;
        await applyQueryAndPage(target);
        current.anchorTop = paneViewer.scribe.scrollContainer.scrollTop;
        endVeil(cover);
        if (liveDoc) {
          const entry = getManifest()?.docs[target.relPath];
          if (entry) persistRasterWindow(liveDoc, entry, target.pageN);
        } else if (!target.immediate) armDwell(target, t);
        handle.hydrated.finally(() => {
          if (t === token) pvLoading.style.display = 'none';
        }).catch(() => {});
        handle.hydrated.then(() => {
          if (!(current && current.handle === handle && paneViewer?.doc)) return;
          const ps = /** @type {NonNullable<typeof paneViewer>} */ (paneViewer).scribe;
          const sc = ps.scrollContainer;
          // Once the reader scrolled away from the anchored spot, hydration must not yank them back.
          const readerMoved = current.anchorTop != null && Math.abs(sc.scrollTop - current.anchorTop) > 2;
          if (current.query) {
            // The swap rebuilt the word objects, so re-derive the matches from the real document at whatever page the reader has reached.
            ps.state.searchMode = true;
            findText(ps, current.query);
            if (!readerMoved) {
              const idx = ps._searchState.matchList.findIndex((m) => m.pageN === ps.state.cp.n);
              if (idx >= 0) {
                Promise.resolve(goToMatch(ps, idx)).then(() => {
                  if (current && current.handle === handle) current.anchorTop = sc.scrollTop;
                }).catch(() => {});
              }
            }
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
      endVeil();
      if (dwellTimer !== null) {
        clearTimeout(dwellTimer);
        dwellTimer = null;
      }
      releaseDoc(current ? current.hash : null);
      current = null;
      if (paneViewer) {
        paneViewer.destroy();
        paneViewer = null;
      }
      if (mountedPane === self) mountedPane = null;
    };

    const self = {
      pane,
      openBtn: /** @type {HTMLElement} */ (pane.querySelector('.scribe-library-pv-open')),
      closeBtn: /** @type {HTMLElement} */ (pane.querySelector('.scribe-library-pv-x')),
      prevBtn: /** @type {HTMLElement} */ (pane.querySelector('[data-prev]')),
      nextBtn: /** @type {HTMLElement} */ (pane.querySelector('[data-next]')),
      /** Which view hosts this pane ('results' | 'list'); reuse is only within a kind. */
      kind: '',
      /** The query the results view last rendered with, so a new search resets the pane. */
      shownQuery: '',
      /** @type {?() => void} Rebound on every host render; a reused pane must never stack listeners. */
      onOpen: null,
      /** @type {?() => void} */
      onClose: null,
      /** @type {?() => void} */
      onPrev: null,
      /** @type {?() => void} */
      onNext: null,
      show,
      showEmpty,
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
    self.openBtn.addEventListener('click', () => self.onOpen?.());
    self.closeBtn.addEventListener('click', () => self.onClose?.());
    self.prevBtn.addEventListener('click', () => self.onPrev?.());
    self.nextBtn.addEventListener('click', () => self.onNext?.());
    mountedPane = self;
    return self;
  };

  return {
    /**
     * The pane for a hosting view, reusing the mounted one when the same kind re-renders.
     * A List/Compact switch or an ingest-progress re-render must not tear down the embedded viewer or its painted pages.
     * @param {string} kind
     * @param {string} emptyText
     * @param {string} prevLabel
     * @param {string} nextLabel
     */
    ensurePane: (kind, emptyText, prevLabel, nextLabel) => {
      if (mountedPane && mountedPane.kind === kind) return mountedPane;
      if (mountedPane) mountedPane.destroy();
      const pv = buildPreviewPane(emptyText, prevLabel, nextLabel);
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
