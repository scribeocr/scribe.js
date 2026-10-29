// The library's full-text search results: ranked hit rows with snippets and page thumbnails, beside a preview pane.
// The built view is retained rather than rebuilt, so returning to an unchanged result set restores scroll and paint intact.

import { titleOf } from './libraryStore.js';
import { markOverlayHTML } from './libraryPreview.js';

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
 * @param {() => HTMLElement} deps.host - The element the hit list mounts into, the split's column or, where no preview is shown, the surface body.
 * @param {import('./docSession.js').DocSessions} deps.sessions
 * @param {ReturnType<typeof import('./libraryPreview.js').createPreview>} deps.preview
 * @param {() => ?import('./libraryStore.js').LibraryStore} deps.getStore
 * @param {() => ?import('./libraryStore.js').LibraryManifest} deps.getManifest
 * @param {() => Array<{hash: string, pages: number[]}>} deps.getResults
 * @param {() => string} deps.getQuery
 * @param {(relPath: string, entry: import('./libraryStore.js').LibraryDocEntry, target: Object) => Promise<void>} deps.openEntry
 * @param {() => boolean} deps.selectOpens - Whether selecting a hit opens its document outright, where no preview is shown.
 * @param {() => void} deps.onBack - Leave the results and return to browsing.
 * @param {() => ReturnType<typeof import('./search/searchClient.js').createSearchClient>} deps.getEngine
 * @param {() => ?import('./search/searchClient.js').SearchResponse} deps.getEngineResponse
 * @param {() => ?import('./search/searchClient.js').SearchResponse|undefined} deps.getEngineTiers - The ranked pass's answer.
 *   Undefined while the pass runs, null once none will come.
 * @param {() => ?string} deps.getEngineError
 */
export function createResultsView({
  host, sessions, preview, getStore, getManifest, getResults, getQuery, openEntry, selectOpens, onBack,
  getEngine, getEngineResponse, getEngineTiers, getEngineError,
}) {
  /**
   * The retained search-results view: the built DOM plus its interaction state.
   * @typedef {Object} ResultsBuild
   * @property {Object} results
   * @property {HTMLElement} wrap
   * @property {(relPath: ?string, pageN: number) => void} select
   * @property {() => void} snapshot
   * @property {() => void} attach
   * @property {() => void} repump
   * @property {() => void} tiers
   * @property {() => void} dispose
   */
  /** @type {?ResultsBuild} */
  let resultsView = null;
  /** Abandons in-flight result-row work when a fresh results build replaces the old one. */
  let resultsGen = 0;
  /** The query the view last rendered with, so a new search clears the preview. */
  let shownQuery = '';

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
    /** The scroller the list sits in at the moment, which can change between the split's column and the surface body. */
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
    const backBtn = document.createElement('button');
    backBtn.className = 'scribe-library-back';
    backBtn.textContent = '‹ Back';
    backBtn.addEventListener('click', onBack);
    summary.appendChild(backBtn);
    wrap.appendChild(summary);

    if (shownQuery !== fullTextQuery) preview.showEmpty();
    shownQuery = fullTextQuery;

    const byHash = new Map();
    if (manifest) for (const [relPath, e] of Object.entries(manifest.docs)) byHash.set(e.hash, { relPath, entry: e });

    /**
     * @type {Array<{relPath: string, entry: import('./libraryStore.js').LibraryDocEntry, hash: string, pageN: number, count: number, row: HTMLElement,
     *   lowerTier?: boolean, tier?: number, marks?: Array<[number, number]>}>}
     */
    const hits = [];
    let active = -1;
    let opening = false;
    const openActive = async () => {
      if (active < 0 || opening) return;
      const h = hits[active];
      opening = true;
      try {
        await openEntry(h.relPath, h.entry, {
          pageN: h.pageN,
          query: fullTextQuery,
          near: h.lowerTier && h.marks ? [{
            page: h.pageN, tier: /** @type {number} */ (h.tier), count: h.count, marks: h.marks,
          }] : [],
        });
      } finally {
        opening = false;
      }
    };

    const selectHit = (i) => {
      active = i;
      hits.forEach((h, j) => h.row.classList.toggle('on', j === i));
      const h = hits[i];
      h.row.scrollIntoView({ block: 'nearest' });
      if (selectOpens()) {
        openActive();
        return;
      }
      preview.show({
        relPath: h.relPath,
        hash: h.hash,
        entry: h.entry,
        pageN: h.pageN,
        query: fullTextQuery,
        near: h.lowerTier && h.marks ? [{
          page: h.pageN, tier: /** @type {number} */ (h.tier), count: h.count, marks: h.marks,
        }] : [],
        title: titleOf(h.relPath),
      });
    };

    /** Mark the row for `pageN` of `relPath` as the selection without showing it, or no row for a null path. */
    const selectRowOnly = (relPath, pageN) => {
      const i = relPath ? hits.findIndex((h) => h.relPath === relPath && h.pageN === pageN) : -1;
      active = i;
      hits.forEach((h, j) => h.row.classList.toggle('on', j === i));
      if (i >= 0) hits[i].row.scrollIntoView({ block: 'nearest' });
    };

    wrap.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (active < hits.length - 1) selectHit(active + 1);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (active > 0) selectHit(active - 1);
      } else if (e.key === 'Enter') {
        openActive();
      }
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
        if (preview.userLoadActive()) {
          preview.userLoadIdle().then(resumeWarm);
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
      const ph = document.createElement('span');
      ph.className = 'ph';
      row.appendChild(ph);
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
      row.addEventListener('click', () => {
        selectHit(hits.indexOf(hit));
        wrap.focus();
      });
      row.addEventListener('dblclick', (e) => {
        if (e.shiftKey || e.ctrlKey || e.metaKey) return;
        selectHit(hits.indexOf(hit));
        openActive();
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
     * @typedef {{docRef: {relPath: string, entry: import('./libraryStore.js').LibraryDocEntry, hash: string}, head: HTMLElement, meta: HTMLElement, datePart: string,
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

    const summaryText = () => {
      if (!response) return '';
      if (response.partial || (second && second.partial)) return PARTIAL_SUMMARY;
      const docCount = groups.size + restDocs.length;
      const total = response.matches + (second ? second.docs.reduce((sum, d) => sum + matchesOn(d.pages), 0) : 0);
      if (response.bounded) return `${response.bound}+ matches · ${docCount} document${docCount === 1 ? '' : 's'}`;
      const queryShown = /["“”„‟＂]/.test(fullTextQuery) ? fullTextQuery : `“${fullTextQuery}”`;
      if (!total) return second === undefined ? 'Searching…' : `No matches for ${queryShown}`;
      return `${total} match${total === 1 ? '' : 'es'} · ${docCount} document${docCount === 1 ? '' : 's'}${second === undefined ? ' · searching…' : ''}`;
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
      g.meta.textContent = `${g.datePart}${pageCount} page${pageCount === 1 ? '' : 's'} · ${total} match${total === 1 ? '' : 'es'} on ${g.pages.length} page${g.pages.length === 1 ? '' : 's'}`;
    };

    /**
     * @param {{docRef: DocGroup['docRef'], perPage: ListedPage[]}} info @param {?Element} before
     */
    const appendGroup = (info, before) => {
      const d = info.docRef;
      const head = document.createElement('div');
      head.className = 'scribe-library-rdoc';
      head.append(`${titleOf(d.relPath)} `);
      const meta = document.createElement('span');
      meta.className = 'm';
      head.appendChild(meta);
      wrap.insertBefore(head, before);
      const dateMatch = /^(\d{4})-(\d{2})-(\d{2})[ _]/.exec(d.relPath.split('/').pop() || '');
      const datePart = dateMatch
        ? `${new Date(+dateMatch[1], +dateMatch[2] - 1, +dateMatch[3]).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })} · `
        : '';
      /** @type {DocGroup} */
      const g = {
        docRef: d, head, meta, datePart, pages: info.perPage, shown: 0, more: null, lastRow: null,
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
      summaryN.textContent = summaryText();
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
      summaryN.textContent = summaryText();
    };
    if (getEngineTiers() !== undefined) appendSecond(getEngineTiers() ?? null);

    let listScrollTop = 0;
    resultsView = {
      results,
      wrap,
      select: selectRowOnly,
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

    /** Mark the row for `pageN` of `relPath` as the selection, or no row for a null path. */
    select: (relPath, pageN) => resultsView?.select(relPath, pageN),

    /**
     * Take the ranked pass's answer into the current results' view.
     * Call it also when no answer will come.
     */
    appendTiers: () => {
      if (resultsView && resultsView.results === getResults()) resultsView.tiers();
    },
  };
}
