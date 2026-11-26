// eslint-disable-next-line import/no-cycle
import { ScribeViewer } from '../viewer.js';
import scribe from '../../scribe.js';
import { parseCitation, resolveCitation } from '../../js/resolveCitation.js';
import { createSearchClient } from '../library/search/searchClient.js';

/** @typedef {import('../../js/containers/scribeDoc.js').ScribeDoc} ScribeDoc */
/** @typedef {import('../../js/objects/ocrObjects.js').OcrPage} OcrPage */

/** Word-count threshold for closing a page run. */
const RUN_WORDS = 100000;

/**
 * Shared search-worker client for documents without a search index.
 * @type {?ReturnType<typeof createSearchClient>}
 */
let runClient = null;
let runDocs = 0;

/**
 * Sync state for one document's page runs in the search worker.
 * @typedef {Object} DocRuns
 * @property {string} key
 * @property {?string} layer - Text layer the runs were partitioned from.
 * @property {number} pageCount
 * @property {number} cuts - Generation counter disambiguating worker keys after runs are repartitioned.
 * @property {Array<{hash: string, first: number, end: number, fed: ?Array<?object|undefined>}>} runs - Worker key, `[first, end)` range, and last-sent `HeldRecord` per page.
 *   Entries in `fed` are null for modified pages and undefined for empty slots.
 * @property {Promise<void>} synced
 */
/** @type {WeakMap<ScribeDoc, DocRuns>} */
const docRuns = new WeakMap();

/** Finalization registry that removes a garbage-collected document's runs from the search worker. */
const runSweep = new FinalizationRegistry((/** @type {DocRuns} */ held) => {
  for (const run of held.runs) runClient?.removeRecords(run.hash).catch(() => {});
});

/** @type {WeakMap<OcrPage, Array<string>>} The ids of a page's words in order. */
const wordIdsOf = new WeakMap();

/**
 * Create a search match that lazily resolves 0-based word indices on `pageN` to word IDs.
 * @param {ScribeDoc} doc
 * @param {number} pageN
 * @param {Array<number>} places
 * @returns {{pageN: number, readonly wordIds: Array<string>}}
 */
export function matchByPlace(doc, pageN, places) {
  return {
    pageN,
    get wordIds() {
      const page = doc.pageStore.readOnlyPage(pageN);
      if (!page) return [];
      let ids = wordIdsOf.get(page);
      if (!ids) {
        ids = page.lines.flatMap((line) => line.words.map((word) => word.id));
        wordIdsOf.set(page, ids);
      }
      const pageIds = ids;
      return places.map((k) => pageIds[k]).filter(Boolean);
    },
  };
}

/**
 * Sync page runs for `doc` with the search worker.
 * @param {ScribeDoc} doc
 * @returns {Promise<DocRuns['runs']>}
 */
export function syncDocRuns(doc) {
  if (!runClient) runClient = createSearchClient();
  const client = runClient;
  let held = docRuns.get(doc);
  if (!held) {
    held = {
      key: `file-${++runDocs}`, layer: null, pageCount: -1, cuts: 0, runs: [], synced: Promise.resolve(),
    };
    docRuns.set(doc, held);
    runSweep.register(doc, held);
  }
  const state = held;
  const run = state.synced.then(async () => {
    const store = doc.pageStore;
    const pageCount = store.slotCount();
    if (state.layer !== store.active || state.pageCount !== pageCount) {
      for (const old of state.runs) await client.removeRecords(old.hash);
      state.layer = store.active;
      state.pageCount = pageCount;
      state.cuts++;
      state.runs = [];
      let first = 0;
      let words = 0;
      for (let n = 0; n < pageCount; n++) {
        words += store.pageCounts(n)?.words || 0;
        if (words >= RUN_WORDS || n === pageCount - 1) {
          state.runs.push({
            hash: `${state.key}:${state.cuts}:${first}`, first, end: n + 1, fed: null,
          });
          first = n + 1;
          words = 0;
        }
      }
    }
    for (const pageRun of state.runs) {
      let stale = !pageRun.fed;
      for (let n = pageRun.first; n < pageRun.end && !stale; n++) {
        const now = store.hasPage(n, 'active') ? store.cleanRecord(n) : undefined;
        stale = now !== /** @type {Array<?object|undefined>} */ (pageRun.fed)[n - pageRun.first];
      }
      if (!stale) continue;
      const fed = [];
      const records = [];
      for (let n = pageRun.first; n < pageRun.end; n++) {
        if (!store.hasPage(n, 'active')) {
          fed.push(undefined);
          records.push(null);
          continue;
        }
        const record = store.cleanRecord(n);
        fed.push(record);
        records.push(record ? { bytes: record.bytes, deflated: record.deflated } : null);
      }
      pageRun.fed = null;
      if (records.some(Boolean)) await client.addRecords(pageRun.hash, records);
      else await client.removeRecords(pageRun.hash);
      pageRun.fed = fed;
    }
  });
  state.synced = run.catch(() => {});
  return run.then(() => state.runs);
}

/**
 * The ids of the words the current search matches on page `n`.
 * @param {import('../viewer.js').ScribeViewer} viewer
 * @param {number} n
 * @returns {string[]}
 */
export function pageMatchIds(viewer, n) {
  const s = viewer._searchState;
  if (!s.search) return [];
  return s.matchList.filter((m) => m.pageN === n).flatMap((m) => m.wordIds);
}

/**
 * Repaint match highlights from `_searchState` on every page that holds word objects.
 * @param {import('../viewer.js').ScribeViewer} viewer
 */
function applyHighlights(viewer) {
  const s = viewer._searchState;
  const activeEntry = s.matchList[s.activeMatch];
  const activeIds = activeEntry ? new Set(activeEntry.wordIds) : new Set();
  if (s.search && viewer.useCustomSelection) {
    // The custom engine builds word objects lazily, and a match needs one to paint on, both on the pages in view and on those kept rendered off-screen.
    viewer.getUiWords();
    for (const n of viewer.textGroupsRenderIndices) viewer.ensureWordObjs(n);
  }
  // Pages kept built off-screen hold the previous query's highlights too.
  viewer._wordObjs.forEach((pageWords, n) => {
    // Dropping off-screen word objects leaves `[]` in `_wordObjs`, so bail before `pageMatchIds` reloads evicted pages.
    if (!pageWords || pageWords.length === 0) return;
    const matchIds = new Set(pageMatchIds(viewer, n));
    for (const kw of pageWords) {
      if (kw._destroyed) continue;
      const isActive = activeIds.has(kw.word.id);
      kw.activeMatch = isActive;
      kw.fillBox = !isActive && matchIds.has(kw.word.id);
    }
  });
}

/**
 * Repaint the citation wash.
 * The wash is the word's own `cited` state, apart from the find bar's match fill, so the two never share a color or clear each other.
 * @param {import('../viewer.js').ScribeViewer} viewer
 * @param {Set<string>} previous - The word ids `viewer._citationIds` held before it changed.
 */
function repaintCitation(viewer, previous) {
  // Pages kept built off-screen hold the previous wash too.
  for (const pageWords of viewer._wordObjs) {
    if (!pageWords) continue;
    for (const kw of pageWords) {
      const id = kw.word.id;
      if (!kw._destroyed && (viewer._citationIds.has(id) || previous.has(id))) kw.cited = viewer._citationIds.has(id);
    }
  }
}

/**
 * Find `text` in the document and paint its matches.
 * A later find on the same viewer supersedes this one.
 * @param {import('../viewer.js').ScribeViewer} viewer
 * @param {string} text
 * @returns {Promise<boolean>} Whether this find's matches are the ones painted.
 */
export async function findText(viewer, text) {
  const _viewer = viewer || ScribeViewer.getDefault();
  const s = _viewer._searchState;
  const { doc } = _viewer;
  const query = text.trim();
  s.findSeq = (s.findSeq || 0) + 1;
  const seq = s.findSeq;
  let matchList = [];
  if (query && doc.findMatches) {
    matchList = await doc.findMatches(query).catch(() => []);
    if (s.findSeq !== seq || _viewer.doc !== doc) return false;
  } else if (query) {
    try {
      const runs = await syncDocRuns(doc);
      /** @type {Array<OcrPage>} */
      const changed = [];
      for (const r of runs) {
        /** @type {Array<?object|undefined>} */ (r.fed).forEach((record, k) => {
          if (record === null) changed.push(/** @type {OcrPage} */ (doc.pageStore.readOnlyPage(r.first + k)));
        });
      }
      const sent = runs.filter((r) => /** @type {Array<?object|undefined>} */ (r.fed).some(Boolean)).map((r) => ({ hash: r.hash, first: r.first }));
      const found = await /** @type {NonNullable<typeof runClient>} */ (runClient).findRuns(sent, query);
      matchList = found.map((match) => matchByPlace(doc, match.pageN, match.wordIds));
      if (changed.length) matchList = [...matchList, ...scribe.utils.ocr.getDocMatches(query, changed)].sort((a, b) => a.pageN - b.pageN);
    } catch (err) {
      console.warn('Find fell back to scanning the pages:', err);
      // Clear cached runs in case `runClient` replaced its worker and lost them.
      docRuns.delete(doc);
      matchList = scribe.utils.ocr.getDocMatches(query, doc.pageStore.pageList());
    }
    if (s.findSeq !== seq || _viewer.doc !== doc) return false;
  }
  const previous = _viewer._citationIds;
  _viewer._citationIds = new Set();
  s.search = query;
  s.matchList = matchList;
  // Selecting a match belongs to goToMatch, so a recompute can refresh highlights without adopting one.
  s.activeMatch = -1;
  applyHighlights(_viewer);
  repaintCitation(_viewer, previous);
  return true;
}

/**
 * Focus `viewer` on search match at `index`.
 * @param {import('../viewer.js').ScribeViewer} viewer
 * @param {number} index
 * @param {object} [options]
 * @param {boolean} [options.navigate=true] - Pass false to make the match active without moving the view.
 * @param {boolean} [options.glide=false] - Glide to a near match.
 * @returns {Promise<void>}
 */
export async function goToMatch(viewer, index, { navigate = true, glide = false } = {}) {
  const _viewer = viewer || ScribeViewer.getDefault();
  const s = _viewer._searchState;
  if (!s.matchList.length) {
    s.activeMatch = -1;
    return;
  }

  const n = ((index % s.matchList.length) + s.matchList.length) % s.matchList.length;
  s.activeMatch = n;
  const match = s.matchList[n];

  // refresh=false: pages already rendered are left intact,
  // so advancing to an on-screen page just moves the image rather than rebuilding every word shape.
  // Pages drawn fresh here already pick up the correct highlights from the renderer.
  if (navigate) {
    await _viewer.displayPage(match.pageN, false, false);
    // The search can close, or run a new query, while the page renders, and then this match must not light up.
    if (_viewer._searchState.matchList[n] !== match) return;
  }

  // Move the active (orange) highlight without re-rendering.
  // The blue match highlights on already-rendered pages are unchanged,
  // so only the new active words and the previous active words need their flags flipped.
  // The previous active words can sit on a page kept built off-screen, so every built page is checked.
  const uiWords = _viewer.getUiWords();
  const activeIds = new Set(match.wordIds);
  for (const pageWords of _viewer._wordObjs) {
    if (!pageWords) continue;
    for (const kw of pageWords) {
      if (kw._destroyed) continue;
      if (activeIds.has(kw.word.id)) {
        kw.activeMatch = true;
        kw.fillBox = false;
      } else if (kw.activeMatch) {
        kw.activeMatch = false;
        kw.fillBox = true;
      }
    }
  }

  if (!navigate) return;
  const uiWord = uiWords.find((kw) => kw.word.id === match.wordIds[0]);
  if (uiWord) _viewer.scrollToWord(uiWord, { glide });
}

/**
 * Search `viewer` for `query` and land on a match.
 * Does nothing unless `viewer.state.searchMode` is on once the document's text is ready.
 * @param {import('../viewer.js').ScribeViewer} viewer
 * @param {string} query
 * @param {object} [options]
 * @param {number} [options.pageN] - Land on this page: on its first match, or on the page itself when none of the matches is there.
 *   Without it the search lands on the first match at or after the page in view.
 * @param {boolean} [options.navigate=true] - Pass false to refresh the matches and highlights without moving the view.
 * @returns {Promise<void>}
 */
export async function searchDoc(viewer, query, { pageN, navigate = true } = {}) {
  const doc = viewer.doc;
  if (!doc || doc.pageMetrics.length === 0) return;
  if (doc._textReadySettle) {
    await doc.textReady;
    if (viewer.doc !== doc) return;
  }
  if (!viewer.state.searchMode) return;
  if (!(await findText(viewer, query))) return;
  if (viewer.doc !== doc) return;
  if (!navigate) return;
  const { matchList } = viewer._searchState;
  if (!matchList.length) return;
  if (pageN !== undefined) {
    const onPage = matchList.findIndex((m) => m.pageN === pageN);
    if (onPage >= 0) await goToMatch(viewer, onPage);
    else await viewer.displayPage(pageN, true, false);
    return;
  }
  const idx = matchList.findIndex((m) => m.pageN >= viewer.state.cp.n);
  await goToMatch(viewer, idx >= 0 ? idx : 0);
}

/**
 * Move to the next match, wrapping to the first after the last.
 * @param {import('../viewer.js').ScribeViewer} viewer
 * @returns {Promise<void>}
 */
export function nextMatch(viewer) {
  const _viewer = viewer || ScribeViewer.getDefault();
  return goToMatch(_viewer, _viewer._searchState.activeMatch + 1, { glide: true });
}

/**
 * Move to the previous match, wrapping to the last before the first.
 * @param {import('../viewer.js').ScribeViewer} viewer
 * @returns {Promise<void>}
 */
export function prevMatch(viewer) {
  const _viewer = viewer || ScribeViewer.getDefault();
  const i = _viewer._searchState.activeMatch;
  // With no match active yet, "previous" is the last match, which index -1 wraps to.
  return goToMatch(_viewer, i < 0 ? -1 : i - 1, { glide: true });
}

/**
 * Backward-compatible static API. Reads/writes search state on the default viewer.
 * For multi-viewer code, use `findText(viewer, text)` etc. directly.
 */
export class search {
  static get search() { return ScribeViewer.getDefault()._searchState.search; }

  static set search(v) { ScribeViewer.getDefault()._searchState.search = v; }

  static get matchList() { return ScribeViewer.getDefault()._searchState.matchList; }

  static set matchList(v) { ScribeViewer.getDefault()._searchState.matchList = v; }

  static get activeMatch() { return ScribeViewer.getDefault()._searchState.activeMatch; }

  static set activeMatch(v) { ScribeViewer.getDefault()._searchState.activeMatch = v; }

  static findText = (text) => findText(ScribeViewer.getDefault(), text);

  static goToMatch = (index) => goToMatch(ScribeViewer.getDefault(), index);

  static nextMatch = () => nextMatch(ScribeViewer.getDefault());

  static prevMatch = () => prevMatch(ScribeViewer.getDefault());
}

/**
 * Navigate `viewer` to a citation.
 * @param {import('../viewer.js').ScribeViewer} viewer
 * @param {string} text
 * @param {object} [options]
 * @param {boolean} [options.highlight=true]
 * @returns {Promise<ReturnType<import('../../js/containers/scribeDoc.js').ScribeDoc['resolveCitation']>>}
 */
export async function goToCitation(viewer, text, { highlight = true } = {}) {
  const _viewer = viewer || ScribeViewer.getDefault();
  const doc = _viewer.doc;
  if (!doc) return [];
  if (doc._textReadySettle) {
    await doc.textReady;
    if (_viewer.doc !== doc) return [];
  }
  const spans = resolveCitation(doc.pageStore.pageList(), text);
  if (!spans.length) {
    clearCitation(_viewer);
    return spans;
  }
  const words = spans.flatMap((sp) => sp.lines.flatMap((l) => l.words));
  await showCitedWords(_viewer, spans[0].page, highlight ? words : [], { wholePage: parseCitation(text)?.kind === 'page', firstWord: words[0] });
  return spans;
}

/**
 * Light `words` as the current citation and bring the passage on page `pageIndex` into view.
 * @param {import('../viewer.js').ScribeViewer} viewer
 * @param {number} pageIndex
 * @param {Array<import('../../js/objects/ocrObjects.js').OcrWord>} words
 * @param {object} [options]
 * @param {boolean} [options.wholePage=false] - Show the page from its top instead of scrolling to the first word.
 * @param {import('../../js/objects/ocrObjects.js').OcrWord} [options.firstWord=words[0]]
 * @param {boolean} [options.scroll=true] - `false` re-marks the words where the view already stands.
 */
export async function showCitedWords(viewer, pageIndex, words, { wholePage = false, firstWord = words[0], scroll = true } = {}) {
  const previous = viewer._citationIds;
  viewer._citationIds = new Set(words.map((w) => w.id));
  if (!scroll) {
    await viewer.displayPage(pageIndex, false, false);
    // A page drawn before its text or any citation existed has no word objects yet, so they are built before the wash is laid.
    viewer.getUiWords();
    repaintCitation(viewer, previous);
    return;
  }
  await viewer.displayPage(pageIndex, wholePage || !firstWord, false);
  const uiWords = viewer.getUiWords();
  repaintCitation(viewer, previous);
  if (wholePage || !firstWord) return;
  const uiWord = uiWords.find((kw) => kw.word.id === firstWord.id);
  if (uiWord) viewer.scrollToWord(uiWord);
}

/**
 * Take the citation wash off every word.
 * @param {import('../viewer.js').ScribeViewer} viewer
 */
export function clearCitation(viewer) {
  const previous = viewer._citationIds;
  viewer._citationIds = new Set();
  repaintCitation(viewer, previous);
}
