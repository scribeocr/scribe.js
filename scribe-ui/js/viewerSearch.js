// eslint-disable-next-line import/no-cycle
import { ScribeViewer } from '../viewer.js';
import scribe from '../../scribe.js';
import { parseCitation } from '../../js/resolveCitation.js';

/**
 * The ids of the words the current search matches on page `n`.
 * @param {import('../viewer.js').ScribeViewer} viewer
 * @param {number} n
 * @returns {string[]}
 */
export function pageMatchIds(viewer, n) {
  const s = viewer._searchState;
  if (!s.search) return [];
  // A document's own find, such as the library's index, can return matches the plain matcher below would not reproduce.
  if (viewer.doc.findMatches) return s.matchList.filter((m) => m.pageN === n).flatMap((m) => m.wordIds);
  const page = viewer.doc.ocr.active[n];
  return page ? scribe.utils.ocr.getMatchingWordIds(s.search, page) : [];
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
    if (!pageWords) return;
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
 * Repaint the citation highlight.
 * @param {import('../viewer.js').ScribeViewer} viewer
 * @param {Set<string>} previous - The word ids `viewer._citationIds` held before it changed.
 */
function repaintCitation(viewer, previous) {
  const s = viewer._searchState;
  const activeEntry = s.matchList[s.activeMatch];
  const searchIds = activeEntry ? new Set(activeEntry.wordIds) : new Set();
  // Pages kept built off-screen hold the previous highlight too.
  for (const pageWords of viewer._wordObjs) {
    if (!pageWords) continue;
    for (const kw of pageWords) {
      const id = kw.word.id;
      if (!kw._destroyed && (viewer._citationIds.has(id) || previous.has(id))) kw.activeMatch = viewer._citationIds.has(id) || searchIds.has(id);
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
  } else if (query) matchList = scribe.utils.ocr.getDocMatches(query, doc.ocr.active);
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
    // A provisional document's page has its words only once asked for, and the scroll to the match below needs them.
    if (_viewer.doc.pageText) await _viewer.doc.pageText(match.pageN);
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
  // Deferred-import text may still be extracting, so searching now would falsely report "No results".
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
  const spans = doc.resolveCitation(text);
  /** @type {Set<string>} */
  const ids = new Set();
  if (highlight) for (const sp of spans) for (const l of sp.lines) for (const w of l.words) ids.add(w.id);
  const previous = _viewer._citationIds;
  _viewer._citationIds = ids;
  const wholePage = parseCitation(text)?.kind === 'page';
  if (spans.length) await _viewer.displayPage(spans[0].page, wholePage, false);
  const uiWords = _viewer.getUiWords();
  repaintCitation(_viewer, previous);
  if (!spans.length || wholePage) return spans;
  const first = spans[0].lines.flatMap((l) => l.words)[0];
  const uiWord = first && uiWords.find((kw) => kw.word.id === first.id);
  if (uiWord) _viewer.scrollToWord(uiWord);
  return spans;
}
