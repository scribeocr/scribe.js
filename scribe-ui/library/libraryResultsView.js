// The library's full-text search results: ranked hit rows with snippets and page thumbnails, beside a preview pane.
// The built view is retained rather than rebuilt, so returning to an unchanged result set restores scroll and paint intact.
// Hit thumbnails come from stored rasters; a background warmer renders the missing ones one bounded import at a time.

import scribeLib from '../../scribe.js';
import {
  RASTER_STORE_MIN_MS, renderPageRaster, WARM_PDF_LIMIT, WARM_SIDECAR_LIMIT,
} from './libraryIngest.js';
import { titleOf } from './libraryStore.js';
import { getMatchRects, markOverlayHTML } from './libraryPreview.js';

/** How many documents, and pages within each, the list shows before a "more" button. */
const RESULT_DOC_LIMIT = 20;
const RESULT_PAGES_PER_DOC = 4;
/** Characters of page text kept either side of a hit in its snippet. */
const SNIPPET_RADIUS = 70;
/** With the positional engine, how long a result set must stand with no query in flight before its thumbnails' sidecar passes and background opens start. */
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
 * @param {() => void} deps.saveManifestSoon - Debounced manifest write, for measurements recorded on entries.
 * @param {() => ?ReturnType<typeof import('./search/searchClient.js').createSearchClient>} [deps.getEngine]
 * @param {() => ?import('./search/searchClient.js').SearchResponse} [deps.getEngineResponse]
 * @param {() => ?import('./search/searchClient.js').SearchResponse} [deps.getEngineTiers] - The near matches of the current query, once they arrive.
 * @param {() => ?string} [deps.getEngineError]
 */
export function createResultsView({
  host, sessions, preview, getStore, getManifest, getResults, getQuery, openEntry, selectOpens, onBack, saveManifestSoon,
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
      // Rasters may have landed since the rows were built (a preview, a full open), so blank rows retry.
      resultsView.repump();
      resultsView.tiers();
      return;
    }
    if (resultsView) {
      resultsView.dispose();
      resultsView = null;
    }
    const myGen = ++resultsGen;
    const engine = getEngine ? getEngine() : null;
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
    const engineError = getEngineError ? getEngineError() : null;
    if (engineError) summaryN.textContent = `Search failed for “${fullTextQuery}”, so no matches are shown: ${engineError}`;
    else if (results.length) summaryN.textContent = `${results.length} document${results.length === 1 ? '' : 's'}`;
    else summaryN.textContent = `No ${engine && getEngineResponse && getEngineResponse()?.fallbackTiers ? 'exact matches' : 'results'} for “${fullTextQuery}”`;
    // Timing tools outside the app read `paintedAt` as the moment the summary took its final text.
    summary.dataset.paintedAt = String(performance.now());
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

    /** @type {Array<{relPath: string, entry: import('./libraryStore.js').LibraryDocEntry, hash: string, pageN: number, count: number, row: HTMLElement, lowerTier?: boolean}>} */
    const hits = [];
    let active = -1;
    let opening = false;
    /**
     * The near matches' section, once appended.
     * Exact rows added later go above it, on screen and in `hits`.
     * @type {?HTMLElement}
     */
    let tierSection = null;

    const openActive = async () => {
      if (active < 0 || opening) return;
      const h = hits[active];
      opening = true;
      try {
        await openEntry(h.relPath, h.entry, { pageN: h.pageN, query: fullTextQuery });
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
        title: titleOf(h.relPath),
        jump: true,
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
     * One hit row's thumbnail work item. `marks` caches the overlay HTML after the first sidecar read;
     * `warmed` records that the background warmer already spent its one render attempt on this page.
     * @typedef {{relPath: string, entry: import('./libraryStore.js').LibraryDocEntry, hash: string, pageN: number, img: HTMLElement, marks?: string, warmed?: boolean}} ThumbItem
     */
    /** @returns {Promise<boolean>} */
    const quiet = async () => {
      // A sidecar pass or a background open can hold the main thread for seconds on a long document, delaying the paint of any query answered meanwhile.
      do {
        if (engine) await engine.queriesSettled();
        await new Promise((resolve) => { window.setTimeout(resolve, THUMB_QUIET_MS); });
        await new Promise((resolve) => { requestIdleCallback(() => resolve(undefined)); });
      } while (engine && engine.querying() && myGen === resultsGen);
      return myGen === resultsGen;
    };
    /** @type {Array<ThumbItem>} */
    const thumbQueue = [];
    let thumbsRunning = false;
    /** @type {Array<ThumbItem>} Rows whose stored raster was absent at pump time, kept for the warmer and for repump retries. */
    const rasterless = [];
    let warmRunning = false;
    /**
     * Overlay a row's match marks once its document's sidecar pass lands, over whatever raster already painted.
     * @param {ThumbItem} t
     * @param {?string} url
     * @param {Promise<?Map<number, {ocr: ?Object, annotations: ?Array<Object>}>>} sidePass
     */
    const paintLateMarks = (t, url, sidePass) => {
      sidePass.then((side) => {
        if (myGen !== resultsGen || t.marks !== undefined) return;
        const page = side?.get(t.pageN)?.ocr ?? null;
        const pd = t.entry.pageDims?.[t.pageN];
        t.marks = markOverlayHTML(getMatchRects(page, pd ? { width: pd[0], height: pd[1] } : null, fullTextQuery));
        if (t.marks) t.img.innerHTML = `${url ? `<img alt="" src="${url}">` : ''}${t.marks}`;
      });
    };
    // The pump never imports a document: it paints stored rasters and sidecar marks, and leaves missing rasters to warmHits.
    const pumpThumbs = async () => {
      if (thumbsRunning) return;
      thumbsRunning = true;
      while (thumbQueue.length) {
        if (myGen !== resultsGen) break;
        const first = /** @type {NonNullable<typeof thumbQueue[0]>} */ (thumbQueue.shift());
        // Every queued page of this document reads in one sidecar pass.
        const batch = [first];
        for (let i = 0; i < thumbQueue.length;) {
          if (thumbQueue[i].hash === first.hash) batch.push(thumbQueue.splice(i, 1)[0]);
          else i++;
        }
        // Stored rasters paint before the sidecar pass lands, because a multi-MB sidecar must not hold up rows that already have images.
        const needMarks = batch.filter((b) => b.marks === undefined);
        /** @type {?Promise<?Map<number, {ocr: ?Object, annotations: ?Array<Object>}>>} */
        let sidePass = null;
        if (needMarks.length && engine) {
          sidePass = quiet().then((current) => (current ? sessions.sidecarPages(first.hash, needMarks.map((b) => b.pageN)) : null)).catch(() => null);
        } else if (needMarks.length) {
          sidePass = sessions.sidecarPages(first.hash, needMarks.map((b) => b.pageN)).catch(() => null);
        }
        for (const t of batch) {
          if (myGen !== resultsGen) break;
          try {
            const url = await sessions.pageImage(t.hash, t.pageN);
            if (myGen !== resultsGen) break;
            if (url || t.marks) t.img.innerHTML = `${url ? `<img alt="" src="${url}">` : ''}${t.marks || ''}`;
            if (!url && !rasterless.includes(t)) rasterless.push(t);
            if (t.marks === undefined && sidePass) paintLateMarks(t, url, sidePass);
          } catch { /* A failed read leaves the placeholder page blank. */ }
        }
      }
      thumbsRunning = false;
      if (myGen === resultsGen && rasterless.some((r) => !r.warmed)) {
        if (engine) {
          quiet().then((current) => {
            if (current) warmHits();
          });
        } else warmHits();
      }
    };
    const pump = () => {
      if (engine) requestAnimationFrame(() => { window.setTimeout(pumpThumbs, 0); });
      else pumpThumbs();
    };

    // Renders the missing hit-page rasters, one bounded import at a time.
    // Each import restores that document's whole sidecar, so the gates below keep warming from running alongside a load the reader is waiting on.
    const resumeWarm = () => {
      if (myGen === resultsGen) warmHits();
    };
    const warmHits = async () => {
      if (warmRunning) return;
      warmRunning = true;
      while (myGen === resultsGen && getStore()) {
        const store = /** @type {import('./libraryStore.js').LibraryStore} */ (getStore());
        if (store.rasterBytes !== null && store.rasterBytes > store.rasterBudget) break;
        if (document.visibilityState !== 'visible') {
          const resume = () => {
            document.removeEventListener('visibilitychange', resume);
            warmHits();
          };
          document.addEventListener('visibilitychange', resume);
          break;
        }
        // A provisional preview showing a stored raster may never hydrate, so it does not count as a user load.
        if (preview.userLoadActive()) {
          preview.userLoadIdle().then(resumeWarm);
          break;
        }
        const busyHash = preview.shownHash();
        const listRect = scroller().getBoundingClientRect();
        let idx = rasterless.findIndex((r) => {
          if (r.warmed || r.hash === busyHash) return false;
          const rect = r.img.getBoundingClientRect();
          return rect.bottom > listRect.top && rect.top < listRect.bottom && rect.height > 0;
        });
        if (idx < 0) idx = rasterless.findIndex((r) => !r.warmed && r.hash !== busyHash);
        if (idx < 0) break;
        const first = /** @type {ThumbItem} */ (rasterless.splice(idx, 1)[0]);
        const batch = [first];
        for (let i = 0; i < rasterless.length;) {
          if (!rasterless[i].warmed && rasterless[i].hash === first.hash) batch.push(rasterless.splice(i, 1)[0]);
          else i++;
        }
        const sidecarBytes = await store.sidecarSize(first.hash);
        if ((sidecarBytes !== null && sidecarBytes > WARM_SIDECAR_LIMIT) || first.entry.size > WARM_PDF_LIMIT) {
          // Too big to import in the background, but the rows stay tracked so a preview or open can still fill them.
          for (const t of batch) {
            t.warmed = true;
            rasterless.push(t);
          }
          continue;
        }
        /** @type {?import('../../js/containers/scribeDoc.js').ScribeDoc} */
        let doc = null;
        let owned = false;
        /** @type {?number} Start of a cold open, cleared once the first render completes the first-paint measurement. */
        let coldStart = null;
        try {
          doc = sessions.peekLive(first.hash);
          if (!doc && engine) {
            await new Promise((resolve) => { requestIdleCallback(() => resolve(undefined)); });
            if (engine.querying() && !(await quiet())) break;
            if (myGen !== resultsGen) break;
          }
          if (!doc) {
            // A click can land after this iteration passed the top-of-loop gate, so re-check before the expensive reads and import.
            // A wait here means the timing below would be contended, so the measurement is skipped rather than recorded inflated.
            const contended = preview.userLoadActive();
            await preview.userLoadIdle();
            if (myGen !== resultsGen) break;
            const t0 = performance.now();
            const files = /** @type {Array<File>} */ ([await store.readFile(first.relPath)]);
            const sidecar = await store.readSidecar(first.hash);
            if (sidecar) files.push(new File([sidecar], `${first.hash}.scribe`));
            doc = await scribeLib.openDocument(files, { deferText: true, skipFontOpt: true, pdfWorkerN: 1 });
            owned = true;
            if (!contended) coldStart = t0;
          }
          // Stored rasters are keyed by the ingested page order, so a document that no longer matches its entry must stay blank.
          if (doc.pageMetrics.length !== first.entry.pageCount) continue;
          for (const t of batch) {
            if (engine && engine.querying() && !(await quiet())) break;
            if (myGen !== resultsGen) break;
            if (coldStart !== null && preview.userLoadActive()) coldStart = null;
            await preview.userLoadIdle();
            t.warmed = true;
            if (!(await store.readPageRaster(t.hash, t.pageN))) {
              const raster = await renderPageRaster(doc, t.pageN);
              if (coldStart !== null) {
                // Only the first render of the batch measures a first paint. The rest run on the open document and are warm.
                first.entry.firstPaintMs = Math.round(performance.now() - coldStart);
                coldStart = null;
                saveManifestSoon();
              }
              if (!raster) continue;
              if (first.entry.firstPaintMs !== undefined && first.entry.firstPaintMs < RASTER_STORE_MIN_MS) {
                sessions.adoptPageImage(t.hash, t.pageN, raster);
              } else {
                await store.writePageRaster(t.hash, t.pageN, raster);
              }
            }
            thumbQueue.push(t);
            pumpThumbs();
          }
        } catch { /* A document that fails to open leaves its rows blank. */
        } finally {
          if (owned && doc) await doc.close().catch(() => {});
        }
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
     * @param {{relPath: string, entry: import('./libraryStore.js').LibraryDocEntry, hash: string}} docRef
     * @param {number} pageN
     * @param {{count: number, snippet: ?DocumentFragment, tier?: number, sn?: HTMLElement}} info - A null `snippet` leaves the snippet span empty and hands it back in `sn` to fill later.
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
      if (info.tier !== 4) {
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
        relPath: docRef.relPath, entry: docRef.entry, hash: docRef.hash, pageN, count: info.count, row, lowerTier,
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
      thumbQueue.push({
        relPath: docRef.relPath, entry: docRef.entry, hash: docRef.hash, pageN, img: ph,
      });
      return row;
    };

    (async () => {
      const store = getStore();
      if (!store || !results.length) return;
      const response = engine && getEngineResponse ? getEngineResponse() : null;
      /**
       * @type {Array<{docRef: {relPath: string, entry: import('./libraryStore.js').LibraryDocEntry, hash: string},
       *   perPage: Array<{pageN: number, count: number, snippet: ?DocumentFragment, tier?: number, marks?: Array<[number, number]>, sn?: HTMLElement}>, total: number}>}
       */
      let ranked;
      let summaryText;
      if (response) {
        ranked = /** @type {typeof ranked} */ (response.docs.map((d) => {
          const docRef = byHash.get(d.hash);
          if (!docRef) return null;
          return {
            docRef: { relPath: docRef.relPath, entry: docRef.entry, hash: d.hash },
            total: d.total,
            perPage: d.pages.map((p) => ({
              pageN: p.page, count: p.count, tier: p.tier, score: p.score, marks: p.marks, snippet: p.snippet ? snippetFragment(p.snippet) : null,
            })),
          };
        }).filter(Boolean));
        ranked = tiesByName(ranked, (d) => d.perPage[0], (d) => d.docRef.relPath);
        const count = response.bounded ? `${response.bound}+` : String(response.matches);
        summaryText = response.partial ? 'Partial results — narrow your search' : `${count} match${count === '1' ? '' : 'es'} · ${ranked.length} document${ranked.length === 1 ? '' : 's'}`;
      } else {
        const infos = await Promise.all(results.map(async (result) => {
          const docRef = byHash.get(result.hash);
          if (!docRef) return null;
          const text = await store.readTextCache(result.hash).catch(() => null);
          if (text === null) return null;
          const pagesText = text.split('\f');
          const queryLower = fullTextQuery.toLowerCase();
          const perPage = result.pages.map((pageN) => {
            const pageText = pagesText[pageN] || '';
            const lower = pageText.toLowerCase();
            let needle = queryLower;
            const starts = [];
            let at = lower.indexOf(needle);
            if (at < 0) {
              needle = queryLower.split(/[^\p{L}\p{N}]+/u).find((t) => t.length >= 2) || '';
              at = needle ? lower.indexOf(needle) : -1;
            }
            while (at >= 0) {
              starts.push(at);
              at = lower.indexOf(needle, at + needle.length);
            }
            const snippet = document.createDocumentFragment();
            if (!starts.length) {
              snippet.append(pageText.slice(0, SNIPPET_RADIUS * 2));
            } else {
              const winStart = Math.max(0, starts[0] - SNIPPET_RADIUS);
              const winEnd = Math.min(pageText.length, starts[0] + needle.length + SNIPPET_RADIUS);
              let pos = winStart;
              if (winStart > 0) snippet.append('…');
              for (const s of starts) {
                if (s < winStart || s + needle.length > winEnd) continue;
                snippet.append(pageText.slice(pos, s));
                const bold = document.createElement('b');
                bold.textContent = pageText.slice(s, s + needle.length);
                snippet.appendChild(bold);
                pos = s + needle.length;
              }
              snippet.append(pageText.slice(pos, winEnd));
              if (winEnd < pageText.length) snippet.append('…');
            }
            return { pageN, count: Math.max(starts.length, 1), snippet };
          });
          const total = perPage.reduce((sum, pp) => sum + pp.count, 0);
          return {
            docRef: { relPath: docRef.relPath, entry: docRef.entry, hash: result.hash }, perPage, total,
          };
        }));
        if (myGen !== resultsGen) return;
        ranked = /** @type {typeof ranked} */ (infos.filter(Boolean));
        ranked.sort((a, b) => b.total - a.total);
        const totalMatches = ranked.reduce((sum, r) => sum + r.total, 0);
        summaryText = `${totalMatches} match${totalMatches === 1 ? '' : 'es'} · ${ranked.length} document${ranked.length === 1 ? '' : 's'}`;
      }
      if (myGen !== resultsGen) return;
      summaryN.textContent = summaryText;
      summary.dataset.paintedAt = String(performance.now());

      /**
       * @param {string} hash
       * @param {Array<{pageN: number, marks?: Array<[number, number]>, sn?: HTMLElement}>} pps
       */
      const fillSnippets = (hash, pps) => {
        const want = pps.filter((pp) => pp.sn);
        if (!engine || !want.length) return;
        engine.snippets(hash, want.map((pp) => ({ page: pp.pageN, marks: pp.marks || [] }))).then((list) => {
          if (myGen !== resultsGen) return;
          for (const item of list) {
            const pp = want.find((w) => w.pageN === item.page);
            if (!pp || !pp.sn || !item.snippet) continue;
            pp.sn.replaceChildren(snippetFragment(item.snippet));
            pp.sn = undefined;
          }
        }).catch(() => {});
      };

      const appendDocGroup = (info) => {
        const d = info.docRef;
        const head = document.createElement('div');
        head.className = 'scribe-library-rdoc';
        head.append(`${titleOf(d.relPath)} `);
        const meta = document.createElement('span');
        meta.className = 'm';
        const dateMatch = /^(\d{4})-(\d{2})-(\d{2})[ _]/.exec(d.relPath.split('/').pop() || '');
        const datePart = dateMatch
          ? `${new Date(+dateMatch[1], +dateMatch[2] - 1, +dateMatch[3]).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })} · `
          : '';
        meta.textContent = `${datePart}${d.entry.pageCount} page${d.entry.pageCount === 1 ? '' : 's'} · ${info.total} match${info.total === 1 ? '' : 'es'} on ${info.perPage.length} page${info.perPage.length === 1 ? '' : 's'}`;
        head.appendChild(meta);
        wrap.insertBefore(head, tierSection);
        const shownNow = info.perPage.slice(0, RESULT_PAGES_PER_DOC);
        for (const pp of shownNow) {
          const firstLower = hits.findIndex((h) => h.lowerTier);
          wrap.insertBefore(buildHitRow(d, pp.pageN, pp, firstLower < 0 ? hits.length : firstLower), tierSection);
        }
        fillSnippets(d.hash, shownNow);
        const rest = info.perPage.slice(RESULT_PAGES_PER_DOC);
        if (rest.length) {
          const more = document.createElement('button');
          more.className = 'scribe-library-rmore';
          more.type = 'button';
          more.textContent = `+ ${rest.length} more page${rest.length === 1 ? '' : 's'}`;
          more.addEventListener('click', () => {
            // Anchor on the preceding row at click time: earlier expansions shift positions in `hits`.
            let prev = more.previousElementSibling;
            while (prev && !prev.classList.contains('scribe-library-hit')) prev = prev.previousElementSibling;
            let at = prev ? hits.findIndex((h) => h.row === prev) + 1 : hits.length;
            for (const pp of rest) {
              const row = buildHitRow(d, pp.pageN, pp, at);
              more.before(row);
              at++;
            }
            more.remove();
            fillSnippets(d.hash, rest);
            pump();
          });
          wrap.insertBefore(more, tierSection);
        }
      };

      const firstBatch = ranked.slice(0, RESULT_DOC_LIMIT);
      for (const info of firstBatch) appendDocGroup(info);
      const restDocs = ranked.slice(RESULT_DOC_LIMIT);
      if (restDocs.length) {
        const moreDocs = document.createElement('button');
        moreDocs.className = 'scribe-library-rmore';
        moreDocs.type = 'button';
        moreDocs.style.paddingLeft = '16px';
        moreDocs.textContent = `+ ${restDocs.length} more document${restDocs.length === 1 ? '' : 's'}`;
        moreDocs.addEventListener('click', () => {
          moreDocs.remove();
          for (const info of restDocs) appendDocGroup(info);
          pump();
        });
        wrap.insertBefore(moreDocs, tierSection);
      }
      pump();
    })();

    let tiersShown = false;
    /** @param {import('./search/searchClient.js').SearchResponse} tiers */
    const appendTierSection = (tiers) => {
      if (tiersShown) return;
      tiersShown = true;
      const groups = tiesByName(
        tiers.docs.map((d) => ({ d, docRef: byHash.get(d.hash) })).filter((g) => g.docRef),
        (g) => g.d.pages[0],
        (g) => g.docRef.relPath,
      );
      const pages = groups.reduce((sum, g) => sum + g.d.pages.length, 0);
      wrap.dataset.tierPages = String(pages);
      if (pages) {
        tierSection = document.createElement('div');
        tierSection.className = 'scribe-library-rtiers';
        for (const { d, docRef } of groups) {
          const ref = { relPath: docRef.relPath, entry: docRef.entry, hash: d.hash };
          const docHead = document.createElement('div');
          docHead.className = 'scribe-library-rtdoc';
          docHead.append(`${titleOf(ref.relPath)} `);
          const docMeta = document.createElement('span');
          docMeta.className = 'm';
          docMeta.textContent = `${ref.entry.pageCount} page${ref.entry.pageCount === 1 ? '' : 's'}`;
          docHead.appendChild(docMeta);
          tierSection.appendChild(docHead);
          for (const p of d.pages) {
            tierSection.appendChild(buildHitRow(ref, p.page, {
              count: p.count, tier: p.tier, snippet: p.snippet ? snippetFragment(p.snippet) : null,
            }, hits.length, true));
          }
        }
        wrap.appendChild(tierSection);
        pump();
      }
      // Timing tools outside the app read `tierPages` and `tiersAt`, so both are set even when the near matches hold no page.
      wrap.dataset.tiersAt = String(performance.now());
    };
    const tiersNow = getEngineTiers ? getEngineTiers() : null;
    if (tiersNow) appendTierSection(tiersNow);

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
        const tiers = getEngineTiers ? getEngineTiers() : null;
        if (myGen === resultsGen && tiers) appendTierSection(tiers);
      },
      dispose: () => {
        resultsGen++;
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

    /** Append the near matches that arrived for the current results to their view, if it is built. */
    appendTiers: () => {
      if (resultsView && resultsView.results === getResults()) resultsView.tiers();
    },
  };
}
