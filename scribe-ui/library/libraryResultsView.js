// The library's full-text search results: ranked hit rows with snippets and page thumbnails.
// The built view is retained rather than rebuilt, so returning to an unchanged result set restores scroll and paint intact.

import { titleOf } from './libraryStore.js';
/**
 * @param {?{dims: {width: number, height: number}, rects: Array<{left: number, top: number, right: number, bottom: number}>, per: number}} m
 *   The first `per` of `rects` belong to the first occurrence.
 * @returns {string}
 */
const markOverlayHTML = (m) => {
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

/** How many documents, and pages within each, the list shows before a "more" button. */
const RESULT_DOC_LIMIT = 20;
const RESULT_PAGES_PER_DOC = 4;
const RESULT_PAGES_PER_CLICK = 10;
const PARTIAL_SUMMARY = 'Partial results — narrow your search';
/** How long a result set must stand with no query in flight before its background opens start. */
const THUMB_QUIET_MS = 1000;

/**
 * Own the search-results view: one retained build at a time, plus the thumbnail pump and warm lane behind it.
 * @param {Object} deps
 * @param {() => HTMLElement} deps.host
 * @param {import('./docSession.js').DocSessions} deps.sessions
 * @param {ReturnType<typeof import('./libraryDocLoads.js').createDocLoads>} deps.loads
 * @param {() => ?import('./libraryStore.js').LibraryStore} deps.getStore
 * @param {() => ?import('./libraryStore.js').LibraryManifest} deps.getManifest
 * @param {() => Array<{hash: string, pages: number[]}>} deps.getResults
 * @param {() => string} deps.getQuery
 * @param {(relPath: string, entry: import('./libraryStore.js').LibraryDocEntry,
 *   target: {pageN: number, query: string, near: import('./libraryDocLoads.js').NearMatches, group?: number}, keep: boolean) => Promise<void>} deps.openEntry
 *   Show the hit's page: a preview the next selection replaces, or, with `keep`, a tab that stays.
 *   `target.group` is the editor group to open in.
 *   Left out, the page opens where a click would open it.
 * @param {(clientX: number, clientY: number, relPath: string, anchor: HTMLElement, openHit: (group: number) => void) => void} deps.openCardMenu
 *   Open a search result's context menu at the pointer.
 * @param {() => void} deps.focusField - Put the keyboard back in the search field.
 * @param {() => ReturnType<typeof import('./search/searchClient.js').createSearchClient>} deps.getEngine
 * @param {() => ?import('./search/searchClient.js').SearchResponse} deps.getEngineResponse
 * @param {() => ?import('./search/searchClient.js').SearchResponse|undefined} deps.getEngineTiers - The ranked pass's answer.
 *   Undefined while the pass runs, null once none will come.
 * @param {() => ?string} deps.getEngineError
 */
export function createResultsView({
  host, sessions, loads, getStore, getManifest, getResults, getQuery, openEntry, openCardMenu, focusField,
  getEngine, getEngineResponse, getEngineTiers, getEngineError,
}) {
  /**
   * The retained search-results view: the built DOM plus its interaction state.
   * @typedef {Object} ResultsBuild
   * @property {Object} results
   * @property {HTMLElement} wrap
   * @property {() => void} snapshot
   * @property {() => void} attach
   * @property {() => void} repump
   * @property {() => void} tiers
   * @property {() => boolean} focus
   * @property {() => void} dispose
   */
  /** @type {?ResultsBuild} */
  let resultsView = null;
  /** Abandons in-flight result-row work when a fresh results build replaces the old one. */
  let resultsGen = 0;

  const renderResults = () => {
    const results = getResults();
    const fullTextQuery = getQuery();
    const manifest = getManifest();
    const hostEl = host();
    // The same result set reattaches the retained view untouched.
    if (resultsView && resultsView.results === results) {
      hostEl.appendChild(resultsView.wrap);
      resultsView.attach();
      // Rasters stored while the view was away fill blank rows on this retry.
      resultsView.repump();
      resultsView.tiers();
      return;
    }
    if (resultsView) {
      resultsView.dispose();
      resultsView = null;
    }
    const myGen = ++resultsGen;
    const engine = getEngine();
    const wrap = document.createElement('div');
    wrap.className = 'scribe-library-rwrap';
    wrap.tabIndex = 0;
    wrap.setAttribute('aria-label', 'Search results');
    hostEl.appendChild(wrap);
    const scroller = () => wrap.parentElement ?? wrap;

    const summary = document.createElement('div');
    summary.className = 'scribe-library-rsummary';
    const summaryN = document.createElement('span');
    summaryN.className = 'n';
    const engineError = getEngineError();
    const response = getEngineResponse();
    if (engineError) {
      summaryN.textContent = `Search failed for “${fullTextQuery}”, so no matches are shown: ${engineError}`;
      summary.dataset.paintedAt = String(performance.now());
    }
    summary.appendChild(summaryN);
    wrap.appendChild(summary);

    const byHash = new Map();
    if (manifest) for (const [relPath, e] of Object.entries(manifest.docs)) byHash.set(e.hash, { relPath, entry: e });

    /**
     * @type {Array<{relPath: string, entry: import('./libraryStore.js').LibraryDocEntry, hash: string, pageN: number, count: number, row: HTMLElement,
     *   lowerTier?: boolean, tier?: number, marks?: Array<[number, number]>}>}
     */
    const hits = [];
    let active = -1;
    let opening = false;
    /**
     * The request made while an open was in flight, run once it lands: the double-click's keep behind its click's preview, or the last of a run of arrow presses.
     * @type {?[boolean, (number|undefined)]}
     */
    let queued = null;
    /**
     * @param {boolean} keep
     * @param {number} [group] - The editor group to open in, by default the one a click opens in.
     */
    const openActive = async (keep, group) => {
      if (active < 0) return;
      if (opening) {
        queued = [keep, group];
        return;
      }
      const h = hits[active];
      opening = true;
      try {
        await openEntry(h.relPath, h.entry, {
          pageN: h.pageN,
          query: fullTextQuery,
          near: h.lowerTier && h.marks ? [{
            page: h.pageN, tier: /** @type {number} */ (h.tier), count: h.count, marks: h.marks,
          }] : [],
          group,
        }, keep);
      } finally {
        opening = false;
        if (queued !== null) {
          const next = queued;
          queued = null;
          openActive(...next);
        }
      }
    };

    const selectHit = (i) => {
      active = i;
      hits.forEach((h, j) => h.row.classList.toggle('on', j === i));
      hits[i].row.scrollIntoView({ block: 'nearest' });
      openActive(false);
    };

    /**
     * Open a hit's page as a tab that stays, with its row the selected one.
     * @param {typeof hits[number]} hit
     * @param {number} [group]
     */
    const keepHit = (hit, group) => {
      active = hits.indexOf(hit);
      hits.forEach((h, j) => h.row.classList.toggle('on', j === active));
      openActive(true, group);
    };

    /**
     * Select a hit and leave the keyboard in the list.
     * @param {number} i
     */
    const pickHit = (i) => {
      // A name left highlighted would stay so, and the copy shortcut would go on taking it instead of this hit's name.
      const selection = window.getSelection();
      if (selection && wrap.contains(selection.anchorNode)) selection.removeAllRanges();
      selectHit(i);
      wrap.focus({ preventScroll: true });
    };

    wrap.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (active < hits.length - 1) selectHit(active + 1);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (active > 0) selectHit(active - 1);
        else focusField();
      } else if (e.key === 'Escape' && !wrap.querySelector('.context')) {
        // With a result's menu open, the key closes the menu and nothing more.
        e.preventDefault();
        focusField();
      } else if (e.key === 'Enter' && e.target === wrap) {
        openActive(true);
      } else if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'c' && active >= 0 && window.getSelection()?.isCollapsed !== false) {
        e.preventDefault();
        navigator.clipboard?.writeText(titleOf(hits[active].relPath)).catch(() => { });
      } else if ((e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) && active >= 0) {
        e.preventDefault();
        const hit = hits[active];
        const rect = hit.row.getBoundingClientRect();
        openCardMenu(rect.left + 40, rect.top + 20, hit.relPath, hit.row, (group) => keepHit(hit, group));
      }
    });
    wrap.addEventListener('copy', (e) => {
      // A triple click selects a name through the end of its line, so the browser's own copy would end in a line break.
      const text = window.getSelection()?.toString().trim();
      if (!text || !e.clipboardData) return;
      e.clipboardData.setData('text/plain', text);
      e.preventDefault();
    });
    wrap.addEventListener('focus', () => {
      // The list shows keyboard focus as an outline on its selected result, so focus arriving by keyboard with none selected would be invisible.
      if (active < 0 && hits.length && wrap.matches(':focus-visible')) selectHit(0);
    });

    /**
     * One hit row's thumbnail work item.
     * `warmed` records that the background warmer already spent its one render attempt on this page.
     * @typedef {{relPath: string, entry: import('./libraryStore.js').LibraryDocEntry, hash: string, pageN: number, img: HTMLElement, marks?: string, warmed?: boolean}} ThumbItem
     */
    /** @returns {Promise<boolean>} */
    const quiet = async () => {
      do {
        await engine.queriesSettled();
        await new Promise((resolve) => { window.setTimeout(resolve, THUMB_QUIET_MS); });
        await new Promise((resolve) => { requestIdleCallback(() => resolve(undefined)); });
      } while (engine.querying() && myGen === resultsGen);
      return myGen === resultsGen;
    };
    /** @type {Array<ThumbItem>} */
    const thumbQueue = [];
    let thumbsRunning = false;
    /** @type {Array<ThumbItem>} */
    const rasterless = [];
    let warmRunning = false;
    const pumpThumbs = async () => {
      if (thumbsRunning) return;
      thumbsRunning = true;
      while (thumbQueue.length) {
        if (myGen !== resultsGen) break;
        const t = /** @type {ThumbItem} */ (thumbQueue.shift());
        try {
          const url = await sessions.pageImage(t.hash, t.pageN);
          if (myGen !== resultsGen) break;
          if (url || t.marks) t.img.innerHTML = `${url ? `<img alt="" src="${url}">` : ''}${t.marks || ''}`;
          if (!url && !rasterless.includes(t)) rasterless.push(t);
        } catch { /* A failed read leaves the placeholder page blank. */ }
      }
      thumbsRunning = false;
      if (myGen === resultsGen && rasterless.some((r) => !r.warmed)) {
        quiet().then((current) => {
          if (current) warmHits();
        });
      }
    };
    const pump = () => {
      requestAnimationFrame(() => { window.setTimeout(pumpThumbs, 0); });
    };
    const onRaster = (hash, n) => {
      const idx = rasterless.findIndex((r) => r.hash === hash && r.pageN === n);
      if (idx < 0) return;
      thumbQueue.push(/** @type {ThumbItem} */ (rasterless.splice(idx, 1)[0]));
      pump();
    };
    sessions.rasterListeners.add(onRaster);

    // A render runs in the worker, but a pixel source's open touches the main thread, so warming waits for queries to settle and for the reader's loads.
    const resumeWarm = () => {
      if (myGen === resultsGen) warmHits();
    };
    const warmHits = async () => {
      if (warmRunning) return;
      warmRunning = true;
      while (myGen === resultsGen && getStore()) {
        if (document.visibilityState !== 'visible') {
          const resume = () => {
            document.removeEventListener('visibilitychange', resume);
            warmHits();
          };
          document.addEventListener('visibilitychange', resume);
          break;
        }
        if (loads.userLoadActive()) {
          loads.userLoadIdle().then(resumeWarm);
          break;
        }
        const listRect = scroller().getBoundingClientRect();
        let idx = rasterless.findIndex((r) => {
          if (r.warmed) return false;
          const rect = r.img.getBoundingClientRect();
          return rect.bottom > listRect.top && rect.top < listRect.bottom && rect.height > 0;
        });
        if (idx < 0) idx = rasterless.findIndex((r) => !r.warmed);
        if (idx < 0) break;
        const t = /** @type {ThumbItem} */ (rasterless.splice(idx, 1)[0]);
        if (engine.querying() && !(await quiet())) break;
        if (myGen !== resultsGen) break;
        t.warmed = true;
        try {
          await sessions.raster({ hash: t.hash, relPath: t.relPath, entry: t.entry }, t.pageN, false);
        } catch { /* A page that fails to render leaves its row blank. */ }
        thumbQueue.push(t);
        pumpThumbs();
      }
      warmRunning = false;
    };

    /**
     * Sort by name each run of documents the engine ranked equal.
     * @template T
     * @param {T[]} docs - In the engine's order.
     * @param {(d: T) => {tier?: number, count: number, score?: number}} best - A document's best page.
     * @param {(d: T) => string} relPath
     * @returns {T[]}
     */
    const tiesByName = (docs, best, relPath) => {
      const key = (d) => { const p = best(d); return `${p.tier ?? 1}|${p.count}|${p.score ?? 0}`; };
      const out = [];
      for (let i = 0; i < docs.length;) {
        let j = i + 1;
        while (j < docs.length && key(docs[j]) === key(docs[i])) j++;
        const run = docs.slice(i, j);
        if (run.length > 1) run.sort((a, b) => titleOf(relPath(a)).localeCompare(titleOf(relPath(b)), undefined, { numeric: true }));
        out.push(...run);
        i = j;
      }
      return out;
    };

    /** @param {import('./search/searchClient.js').Snippet} snippet */
    const snippetFragment = (snippet) => {
      const frag = document.createDocumentFragment();
      if (snippet.before) frag.append('…');
      let pos = 0;
      for (const [start, end] of snippet.marks) {
        if (start < pos) continue;
        frag.append(snippet.text.slice(pos, start));
        const bold = document.createElement('b');
        bold.textContent = snippet.text.slice(start, end);
        frag.appendChild(bold);
        pos = end;
      }
      frag.append(snippet.text.slice(pos));
      if (snippet.after) frag.append('…');
      return frag;
    };

    /**
     * @param {{rects?: ?Array<Array<import('./search/searchClient.js').Box>>, dims?: ?{width: number, height: number}}} info
     */
    const marksOf = (info) => (info.rects && info.dims && info.rects.length
      ? markOverlayHTML({ dims: info.dims, rects: info.rects.flat(), per: info.rects[0].length }) : undefined);

    /**
     * @param {{relPath: string, entry: import('./libraryStore.js').LibraryDocEntry, hash: string}} docRef
     * @param {number} pageN
     * @param {{count: number, snippet: ?DocumentFragment, tier?: number, marks?: Array<[number, number]>, sn?: HTMLElement, rects?: ?Array<Array<import('./search/searchClient.js').Box>>,
     *   dims?: ?{width: number, height: number}, thumb?: ThumbItem}} info
     *   A null `snippet` leaves the snippet span empty and hands it back in `sn` to fill later.
     *   The row's thumbnail item is handed back in `thumb`, for marks that arrive later.
     * @param {number} insertAt - Position in `hits`, so expanded rows keep list order for stepping.
     * @param {boolean} [lowerTier]
     * @returns {HTMLElement}
     */
    const buildHitRow = (docRef, pageN, info, insertAt, lowerTier = false) => {
      const row = document.createElement('div');
      row.className = 'scribe-library-hit';
      const slot = document.createElement('span');
      slot.className = 'phs';
      const ph = document.createElement('span');
      ph.className = 'ph';
      slot.appendChild(ph);
      row.appendChild(slot);
      const hm = document.createElement('span');
      hm.className = 'hm';
      const ht = document.createElement('span');
      ht.className = 'ht';
      ht.append(`Page ${pageN + 1} `);
      // A page that merely holds the words anywhere has no occurrence count to show.
      if (info.tier !== 5) {
        const htMeta = document.createElement('span');
        htMeta.className = 'm';
        htMeta.textContent = `· ${info.count} match${info.count === 1 ? '' : 'es'}`;
        ht.appendChild(htMeta);
      }
      hm.appendChild(ht);
      const sn = document.createElement('span');
      sn.className = 'sn';
      if (info.snippet) sn.appendChild(info.snippet);
      else info.sn = sn;
      hm.appendChild(sn);
      row.appendChild(hm);
      const hit = {
        relPath: docRef.relPath, entry: docRef.entry, hash: docRef.hash, pageN, count: info.count, row, lowerTier, tier: info.tier, marks: info.marks,
      };
      hits.splice(insertAt, 0, hit);
      row.addEventListener('click', () => pickHit(hits.indexOf(hit)));
      row.addEventListener('dblclick', (e) => {
        if (e.shiftKey || e.ctrlKey || e.metaKey) return;
        keepHit(hit);
      });
      row.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        openCardMenu(e.clientX, e.clientY, hit.relPath, row, (group) => keepHit(hit, group));
      });
      /** @type {ThumbItem} */
      const thumb = {
        relPath: docRef.relPath, entry: docRef.entry, hash: docRef.hash, pageN, img: ph, marks: marksOf(info),
      };
      if (thumb.marks) ph.innerHTML = thumb.marks;
      info.thumb = thumb;
      thumbQueue.push(thumb);
      return row;
    };

    /**
     * @typedef {{pageN: number, count: number, tier: number, score: number, marks: Array<[number, number]>, snippet: ?DocumentFragment, sn?: HTMLElement,
     *   rects?: ?Array<Array<import('./search/searchClient.js').Box>>, dims?: ?{width: number, height: number}, thumb?: ThumbItem}} ListedPage
     */
    /**
     * @typedef {{docRef: {relPath: string, entry: import('./libraryStore.js').LibraryDocEntry, hash: string}, head: HTMLElement, meta: HTMLElement,
     *   pages: ListedPage[], shown: number, more: ?HTMLButtonElement, lastRow: ?HTMLElement}} DocGroup
     */
    /** @type {Map<string, DocGroup>} */
    const groups = new Map();
    /** @type {Array<{docRef: DocGroup['docRef'], perPage: ListedPage[]}>} */
    const restDocs = [];
    /** @type {?HTMLButtonElement} */
    let moreDocs = null;
    /** @type {?import('./search/searchClient.js').SearchResponse|undefined} */
    let second = response && response.tiersPending ? undefined : null;
    let secondDone = false;

    /** @param {import('./search/searchClient.js').ResponsePage} p @returns {ListedPage} */
    const listedPage = (p) => ({
      pageN: p.page, count: p.count, tier: p.tier, score: p.score, marks: p.marks, snippet: p.snippet ? snippetFragment(p.snippet) : null, rects: p.rects, dims: p.dims,
    });
    /** @param {{hash: string, pages: Array<import('./search/searchClient.js').ResponsePage>}} d */
    const docInfo = (d) => {
      const docRef = byHash.get(d.hash);
      return docRef ? { docRef: { relPath: docRef.relPath, entry: docRef.entry, hash: d.hash }, perPage: d.pages.map(listedPage) } : null;
    };
    /** @param {Array<{tier: number, count: number}>} pages */
    const matchesOn = (pages) => pages.reduce((sum, p) => sum + (p.tier === 5 ? 1 : p.count), 0);

    /** Write the line above the results, which holds the search's counts or says what became of it. */
    const fillSummary = () => {
      // A failed search has no answer, and its line already says so.
      if (!response) return;
      const partial = response.partial || !!(second && second.partial);
      const docCount = groups.size + restDocs.length;
      const total = response.matches + (second ? second.docs.reduce((sum, d) => sum + matchesOn(d.pages), 0) : 0);
      const counted = !partial && (response.bounded || total > 0);
      // The "Searching" line gives way to the counts, so it is set as they are.
      summary.classList.toggle('count', counted || (!partial && second === undefined));
      if (partial) {
        summaryN.textContent = PARTIAL_SUMMARY;
      } else if (!counted) {
        const queryShown = /["“”„‟＂]/.test(fullTextQuery) ? fullTextQuery : `“${fullTextQuery}”`;
        summaryN.textContent = second === undefined ? 'Searching…' : `No matches for ${queryShown}`;
      } else {
        const matches = document.createElement('b');
        matches.textContent = response.bounded ? `${response.bound}+` : String(total);
        const docs = document.createElement('b');
        docs.textContent = String(docCount);
        summaryN.replaceChildren(
          matches,
          ` match${!response.bounded && total === 1 ? '' : 'es'} · `,
          docs,
          ` document${docCount === 1 ? '' : 's'}${!response.bounded && second === undefined ? ' · searching…' : ''}`,
        );
      }
    };

    /**
     * @param {string} hash
     * @param {Array<{pageN: number, marks?: Array<[number, number]>, sn?: HTMLElement, thumb?: ThumbItem}>} pps
     */
    const fillSnippets = (hash, pps) => {
      const want = pps.filter((pp) => pp.sn);
      if (!want.length) return;
      engine.snippets(hash, want.map((pp) => ({ page: pp.pageN, marks: pp.marks || [] }))).then((list) => {
        if (myGen !== resultsGen) return;
        for (const item of list) {
          const pp = want.find((w) => w.pageN === item.page);
          if (!pp) continue;
          if (pp.sn && item.snippet) {
            pp.sn.replaceChildren(snippetFragment(item.snippet));
            pp.sn = undefined;
          }
          const marks = marksOf(item);
          if (marks && pp.thumb && !pp.thumb.marks) {
            pp.thumb.marks = marks;
            const img = pp.thumb.img.querySelector('img');
            pp.thumb.img.innerHTML = `${img ? img.outerHTML : ''}${marks}`;
          }
        }
      }).catch(() => {});
    };

    /**
     * @param {Element} el
     */
    const hitIndexAfter = (el) => {
      /** @type {?Element} */
      let prev = el;
      while (prev && !prev.classList.contains('scribe-library-hit')) prev = prev.previousElementSibling;
      return prev ? hits.findIndex((h) => h.row === prev) + 1 : 0;
    };

    /**
     * @param {DocGroup} g @param {number} upTo
     */
    const showPages = (g, upTo) => {
      /** @type {ListedPage[]} */
      const batch = [];
      while (g.shown < Math.min(upTo, g.pages.length)) {
        const pp = g.pages[g.shown++];
        const after = g.lastRow ?? g.head;
        const row = buildHitRow(g.docRef, pp.pageN, pp, hitIndexAfter(after), pp.tier >= 3);
        after.after(row);
        g.lastRow = row;
        batch.push(pp);
      }
      fillSnippets(g.docRef.hash, batch);
      const rest = g.pages.length - g.shown;
      if (rest && !g.more) {
        const more = document.createElement('button');
        more.className = 'scribe-library-rmore';
        more.type = 'button';
        more.addEventListener('click', () => {
          showPages(g, g.shown + RESULT_PAGES_PER_CLICK);
          pump();
        });
        /** @type {HTMLElement} */ (g.lastRow ?? g.head).after(more);
        g.more = more;
      }
      if (rest) /** @type {HTMLButtonElement} */ (g.more).textContent = `+ ${rest} more page${rest === 1 ? '' : 's'}`;
      else if (g.more) {
        g.more.remove();
        g.more = null;
      }
      const total = matchesOn(g.pages);
      const { pageCount } = g.docRef.entry;
      g.meta.textContent = `${pageCount} page${pageCount === 1 ? '' : 's'} · ${total} match${total === 1 ? '' : 'es'} on ${g.pages.length} page${g.pages.length === 1 ? '' : 's'}`;
    };

    /**
     * @param {{docRef: DocGroup['docRef'], perPage: ListedPage[]}} info @param {?Element} before
     */
    const appendGroup = (info, before) => {
      const d = info.docRef;
      const head = document.createElement('div');
      head.className = 'scribe-library-rdoc';
      const name = document.createElement('span');
      name.className = 't';
      // A long name wraps after its separators before it breaks inside a word.
      titleOf(d.relPath).split(/([_\-.])/).forEach((part, k) => {
        name.append(part);
        if (k % 2) name.appendChild(document.createElement('wbr'));
      });
      const meta = document.createElement('span');
      meta.className = 'm';
      head.append(name, ' ', meta);
      head.addEventListener('contextmenu', (e) => {
        // The system's own menu stays available only for copying selected text.
        if (window.getSelection()?.isCollapsed !== false) e.preventDefault();
      });
      wrap.insertBefore(head, before);
      /** @type {DocGroup} */
      const g = {
        docRef: d, head, meta, pages: info.perPage, shown: 0, more: null, lastRow: null,
      };
      groups.set(d.hash, g);
      showPages(g, RESULT_PAGES_PER_DOC);
    };

    const syncMoreDocs = () => {
      if (!restDocs.length) {
        if (moreDocs) moreDocs.remove();
        moreDocs = null;
        return;
      }
      if (!moreDocs) {
        const button = document.createElement('button');
        button.className = 'scribe-library-rmore';
        button.type = 'button';
        button.style.paddingLeft = '16px';
        button.addEventListener('click', () => {
          for (const info of restDocs.splice(0)) appendGroup(info, button);
          syncMoreDocs();
          pump();
        });
        wrap.appendChild(button);
        moreDocs = button;
      }
      moreDocs.textContent = `+ ${restDocs.length} more document${restDocs.length === 1 ? '' : 's'}`;
    };

    if (getStore() && response) {
      const ranked = tiesByName(
        /** @type {Array<NonNullable<ReturnType<typeof docInfo>>>} */ (response.docs.map(docInfo).filter(Boolean)),
        (d) => d.perPage[0],
        (d) => d.docRef.relPath,
      );
      for (const info of ranked.slice(0, RESULT_DOC_LIMIT)) appendGroup(info, null);
      restDocs.push(...ranked.slice(RESULT_DOC_LIMIT));
      syncMoreDocs();
      fillSummary();
      // Timing tools outside the app read `paintedAt` as the moment the answer's summary painted.
      summary.dataset.paintedAt = String(performance.now());
      pump();
    }

    /**
     * @param {?import('./search/searchClient.js').SearchResponse} tiers
     */
    const appendSecond = (tiers) => {
      if (secondDone) return;
      secondDone = true;
      second = tiers;
      let pages = 0;
      if (tiers) {
        const infos = tiesByName(
          /** @type {Array<NonNullable<ReturnType<typeof docInfo>>>} */ (tiers.docs.map(docInfo).filter(Boolean)),
          (d) => d.perPage[0],
          (d) => d.docRef.relPath,
        );
        for (const info of infos) {
          pages += info.perPage.length;
          const g = groups.get(info.docRef.hash);
          if (g) {
            g.pages.push(...info.perPage);
            showPages(g, RESULT_PAGES_PER_DOC);
            continue;
          }
          const hidden = restDocs.find((r) => r.docRef.hash === info.docRef.hash);
          if (hidden) hidden.perPage.push(...info.perPage);
          else if (groups.size < RESULT_DOC_LIMIT) appendGroup(info, moreDocs);
          else restDocs.push(info);
        }
        syncMoreDocs();
        pump();
      }
      // Timing tools outside the app read `tierPages` and `tiersAt`, so both are set even when the ranked pass adds no page.
      wrap.dataset.tierPages = String(pages);
      wrap.dataset.tiersAt = String(performance.now());
      fillSummary();
    };
    if (getEngineTiers() !== undefined) appendSecond(getEngineTiers() ?? null);

    let listScrollTop = 0;
    resultsView = {
      results,
      wrap,
      snapshot: () => {
        listScrollTop = scroller().scrollTop;
      },
      attach: () => {
        scroller().scrollTop = listScrollTop;
      },
      repump: () => {
        if (myGen !== resultsGen || !rasterless.length) return;
        thumbQueue.push(...rasterless.splice(0));
        pump();
      },
      tiers: () => {
        const tiers = getEngineTiers();
        if (myGen === resultsGen && tiers !== undefined) appendSecond(tiers);
      },
      focus: () => {
        if (!hits.length) return false;
        pickHit(Math.max(0, active));
        return true;
      },
      dispose: () => {
        resultsGen++;
        sessions.rasterListeners.delete(onRaster);
      },
    };
  };

  return {
    render: renderResults,

    /** Capture scroll state before the host clears the surface, so a reattach can restore it. */
    snapshot: () => {
      if (resultsView && resultsView.wrap.isConnected) resultsView.snapshot();
    },

    /** Drop the retained view and abandon its in-flight row work. */
    dispose: () => {
      if (!resultsView) return;
      resultsView.dispose();
      resultsView = null;
    },

    /** Retry the rows left blank at pump time, after rasters landed elsewhere. */
    repump: () => resultsView?.repump(),

    /**
     * Take the ranked pass's answer into the current results' view.
     * Call it also when no answer will come.
     */
    appendTiers: () => {
      if (resultsView && resultsView.results === getResults()) resultsView.tiers();
    },

    /**
     * Put the keyboard in the list, on its selected result or else its first.
     * @returns {boolean} Whether the list is showing with a result to take it.
     */
    focusList: () => !!resultsView && resultsView.wrap.isConnected && resultsView.focus(),
  };
}
