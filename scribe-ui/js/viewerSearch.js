// eslint-disable-next-line import/no-cycle
import { ScribeViewer } from '../viewer.js';
import scribe from '../../scribe.js';

/** @param {import('../viewer.js').ScribeViewer} viewer */
function extractTextAll(viewer) {
  const s = viewer._searchState;
  const maxValue = viewer.doc.ocr.active.length;
  for (let g = 0; g < maxValue; g++) {
    s.text[g] = scribe.utils.ocr.getPageText(viewer.doc.ocr.active[g]);
  }
}

/** @param {import('../viewer.js').ScribeViewer} viewer */
function findAllMatches(viewer, text) {
  const s = viewer._searchState;
  let total = 0;
  const matches = [];
  const maxValue = s.text.length;
  for (let i = 0; i < maxValue; i++) {
    const n = scribe.utils.countSubstringOccurrences(s.text[i], text);
    matches[i] = n;
    total += n;
  }
  s.matches = matches;
  s.total = total;
}

/**
 * Highlight words that include substring in the current page.
 * @param {import('../viewer.js').ScribeViewer} viewer
 * @param {string} text
 */
function highlightcp(viewer, text) {
  const _viewer = viewer || ScribeViewer.getDefault();
  if (!text) return;
  const matchIdArr = scribe.utils.ocr.getMatchingWordIds(text, _viewer.doc.ocr.active[_viewer.state.cp.n]);

  _viewer.getKonvaWords().forEach((wordObj) => {
    if (matchIdArr.includes(wordObj.word.id)) {
      wordObj.fillBox = true;
    } else {
      wordObj.fillBox = false;
    }
  });

  _viewer.layerText.batchDraw();
}

/**
 * Updates data used for "Find" feature on current page.
 * Should be called after any edits are made, before moving to a different page.
 * @param {import('../viewer.js').ScribeViewer} viewer
 */
function updateFindStats(viewer) {
  const _viewer = viewer || ScribeViewer.getDefault();
  const s = _viewer._searchState;
  if (!_viewer.doc.ocr.active[_viewer.state.cp.n]) {
    s.text[_viewer.state.cp.n] = '';
    return;
  }

  s.text[_viewer.state.cp.n] = scribe.utils.ocr.getPageText(_viewer.doc.ocr.active[_viewer.state.cp.n]);

  if (s.search) {
    s.matches[_viewer.state.cp.n] = scribe.utils.countSubstringOccurrences(s.text[_viewer.state.cp.n], s.search);
    s.total = s.matches.reduce((partialSum, a) => partialSum + a, 0);
  }
}

/**
 * @param {import('../viewer.js').ScribeViewer} viewer
 * @param {string} text
 */
function findText(viewer, text) {
  const _viewer = viewer || ScribeViewer.getDefault();
  const s = _viewer._searchState;
  s.search = text.trim();
  highlightcp(_viewer, text);
  if (s.search) {
    if (!s.init) {
      extractTextAll(_viewer);
      s.init = true;
    }
    findAllMatches(_viewer, s.search);
  } else {
    s.matches = [];
    s.total = 0;
  }
}

/**
 * Returns string showing index of match(es) found on current page.
 * @param {import('../viewer.js').ScribeViewer} viewer
 * @param {number} n
 */
function calcMatchNumber(viewer, n) {
  const _viewer = viewer || ScribeViewer.getDefault();
  const s = _viewer._searchState;
  const matchN = s.matches?.[n];
  if (!matchN) {
    return '-';
  }
  const matchPrev = s.matches.slice(0, n).reduce((a, b) => a + b, 0);

  if (matchN === 1) {
    return String(matchPrev + 1);
  }
  return `${String(matchPrev + 1)}-${String(matchPrev + 1 + (matchN - 1))}`;
}

/**
 * Backward-compatible static API. Reads/writes search state on the default viewer.
 * For multi-viewer code, use `findText(viewer, text)` etc. directly.
 */
export class search {
  static get text() { return ScribeViewer.getDefault()._searchState.text; }

  static set text(v) { ScribeViewer.getDefault()._searchState.text = v; }

  static get search() { return ScribeViewer.getDefault()._searchState.search; }

  static set search(v) { ScribeViewer.getDefault()._searchState.search = v; }

  static get matches() { return ScribeViewer.getDefault()._searchState.matches; }

  static set matches(v) { ScribeViewer.getDefault()._searchState.matches = v; }

  static get init() { return ScribeViewer.getDefault()._searchState.init; }

  static set init(v) { ScribeViewer.getDefault()._searchState.init = v; }

  static get total() { return ScribeViewer.getDefault()._searchState.total; }

  static set total(v) { ScribeViewer.getDefault()._searchState.total = v; }

  static highlightcp = (text) => highlightcp(ScribeViewer.getDefault(), text);

  static updateFindStats = (viewer) => updateFindStats(viewer);

  static findText = (text) => findText(ScribeViewer.getDefault(), text);

  static calcMatchNumber = (n) => calcMatchNumber(ScribeViewer.getDefault(), n);
}
