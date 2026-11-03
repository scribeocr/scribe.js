// The marks of a version comparison in a viewer, and the move to a change.

/**
 * The marks of one side of a diff, by page.
 * @param {import('../../js/textDiff.js').TextDiff} diff
 * @param {'a'|'b'} side
 * @returns {Map<number, {sides: Map<string, 'removed'|'added'>, current: Set<string>}>}
 */
export function diffMarksFor(diff, side) {
  const marks = new Map();
  const kind = side === 'a' ? 'removed' : 'added';
  for (const c of diff.changes) {
    const s = c[side];
    if (s.pageN == null || !s.wordIds.length) continue;
    let page = marks.get(s.pageN);
    if (!page) { page = { sides: new Map(), current: new Set() }; marks.set(s.pageN, page); }
    for (const id of s.wordIds) page.sides.set(id, kind);
  }
  return marks;
}

/**
 * Put a comparison's marks on a viewer, or take them off with null.
 * @param {import('../viewer.js').ScribeViewer} viewer
 * @param {?ReturnType<typeof diffMarksFor>} marks
 */
export function applyDiffMarks(viewer, marks) {
  viewer._diffMarks = marks;
  if (marks && viewer.useCustomSelection) {
    // The custom engine builds word objects lazily, and a mark needs one to paint on, both on the pages in view and on those kept rendered off-screen.
    viewer.getUiWords();
    for (const n of viewer.textGroupsRenderIndices) viewer.ensureWordObjs(n);
  }
  viewer._wordObjs.forEach((pageWords, n) => {
    if (!pageWords) return;
    const page = marks ? marks.get(n) || null : null;
    for (const kw of pageWords) {
      if (kw._destroyed) continue;
      kw.diff = page ? page.sides.get(kw.word.id) || null : null;
      kw.diffCurrent = !!page && page.current.has(kw.word.id);
    }
  });
}

/**
 * Move the current change's ring to change `n` on a viewer whose marks are already applied.
 * @param {import('../viewer.js').ScribeViewer} viewer
 * @param {ReturnType<typeof diffMarksFor>} marks
 * @param {import('../../js/textDiff.js').TextDiff} diff
 * @param {'a'|'b'} side
 * @param {number} n
 */
export function setDiffCurrent(viewer, marks, diff, side, n) {
  for (const page of marks.values()) page.current.clear();
  const c = diff.changes[n - 1];
  const s = c ? c[side] : null;
  if (s && s.pageN != null) {
    const page = marks.get(s.pageN);
    if (page) for (const id of s.wordIds) page.current.add(id);
  }
  viewer._wordObjs.forEach((pageWords, pageN) => {
    if (!pageWords) return;
    const page = marks.get(pageN) || null;
    for (const kw of pageWords) {
      if (kw._destroyed) continue;
      const cur = !!page && page.current.has(kw.word.id);
      if (kw.diffCurrent !== cur) kw.diffCurrent = cur;
    }
  });
}

/**
 * Scroll a viewer to change `n`.
 * @param {import('../viewer.js').ScribeViewer} viewer
 * @param {import('../../js/textDiff.js').TextDiff} diff
 * @param {'a'|'b'} side
 * @param {number} n
 * @returns {Promise<void>}
 */
export async function goToChange(viewer, diff, side, n) {
  const c = diff.changes[n - 1];
  if (!c || !viewer.doc) return;
  const s = c[side];
  const wordId = s.wordIds[0] || s.anchorId;
  let pageN = s.pageN;
  if (pageN == null && wordId) {
    pageN = (viewer.doc.ocr.active || []).findIndex((p) => p && p.lines.some((l) => l.words.some((w) => w.id === wordId)));
    if (pageN < 0) pageN = null;
  }
  if (pageN == null) {
    const other = c[side === 'a' ? 'b' : 'a'];
    if (other.pageN != null && other.pageN < viewer.doc.pageMetrics.length) await viewer.displayPage(other.pageN, true, false);
    return;
  }
  // A provisional document's page has its words only once asked for, and the scroll to the word below needs them.
  if (viewer.doc.pageText) await viewer.doc.pageText(pageN);
  if (c.kind === 'page' && s.wordIds.length) { await viewer.displayPage(pageN, true, false); return; }
  await viewer.displayPage(pageN, false, false);
  const kw = !wordId ? null : viewer.useCustomSelection ? viewer.ensureWordObjs(pageN).get(wordId) || null : (viewer._wordObjs[pageN] || []).find((w) => w.word.id === wordId) || null;
  if (kw) viewer.scrollToWord(kw, { glide: false, center: true });
}

/**
 * The rail's bands for one side of a comparison, by page.
 * @param {import('../../js/containers/scribeDoc.js').ScribeDoc} doc
 * @param {import('../../js/textDiff.js').TextDiff} diff
 * @param {'a'|'b'} side
 * @param {{removed: string, added: string}} colors
 * @returns {(n: number) => Array<{kind: string, color: string, opacity: number, left: number, right: number, top: number, bottom: number}>}
 */
export function diffRunsFor(doc, diff, side, colors) {
  const color = side === 'a' ? colors.removed : colors.added;
  /** @type {Map<number, Set<string>>} */
  const idsByPage = new Map();
  for (const c of diff.changes) {
    const s = c[side];
    if (s.pageN == null) continue;
    let ids = idsByPage.get(s.pageN);
    if (!ids) { ids = new Set(); idsByPage.set(s.pageN, ids); }
    for (const id of s.wordIds) ids.add(id);
  }
  return (n) => {
    const ids = idsByPage.get(n);
    const page = doc.ocr.active?.[n];
    if (!ids || !page) return [];
    const runs = [];
    for (const line of page.lines) {
      for (const w of line.words) {
        if (!ids.has(w.id)) continue;
        runs.push({
          kind: 'highlight', color, opacity: 0.45, left: w.bbox.left, right: w.bbox.right, top: w.bbox.top, bottom: w.bbox.bottom,
        });
      }
    }
    return runs;
  };
}
