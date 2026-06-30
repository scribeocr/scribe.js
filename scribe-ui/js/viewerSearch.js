// eslint-disable-next-line import/no-cycle
import { ScribeViewer } from '../viewer.js';
import scribe from '../../scribe.js';

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
 * @param {import('../viewer.js').ScribeViewer} viewer
 * @param {string} text
 */
export function findText(viewer, text) {
  const _viewer = viewer || ScribeViewer.getDefault();
  const s = _viewer._searchState;
  s.search = text.trim();
  if (s.search) {
    s.matchList = scribe.utils.ocr.getDocMatches(s.search, _viewer.doc.ocr.active);
    s.activeMatch = s.matchList.length ? 0 : -1;
  } else {
    s.matchList = [];
    s.activeMatch = -1;
  }
  applyHighlights(_viewer);
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
  if (!uiWord) return;

  // Center the match vertically in the viewport. Nudge horizontally only if it would sit off an edge.
  // `getClientRect` is in content space; multiply by zoom to get the on-screen offset from the scroll origin.
  const rect = uiWord.getClientRect();
  const margin = 30;
  const sc = _viewer.scrollContainer;
  const zoom = _viewer.zoomLevel || 1;
  sc.scrollTop = (rect.y + rect.height / 2) * zoom - sc.clientHeight / 2;
  const leftPx = rect.x * zoom - sc.scrollLeft;
  const rightPx = (rect.x + rect.width) * zoom - sc.scrollLeft;
  if (rightPx > sc.clientWidth - margin) sc.scrollLeft += rightPx - (sc.clientWidth - margin);
  else if (leftPx < margin) sc.scrollLeft -= margin - leftPx;
  _viewer.updateCurrentPage();
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
  return goToMatch(_viewer, _viewer._searchState.activeMatch - 1);
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
