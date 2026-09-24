// eslint-disable-next-line import/no-cycle
import { ScribeViewer } from '../viewer.js';
import scribe from '../../scribe.js';
import { parseCitation } from '../../js/resolveCitation.js';

/**
 * Repaint match highlights on the currently-rendered words from `_searchState`.
 * @param {import('../viewer.js').ScribeViewer} viewer
 */
function applyHighlights(viewer) {
  const s = viewer._searchState;
  const activeEntry = s.matchList[s.activeMatch];
  const activeIds = activeEntry ? new Set(activeEntry.wordIds) : new Set();
  /** @type {Object<number, Set<string>>} */
  const matchIdsByPage = {};
  for (const kw of viewer.getUiWords()) {
    const pageN = kw.word.line.page.n;
    if (!matchIdsByPage[pageN]) {
      matchIdsByPage[pageN] = s.search && viewer.doc.ocr.active[pageN]
        ? new Set(scribe.utils.ocr.getMatchingWordIds(s.search, viewer.doc.ocr.active[pageN]))
        : new Set();
    }
    const isActive = activeIds.has(kw.word.id);
    kw.activeMatch = isActive;
    kw.fillBox = !isActive && matchIdsByPage[pageN].has(kw.word.id);
  }
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
 * @param {import('../viewer.js').ScribeViewer} viewer
 * @param {string} text
 */
export function findText(viewer, text) {
  const _viewer = viewer || ScribeViewer.getDefault();
  const s = _viewer._searchState;
  const previous = _viewer._citationIds;
  _viewer._citationIds = new Set();
  s.search = text.trim();
  s.matchList = s.search ? scribe.utils.ocr.getDocMatches(s.search, _viewer.doc.ocr.active) : [];
  // Selecting a match belongs to goToMatch, so a recompute can refresh highlights without adopting one.
  s.activeMatch = -1;
  applyHighlights(_viewer);
  repaintCitation(_viewer, previous);
}

/**
 * Focus `viewer` on search match at `index`.
 * @param {import('../viewer.js').ScribeViewer} viewer
 * @param {number} index
 * @returns {Promise<void>}
 */
export async function goToMatch(viewer, index) {
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
  await _viewer.displayPage(match.pageN, false, false);

  // Move the active (orange) highlight without re-rendering.
  // The blue match highlights on already-rendered pages are unchanged,
  // so only the new active words and the previous active words need their flags flipped.
  const uiWords = _viewer.getUiWords();
  const activeIds = new Set(match.wordIds);
  for (const kw of uiWords) {
    if (activeIds.has(kw.word.id)) {
      kw.activeMatch = true;
      kw.fillBox = false;
    } else if (kw.activeMatch) {
      kw.activeMatch = false;
      kw.fillBox = true;
    }
  }

  const uiWord = uiWords.find((kw) => kw.word.id === match.wordIds[0]);
  if (uiWord) _viewer.scrollToWord(uiWord);
}

/**
 * Move to the next match, wrapping to the first after the last.
 * @param {import('../viewer.js').ScribeViewer} viewer
 * @returns {Promise<void>}
 */
export function nextMatch(viewer) {
  const _viewer = viewer || ScribeViewer.getDefault();
  return goToMatch(_viewer, _viewer._searchState.activeMatch + 1);
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
  return goToMatch(_viewer, i < 0 ? -1 : i - 1);
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
