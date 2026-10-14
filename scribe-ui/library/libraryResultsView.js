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
 */
export function createResultsView({
  host, sessions, preview, getStore, getManifest, getResults, getQuery, openEntry, selectOpens, onBack, saveManifestSoon,
}) {
  /**
   * The retained search-results view: the built DOM plus its interaction state.
   * Keeping it lets an unchanged result set reattach instead of rebuilding.
   * @type {?{results: Object, wrap: HTMLElement, select: (relPath: ?string, pageN: number) => void, snapshot: () => void, attach: () => void, repump: () => void, dispose: () => void}}
   */
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
      return;
    }
    if (resultsView) {
      resultsView.dispose();
      resultsView = null;
    }
    const myGen = ++resultsGen;
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
    summaryN.textContent = results.length
      ? `${results.length} document${results.length === 1 ? '' : 's'}`
      : `No results for “${fullTextQuery}”`;
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

    /** @type {Array<{relPath: string, entry: import('./libraryStore.js').LibraryDocEntry, hash: string, pageN: number, count: number, row: HTMLElement}>} */
    const hits = [];
    let active = -1;
    let opening = false;

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
        const sidePass = needMarks.length
          ? sessions.sidecarPages(first.hash, needMarks.map((b) => b.pageN)).catch(() => null)
          : null;
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
      if (myGen === resultsGen && rasterless.some((r) => !r.warmed)) warmHits();
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
     * @param {{relPath: string, entry: import('./libraryStore.js').LibraryDocEntry, hash: string}} docRef
     * @param {number} pageN
     * @param {{count: number, snippet: DocumentFragment}} info
     * @param {number} insertAt - Position in `hits`, so expanded rows keep list order for stepping.
     * @returns {HTMLElement}
     */
    const buildHitRow = (docRef, pageN, info, insertAt) => {
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
      const htMeta = document.createElement('span');
      htMeta.className = 'm';
      htMeta.textContent = `· ${info.count} match${info.count === 1 ? '' : 'es'}`;
      ht.appendChild(htMeta);
      hm.appendChild(ht);
      const sn = document.createElement('span');
      sn.className = 'sn';
      sn.appendChild(info.snippet);
      hm.appendChild(sn);
      row.appendChild(hm);
      const hit = {
        relPath: docRef.relPath, entry: docRef.entry, hash: docRef.hash, pageN, count: info.count, row,
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

      const ranked = /** @type {NonNullable<typeof infos[0]>[]} */ (infos.filter(Boolean));
      ranked.sort((a, b) => b.total - a.total);
      const totalMatches = ranked.reduce((sum, r) => sum + r.total, 0);
      summaryN.textContent = `${totalMatches} match${totalMatches === 1 ? '' : 'es'} · ${ranked.length} document${ranked.length === 1 ? '' : 's'}`;

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
        wrap.appendChild(head);
        const shownNow = info.perPage.slice(0, RESULT_PAGES_PER_DOC);
        for (const pp of shownNow) wrap.appendChild(buildHitRow(d, pp.pageN, pp, hits.length));
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
            pumpThumbs();
          });
          wrap.appendChild(more);
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
          pumpThumbs();
        });
        wrap.appendChild(moreDocs);
      }
      pumpThumbs();
    })();

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
        pumpThumbs();
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
  };
}
